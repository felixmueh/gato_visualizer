"""CPU-only adapters for retained recordings; never construct an MPC solver."""
from __future__ import annotations

from copy import deepcopy
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import replace
import json
from pathlib import Path
import sys
from types import MappingProxyType
from gato_visualizer.plotting.views import freeze


CONTINUE_REASON = ("Exact continuation is unavailable because this solver does not expose "
                   "a resumable optimizer checkpoint.")
MAX_REPLAY_CACHE_BYTES = 256*1024*1024
MAX_REPLAY_CACHE_ITEMS = 16


def _retained_bytes(value, seen=None):
    """Bound the CPU replay cache by retained Python object size, sharing counted once."""
    seen = set() if seen is None else seen
    identity = id(value)
    if identity in seen:
        return 0
    seen.add(identity)
    size = sys.getsizeof(value)
    if isinstance(value, Mapping):
        size += sum(_retained_bytes(k, seen)+_retained_bytes(v, seen) for k, v in value.items())
    elif isinstance(value, (tuple, list)):
        if set(map(type, value)) <= {float, int, str, bool, type(None)}:
            # Conservative: shared scalar storage may be counted twice. Avoid a
            # recursive function/id/set lookup per cell of every numeric vector.
            size += sum(map(sys.getsizeof, value))
        else:
            size += sum(_retained_bytes(v, seen) for v in value)
    return size


def serializable(value):
    if isinstance(value, Mapping):
        return {key: serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serializable(item) for item in value]
    return value


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
        self.buckets = {name: [] for name in ("states", "plans", "intervals", "controls")}
        self.segment = None
        self.raw_cache = None
        self.cursor = self.offset = 0
        self.replay_cache = OrderedDict()
        self.replay_cache_sizes = {}
        self.replay_cache_bytes = 0
        self.preview_reader = None
        self.inspection_cache = {}
        self.numeric_channel_paths = set()

    def read(self, descriptor):
        if descriptor["kind"] == "inspection":
            identifier = descriptor["id"]
            if identifier not in self.inspection_cache:
                from inspection_artifacts import ReadOnlyIterationTrace
                from server import RobotKinematics
                # The source path and frame are actual inspection provenance.
                metadata = json.loads(Path(descriptor["path"]).read_text())
                models = metadata.get("model_snapshots")
                if models is not None:
                    import hashlib
                    folder = Path(descriptor["path"]).parent
                    paths = {}
                    for key in ("full", "reduced"):
                        filename = models[key]["filename"]
                        if Path(filename).name != filename:
                            raise ValueError("Invalid inspection model snapshot path")
                        path = folder / filename
                        if hashlib.sha256(path.read_bytes()).hexdigest() != models[key]["sha256"]:
                            raise ValueError("Inspection model snapshot changed")
                        paths[key] = path
                    kinematics = RobotKinematics(paths["full"], fixed_joints=metadata["fixed_joints"], reduced_urdf=paths["reduced"],
                        end_effector_frame=metadata["end_effector_frame"])
                else:
                    raise ValueError("Inspection result lacks captured FK models; current source geometry is not historical evidence")
                trace = ReadOnlyIterationTrace(descriptor, kinematics)
                plan = dict(metadata, id=identifier, origin="inspection", sim_time_s=None,
                            iterations=trace.summaries(), iteration_trace=trace)
                raw = freeze(dict(source=descriptor, states=[], plans=[plan], records=[],
                                  joint_limits=metadata["joint_limits"]))
                self.inspection_cache = {identifier: raw}
            return self.inspection_cache[identifier]
        if descriptor["kind"] == "live":
            identity = (descriptor["path"], descriptor["generation"])
            if identity != self.identity or descriptor["cursor"] < self.cursor:
                self.identity, self.records, self.cursor, self.offset = identity, [], 0, 0
                self.buckets = {name: [] for name in ("states", "plans", "intervals", "controls")}
                self.segment = self.raw_cache = None
                self.numeric_channel_paths = set()
            if not Path(descriptor["path"]).exists():
                # Only the current run is kept; a replaced generation's file is gone.
                raise ValueError("History changed; its run was replaced")
            with Path(descriptor["path"]).open("rb") as stream:
                stream.seek(self.offset)
                while self.cursor < descriptor["cursor"]:
                    line = stream.readline()
                    if not line or stream.tell() > descriptor["byte_end"]:
                        raise ValueError("Committed Live history prefix is incomplete")
                    record = freeze(json.loads(line))
                    if self.cursor == 0:
                        # The first record holds the segment's constant context.
                        if record.get("type") != "segment":
                            from history_store import NO_SEGMENT
                            raise ValueError(NO_SEGMENT)
                        self.segment = record["context"]
                    self.records.append(record)
                    bucket = {"state": "states", "plan": "plans", "interval": "intervals", "control": "controls"}.get(record.get("type"))
                    if bucket:
                        self.buckets[bucket].append(record)
                        from gato_visualizer.plotting.comparison import record_channel_paths
                        self.numeric_channel_paths.update(record_channel_paths(bucket, record))
                        if bucket == 'controls':
                            self.numeric_channel_paths.update(record_channel_paths('torque_samples', record))
                    self.raw_cache = None
                    self.cursor += 1
                self.offset = stream.tell()
            if self.raw_cache is None:
                self.raw_cache = freeze(dict(records=tuple(self.records), **self.buckets,
                                            numeric_channel_paths=tuple(sorted(self.numeric_channel_paths))))
            # Nested records are immutable shared snapshots. Only cheap outer
            # cursor/preview metadata changes between repeated evaluations.
            raw = dict(self.raw_cache, source=descriptor)
            if self.segment is not None:
                raw.update(segment=self.segment, joint_limits=self.segment.get("joint_limits"),
                           mpc_bounds=self.segment.get("mpc_bounds"))
            if raw["controls"]:
                raw["torque_samples"] = raw["controls"]
            # Physical (scene / URDF) limits. The segment carries the URDF limits plus mpc_bounds.
            raw["scene_joint_limits"] = (self.default_scene or {}).get("joint_limits") or {}
            # Preview is retained separately from executed episode history.
            if descriptor.get("preview_source"):
                if self.preview_reader is None:
                    self.preview_reader = SourceReader()
                raw["previews"] = self.preview_reader.read(descriptor["preview_source"])["plans"]
            if descriptor.get("preview"):
                raw["previews"] = [descriptor["preview"]]
            return freeze(raw)
        key = (descriptor.get("path"), descriptor.get("revision", "default"))
        comparison = descriptor.get('comparison', False)
        if comparison:
            key += ('comparison',)
        if key not in self.replay_cache:
            if descriptor.get("path"):
                from replay_format import load_replay
                from server import replay_scene
                path = Path(descriptor["path"])
                from replay_library import _signature
                if list(_signature(path)) != descriptor["signature"]:
                    raise ValueError("Replay changed; explicitly reload the selected recording")
                replay = load_replay(path, model_urdf=Path(self.mpc_root)/"models/tiago_pro/tiago_pro.urdf")
                # Comparison plots consume recorded execution and timed plan
                # statistics. Prediction geometry belongs to Episode/Solve and
                # must not be eagerly converted/FK'd/copied for every comparison.
                scene = replay_scene(replace(replay, predictions=()) if comparison else replay,
                                     path, self.mpc_root, self.default_scene)
                if list(_signature(path)) != descriptor["signature"]:
                    raise ValueError("Replay changed during loading; explicitly reload it")
                # Preserve all parsed replay metadata and original reference.
                scene["retained_replay"] = dict(metadata=replay.metadata,
                    reference=(None if replay.reference is None else dict(
                        xyz=replay.reference.xyz.tolist(), frame=replay.reference.frame,
                        time_s=None if replay.reference.time_s is None else replay.reference.time_s.tolist())))
                # Scene rendering can use canonical fallback bounds. Analysis
                # must distinguish those from actual historical bounds.
                scene["plot_recorded_joint_limits"] = replay.joint_limits or {}
            else:
                scene = self.default_scene
            raw = scene_records(scene)
            if comparison and descriptor.get('path'):
                origin = raw['time_origin_s']
                timing = raw['source'].get('provenance', {}).get('live', {}).get('plan_timing', {})
                raw['plans'] = [dict(id=plan.identifier, seq=plan.identifier,
                    label=plan.label, sim_time_s=timing.get(plan.identifier, {}).get('request_time_s', plan.origin_time_s)-origin,
                    recorded_origin_time_s=plan.origin_time_s, stats=plan.stats,
                    metadata=dict(origin_time_s=plan.origin_time_s, recorded_start_s=plan.origin_time_s,
                                  stats=plan.stats)) for plan in replay.predictions]
                raw['records'] = [*raw['states'], *raw['plans']]
                raw['recorded_prediction_count'] = len(replay.predictions)
            if comparison:
                from gato_visualizer.plotting.comparison import discover_channel_paths
                raw['numeric_channel_paths'] = discover_channel_paths(raw)
            captured = freeze(raw)
            size = _retained_bytes(captured)
            if size > MAX_REPLAY_CACHE_BYTES:
                return captured  # one large request may read it, but cannot retain it
            self.replay_cache[key] = captured
            self.replay_cache_sizes[key] = size
            self.replay_cache_bytes += size
            while len(self.replay_cache) > MAX_REPLAY_CACHE_ITEMS or self.replay_cache_bytes > MAX_REPLAY_CACHE_BYTES:
                removed, _ = self.replay_cache.popitem(last=False)
                self.replay_cache_bytes -= self.replay_cache_sizes.pop(removed)
        self.replay_cache.move_to_end(key)
        return self.replay_cache[key]


def comparison_source(reader, descriptor, request):
    """Capture each episode once; retain native clocks and expose session placement."""
    from gato_visualizer.plotting import ComparisonView, ComparisonRun, EpisodeView, InspectionContext
    from gato_visualizer.plotting.views import finite
    from gato_visualizer.plotting.comparison import intersect
    runs = []
    for entry in descriptor['runs']:
        error = None
        try:
            # Set the projection in the CPU worker too: a plotter reload is
            # sufficient even when the HTTP parent's class predates this hint.
            raw = reader.read(dict(entry['descriptor'], comparison=True))
            selected = entry['source'].get('trajectory_index')
            if selected is not None:
                trajectories = raw.get('trajectories', ())
                if selected >= len(trajectories) or trajectories[selected].get('kind') != 'recorded':
                    raise ValueError('Comparison requires recorded motion, not a prediction horizon')
                raw = dict(raw, states=tuple(s for s in raw.get('states', ()) if s.get('trajectory_index') == selected))
            # SourceReader's nested records are already immutable. A new
            # threshold/context envelope must not traverse/copy the episode.
            raw = MappingProxyType(dict(raw, limit_settings=freeze(request.get('limit_settings') or {})))
        except (ValueError, OSError) as exc:
            raw, error = dict(states=[]), str(exc)
        episode = EpisodeView(raw)
        if not episode.all_states and error is None:
            error = 'No recorded episode states'
        runs.append(ComparisonRun(entry['key'], entry['label'], episode, entry['offset_s'], entry['color'], entry['source'], error))
    analysis = request.get('range') or {}
    clock = 'session:'+str(request.get('client_id', 'comparison'))
    context = InspectionContext(episode_cursor_s=analysis.get('cursor_s'), analysis_range=analysis.get('mode', 'entire'),
        visible_window=((analysis.get('start_s'), analysis.get('end_s')) if analysis.get('mode') in ('window', 'visible') else None), clock=clock)
    view = ComparisonView(tuple(runs), context)
    details = []
    for run in runs:
        bounds = view.run_bounds(run)
        metadata = run.metadata
        scene = run.episode.raw.get('scene', {})
        source = scene.get('source', {})
        details.append(dict(key=run.key, label=run.label, color=run.color, source=serializable(run.source), offset_s=run.offset_s,
            bounds=run.bounds, analysis_bounds=bounds, episode_available=run.error is None and run.bounds is not None,
            coverage_s=max(0., bounds[1]-bounds[0]) if bounds else 0., error=run.error,
            time_origin_s=run.episode.raw.get('time_origin_s', 0),
            time_basis=metadata.get('time_basis', 'simulation' if run.source.get('kind') == 'live' else source.get('time_basis')),
            end_effector_frame=metadata.get('end_effector_frame', source.get('end_effector_frame')),
            outcome=serializable(metadata.get('outcome', metadata.get('provenance', {}).get('outcome'))),
            provenance=serializable(metadata.get('provenance', source.get('provenance', {})))))
    return view, serializable(dict(clock=clock, bounds=view.bounds, common_bounds=view.common_bounds,
                      usable_runs=len(view.available_runs), runs=details, channels=list(view.channels), joint_names=list(runs[0].episode.joint_names) if runs else []))


def scene_records(scene):
    """Normalize the existing scene contract while preserving original fields."""
    raw = dict(scene=scene, source=scene.get("source", {}),
               joint_names=scene.get("joint_names", [f"arm_right_{i}_joint" for i in range(1, 8)]),
               joint_limits=scene.get("plot_recorded_joint_limits", scene.get("joint_limits")) or {},
               scene_joint_limits=scene.get("joint_limits") or {},
               mpc_bounds=scene.get("mpc_bounds"),
               states=[], plans=[], intervals=[], records=[], trajectories=scene.get("trajectories", []))
    recorded = next((t for t in raw["trajectories"] if t.get("kind") == "recorded"), None)
    origin = recorded["time_s"][0] if recorded and recorded.get("time_s") else 0
    raw["time_origin_s"] = origin
    provenance = raw["source"].get("provenance", {})
    retained_live = provenance.get("live", {})
    plan_timing = retained_live.get("plan_timing", {})
    for trajectory_index, trajectory in enumerate(raw["trajectories"]):
        if trajectory.get("kind") == "prediction":
            plan = dict(trajectory)
            metadata = plan.get("metadata", {})
            original_time = metadata.get("origin_time_s", metadata.get("recorded_start_s"))
            plan.update(id=plan.get("id", str(trajectory_index)), trajectory_index=trajectory_index,
                        recorded_origin_time_s=original_time,
                        sim_time_s=None if original_time is None else original_time-origin,
                        knot_time_s=plan.get("time_s", []), stats=metadata.get("stats", {}))
            timing = plan_timing.get(plan["id"], {})
            for field in ("plan_origin_time_s", "measured_time_s"):
                if field in timing:
                    plan[field] = timing[field]-origin
            if "request_time_s" in timing:
                plan["sim_time_s"] = plan["request_time_s"] = timing["request_time_s"]-origin
            if "activation_time_s" in plan["stats"]:
                activation = plan["stats"]["activation_time_s"]
                plan["activation_time_s"] = None if activation is None else activation-origin
            if "diagnostics" in plan["stats"]:
                plan["diagnostics"] = plan["stats"]["diagnostics"]
            if "iterations" in plan["stats"]:
                plan["iterations"] = plan["stats"]["iterations"]
            captured = retained_live.get("inspection_inputs", {}).get(plan["id"])
            if captured is not None:
                plan.update(retained_live["inspection_context"])
                plan.update(captured, problem_configuration=provenance["params"])
            raw["plans"].append(plan)
            plan["joint_limits"] = raw["joint_limits"]
            plan["mpc_bounds"] = raw["mpc_bounds"]
        elif trajectory.get("kind") == "recorded":
            # References retain their own clock, rather than positional zip.
            # Interpolate each axis once: per-state column rebuilding was
            # quadratic and timed out the plot worker on long recordings.
            reference_time, reference = trajectory.get("reference_time_s"), trajectory.get("reference_xyz")
            targets = None
            if reference_time is not None and reference is not None:
                import numpy as np
                targets = np.stack([np.interp(trajectory.get("time_s", []), reference_time,
                                              [p[axis] for p in reference]) for axis in range(3)], axis=1).tolist()
            for i, time_s in enumerate(trajectory.get("time_s", [])):
                state = dict(type="state", sim_time_s=time_s-origin, recorded_time_s=time_s,
                             trajectory_index=trajectory_index)
                for field in ("q", "qd_rad_s", "ee_xyz", "orientation_error_rad"):
                    values = trajectory.get(field)
                    if values is not None and i < len(values) and values[i] is not None:
                        state[field] = values[i]
                if targets is not None:
                    state["target_xyz"] = targets[i]
                raw["states"].append(state)
            if trajectory.get("torque_nm") is not None:
                raw.setdefault("torque_samples", []).extend(
                    dict(sim_time_s=t-origin, recorded_time_s=t, torque_nm=u) for t, u in
                    zip(trajectory.get("torque_time_s", trajectory.get("time_s", [])), trajectory["torque_nm"]))
    raw["records"] = [*raw["states"], *raw["plans"]]
    return raw


def _column(value):
    if value is None:
        return []
    return [row[0] if isinstance(row, (list, tuple)) and len(row) == 1 else row for row in value]


def solve_iterations(plan):
    if "iterations" in plan:
        return [dict(item) for item in plan["iterations"]]
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
        value = str(plan.get("id", plan.get("seq")))
        return f"preview:{value}" if plan.get("origin") == "preview" else value
    if selection.get("solve_id") is not None:
        selected = next((p for p in [*plans, *raw.get("previews", [])]
                         if identity(p) == str(selection["solve_id"])), None)
        if selected is None:
            raise ValueError("Selected solve is not retained in this source")
        association = "explicit"
    elif selection.get("trajectory_index") is not None and any(
            p.get("trajectory_index") == selection["trajectory_index"] for p in plans):
        selected = next((p for p in plans if p.get("trajectory_index") == selection["trajectory_index"]), None)
        association = "explicit trajectory"
    elif (raw.get("source", {}).get("kind") == "inspection" and plans
          and selection.get("trajectory_index") is None):
        # A standalone result has its own Solve identity and no episode clock.
        # The browser retains the original episode cursor while switching only
        # the Solve inspector source, so that cursor cannot associate this plan.
        selected, association = plans[0], "standalone solve"
    elif plans:
        cursor = analysis.get("cursor_s")
        states = raw.get("states", [])
        state = next((s for s in reversed(states) if cursor is not None and s.get("sim_time_s", 0) <= cursor), None)
        seq = (state or {}).get("plan_seq")
        control = next((c for c in reversed(raw.get("controls", []))
                        if cursor is not None and c.get("sim_time_s", 0) <= cursor), None)
        if control is not None and (state is None or control["sim_time_s"] >= state["sim_time_s"]):
            seq = control.get("plan_seq", seq)
        if seq is not None:
            selected = next((p for p in plans if p.get("seq") == seq), None)
            association = "recorded"
        if selected is None and cursor is not None and not (state is not None and "control_updates" in state):
            selected = next((p for p in reversed(plans)
                             if p.get("activation_time_s", p.get("sim_time_s")) is not None
                             and p.get("activation_time_s", p.get("sim_time_s")) <= cursor
                             and "available_time_s" not in p), None)
            association = "timestamp fallback"
        elif selected is None and cursor is None:
            selected, association = plans[-1], "latest available (no episode cursor)"
    elif raw.get("previews"):
        selected, association = raw["previews"][-1], "preview"
    info = dict(episode_available=bool(raw.get("states")), selected_solve=None, association=association)
    if selected is not None:
        # A Live plan takes its constant context from its segment header.
        selected = dict(raw.get("segment") or {}, **selected)
        selected["id"] = identity(selected)
        selected["iterations"] = solve_iterations(selected)
        from inspection_problem import run_again_capability
        trace = selected.get("iteration_trace")
        iteration = selection.get("iteration", selection.get("iteration_index"))
        prediction = trace.prediction(iteration) if trace is not None else None
        final = ({k: selected[k] for k in ("q", "ee_xyz", "knot_time_s", "reference_xyz") if k in selected}
                 if trace is None else prediction if iteration is None else {})
        info["selected_solve"] = dict(id=selected["id"], time_s=selected.get("sim_time_s"),
            origin=selected.get("origin", "recorded"), iterations=selected["iterations"],
            final_prediction=final, selected_prediction=prediction, selected_iteration=iteration,
            stats=selected.get("stats", {}),
            provenance=({key: selected.get(key) for key in ("original", "initialization", "requested",
                "mode", "snapshot_count", "solves_run", "max_sqp_cap", "stop_reason", "solver_profile", "model_identity",
                "original_solver_profile", "original_model_identity")} if trace is not None else None),
            capabilities=dict(continue_sqp=False, continue_reason=CONTINUE_REASON,
                run_again=run_again_capability(selected),
                iteration_predictions=trace is not None or any(i.get("prediction") is not None for i in selected["iterations"]),
                iteration_paths=trace is not None))
    return selected, serializable(info)
