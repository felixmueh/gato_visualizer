"""CPU-only adapters for retained recordings; never construct an MPC solver."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path


CONTINUE_REASON = ("Exact Continue SQP is unavailable: the current GATO public API does not expose "
                   "optimizer checkpoint/restore/resume or per-SQP trajectory snapshots. "
                   "A new warm-seeded invocation is a different solve.")


class SourceReader:
    """Incrementally read the committed JSONL prefix and cache replay conversion.

    Only the plot subprocess owns this cache. It reads a separate file handle,
    never a solver/history-store lock. Superseded history files remain retained.
    """
    def __init__(self, mpc_root=None, default_scene=None):
        self.mpc_root = mpc_root
        self.default_scene = default_scene
        self.identity = None
        self.records = []
        self.cursor = self.offset = 0
        self.replay_cache = {}

    def read(self, descriptor):
        if descriptor["kind"] == "live":
            identity = (descriptor["path"], descriptor["generation"])
            if identity != self.identity or descriptor["cursor"] < self.cursor:
                self.identity, self.records, self.cursor, self.offset = identity, [], 0, 0
            with Path(descriptor["path"]).open("rb") as stream:
                stream.seek(self.offset)
                while self.cursor < descriptor["cursor"]:
                    line = stream.readline()
                    if not line or stream.tell() > descriptor["byte_end"]:
                        raise ValueError("Committed Live history prefix is incomplete")
                    self.records.append(json.loads(line))
                    self.cursor += 1
                self.offset = stream.tell()
            records = self.records
            raw = dict(records=records, states=[r for r in records if r.get("type") == "state"],
                       plans=[r for r in records if r.get("type") == "plan"],
                       intervals=[r for r in records if r.get("type") == "interval"],
                       controls=[r for r in records if r.get("type") == "control"],
                       source=descriptor)
            if raw["plans"]:
                raw["joint_limits"] = raw["plans"][0].get("joint_limits")
            # Preview is retained separately from executed episode history.
            if descriptor.get("preview"):
                raw["previews"] = [descriptor["preview"]]
            return raw
        key = (descriptor.get("path"), descriptor.get("revision", "default"))
        if key not in self.replay_cache:
            if descriptor.get("path"):
                from replay_format import load_replay
                from server import replay_scene
                path = Path(descriptor["path"])
                from replay_library import _signature
                if list(_signature(path)) != descriptor["signature"]:
                    raise ValueError("Replay changed; explicitly reload the selected recording")
                replay = load_replay(path, model_urdf=Path(self.mpc_root)/"models/tiago_pro/tiago_pro.urdf")
                scene = replay_scene(replay, path, self.mpc_root, self.default_scene)
                if list(_signature(path)) != descriptor["signature"]:
                    raise ValueError("Replay changed during loading; explicitly reload it")
                # Preserve all parsed replay metadata and original reference.
                scene["retained_replay"] = dict(metadata=replay.metadata,
                    reference=(None if replay.reference is None else dict(
                        xyz=replay.reference.xyz.tolist(), frame=replay.reference.frame,
                        time_s=None if replay.reference.time_s is None else replay.reference.time_s.tolist())))
            else:
                scene = self.default_scene
            raw = scene_records(scene)
            self.replay_cache = {key: raw}  # bounded to the selected recording
        return self.replay_cache[key]


def scene_records(scene):
    """Normalize the existing scene contract while preserving original fields."""
    raw = dict(scene=scene, source=scene.get("source", {}), joint_limits=scene.get("joint_limits"),
               states=[], plans=[], intervals=[], records=[], trajectories=scene.get("trajectories", []))
    for trajectory_index, trajectory in enumerate(raw["trajectories"]):
        if trajectory.get("kind") == "prediction":
            plan = dict(trajectory)
            metadata = plan.get("metadata", {})
            plan.update(id=plan.get("id", str(trajectory_index)), trajectory_index=trajectory_index,
                        sim_time_s=metadata.get("origin_time_s", metadata.get("recorded_start_s")),
                        knot_time_s=plan.get("time_s", []), stats=metadata.get("stats", {}))
            raw["plans"].append(plan)
        elif trajectory.get("kind") == "recorded":
            for i, time_s in enumerate(trajectory.get("time_s", [])):
                state = dict(type="state", sim_time_s=time_s, trajectory_index=trajectory_index)
                for field in ("q", "qd_rad_s", "ee_xyz"):
                    values = trajectory.get(field)
                    if values is not None and i < len(values):
                        state[field] = values[i]
                # References retain their own clock, rather than positional zip.
                reference_time, reference = trajectory.get("reference_time_s"), trajectory.get("reference_xyz")
                if reference_time is not None and reference is not None:
                    import numpy as np
                    state["target_xyz"] = [float(np.interp(time_s, reference_time,
                                                          [p[axis] for p in reference])) for axis in range(3)]
                raw["states"].append(state)
            if trajectory.get("torque_nm") is not None:
                raw.setdefault("torque_samples", []).extend(
                    dict(sim_time_s=t, torque_nm=u) for t, u in
                    zip(trajectory.get("torque_time_s", trajectory.get("time_s", [])), trajectory["torque_nm"]))
    raw["records"] = [*raw["states"], *raw["plans"]]
    return raw


def _column(value):
    if value is None:
        return []
    return [row[0] if isinstance(row, (list, tuple)) and len(row) == 1 else row for row in value]


def solve_iterations(plan):
    if "iterations" in plan:
        return deepcopy(plan["iterations"])
    diagnostics = plan.get("diagnostics", {})
    pcg = _column(diagnostics.get("pcg_iters"))
    merit = _column(diagnostics.get("min_merit"))
    step = _column(diagnostics.get("step_size"))
    # Metrics are returned only for actual recorded native rows. Missing rows
    # remain absent, including SQP shortcuts which never reached line search.
    result = []
    for i in range(max(len(pcg), len(merit), len(step))):
        stats = {}
        for name, values in (("pcg_iters", pcg), ("merit", merit), ("step_size", step)):
            if i < len(values):
                stats[name] = values[i]
        status = "rejected" if stats.get("step_size") == -1 else "recorded metrics"
        if stats.get("pcg_iters") == 0:
            status = "zero-PCG shortcut"
        result.append(dict(index=i+1, stats=stats, status=status, has_prediction=False))
    return result


def inspect_source(raw, selection=None, analysis=None):
    selection, analysis = selection or {}, analysis or {}
    plans = raw.get("plans", [])
    selected = None
    association = None
    def identity(plan):
        return str(plan.get("id", plan.get("seq")))
    if selection.get("solve_id") is not None:
        selected = next((p for p in [*plans, *raw.get("previews", [])]
                         if identity(p) == str(selection["solve_id"])), None)
        if selected is None:
            raise ValueError("Selected solve is not retained in this source")
        association = "explicit"
    elif selection.get("trajectory_index") is not None:
        selected = next((p for p in plans if p.get("trajectory_index") == selection["trajectory_index"]), None)
        association = "explicit trajectory"
    elif plans:
        cursor = analysis.get("cursor_s")
        states = raw.get("states", [])
        state = next((s for s in reversed(states) if cursor is not None and s.get("sim_time_s", 0) <= cursor), None)
        seq = (state or {}).get("plan_seq")
        if seq is not None:
            selected = next((p for p in plans if p.get("seq") == seq), None)
            association = "recorded"
        if selected is None and cursor is not None:
            selected = next((p for p in reversed(plans) if p.get("sim_time_s") is not None and p["sim_time_s"] <= cursor), None)
            association = "timestamp fallback"
        elif selected is None:
            selected, association = plans[-1], "latest available (no episode cursor)"
    elif raw.get("previews"):
        selected, association = raw["previews"][-1], "preview"
    info = dict(episode_available=bool(raw.get("states")), selected_solve=None, association=association)
    if selected is not None:
        selected = dict(selected)
        selected["id"] = identity(selected)
        selected["iterations"] = solve_iterations(selected)
        info["selected_solve"] = dict(id=selected["id"], time_s=selected.get("sim_time_s"),
            origin=selected.get("origin", "recorded"), iterations=selected["iterations"],
            final_prediction={k: selected[k] for k in ("q", "ee_xyz", "knot_time_s", "reference_xyz") if k in selected},
            stats=selected.get("stats", {}), capabilities=dict(continue_sqp=False, continue_reason=CONTINUE_REASON,
                iteration_predictions=any(i.get("prediction") is not None for i in selected["iterations"])))
    return selected, info
