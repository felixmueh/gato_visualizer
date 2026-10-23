# Live settings and event API

Task/settings payloads and Live events shared by the Python backend and browser.
[Execution and history](execution-api.md) defines scheduling, calculation modes,
commands and lossless playback; [presentation settings](presentation.md) defines
report cadence, buffering and interpolation. [Solver profiles](solver-profiles.md)
defines the separate simulator and solver processes. HTTP threads enqueue
commands and read retained records; they own no controller or CUDA state.

## Transport

- `GET /api/live/schema`: JSON for building the settings UI (below).
- `GET /api/live/events`: Server-Sent Events, each `data:` line one JSON
  object with a `type` field. On connect the server sends the current
  `status` and the latest `plan` and `state`.
- `POST /api/live/command`: JSON body `{ "type": ..., ... }`. Responds
  `{"accepted": true, "settings_version": 3}` or
  `{"accepted": false, "error": "..."}`; results arrive as events. A settings
  version is assigned when accepted, before the worker applies the command.
  The browser keeps an old prediction labelled as pending until a plan with
  that version or a newer version arrives. Non-settings commands return the
  most recently assigned version.
- Without Live (`--replay-only`, or a setup error), every Live, solver-profile
  and Run-again route answers 503 with `{"error": "<reason>"}`; unknown `/api/`
  routes answer 404 with a JSON `error`.

## Settings object

`config` is `asdict(MpcParams)` of the selected `tiago_mpc` plus the
visualizer's simulated-plant group:

- `MpcParams` fields: `N`, `dt_s`, `solver` (GATO's `SolverParams`: SQP/PCG
  caps and tolerance, `mu`, `rho`, costs, `linsys`, `exact_hessian`, …),
  `ee_frame`, `warm_start`, `reset_rho_each_step`, `admm_linsys`, `admm`
  (ADMM limit-row settings), `joint_margin_rad`, `velocity_fraction`,
  `effort_fraction`, `friction` (predictor friction, `null` when loss-free),
  `max_sqp_time_s` (wall time for a solve's SQP iterations within
  `solver.max_sqp_iters`; `null`: no time limit) and `warmup` (a boolean:
  GATO's warm-up solve at every reseed, below).
- `plant`: the simulation group: `friction` (the simulator friction switch,
  false), `clip_effort` (true: commands clipped to ± the raw URDF effort limit
  before the plant) and `stop_on_breach: {"position": true, "velocity": true,
  "torque": true}` (Live pauses where a simulated value breaches its raw URDF
  limit). See [limit handling](execution-api.md#limit-handling); Felix,
  2026-10-23. `start_pose_rad`: the start pose, seven native joint positions
  the simulated arm starts from at t = 0 (velocities zero) and Reset returns
  to; the default is the simulator source's `tiago.Q_START`, and each value must
  lie within the raw URDF position limits. Changing it starts a new run at t = 0
  ([commands](execution-api.md#settings-and-commands)). A start pose outside the
  MPC planning box (the URDF range less `joint_margin_rad`) is accepted; the
  browser flags it. Task geometry stays tied to `Q_START` (Felix, 2026-10-23).

The defaults are `tiago_mpc`'s `TIAGO` parameters, reported by the selected
interpreter's source probe, with `max_sqp_time_s: null`, plus the `plant`
group above (its start pose from the simulator's checkout, `live_mpc.start_pose_spec`). `TIAGO`'s 10 ms limit is for the wall clock; Live and
precalculation run on the simulation clock, so the visualizer's default has no
time limit, and the user can still set one (Felix, 2026-10-23). The solver child
rebuilds `MpcParams.from_dict` from everything except `plant`; no
configuration file is written. Recorded plans carry the same object as
`problem_configuration`.

`task` is separate:

- `{"kind": "reach", "target_offset_m": [dx, dy, dz]}`: offset in the world
  frame from the default reaching target, FK(`Q_REACH`) at the grasp frame
  (the target of `tiago_mpc`'s `experiments/reach.py`).
  The visualizer defaults to `[0.15, 0.2, 0.2]` m; these are offsets, not absolute XYZ coordinates.
- `{"kind": "figure8", "target_offset_m": [dx,dy,dz], "width_m": 0.24,
  "height_m": 0.16, "period_s": 24, "orientation_xyzw": [0,0,0,1]}`: horizontal world-XY tracking. The loop
  starts at the comfortable-pose tool position plus the offset, extends
  `width_m` forward (+X), and spans `height_m` laterally (Y). There is no
  position jump at t=0 with the zero offset. Its center is start+offset+
  `[width_m/2,0,0]`. Width/height accept .01–.6 m; period accepts 1–120 s.

For figure8, phase is `2*pi*t/period_s`, X adds
`width_m/2*(1-cos(phase))`, Y adds `height_m/2*sin(2*phase)`, and Z stays fixed.
An optional unit quaternion `orientation_xyzw` rotates this local loop about
its start; translation stays in world axes and identity keeps the XY geometry.
Every solve builds its reference at exact simulation times `t+k*dt_s`; state
tracking error compares with the reference at that state's timestamp. Pause
holds On Play simulation time and phase; Manual/Automatic calculation can
continue behind paused playback. Reset returns both to zero. Settings changes
preserve the captured displayed state/time and deterministic task anchor.
The task transform controls edit the static anchor/orientation; the moving
reference marker follows task time. The schema's `tasks` list supplies both task
defaults plus editable figure8 parameter descriptors. The segment header holds the
`task` (with its `kind`); plans and states include their instantaneous world
`target_xyz`; tracking does not report target arrival.

This is a simulation diagnostic using the selected solver and fixed simulator.
The figure-eight geometry is defined in `live_mpc.figure8_reference`; it does
not qualify the dynamics/cost settings of historical experiments.

The solver reference is in the reduced arm's root (torso) frame; the backend
converts world-frame values with the transform derived from the full URDF.

The schema and each segment header include `task_anchors: {"reach": [x,y,z],
"figure8": [x,y,z]}` in world coordinates, before task offsets. These fixed
anchors identify the imported default reaching target and comfortable-pose
tracking start. They do not move when the simulated state, task position,
tracking dimensions or orientation change; the UI can edit either task before
receiving its first solved plan.

## Schema response

```json
{
  "defaults": {"config": {...}, "task": {"kind": "reach", "target_offset_m": [0.15, 0.2, 0.2]}},
  "available_N": [16, 32, 64, 128],
  "available_N_by_friction": {"off": [16, 32, 64, 128], "on": [32]},
  "friction": {"coefficients": {...}, "predictor": {...}, "source": "...",
               "simulation_law": "...", "prediction_law": "..."},
  "parameters": [
    {"path": "solver.q_cost", "label": "Tool position cost", "group": "Costs",
     "kind": "float", "scale": "linear", "min": 0, "max": 100000}
  ],
  "source": {"mpc_root": "...", "mpc_commit": "...", "mpc_dirty": false,
             "gato_commit": "..."}
}
```

`available_N_by_friction.off` / `.on` list the N whose loss-free or
predictor-friction module `tiago_mpc`'s `find_binary` finds, among the offered
knot counts 8, 16, 24, 32, 48, 64, 96 and 128; `available_N` is their union.
`kind` is `float`, `int`, `bool`, `choice` (with `choices`, each a plain value
or `{value, label}`) or `joints` (`plant.start_pose_rad`: one value per joint,
with per-joint `lower` and `upper` bounds, the raw URDF position limits; the
browser edits it in the Joints tab, not the settings panel); `scale` is `log` or `linear`; numeric entries may be
`nullable` (`max_sqp_time_s`, whatever its default). Every leaf of `config` has a parameter entry, so every
default is shown. An entry may carry a `description` (its tooltip) and a
`row`: entries sharing a row are shown side by side (the three **Stop on
breach** checkboxes of the **Limit handling** group). Fixed fields have `disabled: true` and a single allowed
choice: `solver.linsys` is null, `solver.exact_hessian` is false, and
`ee_frame` is the grasp frame the simulator tracks. `friction` is one choice
between loss-free and the URDF friction with the fixed tanh width. All numeric
ranges are enforced by the backend and published by `live_mpc.parameter_specs`;
consumers should use the returned schema. Current upper bounds are SQP 100000,
PCG 1000000 and ADMM 200. Inspection Run again
has its own cap and capture-memory limits.

## Commands and GPU sharing

Use the complete command definitions in [execution-api.md](execution-api.md).
`set_settings` supplies `config`, `task` and `execution`; optional native anchors
start an identified continuation. Preview computes a prediction without plant
motion. It is distinct from a separate cold Run again inspection and is not a
promise of the exact first Play plan or a preserved optimizer checkpoint.
Normal settings/N changes load a compiled module (`Mpc(params, binary)`) and
never compile; an N that is not compiled for the chosen predictor is rejected
with "Not compiled". A successful Build into the active solver's own
checkout, interpreter and cache adds its modules to the running backend's
schema at once (`compiled_modules` event; Felix, 2026-10-23): building only
adds modules, which the solver child finds with `find_binary` at its next
configure. A Build for another selection, or after the source identity
changed, still needs Apply and its restart.

**Warm-up at every reseed (Felix, 2026-10-23).** Each time the solver child's
controller is reseeded from a state (configuring, Reset, an anchor, a preview,
rollback after a cancellation, resuming Play after a preview), it calls
`tiago_mpc`'s `Mpc.warmup(state, reference)` with the task reference a request
at that time gets (the figure-eight window from the state's time). With
`warmup` on, that resets the controller and runs GATO's warm-up solve, as
`run()` does before its first tick; with it off, it is the plain controller
reset. A reseed repeating the previous one with no solve in between is skipped.
The warm-up is no plan: it creates no record and is not part of an interval's
timing. Like a solve, the call has no deadline. The solver log
(`solver-processes/` in the [runtime directory](execution-api.md#runtime-files)) has one line per warm-up.

Before constructing, resetting, solving or disposing native solver state, the
coordinator acquires the canonical experiment locks nonblockingly. While another
owner holds them it reports `gpu_busy` and waits cooperatively. Losing the last
SSE subscriber pauses On Play at a numerical boundary; explicit Manual/Automatic
precalculation may finish without a subscriber. A selected solver child may
remain idle; no continuous solving is
required for Replay, camera movement or scrubbing retained history.

## Events

```json
{"type": "status", "state": "idle|playing|paused|gpu_busy|error",
 "message": "...", "settings_version": 3, "N": 32, "dt_s": 0.01,
 "breach": {"sim_time_s": 0.03, "breaches": [...]}}

{"type": "plan", "seq": 12, "origin": "preview|play", "settings_version": 3,
 "sim_time_s": 0.12, "N": 32, "dt_s": 0.01,
 "knot_time_s": [...], "q": [[7 floats] x N], "ee_xyz": [[3 floats] x N],
 "reference_xyz": [[3 floats] x N],
 "stats": {"sqp_iters": 5, "pcg_iters": 410, "admm_iters": 100,
           "admm_linsys_iters": 0, "admm_linsys_mode": "pcg",
           "zero_pcg_rows": 0, "budget_hit": false, "solve_time_ms": 4.9,
           "step_wall_s": 0.006, "row_violation": [...],
           "controller_restarted": false},
 "diagnostics": {"initial_merit": [...], "final_merit": [...], ...}}

{"type": "state", "sim_time_s": 0.13, "settings_version": 3,
 "q": [7 floats], "qd": [7 floats],
 "ee_xyz": [3 floats], "distance_m": 0.031, "arrived": false, "rtf": 0.98}

{"type": "compiled_modules", "available_N": [16, 32],
 "available_N_by_friction": {"off": [16, 32], "on": [32]}}

{"type": "error", "message": "...", "detail": "..."}
```

`breach` appears on the `paused` status of a calculation that stopped on a
limit breach ([limit handling](execution-api.md#limit-handling)).

`compiled_modules` follows a successful Build into the active solver's
checkout, interpreter and cache: the backend has updated the schema's available
N without a restart, and the browser updates the N choices (below,
[Commands](#commands-and-gpu-sharing)).

All positions are in the full robot's root frame. `q` values are native joint
coordinates, already converted from the GPU convention with the joint-6 sign.
The current report default is 20 Hz of wall time, with immediate boundary
flushes; see [presentation.md](presentation.md). SSE latest values/notices may
coalesce, but all committed numerical records remain in the current run's history
and are fetched through cursor pages. Browser motion uses that history, not SSE
arrival times. SSE socket writes run on client HTTP threads independently of
numerical execution. Status fields include execution/job/generation information
defined in [execution-api.md](execution-api.md); the examples above show core
fields rather than an exhaustive schema.

Context that is constant within a segment (generation) is not repeated in plans
and states: it arrives once in the generation's `segment` record, as the first
history record and as an SSE `segment` event (also on reconnect), and the browser
looks it up by `generation`
([segment header](execution-api.md#segment-header)). For a figure eight it holds
`task_path_xyz`, a complete world-frame reference loop; `reference_xyz` remains
each plan's reference over its predicted horizon.

Joint telemetry is native throughout: each plan also includes `qd_rad_s[N,7]`,
`torque_nm[N-1,7]`, `torque_time_s` (nonterminal knot offsets),
`torque_kind: "predicted"`, and an exclusive `torque_end_time_s` at the terminal
knot. The terminal knot has no actuator control. Each state includes
`torque_nm[7]` for the last control actually applied to the simulated plant
(applied torque), or null before any plant step; with Clip effort on
it is the clipped command ([limit handling](execution-api.md#limit-handling)). Solving a preview
never changes the last applied control. These are actuator torques; they are
not reconstructed from positions or passive resisting torques.

The segment header carries `joint_limits`, the physical URDF limits, with native
`lower_position_rad`, `upper_position_rad`, `velocity_rad_s`, `effort_nm`, and
`source`; limit use is measured against them. It also carries `mpc_bounds`: the
rows actually installed in the solver from the `MpcParams` limit settings
(`joint_margin_rad`, default 0.1 rad; `velocity_fraction`; `effort_fraction`),
in the same native fields plus those values as `limit_bounds`. Velocity/torque rows appear only when symmetric. Reset
clears episode plan count (`seq`); its next plan is 1. Settings/profile changes
start a new history generation and plan sequence; identify a retained solve
within its source/generation, not by sequence alone. SSE transport event IDs
remain monotonic independently.

## Independent joint friction

`config.plant.friction` (boolean) switches the simulator's friction;
`config.friction` is the predictor's (`null` or the URDF friction with the fixed
0.03 rad/s tanh width). Both default to loss-free. `available_N_by_friction.off`
/ `.on` identify the compiled predictor variants. See [friction](friction.md)
for the laws and the build contract.
