"""Tracking controls around TIAGo's native CostMenu, without importing GATO.

Only menus exactly representable by default_cost get convenience controls. Other
native menus remain intact; resizing such an objective needs an explicit menu.
"""
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
import math

import numpy as np

WEIGHTS = ("position", "terminal_position", "velocity", "torque", "orientation", "terminal_orientation")


def checked_weights(values):
    if not isinstance(values, dict) or set(values) != set(WEIGHTS):
        raise ValueError("cost_weights requires position, terminal_position, velocity, torque, orientation and terminal_orientation")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or
           not math.isfinite(value) or value < 0 for value in values.values()):
        raise ValueError("tracking weights must be finite and nonnegative")
    return {name: float(values[name]) for name in WEIGHTS}


def serialized_cost(n, values):
    """Pure-JSON counterpart of default_cost, for the HTTP parent's native payload.

    Selected-interpreter construction always goes through default_cost. The
    contract test compares all fields with its actual record.to_dict output.
    """
    weights = checked_weights(values)
    if type(n) is not int or n < 2:
        raise ValueError("n must be an integer >= 2")
    result = dict(type="CostMenu", **{key: None for key in (
        "frame_pos", "state", "input", "linear_x", "linear_u", "orientation", "velocity", "frame_pos_2", "q_ref")})
    def term(weight, target=None):
        return dict(type="Term", weight=weight, target=target, activation="quadratic", eps=0., lower=None, upper=None)
    for key, running, terminal, target in (
            ("frame_pos", "position", "terminal_position", [0.] * 3),
            ("orientation", "orientation", "terminal_orientation", np.eye(3).tolist())):
        if weights[running] or weights[terminal]:
            result[key] = term([[weights[running]] * 3 for _ in range(n - 1)] + [[weights[terminal]] * 3], target)
    if weights["velocity"]:
        result["state"] = term([0.] * 7 + [weights["velocity"]] * 7)
    if weights["torque"]:
        result["input"] = term(weights["torque"])
    if all(result[key] is None for key in ("frame_pos", "state", "input", "orientation")):
        result["input"] = term(0.)
    return result


def cost_weights(cost):
    """Read canonical default_cost weights; return None for custom objectives."""
    if not isinstance(cost, dict) or cost.get("type") != "CostMenu":
        return None
    values = dict.fromkeys(WEIGHTS, 0.)
    n = None
    try:
        for term, running, terminal in (("frame_pos", "position", "terminal_position"),
                                        ("orientation", "orientation", "terminal_orientation")):
            if cost.get(term) is not None:
                rows = np.asarray(cost[term]["weight"], dtype=float)
                if rows.ndim != 2 or rows.shape[1] != 3 or len(rows) < 2 or n not in (None, len(rows)):
                    return None
                n = len(rows)
                values[running], values[terminal] = float(rows[0, 0]), float(rows[-1, 0])
        if cost.get("state") is not None:
            values["velocity"] = float(cost["state"]["weight"][7])
        if cost.get("input") is not None:
            values["torque"] = cost["input"]["weight"]
        # No position/orientation term means the objective does not depend on N.
        return checked_weights(values) if serialized_cost(n or 2, values) == cost else None
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def native_params(data):
    """Construct native params; convenience weights never enter MpcParams."""
    from tiago_mpc.costs import default_cost
    from tiago_mpc.mpc import MpcParams
    from tiago_mpc.record import from_dict, to_dict
    payload = deepcopy(data)
    values = payload.pop("cost_weights", None)
    params = from_dict(payload)
    if not isinstance(params, MpcParams):
        raise ValueError("Solver configuration must be tagged MpcParams from tiago_mpc.record.to_dict")
    canonical = cost_weights(to_dict(params.cost))
    if values is not None and canonical is None:
        raise ValueError("Convenience cost_weights cannot replace a custom CostMenu")
    values = canonical if values is None else checked_weights(values)
    if values is not None:
        params = replace(params, cost=default_cost(params.N, **values))
    validate_native_cost(params)
    return params


def validate_native_cost(params):
    """Use GATO's host validator with a no-op upload sink, never a GPU solver.

    This is the fixed-base TIAGo model and the same host-only CostMenu.apply
    boundary used in GATO's own cost-menu tests. Widths follow its documented
    residuals; native GATO owns every shape/activation/rotation validation.
    """
    from tiago_mpc.record import to_dict
    from tiago_mpc.tiago import Q_START
    if cost_weights(to_dict(params.cost)) is not None:
        return
    nq = len(Q_START)
    nx, nu = 2 * nq, nq
    sizes = dict(x_des=nx, Q=nx, x_lower=nx, x_upper=nx, u_des=nu, R=nu, ub_lower=nu, ub_upper=nu,
                 ee_des=3, W=3, Ax=nx*nx, bx=nx, tx=nx, Wx=nx, lx_lower=nx, lx_upper=nx,
                 Au=nu*nu, bu=nu, tu=nu, Wu=nu, lu_lower=nu, lu_upper=nu, R_des=9, Wo=3,
                 v_des=6, Wv=6, v_lower=6, v_upper=6, cf_des=3, Wcf=3, cf_lower=3, cf_upper=3, eps=8)
    def discard(*args):
        pass
    upload = SimpleNamespace(**{name: discard for name in (
        "set_cost_menu_on", "set_cost_menu_field", "set_cost_menu_activation", "set_cost_menu_gravity_target")})
    lib = SimpleNamespace(COST_MENU_AVAILABLE=True, COST_MENU_FIELDS=sizes,
                          COST_MENU_TANGENT=False, NUM_COST_FRAMES=1)
    try:
        params.cost.apply(SimpleNamespace(lib=lib, N=params.N, batch_size=1, nq=nq, solver=upload))
    except ValueError as exc:
        raise ValueError(f"Invalid native CostMenu for N={params.N}: {exc}") from exc


def with_knot_count(params, n):
    """Resize the standard tracking menu along with its horizon, preserving weights."""
    if n == params.N:
        return params
    from tiago_mpc.costs import default_cost
    from tiago_mpc.record import to_dict
    values = cost_weights(to_dict(params.cost))
    if values is None:
        raise ValueError("Changing N for a custom CostMenu requires an explicit menu for the new horizon")
    return replace(params, N=n, cost=default_cost(n, **values))
