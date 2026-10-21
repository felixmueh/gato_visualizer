# Visualizer execution and recorded playback

This contract supersedes the worker, pacing and displayed-history portions of
`live-api.md`. The visualizer owns execution timing. It imports the unchanged
`tiago_mpc` models, configuration, `reach_sim.rk4` and GATO MPC controller. The
adapter's existing synchronous `solve`/`advance` methods remain available for
the original conformance checks. No upstream warm-start policy is changed.

## Settings and commands

`GET /api/live/schema` adds `defaults.execution`:

```json
{
  "simulation_hz": 1000,
  "control_hz": 100,
  "to_hz": 100,
  "calculation": "on_play",
  "duration_s": 10,
  "continue_at_end": false
}
```

Rates are positive and obey `simulation_hz >= control_hz >= to_hz`.
`config.dt_s` is the independent prediction knot interval. The backend validates
all settings before acceptance. Static previews accept large positive SQP/PCG
budgets within the native integer range; the prior small MVP caps no longer
define their intended scope. Reject an unsupported history capacity before
starting a job with an explanatory error; never silently truncate duration or
samples. The implementation supplies explicit duration/rate/sample limits.
The UI hides `controller.warm_start` while retaining its complete config value.

`POST /api/live/command` retains its accepted/settings-version response.

- `set_settings`: existing complete `config` and `task`, plus `execution` and
  optional `anchor`.
- `precalculate`: generate `duration_s` of closed-loop motion without pacing;
  optional `anchor` chooses its initial state.
- `play`: produce motion from the authoritative history tip, paced at at most
  one simulated second per wall second. It never branches from a scrubbed frame.
- `pause`: stop further generation cooperatively. Browser playback is local.
- `cancel`: invalidate the current job cooperatively.
- `reset`: return to the comfortable pose, zero velocity and simulation time;
  clear the current history and episode plan sequence.

An anchor is `{sim_time_s, q: [7 native positions], qd: [7 native velocities]}`.
The browser captures the displayed state once when a settings transaction
starts, including during playback, and keeps it frozen through debouncing and
the resulting calculation. It does not replace the anchor with arriving
background states. Figure-eight phase follows `sim_time_s`.

Calculation modes are `on_play`, `manual`, and `automatic`. On Play generates
only as playback needs new history. Manual uses the Precalculate action to
generate a full bounded recording. Automatic invalidates stale work and
precalculates after settings changes from the frozen displayed anchor. Static
prediction remains one solve at the current state. Play with empty history
starts computation even when Continue is disabled; in Manual mode it may
precalculate the requested duration and autoplay when ready. Play with existing
history is local playback. Continue simulation at end governs extending the
existing tip; without it, playback stops at the end of its requested duration.

## Process and cancellation boundaries

A single persistent `multiprocessing` spawn process owns the controller, CUDA
objects and plant integration. HTTP remains in the parent process, so a native
solve holding the child Python GIL cannot block commands or history requests.
Use the existing experiment GPU locks for construction, solving and disposal.
No worker is started per solve. No compilation happens on a settings change.

Commands and output chunks have bounded queues. The parent drains child output
independently of SSE clients; it retains numerical history before any latest
frame coalescing. Backpressure may slow generation but never drops history.
Cancellation is checked after the current solve and between integration chunks.
It does not promise to interrupt a native solver call.

`settings_version` identifies effective settings. `generation` identifies a
particular history/job. Acceptance of an invalidating command updates generation
in the parent immediately, so old child outputs cannot overwrite new state.
Preserve or clear retained history intentionally at each command boundary;
cancelled work must never be presented as a completed requested recording.

## Authoritative history

Existing SSE `plan`, `state`, and `status` events remain useful for previews and
current status. They are not the playback recording. The history endpoint is:

```
GET /api/live/history?generation=G&after=C&limit=256
```

The initial cursor is zero. Records are append ordered; `next_cursor` is the
cursor to pass on the next request. The endpoint returns bounded pages:

```json
{
  "generation": 4,
  "next_cursor": 256,
  "complete": false,
  "history_end_s": 0.21,
  "records": []
}
```

`records` contains existing native `plan` and `state` payloads and the interval
records below. Every record carries `generation` and `settings_version`.
History includes the initial state, every integration endpoint, every solved
plan, and every completed timing interval. Saved states retain actual applied
torque. Predictions retain only their nonterminal control samples. A generation
mismatch returns HTTP 409; clients discard the obsolete page and synchronize
to the active generation. `complete` means the requested calculation finished,
not merely that this page has caught up with the producer.

SSE sends lightweight notices, also included when reconnecting:

```json
{"type":"history", "generation":4, "history_cursor":256,
 "history_end_s":0.21, "complete":false}
```

Notices may coalesce. The browser fetches serial pages until caught up, without
overlapping requests for the same generation. It rejects outdated generations
after every asynchronous response. History must not silently inherit the old
60-second/2000-sample/256-plan presentation eviction limits. One authoritative
recording supplies playback, scrubbing, executed path and trajectory fitting.

## Simulation clock and plan execution

Simulation time advances according to the requested rates, irrespective of
solve latency. Physics uses the unchanged RK4 function. Integer tick counters
and exact event boundaries avoid accumulating floating-point scheduling drift.
Noncommensurate rates require splitting an integration step at a control or TO
boundary. At a coincident boundary, solve first, select control next, then
integrate. The final state lands on the requested duration endpoint.

Decode each new GPU plan once to native coordinates. At every control tick,
choose the nonterminal torque for elapsed plan time using zero-order hold and
the independent prediction knot spacing. Hold that selected torque until the
next control update. If execution outlasts the prediction horizon, hold the
last nonterminal torque until replanning and mark `plan_exhausted: true` on the
affected state; never use a nonexistent terminal control. The existing upstream
controller warm-start heuristic remains intact.

Precalculation runs unpaced. On Play generation is paced to at most 1x and
slows when computation cannot keep up. Recorded playback advances at 1x
simulation time from browser elapsed time, interpolating native positions and
velocities between saved timestamps. It does not derive playback speed from
network arrival time. At an unavailable tail, hold position and show that
generation is pending; do not jump to the latest sample. Scrubbing and replaying
available history require no solver calls.

## Interval timing

Each TO execution interval, including the final partial interval, produces:

```json
{
  "type": "interval", "generation": 4, "settings_version": 3,
  "start_time_s": 0.0, "end_time_s": 0.03, "to_budget_s": 0.03,
  "solve_wall_s": 0.01, "physics_wall_s": 0.004, "total_wall_s": 0.015,
  "mpc_ratio": 0.333333, "physics_ratio": 0.133333,
  "total_ratio": 0.5, "severity": "none"
}
```

`solve_wall_s` measures the whole controller call using a monotonic host clock;
the existing solver timing remains separate. `physics_wall_s` measures plant
integration and control execution. `total_wall_s` includes serial execution
overhead, excluding deliberate pacing sleeps, rendering and transport work.
Setup costs are separate from recurring interval costs.

Red means `solve_wall_s > to_budget_s`, with the nominal TO period as the
optimizer deadline even for a final partial interval. Otherwise yellow means
physics or total serial computation exceeds the actual simulated interval
duration. Red wins when both conditions hold. Tooltips show the separate
costs and explain combined-only overruns without attributing them to physics
alone. Generation real-time factor compares simulated progress with generation
wall time; it never changes recorded playback speed. These are diagnostic
execution measurements, not experiment benchmark evidence.
