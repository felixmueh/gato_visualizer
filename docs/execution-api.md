# Visualizer execution and recorded playback

This contract defines execution and authoritative history; [live-api.md](live-api.md)
defines task/settings payloads and events. The visualizer owns execution timing
and uses `tiago_mpc` unchanged: its model, `MpcParams` and `Mpc` (in the solver
child) and `SimPlant` (in the coordinator). No upstream warm-start policy is
changed. `scripts/check_conformance.py` compares this loop with `tiago_mpc`'s
`run_virtual_time` with a `Reach` task.

## Settings and commands

`GET /api/live/schema` adds `defaults.execution`:

```json
{
  "simulation_hz": 1000,
  "control_hz": 500,
  "to_hz": 100,
  "solve_latency_s": "measured",
  "latency_compensation": false,
  "calculation": "on_play",
  "duration_s": 10,
  "continue_at_end": false
}
```

Simulation and command rates are positive and obey `simulation_hz >= control_hz >= to_hz`.
`to_hz=0` means back-to-back requests; a positive TO rate sets request slots.
`solve_latency_s` is `"measured"` (default) or finite nonnegative seconds.
Measured latency is native `Plan.stats["wall_s"]`, exposed by the solver child as
`stats.step_wall_s`, not CUDA-event time or the whole solver RPC. Numeric latency
is declared simulation time; it does not shorten a real computation. Commands
default to 500 Hz, as `tiago_mpc`'s experiments (Felix, 2026-10-23); simulation
stays at 1000 Hz and TO at 100 Hz. What is recorded follows the control events,
not a setting; see [Recording](#recording).

**Latency compensation** is one optional checkbox, off by default. When enabled,
execution solves from the state forecast for its next command activation tick.
The forecast uses the simulated plant's configured physics, friction and armature,
and the same selected law, effort clipping and final total-command hold as execution.
Declared latency forecasts that delay; measured latency uses the previous completed
solve's native wall time, initially the package's 5 ms estimate. It never uses the
current solve's duration to predict its own input. Actual availability still charges
the declared/current measured delay. An early result waits for its predicted origin;
a late result keeps that origin and its resulting age. Reset, anchors and settings
changes start a fresh forecast. An instantaneous preview remains a solve from the
displayed measured state, without an execution delay. Prediction runs in the CPU
simulation coordinator and does not change the physical-robot lease policy.
`config.dt_s` is the independent prediction knot interval. The backend validates
all settings before acceptance. Static previews accept large positive SQP/PCG
budgets within the native integer range; the prior small MVP caps no longer
define their intended scope. Reject an unsupported history capacity before
starting a job with an explanatory error; never silently truncate duration or
samples. Explicit precalculations have duration/rate/sample limits. Continuous
On Play retains its growing recording in the current run's history until paused;
IPC chunks remain bounded and no recorded samples are silently dropped.
`warm_start` (shift or hold) is an ordinary `MpcParams` setting in the UI.

`POST /api/live/command` retains its accepted/settings-version response.

- `set_settings`: existing complete `config` and `task`, plus `execution` and
  optional `anchor`. The first viewer of an unconfigured backend sends `reset: true` instead
  of an anchor: settings and the zero-time state at the start pose are applied
  atomically before preview or Automatic calculation. Later mode switches and
  reconnects preserve the session. `reset` must be boolean; a true reset cannot
  be combined with an anchor. A `config.plant.start_pose_rad` that differs
  from the current one always starts a new run at t = 0 from the new start
  pose, as Reset; the browser sends `reset: true` with it, and an anchor sent
  with it is not used (Felix, 2026-10-23).
- `patch_settings`: `patch` holds any subset of `config`, `task`, `execution`;
  nested objects merge atomically, arrays replace and null stays null. A task
  kind change starts from the new task's defaults. Validation and numerical
  behavior match `set_settings`. Both support `expected_settings_version` and
  reject stale writes with HTTP 409 plus current `settings`. A patch changing
  only `execution.continue_at_end`, without anchor/reset, shares that playback
  preference without changing generation/version, history or numerical work.
  [Agent controls](agent-api.md) documents current-settings reads and examples.
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
- `reset`: return to the configured start pose (`config.plant.start_pose_rad`,
  default `tiago.Q_START`), zero velocity and simulation time;
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
covers task/simulation time 5–15 s. It reseeds the controller for the changed
configuration (with the warm-up, [live-api.md](live-api.md#commands-and-gpu-sharing)) while preserving the selected plant state and figure-eight
phase. The active UI history contains the new segment; it does not stitch in
the old 0–5 s prefix. The superseded run's history file is deleted
([runtime files](#runtime-files)).

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
owns `tiago_mpc`'s `Mpc` and its CUDA state in its profile's prepared
interpreter; the coordinator imports no compiled GATO module.
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

`records` starts with the generation's [segment header](#segment-header), followed
by native `plan` and `state` payloads, explicit control updates, and the interval
and breach records below. Every record carries `generation` and
`settings_version`; the generation names the segment whose header holds its
constant context. A state has `sim_time_s`, native `q`, `qd`, the applied
`torque_nm`, `ee_xyz`, `target_xyz`, `distance_m`, `arrived`, `plan_seq`,
`control_updates` and `horizon_exhausted`/`plan_exhausted`. A control update has
`type: "control"`, `sim_time_s`, native
`torque_nm`, `plan_seq`, `plan_elapsed_s`, `plan_activated` on the first command
from a new plan, and `horizon_exhausted` (also exposed
as `plan_exhausted`). Control timestamps distinguish when the held command
changed from endpoint state torques, which record the input producing that state.
History includes the initial state, every solved plan, every command, every
completed timing interval and the states at the control events
([Recording](#recording)). Saved states retain actual applied
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

## Recording

Felix, 2026-10-23 (replaces the `record_every` setting): Live records at the
control events, not at physics steps. `MultirateSession` records every command,
every requested plan and every interval, and the simulated state at every command tick.
TO requests are quantized to command ticks, including at noncommensurate rates.
It also records the state at the end of each call (job end,
pause, a bounded chunk, which ends on a command tick) and at a breaching tick.
Physics still integrates at `simulation_hz`; the steps between two recorded states
are simulated but not recorded. Nothing the session computes depends on what is
recorded: breach detection, plan exhaustion, overrun timing, clipping counts and
the step/command/solve counters see every step. Values derived from the history
(arrival flag and distance, limit use, plots and aggregates, the executed path,
playback) see the recorded states only; extrema between them are not recorded.
Finite jobs estimate stored states from this rule before starting
(`estimated_states`: a conservative command-plus-TO tick bound and the end).

At the defaults (1000/500/100 Hz) this records every 2 ms, exactly the times the
former default `record_every` 2 recorded: per simulated second 500 states, 500
commands and up to 100 plans/intervals, depending on solve latency. The conformance script records the same
way.

### Segment header

Every generation is one segment: Reset, settings changes (with their anchor),
precalculation and profile activation start one; ordinary Play extends it. Its
first record is a header holding everything constant within it, written once
instead of with every record:

```json
{"type": "segment", "generation": 4, "settings_version": 3, "sim_time_s": 5.0,
 "context": {"settings": {"config": {...}, "task": {...}, "execution": {...}},
             "source": {...}, "simulator_identity": {...}, "solver_profile": {...},
             "problem_configuration": {...}, "model_identity": {...},
             "joint_limits": {...}, "mpc_bounds": {...}, "constraint_bounds_native": [...],
             "task": {...}, "task_path_xyz": null, "task_anchors": {...},
             "end_effector_frame": "...", "position_tol_m": 0.05, "speed_l1_tol_rad_s": 1.0}}
```

`settings` are the segment's complete effective settings: `config` (`to_dict(MpcParams)`
with the `plant` group: integrator, plant friction, limit handling and start pose), `task` and
`execution` (rates, calculation mode, duration); `source` is the simulator
checkout's identity. `simulator_identity`, `solver_profile`, `model_identity`,
`problem_configuration` and the bounds identify the plant, the predictor and the
installed problem. `task_path_xyz` is the figure-eight path (null for a reach);
`position_tol_m` and `speed_l1_tol_rad_s` are the arrival rule. State, control,
plan, breach and interval records keep only their own data (a plan keeps its own
reference window, `reference_native`/`reference_xyz`, and `target_xyz`).

Every reader takes the context from the header: the history store returns a
retained plan merged with its segment's context (Run again), the preview store
starts with a copy of the header, the plot reader exposes it as `raw["segment"]`
(and its `joint_limits`/`mpc_bounds` as before), and the browser receives it once
per segment (history page or SSE `segment` event) and looks it up by generation.
Histories recorded before this format have no header and fail with "Live history
has no segment header" (development data; Felix agreed).

### History size

Measured on the GPU (2026-10-23, defaults, loss-free, stored JSONL, 2 s runs;
before: `8a84365` with `record_every` 2):

| Run | Before | After | Records per simulated second |
| --- | --- | --- | --- |
| Reach | 5.7 MB/s | 2.8 MB/s | 1200 (unchanged; plus one header) |
| Figure eight | 7.3 MB/s | 2.8 MB/s | 1200 (unchanged; plus one header) |

A state shrinks from about 3.4 kB to 0.8 kB, a command from 0.76 kB to 0.32 kB, a
plan from 36 kB (reach) or 52 kB (figure eight) to about 22 kB; the header is
16 kB (reach) or 31 kB (figure eight, with its path) once per segment. Plans are
now about 78 % of the bytes. The recorded values are identical at the same times
(states, commands, plans and intervals, excluding wall-clock fields), and every
plot output is identical by digest on the same data.

## Runtime files

Session freezes are exported into `freezes/p<pid>/` under this RAM-backed
runtime directory. Up to eight remain available in the replay catalog during
the server run, including across page reloads. Startup removes ended owners'
leftovers and shutdown removes the current owner's directory. Browser track
changes do not write config or delete recordings; Keep to disk is deferred.

Felix, 2026-10-23: runtime scratch lives in RAM-backed files, and the Live
history keeps only the current run. The runtime directory is
`<system temp>/tiago-mpc-visualizer-<uid>/` (Python's `tempfile.gettempdir()`, `/tmp`
on this host, which is tmpfs; created 0700; `TIAGO_VISUALIZER_RUNTIME_DIR` overrides
it; `runtime_files.py`, Linux tmpfs only). It holds `history/` (one JSONL
file per generation), `solves/` (preview captures of that generation),
`solve-inspections/p<pid>/<id>/` (Run again results, see
[inspection](inspection.md#fresh-inspection-service-and-binary-data-flow)),
`solver-processes/` (child logs, the last 16 kept) and `coordinator-lifecycle/`. The
server and everything it spawns (Build's compiler intermediates, Node's compile
cache) use the normal system temp directory. Only what must persist
goes to disk: uploads (`_expr_data/uploads/`), the config file (atomically rewritten
only when a setting actually changes), builds with their request, log and receipt
(`_expr_data/source-builds/`, plus modules in the GATO cache) and replays exported by
experiments.

`HistoryStore` deletes a generation's file when it stops being current (a new
generation: Reset, settings change, precalculation, profile activation; close at
shutdown or source restart) and, at start, files of ended server runs (names carry
the owner pid, so concurrent servers keep theirs). History pages and Run again
open the current file under the store lock, so a read in progress survives the
replacement; a request for a replaced generation gets "History changed" (HTTP 409
for pages). `HistoryStore.kept` is the hook for runs kept on purpose later; nothing
uses it yet. Startup prints the directory and warns when it is not on tmpfs or has
less than 512 MiB free; a full directory fails the run with a message naming it.

## Limit handling

Felix, 2026-10-23. Since `tiago_mpc` 436b419, `Mpc.result()` returns plans
whose torques exceed the raw URDF effort limit (the check moved into
`tiago_mpc`'s own `run` loop, which the visualizer does not use). Two
orthogonal simulation settings in `config.plant` handle them in Live
([settings](live-api.md#settings-object)):

- **Clip effort** (`clip_effort`, default true): at every command tick the
  selected knot torque is clipped to ± `tiago.limits().effort` before
  `SimPlant.apply`. The state and control records carry the applied (clipped)
  torque; a control record whose command clipping changed adds
  `planned_torque_nm`, the knot torque before clipping. Every interval record
  carries `clipped_commands`, the number of clipped commands in it. Plans keep their
  planned torques.
- **Stop on breach** (`stop_on_breach: {position, velocity, torque}`, all
  true): `MultirateSession` checks simulated values at full rate, never only the
  recorded ones: position and velocity at every physics endpoint against
  the raw URDF position and velocity limits, the applied torque (after
  clipping) at every command against the effort limit. Planned knots are never
  checked. A breach ends the session's call at that tick: a torque breach right
  after its command, before integrating; a position or velocity breach at the
  physics endpoint. The tick's state is recorded (also between command ticks),
  followed by a breach record and the partial interval:

  ```json
  {"type": "breach", "sim_time_s": 0.03,
   "breaches": [{"joint_index": 6, "quantity": "torque", "value": 371.7, "limit": 26.0}],
   "message": "Limit breach at 0.030 s: joint 7 torque 371.7 Nm beyond its effort limit 26 Nm (+1 more)"}
  ```

  `joint_index` is 0-based (the message counts joints from 1); `limit` is the
  bound crossed, signed. Breaches at one tick are ordered by relative excess
  (to the limit for velocity and torque, to the joint's range for position),
  and the message names the largest. The coordinator ends the job and reports
  `status` `paused` with that message and `breach: {sim_time_s, breaches}`;
  the session stays ready, so `play` continues from the breaching tick (in
  Manual/Automatic mode it calculates `duration_s` from there). The browser
  stops playback where it crosses a breach record, marks breaches on the
  history track, and Play at a breach-ended tip continues in every mode.

  Re-arming rule: a quantity of a joint breaches when it starts to be beyond
  its limit and re-arms once it is back within, so a value that stays beyond
  pauses once, not on every following tick. A value already beyond when a
  session starts (an anchor or settings change from a state beyond a limit) is
  armed only once back within. With clipping on, the applied torque cannot
  exceed the effort limit, so the torque box matters once clipping is off.

## Simulation clock and plan execution

Simulation time advances according to the command and physics rates. Solving
blocks the coordinator without advancing virtual time; the resulting plan then
waits for its measured or declared latency while the old plan continues. Physics is `tiago_mpc`'s `SimPlant` (RK4 or semi-implicit Euler,
[friction](friction.md)) with substeps of at most 1/`simulation_hz`: each integration chunk applies the held command and advances
the plant to the chunk's end time. Every session (Reset, anchor, settings
change, rollback) starts a fresh `SimPlant` at the current native state on a
simulation clock at the current time, because that clock never moves backward.
Integer tick counters avoid accumulating floating-point command/physics drift.
At each command tick the session activates an available pending plan, then calls
the package's `Schedule` only when no solve is pending. Missed TO slots are
skipped, never queued. A new solve with positive latency remains pending; zero
declared latency can activate at its request tick. The active plan supplies the
command, then physics integrates. A bounded precalculation lands exactly on its requested duration
endpoint; continuous On Play has no duration endpoint.

At stationary startup no command has been applied: `SimPlant` holds the state
until the first plan activates, as the package loop does. A fresh session at a
committed tip preserves its last applied torque while waiting. An anchor supplies
q/qd/time without a held-command checkpoint: if it is moving, zero effort is
applied during the wait so its dynamics continue. The initial state records
`startup_command_source` as `position_hold`, `held_command` or
`zero_effort_moving_anchor`. Reset/anchors never borrow an unrelated tip torque.
Ordinary chunks retain pending plans; cancellation/rollback replaces the session
and discards its pending result.

Plan records keep `sim_time_s` at the actual request/history time. The separate
`plan_origin_time_s` dates the initial condition, in the future when compensated;
`measured_time_s` retains the original observation. Knot times remain offsets
from the plan origin. `request_time_s`, `available_time_s`, `scheduled_activation_time_s`,
`solve_latency_s` and `latency_overrun` describe the request and its earliest
possible activation; `controller_wall_s` measures the forecast plus the whole RPC.
The actual first command is identified by its `plan_seq` and `plan_activated`.
State/control sequence IDs own historical association; a requested plan that
never commands stays inspectable without becoming applied motion. Freeze writes
the existing activation timings into optional prediction `stats`, including actual
`activation_time_s` (null if never commanded). It exports the prediction's future
origin and retains observation/request/origin timestamps under
`provenance.live.plan_timing`, separately from native solver statistics. Episode
and comparison plots index solve events by actual request time. Older recordings
without separate origins retain their recorded meaning.

Plans arrive native from `tiago_mpc`'s `Plan` (N−1 knot torques), possibly
beyond the effort limit ([limit handling](#limit-handling)). At every
control tick, choose the nonterminal torque for elapsed plan time using
zero-order hold and the independent prediction knot spacing (`hold_last`, the
law of `tiago_mpc`'s `sample_knot` except past the horizon). Hold that selected torque until the
next control update. If execution outlasts the prediction horizon, hold the
last nonterminal torque until replanning and mark `plan_exhausted: true` on the
affected state; never use a nonexistent terminal control (`sample_knot` would
raise there). The upstream controller warm-start heuristic remains intact.
Live deliberately retains this diagnostic hold beyond the horizon, configurable
effort clipping and simulated breach handling. It does not adopt the package
loop's 100 ms/horizon lease, whole-plan raw-effort rejection or global STOP.
The full blocking `run_virtual_time` also owns a fresh clock and plant lifecycle;
Live keeps its own coordinator to support pause, history and continuation.

Precalculation runs unpaced. On Play generation is paced to at most 1x and
slows when computation cannot keep up. Recorded playback advances from browser
elapsed time at the selected session rate (0.25–4×), forced to 1× while following
a growing Live tip. Live defaults to sample hold; optional
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
An interval ends at the next eligible request tick (or an explicit endpoint).
With TO Hz 0, `to_back_to_back` is true and there is no TO deadline:
`to_budget_s` and its deadline ratio `mpc_ratio` are null. The separate
`mpc_realtime_ratio` is controller wall time divided by actual simulated interval
span; physics and total ratios use that span as well. These measure simulation
compute throughput, not missed adaptive TO deadlines.

In fixed-rate TO, red means `solve_wall_s > to_budget_s`, with the nominal TO
period as the optimizer deadline even for a final partial interval. Adaptive
TO never gets a red TO-deadline marker. Otherwise yellow means
physics or total serial computation exceeds the actual simulated interval
duration. Red wins when both conditions hold. Tooltips show the separate
costs and explain combined-only overruns without attributing them to physics
alone. Generation real-time factor compares simulated progress with generation
wall time; it never changes recorded playback speed. These are diagnostic
execution measurements, not experiment benchmark evidence.

ASAP can request many more solves than a fixed-rate run. If serial computation
and recording cannot keep up with simulation time, live playback buffers at the
growing history edge. That is slower-than-real-time simulation, not a missed
ASAP solve deadline. A declared latency remains a physical availability delay
regardless of TO mode; for example 50 seconds holds the initial command/pose
until the first plan becomes available. The measured-latency checkbox is
independent of the ASAP checkbox.
