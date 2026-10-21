"""Validate captured problems without importing GATO or guessing replay data."""
from copy import deepcopy
import math
import numpy as np


def captured_problem(plan):
    if not plan:
        raise ValueError("No retained solve is selected")
    required = ("initial_state", "reference_native", "problem_configuration", "joint_limits", "task")
    missing = [key for key in required if not plan.get(key)]
    if missing:
        raise ValueError("Run again unavailable: selected solve lacks captured " + ", ".join(missing))
    config = deepcopy(dict(plan["problem_configuration"]))
    if not isinstance(config.get("solver_params"), dict) or not isinstance(config.get("controller"), dict):
        raise ValueError("Run again unavailable: captured solver/controller settings are incomplete")
    n, dt = config.get("N"), config.get("dt_s")
    if type(n) is not int or n < 2 or isinstance(dt, bool) or not isinstance(dt, (int, float)) or not math.isfinite(dt) or dt <= 0:
        raise ValueError("Run again unavailable: captured horizon settings are incomplete")
    initial = deepcopy(dict(plan["initial_state"]))
    state = np.asarray([*initial.get("q", []), *initial.get("qd", [])], dtype=float)
    if state.shape != (14,) or not np.isfinite(state).all():
        raise ValueError("Run again unavailable: captured native initial state requires q and qd")
    if isinstance(initial.get("time_s"), bool) or not isinstance(initial.get("time_s"), (int, float)) or not math.isfinite(initial["time_s"]):
        raise ValueError("Run again unavailable: captured task time is missing")
    reference = np.asarray(plan["reference_native"], dtype=float)
    if reference.shape != (n, 6) or not np.isfinite(reference).all():
        raise ValueError("Run again unavailable: exact native reference is missing or incompatible")
    limits = deepcopy(dict(plan["joint_limits"]))
    for key in ("lower_position_rad", "upper_position_rad", "velocity_rad_s", "effort_nm"):
        array = np.asarray(limits.get(key), dtype=float)
        if array.shape != (7,) or not np.isfinite(array).all():
            raise ValueError("Run again unavailable: captured joint bounds are incomplete")
    if np.any(np.asarray(limits["lower_position_rad"]) >= limits["upper_position_rad"]):
        raise ValueError("Run again unavailable: captured position bounds are invalid")
    for key in ("velocity_rad_s", "effort_nm"):
        if np.any(np.asarray(limits[key]) <= 0):
            raise ValueError("Run again unavailable: captured symmetric bounds are invalid")
    return dict(initial_state=initial, reference_native=reference.tolist(), problem_configuration=config,
                joint_limits=limits, task=deepcopy(dict(plan["task"])),
                original_model_identity=deepcopy(dict(plan.get("model_identity", {}))),
                original_solver_profile=deepcopy(dict(plan.get("solver_profile", {}))))


def run_again_capability(plan):
    try:
        captured_problem(plan)
    except (ValueError, TypeError, KeyError) as exc:
        return dict(available=False, reason=str(exc), initialization="cold_state")
    return dict(available=True, reason=None, initialization="cold_state")


def configuration_overrides(problem, sqp_iters):
    """Recreate all recorded solve settings; bounds are set explicitly afterwards."""
    effective = problem["problem_configuration"]
    result = {key: deepcopy(effective[key]) for key in ("N", "dt_s", "solver_params", "controller")}
    result["solver_params"]["max_sqp_iters"] = sqp_iters
    # Effective bounds have extra descriptive compiled offsets, which are not
    # input configuration keys. Native rows are overridden by captured bounds.
    result["limit_bounds"] = {key: value for key, value in effective.get("limit_bounds", {}).items()
                              if key in ("joint_margin_rad", "velocity_fraction", "effort_fraction") and value is not None}
    losses = effective.get("prediction_joint_dynamics")
    if losses is not None:
        result["joint_dynamics"] = deepcopy(losses)
        result["predictor_smoothing_rad_s"] = losses["smoothing_rad_s"]
    return result
