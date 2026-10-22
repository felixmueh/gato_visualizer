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

## Settings object

`config` has the shape of `tiago_mpc/configs/reaching.json` without
`description` and `save_plan_steps`: `N`, `dt_s`, `solver_params`,
`controller` (`warm_start`, `reset_rho_each_step`, `admm_linsys`,
`limits_kw`), `limit_bounds`. The backend always writes the complete object
to a JSON file under `_expr_data/live/` and resolves it with
`reaching_config.load_configuration(path)`, so the effective settings are
the ones `reach_sim.py --config <that file>` would use.

`task` is separate, because `reaching_config` rejects unknown fields:

- `{"kind": "reach", "target_offset_m": [dx, dy, dz]}`: offset in the world
  frame from the default `reach_sim` target, FK(`Q_START_RAD + Q_GOAL_DELTA_RAD`).
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
defaults plus editable figure8 parameter descriptors. Plans/states include `task_kind` and their
instantaneous world `target_xyz`; tracking does not report target arrival.

This is a simulation diagnostic using the selected solver and fixed simulator.
The figure-eight geometry is defined in `live_mpc.figure8_reference`; it does
not qualify the dynamics/cost settings of historical experiments.

The solver reference is in the reduced arm's root (torso) frame; the backend
converts world-frame values with the transform derived from the full URDF.

Plan and state events include `task_anchors: {"reach": [x,y,z],
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
  "parameters": [
    {"path": "solver_params.q_cost", "label": "Position cost", "group": "Costs",
     "kind": "float", "scale": "log", "min": 1e-3, "max": 1e4}
  ],
  "source": {"mpc_root": "...", "mpc_commit": "...", "mpc_dirty": false,
             "gato_commit": "..."}
}
```

`available_N` lists only N whose module is already compiled (found without
building). `kind` is `float`, `int`, `bool` or `choice` (with `choices`);
`scale` is `log` or `linear`. Every field of `config` that a user may change
has a parameter entry. Fixed adapter fields also have entries with
`disabled: true` and a single allowed choice: `solver_params.linsys` is null
(the reaching controller uses PCG), and `solver_params.exact_hessian` is false.
All numeric ranges are enforced by the backend and published by
`live_mpc.parameter_specs`; consumers should use the returned schema. Current
upper bounds are SQP 100000, PCG 1000000 and ADMM 200. Inspection Run again
has its own cap and capture-memory limits.

## Commands and GPU sharing

Use the complete command definitions in [execution-api.md](execution-api.md).
`set_settings` supplies `config`, `task` and `execution`; optional native anchors
start an identified continuation. Preview computes a prediction without plant
motion. It is distinct from a separate cold Run again inspection and is not a
promise of the exact first Play plan or a preserved optimizer checkpoint.
Normal settings/N changes load compatible prebuilt modules and never compile.

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
 "message": "...", "settings_version": 3, "N": 32, "dt_s": 0.01}

{"type": "plan", "seq": 12, "origin": "preview|play", "settings_version": 3,
 "sim_time_s": 0.12, "N": 32, "dt_s": 0.01,
 "knot_time_s": [...], "q": [[7 floats] x N], "ee_xyz": [[3 floats] x N],
 "reference_xyz": [[3 floats] x N],
 "stats": {"sqp_iters": 5, "pcg_iters": 410, "admm_iters": 100,
           "admm_linsys_iters": 0, "solve_time_ms": 4.9,
           "row_violation": [...], "controller_restarted": false}}

{"type": "state", "sim_time_s": 0.13, "settings_version": 3,
 "q": [7 floats], "qd": [7 floats],
 "ee_xyz": [3 floats], "distance_m": 0.031, "arrived": false, "rtf": 0.98}

{"type": "error", "message": "...", "detail": "..."}
```

All positions are in the full robot's root frame. `q` values are native joint
coordinates, already converted from the GPU convention with the joint-6 sign.
The current report default is 20 Hz of wall time, with immediate boundary
flushes; see [presentation.md](presentation.md). SSE latest values/notices may
coalesce, but all committed numerical records remain in the disk-backed history
and are fetched through cursor pages. Browser motion uses that history, not SSE
arrival times. SSE socket writes run on client HTTP threads independently of
numerical execution. Status fields include execution/job/generation information
defined in [execution-api.md](execution-api.md); the examples above show core
fields rather than an exhaustive schema.

Figure-eight plans additionally carry `task_path_xyz`, a complete world-frame
reference loop. `reference_xyz` remains the reference over the predicted horizon.

Joint telemetry is native throughout: each plan also includes `qd_rad_s[N,7]`,
`torque_nm[N-1,7]`, `torque_time_s` (nonterminal knot offsets),
`torque_kind: "predicted"`, and an exclusive `torque_end_time_s` at the terminal
knot. The terminal knot has no actuator control. Each state includes
`torque_nm[7]` for the last control actually applied to the simulated plant,
`torque_kind: "applied"`, or null before any plant step. Solving a preview
never changes the last applied control. These are actuator torques; they are
not reconstructed from positions or passive resisting torques.

Plans and states carry `joint_limits` with native `lower_position_rad`,
`upper_position_rad`, `velocity_rad_s`, `effort_nm`, and `source`. Live bounds
are the effective configured MPC bounds, including margin/fractions. Reset
clears episode plan count (`seq`); its next plan is 1. Settings/profile changes
start a new history generation and plan sequence; identify a retained solve
within its source/generation, not by sequence alone. SSE transport event IDs
remain monotonic independently.
