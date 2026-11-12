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


def replay_problem(plan, scene):
    """Build a cold inspection from saved predictions and the recorded task.

    References extend beyond the episode's last state: regenerate the task at
    the prediction's actual knot times instead of holding the last recorded target.
    The saved first prediction knot supplies q/qd, not an optimizer checkpoint.
    """
    provenance = scene.get("source", {}).get("provenance", {})
    live = provenance.get("live", {})
    profile = live.get("solver_profile", {})
    task = live.get("settings", {}).get("task", {})
    recorded = next((item for item in scene.get("trajectories", ()) if item.get("kind") == "recorded"), {})
    try:
        origin = plan["metadata"]["origin_time_s"]
        times = np.asarray(plan["knot_time_s"], dtype=float)
        source_time = recorded["reference_time_s"][0]
        source_xyz = np.asarray(recorded["reference_xyz"][0], dtype=float)
        transform = np.asarray(profile["coordinate_contract"]["world_from_reference"], dtype=float)
        if transform.shape != (4, 4) or not np.isfinite(transform).all():
            raise ValueError("invalid recorded reference transform")
        if task["kind"] == "reach":
            world = np.tile(source_xyz, (len(times), 1))
        elif task["kind"] == "figure8":
            from live_mpc import figure8_reference
            # The episode may start at a nonzero phase after a continuation.
            anchor = source_xyz - figure8_reference([source_time], [0., 0., 0.], task)[0]
            world = figure8_reference(origin + times, anchor, task)
        else:
            raise ValueError("unsupported recorded task")
        reference = np.full((len(times), 6), np.nan)
        reference[:, :3] = (world - transform[:3, 3]) @ transform[:3, :3]
        from live_mpc import orientation_goal
        goal = orientation_goal(task)
        if goal is not None:
            import pinocchio as pin
            reference[:, 3:] = pin.log3(transform[:3, :3].T @ pin.exp3(np.asarray(goal, dtype=float)))
        from solver_process import reference_to_wire
        initial = dict(q=plan["q"][0], qd=plan["qd_rad_s"][0], time_s=origin,
                       measured_time_s=live.get("plan_timing", {}).get(plan["id"], {}).get("measured_time_s", origin))
        return dict(plan, initial_state=initial, reference_native=reference_to_wire(reference),
                    problem_configuration=provenance["params"], joint_limits=scene["joint_limits"], task=task,
                    constraint_bounds_native=profile["predictor"]["constraint_bounds_native"],
                    model_identity=live["model_identity"], solver_profile=profile)
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise ValueError(f"Run again unavailable: saved prediction or task context is incomplete ({error})") from error


def captured_problem(plan, *, replay_scene=None):
    if not plan:
        raise ValueError("No retained solve is selected")
    if replay_scene is not None:
        plan = replay_problem(plan, replay_scene)
    required = ("initial_state", "reference_native", "problem_configuration", "joint_limits", "task", "constraint_bounds_native")
    missing = [key for key in required if not plan.get(key)]
    if missing:
        raise ValueError("Run again unavailable: selected solve lacks captured " + ", ".join(missing))
    config = detached(dict(plan["problem_configuration"]))
    if config.get("type") != "MpcParams" or "solver_params" in config or "controller" in config:
        raise ValueError("Run again unavailable: pre-migration recording")
    if isinstance(config.get("solver"), dict) and config["solver"].get("type") == "SolverParams":
        raise ValueError("Run again unavailable: recording uses the previous cost API; "
                         "view its recorded motion or use its original tiago_mpc checkout")
    if (not isinstance(config.get("solver"), dict) or config["solver"].get("type") != "SolverSettings"
            or not isinstance(config.get("cost"), dict) or config["cost"].get("type") != "CostMenu"
            or not isinstance(config.get("admm"), dict) or config["admm"].get("type") != "AdmmLimits"):
        raise ValueError("Run again unavailable: captured MpcParams are incomplete")
    if ("friction_law" not in config or
            isinstance(config.get("friction"), dict) and "law" in config["friction"]):
        raise ValueError("Run again unavailable: recording uses the previous friction API; "
                         "view its recorded motion or use its original tiago_mpc checkout")
    n, dt = config.get("N"), config.get("dt_s")
    if type(n) is not int or n < 2 or isinstance(dt, bool) or not isinstance(dt, (int, float)) or not math.isfinite(dt) or dt <= 0:
        raise ValueError("Run again unavailable: captured horizon settings are incomplete")
    initial = detached(dict(plan["initial_state"]))
    state = np.asarray([*initial.get("q", []), *initial.get("qd", [])], dtype=float)
    if state.shape != (14,) or not np.isfinite(state).all():
        raise ValueError("Run again unavailable: captured native initial state requires q and qd")
    if isinstance(initial.get("time_s"), bool) or not isinstance(initial.get("time_s"), (int, float)) or not math.isfinite(initial["time_s"]):
        raise ValueError("Run again unavailable: captured task time is missing")
    measured = initial.get("measured_time_s", initial["time_s"])
    if (isinstance(measured, bool) or not isinstance(measured, (int, float))
            or not math.isfinite(measured) or measured > initial["time_s"]):
        raise ValueError("Run again unavailable: invalid captured observation time")
    from solver_process import reference_from_wire
    try:
        reference_from_wire(plan["reference_native"], n)  # a null orientation slot: no target
    except ValueError as error:
        raise ValueError("Run again unavailable: exact native reference is missing or incompatible") from error
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
    return dict(constraint_bounds_native=constraints, initial_state=initial, reference_native=detached(plan["reference_native"]), problem_configuration=config,
                joint_limits=limits, task=detached(dict(plan["task"])),
                original_model_identity=detached(dict(plan.get("model_identity", {}))),
                original_solver_profile=detached(dict(plan.get("solver_profile", {}))))


def run_again_capability(plan, *, replay_scene=None):
    try:
        captured_problem(plan, replay_scene=replay_scene)
    except (ValueError, TypeError, KeyError) as exc:
        return dict(available=False, reason=str(exc), initialization="cold_state")
    return dict(available=True, reason=None, initialization="cold_state")


# gato.rowkinds.KIND_COLLISION: GATO's collision clearance rows (tiago_mpc's
# MpcParams.collision), appended after the three limit groups.
COLLISION_KIND = 5


def capture_constraint_bounds(solver):
    """Retain the actual installed limit rows once after configuration, in native units.

    A collision row group may follow them. It is not captured here: MpcParams.collision
    in the captured problem configuration installs it again, with its environment."""
    result = []
    groups = solver.get_row_groups()
    if len(groups) < 3 or any(int(group["kind"]) != COLLISION_KIND for group in groups[3:]):
        raise ValueError("Inspection supports exactly the configured position/velocity/torque box rows"
                         " and collision rows")
    for i, group in enumerate(groups[:3]):
        if int(group["kind"]) != i or int(group["n_rows"]) != 7:
            raise ValueError("Unexpected configured constraint row topology")
        native = deepcopy(dict(group))
        native["lo"], native["hi"] = np.asarray(group["lo"]).tolist(), np.asarray(group["hi"]).tolist()
        native["active"] = np.asarray(group["active"]).tolist()
        result.append(native)
    return result
