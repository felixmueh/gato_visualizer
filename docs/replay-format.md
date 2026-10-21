# Portable replay NPZ v1

Export one compressed `.npz` from the experiment, then upload it from the
laptop or place it anywhere below the configured `ingest_directory` on the
server. The Replay library discovers nested files when the browser polls it.
Selecting a recording loads a snapshot; later catalog changes do not replace
that snapshot. Use Reload to load a changed recording.

## Export from tiago_mpc

The single exporter lives in **`tiago_mpc/experiments/tools.py`**, on the
producer side. It needs only NumPy and Python's standard library. From the
`tiago_mpc` checkout, an experiment can call:

```python
from pathlib import Path
import numpy as np
from experiments.tools import JOINT_NAMES, save_replay

save_replay(
    Path("../_expr_data/ingest/my-study/replay.npz"),
    time_s=np.asarray(times),               # actual saved sample timestamps
    q=np.asarray(native_states)[:, :7],    # native right-arm radians
    joint_names=JOINT_NAMES,
    model_urdf=Path("models/tiago_pro/tiago_pro.urdf"),
    time_basis="simulation",              # use "wall" for wall-clock samples
    label="My reaching run",
    reference_xyz_m=target_xyz,            # optional static position
    reference_frame="torso_lift_link",    # frame of target_xyz
)
```

`model_urdf` identifies the full model used to display the recording;
its SHA-256 is computed by the helper. Omitting this argument uses the main
`tiago_mpc` canonical full model. Export to a fresh result path: the helper
writes a temporary file and atomically replaces its destination on success.
The viewer refuses a different model identity, rather than substituting a model.
Exporting does not alter the experiment or existing recordings.

For retained historical runs, establish native joint/frame compatibility
before selecting a newer display model. Preserve original full/reduced model
hashes, dynamics settings, source paths/commits, configuration and outcomes in
the optional `provenance` JSON object; a display model hash does not replace
the original experiment identity. For example, pass
`provenance={"source_directory": "_expr_data/my-study", "source_commit": commit,
"source_model_sha256": original_hash, "outcome": original_outcome}`.
The viewer retains this object at `scene.source.provenance` without duplicating
it in every trajectory. Provenance values must be finite JSON.

For a moving reference, add `reference_time_s` and pass an `(R, 3)` array as
`reference_xyz_m`. Each timestamp uses the same clock as `time_s`. References
are linearly interpolated, holding the nearest endpoint outside their range.
Optional `fixed_joints={"torso_lift_joint": 0.15}` records static context in
native metres/radians. The viewer's resting left-arm display remains the
default unless explicitly overridden.

Optional predictions are native trajectories with their own knot times:

```python
save_replay(
    "../_expr_data/ingest/my-study/replay-with-plan.npz",
    time_s=times, q=native_q, joint_names=JOINT_NAMES,
    time_basis="simulation",
    reference_xyz_m=target_xyz, reference_frame="torso_lift_link",
    plans=[{
        "origin_time_s": 0.12,             # recording clock when planned
        "time_s": np.arange(len(plan_q)) * knot_dt_s,  # offsets from origin
        "q": plan_q,                      # same native joint_names order
        "label": "Plan at 0.12 s",
        "stats": {"sqp_iters": 5, "pcg_iters": 120},  # optional finite JSON
    }],
)
```

Each plan can also supply `id`, `reference_xyz_m`, `reference_time_s` and
`reference_frame`. Its reference times are offsets from its origin. A plan
without its own reference uses the recording reference over that horizon.
Convert GPU predictions to native coordinates in the experiment before
exporting; the format contains no GPU signs, packed states or controls.

## Archive fields

Load with `np.load(path, allow_pickle=False)`. Required arrays:

| Key | Shape | Meaning |
| --- | --- | --- |
| `metadata_json` | Unicode scalar | JSON object below |
| `time_s` | `(T,)`, T ≥ 2 | Finite, nonnegative, strictly increasing timestamps |
| `q` | `(T, 7)` | Finite native joint positions, in metadata joint order |

Required metadata:

```json
{
  "format": "tiago-replay",
  "version": 1,
  "joint_names": ["arm_right_1_joint", "arm_right_2_joint", "arm_right_3_joint", "arm_right_4_joint", "arm_right_5_joint", "arm_right_6_joint", "arm_right_7_joint"],
  "model_sha256": "SHA-256 of the canonical full URDF bytes",
  "time_basis": "simulation"
}
```

`time_basis` is `simulation` or `wall`. Joint ordering may differ; the viewer
requires all seven names exactly once and normalizes the order. Samples are
never sorted, repaired or dropped; finite joint-limit violations remain visible.
Optional metadata: `label`, `fixed_joints`, `reference_frame`, `predictions`,
`provenance` (a JSON object).
References require `reference_frame` to be `base_footprint` or
`torso_lift_link`; the full model and fixed posture determine the transform.

A static reference uses `reference_xyz_m` with shape `(3,)`. A moving reference
uses both `reference_time_s` `(R,)` and `reference_xyz_m` `(R, 3)` (R ≥ 1).

`predictions` is a list of descriptors with required `origin_time_s`,
`time_key`, `q_key`, and optional `id`, `label`, `stats`, `reference_xyz_key`,
`reference_time_key`, `reference_frame`. Keys name arrays inside the same
archive; prediction timestamps are nonnegative, strictly increasing offsets
from the explicit origin, and each plan has at least two samples. A plan's
reference follows the same static/moving array shapes. No solver dt is inferred.

The viewer accepts at most 64 MiB compressed, 256 MiB expanded, 1 MiB of JSON
metadata, 1,024 prediction descriptors and 200,000 total trajectory/reference
samples. Excess files receive an explicit error; samples are not filtered.
Object arrays and malformed NPY headers are rejected before loading.

## Library and uploads

`visualizer.json` selects the recursively scanned ingest directory, default
`../_expr_data/ingest` relative to the visualizer checkout: the shared
`impl/_expr_data/ingest` on the host or `/workspace/_expr_data/ingest` in the
container. Relative directory paths resolve against that config file.
The scan is read-only, ignores hidden paths and symlinks, and shows an error
beside a partial or invalid `.npz`. A later file change triggers validation
again. Writing producers should publish with an atomic rename, as the helper does.

Browser uploads preserve the original file bytes under the visualizer's
`_expr_data/uploads`, including safe folder-relative paths. They do not write
to an external ingest directory. Existing filenames return an error rather
than being overwritten. The browser supports selecting multiple files or a
folder; each file is sent independently.

API:

- `GET /api/replays` → `{items, revision}`. Items include `id`, `name`, `path`,
  `source`, `revision`, `status` (`ready` or `error`) and an optional `error`.
- `GET /api/replays/scene?id=...` → a snapshot in the existing scene shape.
  `default` retains the initial legacy recording, or a starting pose if no
  legacy recording is available. `/api/scene` keeps its initial scene.
- `POST /api/replays/upload?path=study/run.npz`, raw body with
  `Content-Type: application/octet-stream` → `{accepted, item, id}`.
  Invalid uploads return `{accepted:false,error}`; collisions use HTTP 409.

An uploaded scene includes full-root `reference_time_s`/`reference_xyz` for
each trajectory when present, and `metadata.time_basis`. Prediction
`metadata.recorded_start_s` records the explicit origin. With no reference,
`target_xyz` is null. Starting-pose scenes have `source.bootstrap=true` and no
trajectories; they do not manufacture recordings or timestamps.
