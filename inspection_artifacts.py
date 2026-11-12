"""Binary final trajectories from independent SQP caps, decoded one snapshot at a time."""
from __future__ import annotations

from collections.abc import Mapping
import json
from pathlib import Path

import numpy as np

# 1024 snapshots at N=32: about 2 MB of JSON and 0.7 s of CPU FK per chunk.
PATH_CHUNK_POINTS = 32768


def json_metadata(value):
    """Only small metadata/telemetry may use this conversion, never trace.xu."""
    if isinstance(value, Mapping):
        return {str(key): json_metadata(item) for key, item in value.items()}
    if isinstance(value, np.ndarray):
        return json_metadata(value.tolist())
    if isinstance(value, (list, tuple)):
        return [json_metadata(item) for item in value]
    if isinstance(value, np.generic):
        return json_metadata(value.item())
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def write_artifact(folder, snapshots, metadata):
    """Publish the seed and final trajectories of independent capped solves."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    count, n = int(snapshots.snapshot_count), int(metadata["N"])
    xu = np.asarray(snapshots.xu, dtype=np.float32)
    runs = metadata["runs"]
    if xu.shape != (count, 1, 21*n-7) or count < 2 or len(runs) != count-1:
        raise ValueError("Independent capped snapshots have an incompatible shape")
    if metadata.get("mode") != "independent_sqp_caps":
        raise ValueError("Inspection snapshots require independent_sqp_caps mode")
    for cap, run in enumerate(runs, 1):
        actual = run.get("actual_sqp_iters")
        if run.get("cap") != cap or type(actual) is not int or not 0 <= actual <= cap:
            raise ValueError("Independent capped solve metadata has an invalid cap or actual iteration count")
    if not np.isfinite(xu).all():
        raise ValueError("Independent capped snapshots contain nonfinite trajectories")
    binary = folder / "iterations.npz"
    with binary.open("xb") as stream:
        np.savez_compressed(stream, xu=xu)
    metadata = json_metadata(dict(metadata, snapshot_count=count, solves_run=count-1, max_sqp_cap=count-1,
                                  stop_reason="independent_caps_completed", format_version=2, coordinates="native"))
    path = folder / "metadata.json"
    with path.open("x") as stream:
        json.dump(metadata, stream, allow_nan=False, separators=(",", ":"))
    return dict(kind="inspection", id=metadata["id"], path=str(path), binary_path=str(binary),
                revision=metadata["id"], mode=metadata["mode"], snapshot_count=count,
                solves_run=count-1, max_sqp_cap=count-1, stop_reason=metadata["stop_reason"])


class ReadOnlyIterationTrace:
    """Cached binary arrays with on-demand native-coordinate prediction decoding.

    This object intentionally has no tolist method. The plotting SDK freezes
    only metadata; .prediction(index) decodes a single retained snapshot.
    """
    def __init__(self, descriptor, kinematics=None):
        from gato_visualizer.plotting.views import freeze
        self.metadata = freeze(json.loads(Path(descriptor["path"]).read_text()))
        with np.load(descriptor["binary_path"], allow_pickle=False) as archive:
            self._xu = archive["xu"]
        self._xu.flags.writeable = False
        self.kinematics = kinematics
        self._prediction_cache = {}
        self._path_chunk = None

    @property
    def snapshot_count(self):
        return int(self.metadata["snapshot_count"])

    @property
    def xu(self):
        # A view preserves the immutable base, including against setflags(True).
        value = self._xu.view()
        value.flags.writeable = False
        return value

    def summaries(self):
        result = [dict(index=0, status="Seed (cold state)", has_prediction=True, stats={})]
        for run in self.metadata["runs"]:
            cap, actual = run["cap"], run["actual_sqp_iters"]
            stats = dict(run["stats"], requested_sqp_cap=cap, actual_sqp_iters=actual,
                         stop_reason=run["stop_reason"], call_wall_s=run["call_wall_s"])
            for key, target in (("final_merit", "merit"), ("step_size", "step_size")):
                value = run.get("diagnostics", {}).get(key)
                if value is not None:
                    stats[target] = value[0] if isinstance(value, (list, tuple)) and len(value) == 1 else value
            result.append(dict(index=cap, status=f"SQP cap {cap} (ran {actual})", has_prediction=True, stats=stats))
        return result

    def prediction(self, index=None):
        from server import decode_prediction_telemetry
        from gato_visualizer.plotting.views import freeze
        index = self.snapshot_count-1 if index is None else 0 if index == "seed" else index
        if type(index) is not int or not 0 <= index < self.snapshot_count:
            return None
        if index not in self._prediction_cache:
            n, dt = self.metadata["N"], self.metadata["dt_s"]
            q, qd, u = decode_prediction_telemetry(self._xu[index], self.metadata["signs"], n)
            result = dict(q=q.tolist(), qd_rad_s=qd.tolist(), torque_nm=u.tolist(),
                          knot_time_s=(np.arange(n)*dt).tolist(), N=n, dt_s=dt,
                          torque_time_s=(np.arange(n-1)*dt).tolist(), torque_kind="predicted",
                          torque_end_time_s=(n-1)*dt)
            if self.kinematics is not None:
                result["ee_xyz"] = self.kinematics.ee_positions(q).tolist()
                result["reference_xyz"] = [self.kinematics.target_to_world(row[:3]).tolist()
                                           for row in self.metadata["reference_native"]]
            # Bound decoded snapshots as the user scrubs; binary is loaded once.
            self._prediction_cache = {index: freeze(result)}
        return self._prediction_cache[index]

    def path_chunk(self, index, max_points=PATH_CHUNK_POINTS):
        """End-effector paths of the aligned chunk of snapshots containing index.

        The 3D view scrubs through these without a request per iteration. Each
        chunk holds at most max_points knots, so long traces load piecewise.
        Coordinates are rounded to 1 µm for transport; plots keep full data.
        """
        if self.kinematics is None or type(index) is not int or not 0 <= index < self.snapshot_count:
            return None
        from server import decode_prediction_telemetry
        n = int(self.metadata["N"])
        size = max(1, int(max_points) // n)
        start = index // size * size
        stop = min(self.snapshot_count, start + size)
        if self._path_chunk is None or self._path_chunk["start"] != start:
            paths = []
            for i in range(start, stop):
                q, _, _ = decode_prediction_telemetry(self._xu[i], self.metadata["signs"], n)
                paths.append(np.round(self.kinematics.ee_positions(q), 6).tolist())
            self._path_chunk = dict(start=start, stop=stop, ee_xyz=paths)
        return self._path_chunk
