# Visualizer execution and recorded playback

This contract defines execution and authoritative history; [live-api.md](live-api.md)
defines task/settings payloads and events. The visualizer owns execution timing
and imports the unchanged
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
samples. Explicit precalculations have duration/rate/sample limits. Continuous
On Play retains its growing recording in disk-backed history until paused;
IPC chunks remain bounded and no recorded samples are silently dropped.
The UI hides `controller.warm_start` while retaining its complete config value.

`POST /api/live/command` retains its accepted/settings-version response.

- `set_settings`: existing complete `config` and `task`, plus `execution` and
  optional `anchor`. The first browser Live session sends `reset: true` instead
  of an anchor: settings and the comfortable zero-time state are applied
  atomically before preview or Automatic calculation. Later mode switches and
  reconnects preserve the session. `reset` must be boolean; a true reset cannot
  be combined with an anchor.
- `precalculate`: generate `duration_s` of closed-loop motion without pacing;
  optional `anchor` chooses its initial state.
- `preview`: compute one prediction at the optional displayed-state `anchor`
  without replacing existing motion history or moving its authoritative tip.
- `play`: produce motion from the authoritative history tip, paced at at most
  one simulated second per wall second in On Play mode, continuously until
  Pause or Cancel. `duration_s` limits only explicit Manual/Automatic
  precalculation; it never branches from a scrubbed frame.
- `pause`: stop On Play generation cooperatively. In Manual/Automatic mode it
  pauses browser playback while explicit precalculation continues.
- `cancel`: invalidate the current job cooperatively.
- `reset`: return to the comfortable pose, zero velocity and simulation time;
  clear the current history and episode plan sequence. Reset also recovers
  after a numerical failure: the discarded state, which may be nonfinite or
  beyond the solver's float32 range, never seeds the reconfigured solver.

An anchor is `{sim_time_s, q: [7 native positions], qd: [7 native velocities]}`.
The browser captures the displayed state once when a settings transaction
starts, including during playback, and keeps it frozen through debouncing and
the resulting calculation. It does not replace the anchor with arriving
background states. Figure-eight phase follows `sim_time_s`.

### Continuation from the displayed state — Felix, 2026-10-21

Domain terms are defined in [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md).
Changing execution settings starts a new active episode segment from the
displayed native positions, velocities and task time. For example, play to
10 s, scrub to 5 s, change settings, then calculate 10 s: the continuation
covers task/simulation time 5–15 s. It resets the controller for the changed
configuration while preserving the selected plant state and figure-eight
phase. The active UI history contains the new segment; it does not stitch in
the old 0–5 s prefix. Superseded history files remain on disk.

This accepted simplification does not add episode branching or change ordinary
Play, which extends the existing history tip without a settings edit. Plot
configuration, camera changes and inspection do not start a continuation.

Calculation modes are `on_play`, `manual`, and `automatic`. On Play generates
only as playback needs new history. Manual uses the Precalculate action to
generate a full bounded recording. Automatic invalidates stale work and
precalculates after settings changes from the frozen displayed anchor. Static
prediction remains one solve at the current state. Play with empty history
starts computation even when Continue is disabled; in Manual mode it may
precalculate the requested duration and autoplay when ready. Play with existing
history is local playback. Continue simulation at end governs extending the
existing tip for Manual/Automatic recorded playback; without it, that playback
stops at the end of its requested duration. On Play keeps generating and waits
at a growing tip regardless of this toggle, until the user pauses.

## Process and cancellation boundaries

The HTTP parent spawns one persistent simulation coordinator (`execution_worker`).
It owns the plant and `MultirateSession`, and calls a separate persistent
`solver_worker` through `SimulatorAdapter`/`SolverProcess`. The solver child
owns the upstream controller and CUDA state in its profile's prepared interpreter.
A native solve holding that child's GIL cannot block HTTP or CPU plotting.
The coordinator holds experiment GPU leases across construction, calls and
disposal; the child borrows those leases for each RPC. No worker is started per
ordinary solve, and settings changes never compile. See [solver profiles](solver-profiles.md)
for switching and lease lifetimes, and [inspection](inspection.md) for the
separate temporary Run again child and its explicit Stop behavior.

Commands and output chunks have bounded queues. The parent drains child output
independently of SSE clients; it retains numerical history before any latest
frame coalescing. Backpressure may slow generation but never drops history.
Cancellation is checked after the current solve and between integration chunks.
It does not promise to interrupt a native solver call.

`settings_version` identifies effective settings. `generation` identifies a
particular history/job. A replacement history gets a new generation immediately
in the parent. A separate cancellation revision invalidates in-flight work while
retaining the current generation on Pause/Cancel. Old child outputs cannot
overwrite new state; already committed records for retained history still drain.
Preserve or clear retained history intentionally at each command boundary;
cancelled work must never be presented as a completed requested recording.

## Authoritative history

Existing SSE `plan`, `state`, and `status` events remain useful for previews and
current status. They are not the playback recording. The history endpoint is:

```
GET /api/live/history?generation=G&after=C&limit=256
```

The initial cursor is zero. Records are append ordered; `next_cursor` is the
cursor to pass on the next request. Pages default to 256 and allow at most 2048
records; the browser requests 1024. These limits are independent of the worker's
256-record IPC packets. [Presentation settings](presentation.md) controls
report cadence without changing numerical clocks or dropping history:

```json
{
  "generation": 4,
  "next_cursor": 256,
  "complete": false,
  "history_end_s": 0.21,
  "records": []
}
```

`records` contains existing native `plan` and `state` payloads, explicit control
updates, and the interval records below. Every record carries `generation` and
`settings_version`. A control update has `type: "control"`, `sim_time_s`, native
`torque_nm`, `plan_seq`, `plan_elapsed_s`, and `horizon_exhausted` (also exposed
as `plan_exhausted`). Control timestamps distinguish when the held command
changed from endpoint state torques, which record the input producing that state.
History includes the initial state, every integration endpoint, every solved
plan, and every completed timing interval. Saved states retain actual applied
torque. Predictions retain only their nonterminal control samples. A generation
mismatch returns HTTP 409; clients discard the obsolete page and synchronize
to the active generation. `complete` means the requested calculation finished,
not merely that this page has caught up with the producer. Cancellation,
capacity exhaustion and a paused producer do not make an unfinished requested
duration complete; `status.job_active` separately reports active generation.

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
integrate. A bounded precalculation lands exactly on its requested duration
endpoint; continuous On Play has no duration endpoint.

Decode each new GPU plan once to native coordinates. At every control tick,
choose the nonterminal torque for elapsed plan time using zero-order hold and
the independent prediction knot spacing. Hold that selected torque until the
next control update. If execution outlasts the prediction horizon, hold the
last nonterminal torque until replanning and mark `plan_exhausted: true` on the
affected state; never use a nonexistent terminal control. The existing upstream
controller warm-start heuristic remains intact.

Precalculation runs unpaced. On Play generation is paced to at most 1x and
slows when computation cannot keep up. Recorded playback advances at 1x
simulation time from browser elapsed time. Live defaults to sample hold; optional
interpolation blends native positions and velocities between recorded timestamps.
The default 200 ms playback buffer is a simulation-time lead over the cursor,
measured from received history. It does not derive playback speed from
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
Internal chunks used for cancellation and bounded transport do not create
additional TO intervals: their measured costs accumulate until the TO boundary
or requested final endpoint.

Red means `solve_wall_s > to_budget_s`, with the nominal TO period as the
optimizer deadline even for a final partial interval. Otherwise yellow means
physics or total serial computation exceeds the actual simulated interval
duration. Red wins when both conditions hold. Tooltips show the separate
costs and explain combined-only overruns without attributing them to physics
alone. Generation real-time factor compares simulated progress with generation
wall time; it never changes recorded playback speed. These are diagnostic
execution measurements, not experiment benchmark evidence.
