"""Convert a committed Live JSONL prefix to arguments for the producer exporter.

No solver, browser, FK or NPZ writer lives here. The selected tiago_mpc owns
save_replay; replay_format owns the same display limits as imported recordings.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import importlib
import json
import math
from pathlib import Path

import numpy as np

from replay_format import JOINT_NAMES, MAX_PREDICTIONS, MAX_TOTAL_SAMPLES, ReplayError, load_replay


def committed_records(reader, *, byte_end, cursor):
    """Read exactly the already-open committed prefix, never a concurrent append."""
    remaining, count = byte_end, 0
    while remaining:
        line = reader.readline(remaining)
        if not line or not line.endswith(b"\n"):
            raise ValueError("Committed Live history prefix is incomplete")
        remaining -= len(line)
        count += 1
        yield json.loads(line)
    if count != cursor:
        raise ValueError("Committed Live history prefix is incomplete")


def _stats(value):
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if isinstance(key, str) and
            (item is None or type(item) in (str, bool, int) or
             (type(item) is float and math.isfinite(item)))}


def freeze_arguments(records, *, generation, complete, fixed_joints, world_frame, label, frozen_at=None):
    """Pure history conversion; refuses unsupported frames and lossful truncation."""
    if world_frame not in ("base_footprint", "torso_lift_link"):
        raise ReplayError(f"Freeze reference frame is unsupported: {world_frame}")
    header, states, plans, breaches = None, [], [], []
    activations, plan_timing = {}, {}
    total_samples = 0
    for record in records:
        if not isinstance(record, dict) or record.get("generation") != generation:
            raise ReplayError("Freeze history generation does not match the current run")
        kind = record.get("type")
        if header is None:
            if kind != "segment" or not isinstance(record.get("context"), dict):
                raise ReplayError("Live history has no segment header; cannot freeze this run")
            header = record["context"]
        elif kind == "segment":
            raise ReplayError("Freeze history contains more than one segment header")
        if kind == "state":
            states.append(record)
            # A moving reference is saved at every state time too.
            total_samples += 2
        elif kind == "plan" and record.get("origin") != "preview":
            stats = _stats(record.get("stats"))
            if "available_time_s" in record:
                stats.update({key: record[key] for key in ("request_time_s", "available_time_s", "scheduled_activation_time_s", "solve_latency_s", "latency_overrun", "controller_wall_s") if key in record})
                stats["live_plan_seq"] = record["seq"]
            plan = dict(id=f"live-{record.get('seq', len(plans))}", origin_time_s=record.get("plan_origin_time_s", record["sim_time_s"]),
                        time_s=record["knot_time_s"], q=record["q"], stats=stats)
            for field in ("qd_rad_s", "torque_nm", "torque_time_s"):
                if record.get(field) is not None:
                    plan[field] = record[field]
            if "plan_origin_time_s" in record:
                plan_timing[plan["id"]] = {key: record[key] for key in (
                    "request_time_s", "plan_origin_time_s", "measured_time_s") if key in record}
            plans.append(plan)
            total_samples += len(plan["time_s"])
            if len(plans) > MAX_PREDICTIONS:
                raise ReplayError(f"Freeze exceeds the {MAX_PREDICTIONS} prediction display limit")
        elif kind == "control" and record.get("plan_seq") is not None:
            activations.setdefault(record["plan_seq"], record["sim_time_s"])
        elif kind == "breach":
            breaches.append(deepcopy(record))
        if total_samples > MAX_TOTAL_SAMPLES:
            raise ReplayError(f"Freeze exceeds the {MAX_TOTAL_SAMPLES} total sample display limit "
                              "(states, references and prediction knots); no data was dropped")
    if header is None:
        raise ReplayError("Live history has no segment header; cannot freeze this run")
    if len(states) < 2:
        raise ReplayError("Freeze needs at least two recorded states")
    for plan in plans:
        if "live_plan_seq" in plan["stats"]:
            # None preserves a requested solve that never actually commanded.
            plan["stats"]["activation_time_s"] = activations.get(plan["stats"]["live_plan_seq"])
    required = ("settings", "source", "simulator_identity", "solver_profile", "model_identity",
                "position_tol_m", "speed_l1_tol_rad_s", "problem_configuration", "end_effector_frame", "joint_limits")
    missing = [key for key in required if key not in header]
    if missing:
        raise ReplayError("Freeze segment header is missing " + ", ".join(missing))
    live = {key: deepcopy(header[key]) for key in required if key not in
            ("problem_configuration", "end_effector_frame", "joint_limits")}
    if "effective_settings" in header:
        live["effective_settings"] = deepcopy(header["effective_settings"])
    if plan_timing:
        live["plan_timing"] = plan_timing
    live.update(generation=generation, complete=bool(complete),
                frozen_at=frozen_at or datetime.now(timezone.utc).isoformat(), breaches=breaches)
    sent = [record for record in states if record.get("torque_nm") is not None]
    arguments = dict(time_s=np.asarray([record["sim_time_s"] for record in states]),
                     q=np.asarray([record["q"] for record in states]),
                     qd_rad_s=np.asarray([record["qd"] for record in states]),
                     joint_names=JOINT_NAMES, time_basis="simulation", label=label,
                     fixed_joints={name: value for name, value in fixed_joints.items() if name not in JOINT_NAMES},
                     end_effector_frame=header["end_effector_frame"], joint_limits=deepcopy(header["joint_limits"]),
                     reference_time_s=np.asarray([record["sim_time_s"] for record in states]),
                     reference_xyz_m=np.asarray([record["target_xyz"] for record in states]),
                     reference_frame=world_frame, plans=plans,
                     provenance=dict(params=deepcopy(header["problem_configuration"]), live=live))
    from live_mpc import orientation_goal
    goal = orientation_goal(header["settings"]["task"])
    if goal is not None:
        # The segment's orientation goal at every state time, a world-frame rotation vector.
        arguments["reference_rotvec_rad"] = np.tile(np.asarray(goal, dtype=float), (len(states), 1))
    collision = header.get("collision")  # None: rows off
    if collision is not None:
        # The segment's collision rows, as tiago_mpc's exporter records them: obstacles and
        # the environment (body cover, then obstacles) in ROOT_FRAME, the arm cover by link.
        arguments.update(obstacles=deepcopy(collision["obstacles"]),
                         collision_spheres=dict(environment=deepcopy(collision["body"] + collision["obstacles"]),
                                                arm=deepcopy(collision["arm"])))
        # Capsules, boxes and planes as tiago_mpc's exporter writes them: only when present;
        # so are the body cover's capsules and boxes.
        arguments.update({f"obstacle_{name}": deepcopy(collision[name])
                          for name in ("capsules", "boxes", "planes") if collision.get(name)})
        arguments.update({name: deepcopy(collision[name]) for name in ("body_capsules", "body_boxes")
                          if collision.get(name)})
    if sent:
        arguments.update(torque_nm=np.asarray([record["torque_nm"] for record in sent]),
                         torque_time_s=np.asarray([record["sim_time_s"] for record in sent]))
    return arguments


def export_freeze(path, records, *, mpc_root, model_urdf, save_replay=None, **context):
    """Call the selected, unchanged producer exporter; reject every format limit."""
    arguments = freeze_arguments(records, **context)
    if save_replay is None:
        from live_mpc import import_tiago
        root = Path(mpc_root).resolve()
        import_tiago(root)
        exporter = importlib.import_module("experiments.replay")
        if Path(exporter.__file__).resolve() != root / "experiments/replay.py":
            raise ReplayError("Replay exporter is not from the selected tiago_mpc checkout; restart the backend")
        save_replay = exporter.save_replay
    destination = Path(path)
    try:
        save_replay(destination, model_urdf=model_urdf, **arguments)
        # The producer intentionally has no visualizer display-size policy.
        # Validate compressed/expanded/metadata limits before catalog publication.
        load_replay(destination, model_urdf=model_urdf)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return destination
