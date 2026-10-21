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
- The native solve holds Python's GIL. Pause and settings responses may wait
  for the current solve to finish. Browser rendering remains independent.
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
- `{"kind": "figure8", "amplitude_m": [ax, az], "period_s": T}`: optional
  stretch goal, a figure-eight reference centred on the start tool position,
  in the plane spanned by world x and z.

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

{"type": "state", "sim_time_s": 0.13, "q": [7 floats], "qd": [7 floats],
 "ee_xyz": [3 floats], "distance_m": 0.031, "arrived": false, "rtf": 0.98}

{"type": "error", "message": "...", "detail": "..."}
```

All positions are in the full robot's root frame. `q` values are native joint
coordinates, already converted from the GPU convention with the joint-6 sign.
Plans are sent after every solve; `state` events at most about 60 per second
of wall time.
