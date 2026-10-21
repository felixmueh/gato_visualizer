# Live MPC API contract (MVP)

Contract between the Python backend and the browser frontend for the live
modes. Agents change it only through the coordinating agent. Replay endpoints
(`/api/scene`, `/api/health`, `/assets/...`) stay as they are.

## Process model

- One `server.py` process, stdlib `ThreadingHTTPServer`; no new Python
  dependencies. Default port 8090; the container's server uses 8080.
- One GPU worker thread owns every GATO/CUDA object. HTTP threads only enqueue
  commands and read published events. Consecutive pending settings commands
  coalesce to the newest one; play/pause/reset ordering is preserved.
- A separate presentation thread decodes predictions, computes full-model FK,
  and validates JSON. It owns its own Pinocchio model/data and receives copied,
  immutable numerical snapshots. Its mailbox holds one pending frame in addition
  to the frame being rendered; a newer frame replaces the pending frame. Control
  and plant stepping never wait for presentation or SSE socket writes.
- Settings, play, pause and reset invalidate obsolete presentation work. Pause
  sends the exact final native state and last solved plan, followed by paused
  status. This can repeat the last plan's identity without a new solve.
- The native solve holds Python's GIL. Pause and settings responses may wait
  for the current solve to finish. Presentation also shares that GIL, so this
  removes synchronous work/backpressure from control without promising CPU
  isolation or hard real-time scheduling. Browser rendering remains independent.
- MPC code comes from the unchanged `tiago_mpc` checkout (see `AGENTS.md`).
  `GATO_CACHE_DIR` is this checkout's `.cache/gato`, set before importing
  `reach_sim`.

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
- `{"kind": "figure8", "target_offset_m": [dx,dy,dz], "width_m": 0.24,
  "height_m": 0.16, "period_s": 24}`: horizontal world-XY tracking. The loop
  starts at the comfortable-pose tool position plus the offset, extends
  `width_m` forward (+X), and spans `height_m` laterally (Y). There is no
  position jump at t=0 with the zero offset. Its center is start+offset+
  `[width_m/2,0,0]`. Width/height accept .01–.6 m; period accepts 1–120 s.

For figure8, phase is `2*pi*t/period_s`, X adds
`width_m/2*(1-cos(phase))`, Y adds `height_m/2*sin(2*phase)`, and Z stays fixed.
Every solve builds its reference at exact simulation times `t+k*dt_s`; state
tracking error compares with the reference at that state's timestamp. Pause
holds simulation time and phase. Reset returns both to zero. Changing settings
preserves current time/phase and the deterministic comfortable-pose anchor.
The reach target drag handles are hidden for figure8; its moving marker is
read-only. The schema's `tasks` list supplies both task defaults plus editable
figure8 parameter descriptors. Plans/states include `task_kind` and their
instantaneous world `target_xyz`; tracking does not report target arrival.

This is a simulation diagnostic using the currently selected solver/plant
settings, with the existing position-reference/orientation semantics. Geometry
follows `tiago_mpc-larger-fig8/examples/track_figure8.py` and retained 24×16 cm
examples, but omits their experiment-specific 20 mm initial edge offset. It
does not reproduce or qualify those historical dynamics/cost settings.

The solver reference is in the reduced arm's root (torso) frame; the backend
converts world-frame values with the transform derived from the full URDF.

## Schema response

```json
{
  "defaults": {"config": {...}, "task": {"kind": "reach", "target_offset_m": [0, 0, 0]}},
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
All numeric ranges are enforced by the backend. MVP work caps are SQP 20,
PCG 800 and ADMM 200 per solve.

## Commands

- `{"type": "set_settings", "config": {...}, "task": {...}}`: replace both.
  While paused, the backend recomputes the preview. While playing, the change
  applies at the next control interval.
- `{"type": "play"}`, `{"type": "pause"}`.
- `{"type": "reset"}`: return to the task start state (zero velocity) and
  recompute the preview.

An N without a compiled module is rejected; the backend never compiles in
response to a command.

## Semantics the UI must label

- **Preview:** `controller.reset(x)` at the current state, then one
  `controller.step`. This is the same as the first plan that Play would
  compute from that state.
- **Play:** the fixed pacing of `reach_sim.py`. Each solve is followed by one
  knot interval `dt_s` of RK4 plant steps of at most `SIM_DT_S`, with solve
  latency not advancing the plant. The worker paces this to wall-clock real
  time and runs slower when it cannot keep up; `rtf` reports the ratio. Play
  keeps running after arrival, holding the target, until paused.
- **Settings change during Play (MVP):** rebuild the solver and controller as
  needed and `controller.reset` at the current state. The next plan carries
  `controller_restarted: true`.
- **GPU sharing:** before Play and before each preview, try the locks used by
  `tiago_mpc/experiments/random100/run.py` (non-blocking, exclusive). Hold
  them while playing, and release them on pause. If a lock is taken, emit
  `status` with `state: "gpu_busy"` and do not solve.
- **No active views:** when the last SSE connection disconnects, pause and
  release the GPU locks. Initial previews wait for a connected view. CUDA
  controller construction, resets, model checks and graceful disposal also
  use the locks. Graceful disposal may wait for an experiment lock owner.

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
Presentation publishes matching plan/state/status bundles at most about 60 times
per second of wall time, with immediate final pause/preview updates. It may skip
intermediate solves when control is faster than presentation; `seq` still counts
every solve. This is display-only subsampling: every numerical solve and fixed
plant interval still executes. Browser history contains the displayed snapshots,
not a complete experiment recording. SSE writes run on each client's HTTP thread
against the existing bounded event buffer, without blocking the control worker.

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
clears episode plan count (`seq`); its next plan is 1. Settings/controller
restarts keep counting. SSE transport event IDs remain monotonic independently.
