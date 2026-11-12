# Portable replay NPZ v1

Export one compressed `.npz` from the experiment, then upload it from the
laptop or place it anywhere below the configured `ingest_directory` on the
server. The Replay library discovers nested files when the browser polls it.
Selecting a recording loads a snapshot; later catalog changes do not replace
that snapshot. Use Reload to load a changed recording.

## Export from tiago_mpc

The single exporter lives in **`tiago_mpc/experiments/replay.py`**, on the
producer side. Run it in the prepared uv environment; its package imports
include Pinocchio and GATO's Python package, without ROS or a compiled CUDA solver. An experiment
run writes `<run>/replay.npz` with `export_replay(record)`: execution-time
states and commands, the task reference (with its orientation target when the
task has one) and every plan, with `provenance={"params": to_dict(MpcParams)}`. A run with collision rows
(`MpcParams.collision`) also records its body posture as fixed joints, its
obstacles and the spheres its rows see ([obstacles and collision
spheres](#obstacles-and-collision-spheres)). Other producers call
`save_replay` directly from the `tiago_mpc` checkout:

```python
from tiago_mpc.record import to_dict
from pathlib import Path
import numpy as np
from experiments.replay import save_replay
from tiago_mpc.tiago import GRASP_FRAME, RIGHT_ARM_JOINTS, ROOT_FRAME

save_replay(
    Path("../_expr_data/ingest/my-study/replay.npz"),
    time_s=np.asarray(times),               # actual saved sample timestamps
    q=np.asarray(native_states)[:, :7],    # native right-arm radians
    qd_rad_s=np.asarray(native_states)[:, 7:],  # optional saved velocities
    torque_nm=applied_actuator_torque,     # optional saved actuator controls
    torque_time_s=np.asarray(times)[:-1], # one value per plant interval
    joint_names=RIGHT_ARM_JOINTS,
    time_basis="simulation",              # use "wall" for wall-clock samples
    label="My reaching run",
    end_effector_frame=GRASP_FRAME,       # arm_right_grasp_joint, between the fingers
    reference_xyz_m=target_xyz,            # optional static position
    reference_frame=ROOT_FRAME,           # torso_lift_link, frame of target_xyz
    provenance={"params": to_dict(params)}, # optional; MpcParams give the MPC bounds
)
```

The optional `model_urdf` identifies the full model used to display the recording;
its SHA-256 is computed by the helper. Omitting it uses `tiago_mpc.tiago.FULL_URDF`,
the canonical full model. Export to a fresh result path: the helper
writes a temporary file and atomically replaces its destination on success.
The hash covers the file's raw bytes, so comment or dynamics edits change it
too. A recording whose hash differs from the displayed model still loads, with
a ⚠ marker whose tooltip names both hashes; the catalog item and
`scene.source.model_warning` carry them, and `scene.source.full_urdf_sha256`
keeps the recorded hash. Joint names, fixed joints and frames are still
checked against the displayed model and reject an incompatible recording.
Exporting does not alter the experiment or existing recordings.

`end_effector_frame` identifies the point followed by recorded paths and
references: `arm_right_grasp_joint` (`GRASP_FRAME`, the grasp center that
`export_replay` always records at this frame) or `arm_right_tool_joint`
(`FLANGE_FRAME`, the flange). `save_replay` and the viewer default to the flange,
so recordings without the field keep it.
The viewer reads application-only fixed TCP offsets from the selected
`tiago_mpc` reduced URDF without changing the canonical full model or its hash.

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

An optional `reference_rotvec_rad`, the shape of `reference_xyz_m`, is the end
effector's target orientation at each reference sample: a rotation vector (axis
times angle, radians) in `reference_frame`, or a NaN row for no orientation
target at that sample. `tiago_mpc`'s reference rows hold the same vectors in
their orientation slots (`tm.ee_orientation(q)` gives the grasp frame's). Unlike
positions, an orientation reference holds each sample until the next one
(zero-order hold; the first sample before it).
Optional `fixed_joints={"torso_lift_joint": 0.15}` records static context in
native metres/radians. The viewer's resting left-arm display remains the
default unless explicitly overridden.

Optional predictions are native trajectories with their own knot times:

```python
save_replay(
    "../_expr_data/ingest/my-study/replay-with-plan.npz",
    time_s=times, q=native_q, joint_names=RIGHT_ARM_JOINTS,
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
exporting; the format contains no GPU signs or packed states. Native predicted
velocities/controls can be exported explicitly using the optional fields below.

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
`obstacles`, `obstacle_capsules`, `obstacle_boxes`, `obstacle_planes`,
`collision_spheres`, `body_capsules`, `body_boxes`, `provenance` (a JSON object).
References require `reference_frame` to be `base_footprint` or
`torso_lift_link`; the full model and fixed posture determine the transform.

A static reference uses `reference_xyz_m` with shape `(3,)`. A moving reference
uses both `reference_time_s` `(R,)` and `reference_xyz_m` `(R, 3)` (R ≥ 1).
The optional `reference_rotvec_rad` has the shape of `reference_xyz_m`; each
row is three finite values or three NaN (no orientation target there). It
needs reference positions. Plan references have no orientation.

`predictions` is a list of descriptors with required `origin_time_s`,
`time_key`, `q_key`, and optional `id`, `label`, `stats`, `reference_xyz_key`,
`reference_time_key`, `reference_frame`. Keys name arrays inside the same
archive; prediction timestamps are nonnegative, strictly increasing offsets
from the explicit origin, and each plan has at least two samples. A plan's
reference follows the same static/moving array shapes. No solver dt is inferred.

The viewer accepts at most 64 MiB compressed, 256 MiB expanded, 65,536 arrays,
16 MiB of JSON metadata (stored as UCS-4, four bytes per character), 10,000
prediction descriptors and 200,000 total trajectory/reference samples. A default
figure eight (2400 plans, 12,008 arrays) fits. Excess files receive an explicit error; samples are not filtered.
Object arrays and malformed NPY headers are rejected before loading.

## Optional joint telemetry and limits

Position-only exports remain valid. The viewer shows missing velocity/torque as
`—`; it never differentiates positions or invents torque. All telemetry columns
use the same native `joint_names` order as `q` (including native joint-6 signs).

- `qd_rad_s`: finite `(T, 7)` recorded velocities, aligned with `time_s`.
- `torque_nm`: finite `(K, 7)` **applied actuator torque**, excluding separately
  modeled passive friction/damping. Supply `torque_time_s` `(K,)` when controls
  use different timestamps from states; otherwise K must equal T.
- Torque timestamps must strictly increase within the state's time span.
  Torque uses zero-order hold from each timestamp until the next. For a plant
  with T states and T−1 interval controls, pass `torque_time_s=time_s[:-1]`.
  At the final recorded state, the table displays the last actually applied
  interval torque, not a newly inferred terminal command. Before the first
  control timestamp torque is unavailable.

Each optional plan accepts `qd_rad_s`, `torque_nm`, and `torque_time_s` with
these same shapes, using offsets from its origin. They become descriptor
`qd_key`, `torque_key`, and `torque_time_key` fields naming the archived arrays.
Plan torque is labeled **predicted actuator torque**. For N knots, export only
N−1 controls at `time_s[:-1]`; the terminal knot has no predicted control and
shows `—`. The API adds `torque_kind="predicted"` and an exclusive
`torque_end_time_s` equal to the final state timestamp. Recorded API torque is
labeled `torque_kind="applied"`. Live state torque is the last torque actually
applied to the simulated plant; a preview changes the predicted command only,
and never claims to have applied it. After Reset it remains null until motion.

The exporter optionally accepts `joint_limits` as a JSON object containing
seven-element arrays `lower_position_rad`, `upper_position_rad`,
`velocity_rad_s`, and `effort_nm`, plus a descriptive `source` string. Position
bounds must be ordered and velocity/effort limits positive. Use the recording's
actual historical bounds when available; the reader normalizes their order
along with joint columns. These recorded bounds take precedence over display
URDF limits. Without them, the scene uses and labels canonical display URDF
limits. These are the physical limits: limit use (tint, Joints gauges, limit
plot) is measured against them. When `provenance.params` (the recorded
`MpcParams`) states a numeric `joint_margin_rad`, `velocity_fraction` or
`effort_fraction`, the scene also carries `mpc_bounds` derived from these
limits as `tiago_mpc`'s `set_bounds` does: the position limits narrowed by the
margin, the velocity and effort limits scaled by the fractions. Missing values
are not inferred. Recordings made before the migration keep their settings in
`provenance.configuration.limit_bounds`, which is no longer read. Live carries the MPC bounds installed in its
solver the same way. Limit colors describe proximity to the URDF limits; they
are not a convergence or physical-safety verdict.

## Obstacles and collision spheres

A run with `tiago_mpc`'s collision rows (`MpcParams.collision`) records the
geometry they work with. Each sphere is `[x, y, z, radius]` in metres, finite,
with a positive radius:

- `obstacles`: the scene's obstacle spheres (`Collision.obstacles`), in
  `torso_lift_link` (`tiago_mpc`'s `ROOT_FRAME`).
- `obstacle_capsules`, `obstacle_boxes`, `obstacle_planes` (optional,
  2026-11-03, `tiago_mpc` a14b746): `Collision.capsules`
  `[ax, ay, az, bx, by, bz, r]`, `Collision.boxes`
  `[cx, cy, cz, qx, qy, qz, qw, hx, hy, hz]` (quaternion xyzw, half-extents)
  and `Collision.planes` `[nx, ny, nz, d]` (free side n·p ≥ d), in the same
  frame. Writers include them only when non-empty. Radii and half-extents must
  be positive, quaternions and normals nonzero.
- `collision_spheres`: the spheres of the MPC's collision rows,
  `{"environment": [...], "arm": {"<link>": [...]}}`. `environment` is
  `Collision.environment()`'s spheres in `torso_lift_link`: the body cover's
  spheres, then the obstacles. `arm` is the arm's stored sphere cover
  (`collision.arm_cover`) by link, each in its link's frame; the link names must
  exist in the displayed model.
- `body_capsules`, `body_boxes` (optional, 2026-11-07): the capsules and boxes of
  the body's stored mixed cover (`collision.body_cover`; the rows' environment
  holds them before the obstacles' capsules and boxes), in `torso_lift_link` and
  the layouts of `obstacle_capsules` and `obstacle_boxes`. Writers include them
  only when non-empty.

`torso_lift_link` moves with the torso lift, so the recording's
`fixed_joints` (the run's body posture) place both lists, like a reference in
that frame. The exporter writes them only for a collision run; other runs
export exactly as before. A collision run without obstacles has an empty
`obstacles` list.

The viewer draws the obstacles of each visible track as solid shapes (a plane
as a translucent 1.2 m patch with an edge, centred where the root frame's
origin projects onto it), and
the collision spheres behind the viewport's collision-spheres toggle, default
off: the environment and, on each Arm ghost, the arm cover, both translucent
cyan. The covers are the MPC's conservative approximation;
the obstacles are the scene's geometry.

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

Direct links: `/?replay=<name>` selects the catalog item whose `name` (the
relative path without `.npz`) matches, preferring ingest over an upload with
the same name; `uploads/<name>` addresses an upload explicitly. Resolution is
client-side against `GET /api/replays`, so no filesystem path is interpreted.
Repeat the parameter (`/?replay=study/stock&replay=study/feedback`) to add
several recordings to one Replay-mode session. Available entries load in URL
order, once each; repeated paths are ignored. Multi-recording links place each
track at offset zero and name it from the recording label (catalog basename
if absent). Missing or unreadable entries remain pending for catalog updates;
tracks already added retain their loaded copies. Encode each value separately,
including `%2B` for a literal plus sign. These links describe the recordings to
open, not subsequent visibility, names or offset edits to the browser session.

API:

- `GET /api/replays` → `{items, revision}`. Items include `id`, `name`, `path`,
  `source`, `revision`, `status` (`ready` or `error`) and an optional `error`.
- `GET /api/replays/scene?id=...` → a snapshot in the existing scene shape.
  `default` is the start pose. `/api/scene` keeps that initial scene.
- `POST /api/replays/upload?path=study/run.npz`, raw body with
  `Content-Type: application/octet-stream` → `{accepted, item, id}`.
  Invalid uploads return `{accepted:false,error}`; collisions use HTTP 409.

An uploaded scene includes full-root `reference_time_s`/`reference_xyz` for
each trajectory when present, and `metadata.time_basis`. With an orientation
reference, the recorded trajectory also has `orientation_error_rad` per state:
the end effector's angle to the held orientation target, or null where it has
none; Episode plots and aggregates read it. Prediction
`metadata.recorded_start_s` records the explicit origin. With no reference,
`target_xyz` is null. Start-pose scenes have `source.bootstrap=true` and no
trajectories; they do not manufacture recordings or timestamps.


## Live freezes

The library also scans the server-owned RAM runtime root
`freezes/p<pid>/`, with catalog ids `freeze-<hash>` and `source: "freeze"`.
These files survive browser reloads, are pruned oldest-first beyond eight, and
are deleted on server shutdown; startup removes directories of ended servers.
Removing a browser track does not delete its file. Keep to disk is deferred.

`GET /api/replays/motion?id=<catalog id>` is the lightweight track payload:
`id`, `revision`, `label`, `time_basis`, `end_effector_frame`, `fixed_joints`,
`joint_limits`, `model_warning`, `time_s`, `q`, `ee_xyz`, `reference_time_s`,
`reference_xyz`, `arm_base` (4×4 row-major world transform of the first arm
joint's parent), `plan_count`, `obstacles`, `obstacle_capsules`,
`obstacle_boxes`, `obstacle_planes` and `collision_spheres` (null
when absent; obstacles and environment in the world at the recorded fixed
joints, the arm's spheres in their link frames; `collision_spheres` also holds
the body cover's `body_capsules` and `body_boxes` in the world, empty when absent) and `provenance`. A recording with an orientation
reference adds `reference_rotvec` (world rotation vectors aligned with
`reference_time_s`, null where a sample has no target) and `ee_rotvec` (the
recorded end effector's world orientation at each state), from which the track
draws its [gripper glyphs](presentation.md#orientation-goal-glyphs). It computes FK for recorded
motion only, caches by catalog id and revision, and never switches the current
Replay or discards its Run again results. Queries accept exactly one catalog
id, never paths. `/api/replays/scene` still serves full Replay payloads.

Freeze uses the selected checkout's unchanged `experiments.replay.save_replay`.
It includes every committed state (`time_s`, native q and qd), applied torque,
state-time targets as a moving reference (with the segment's orientation goal
at every state as `reference_rotvec_rad`, when it has one), every controller plan with origin,
knot states/velocities/predicted torques and finite scalar statistics, joint
limits, end-effector frame and the scene's fixed joints. Preview plans are
excluded. Live world coordinates derive from the full URDF root,
`base_footprint`, so this is the reference frame written to the replay.
A segment with collision rows also writes its obstacles (capsules, boxes and
planes only when non-empty) and collision
spheres (environment: body cover, then obstacles; arm cover by link) in
`torso_lift_link`, which the scene's fixed joints place.
`provenance.params` carries the problem configuration;
`provenance.live` carries settings, source/simulator/solver/model identities,
arrival rule, generation, completion status, freeze timestamp and breaches.

Accepted v1 omissions: timing intervals (no freeze timing plots/bands), command
records (plan sequence, planned unclipped torque and plan exhaustion), state
`distance_m`/`arrived` and playback breach stops. Applied torque remains;
breaches and the arrival rule remain in provenance. Run again reconstructs its
cold state from the saved prediction's first q/qd knot and regenerates the
reference from the recorded task and clock. Installed bounds and identities use
the existing shared provenance. Per-solve `initial_state`/`reference_native`
copies and a separate inspection context are not exported. See
[inspection](inspection.md#fresh-inspection-service-and-binary-data-flow).
Format limits apply:
200,000 total samples, 10,000 predictions and 64 MiB compressed. Total samples
include recorded states, reference samples and prediction knots. Oversized runs
are refused with the limit named; no export subsampling is performed.
