"""Validate captured problems without importing GATO or guessing replay data."""
from copy import deepcopy
from collections.abc import Mapping
import math
import numpy as np


def detached(value):
    if isinstance(value, Mapping):
        return {key: detached(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [detached(item) for item in value]
    return deepcopy(value)


def captured_problem(plan):
    if not plan:
        raise ValueError("No retained solve is selected")
    required = ("initial_state", "reference_native", "problem_configuration", "joint_limits", "task", "constraint_bounds_native")
    missing = [key for key in required if not plan.get(key)]
    if missing:
        raise ValueError("Run again unavailable: selected solve lacks captured " + ", ".join(missing))
    config = detached(dict(plan["problem_configuration"]))
    if "solver_params" in config or "controller" in config:
        raise ValueError("Run again unavailable: pre-migration recording")
    if not isinstance(config.get("solver"), dict) or not isinstance(config.get("admm"), dict):
        raise ValueError("Run again unavailable: captured MpcParams are incomplete")
    n, dt = config.get("N"), config.get("dt_s")
    if type(n) is not int or n < 2 or isinstance(dt, bool) or not isinstance(dt, (int, float)) or not math.isfinite(dt) or dt <= 0:
        raise ValueError("Run again unavailable: captured horizon settings are incomplete")
    initial = detached(dict(plan["initial_state"]))
    state = np.asarray([*initial.get("q", []), *initial.get("qd", [])], dtype=float)
    if state.shape != (14,) or not np.isfinite(state).all():
        raise ValueError("Run again unavailable: captured native initial state requires q and qd")
    if isinstance(initial.get("time_s"), bool) or not isinstance(initial.get("time_s"), (int, float)) or not math.isfinite(initial["time_s"]):
        raise ValueError("Run again unavailable: captured task time is missing")
    reference = np.asarray(plan["reference_native"], dtype=float)
    if reference.shape != (n, 6) or not np.isfinite(reference).all():
        raise ValueError("Run again unavailable: exact native reference is missing or incompatible")
    limits = detached(dict(plan["joint_limits"]))
    for key in ("lower_position_rad", "upper_position_rad", "velocity_rad_s", "effort_nm"):
        array = np.asarray(limits.get(key), dtype=float)
        if array.shape != (7,) or not np.isfinite(array).all():
            raise ValueError("Run again unavailable: captured joint bounds are incomplete")
    if np.any(np.asarray(limits["lower_position_rad"]) >= limits["upper_position_rad"]):
        raise ValueError("Run again unavailable: captured position bounds are invalid")
    for key in ("velocity_rad_s", "effort_nm"):
        if np.any(np.asarray(limits[key]) <= 0):
            raise ValueError("Run again unavailable: captured symmetric bounds are invalid")
    constraints = detached(plan["constraint_bounds_native"])
    if not isinstance(constraints, (list, tuple)) or len(constraints) != 3:
        raise ValueError("Run again unavailable: exact installed constraint bounds are missing")
    for i, group in enumerate(constraints):
        if group.get("kind") != i or group.get("n_rows") != 7:
            raise ValueError("Run again unavailable: unsupported captured constraint topology")
        lo, hi = np.asarray(group.get("lo"), dtype=float), np.asarray(group.get("hi"), dtype=float)
        if lo.shape != (7,) or hi.shape != (7,) or not np.isfinite(lo).all() or not np.isfinite(hi).all() or np.any(lo > hi):
            raise ValueError("Run again unavailable: invalid captured constraint bounds")
        if len(group.get("active", [])) != n:
            raise ValueError("Run again unavailable: captured constraint activity mask is missing")
    return dict(constraint_bounds_native=constraints, initial_state=initial, reference_native=reference.tolist(), problem_configuration=config,
                joint_limits=limits, task=detached(dict(plan["task"])),
                original_model_identity=detached(dict(plan.get("model_identity", {}))),
                original_solver_profile=detached(dict(plan.get("solver_profile", {}))))


def run_again_capability(plan):
    try:
        captured_problem(plan)
    except (ValueError, TypeError, KeyError) as exc:
        return dict(available=False, reason=str(exc), initialization="cold_state")
    return dict(available=True, reason=None, initialization="cold_state")


def capture_constraint_bounds(solver, signs):
    """Retain the actual installed rows once after configuration, in native units."""
    result = []
    signs = np.asarray(signs)
    groups = solver.get_row_groups()
    if len(groups) != 3:
        raise ValueError("Inspection supports exactly the configured position/velocity/torque box rows")
    for i, group in enumerate(groups):
        if int(group["kind"]) != i or int(group["n_rows"]) != 7:
            raise ValueError("Unexpected configured constraint row topology")
        lo, hi = np.asarray(group["lo"]) * signs, np.asarray(group["hi"]) * signs
        native = deepcopy(dict(group))
        native["lo"], native["hi"] = np.minimum(lo, hi).tolist(), np.maximum(lo, hi).tolist()
        native["active"] = np.asarray(group["active"]).tolist()
        result.append(native)
    return result
