# Visualizer execution and recorded playback

This contract defines execution and authoritative history; [live-api.md](live-api.md)
defines task/settings payloads and events. Live and experiments execute the same
`tiago_mpc.loops.run_virtual_time` function. The visualizer owns reporting,
playback and the callback gate that parks this invocation. `Mpc` remains in the
solver child and `SimPlant` in the coordinator. `scripts/check_conformance.py`
compares headless and observed execution of this shared loop.

`NativeSession` constructs one native `VirtualTimeSettings` from the accepted
execution settings and passes it as the required `settings=` argument to
`run_virtual_time(..., settings=settings, duration=..., ...)`. The settings object owns
only `command_period`, `update_period` and `solve_latency_s`.
Compensation, `ExecutionSafety(max_plan_age_s=...)` and effort handling are
separate loop arguments, serialized separately in effective settings.
The command law, callbacks, cancellation, start time and initial command remain
invocation arguments. Live supplies `sys.float_info.max` as a finite duration
and overrides the native experiment duration guard in the simulation process.
The callback gate pauses it and cancellation ends it. Conformance supplies its
actual finite duration so both runs collect the same terminal results.
Sources with the old `VirtualTime`
name or combined execution settings fail the source probe; there is no fallback.

## Settings and commands

`GET /api/live/schema` adds `defaults.execution`. Its control rate, TO rate,
solve latency and latency compensation are the selected source's
`run_virtual_time` defaults (`VirtualTimeSettings.constant_rate()`: a request
every TO period, its plan in effect one period later), here those of `tiago_mpc` main:

```json
{
  "simulation_hz": 1000,
  "control_hz": 500,
  "to_hz": 100,
  "solve_latency_s": 0.01,
  "latency_compensation": true,
  "max_plan_age_s": null,
  "calculation": "on_play",
  "duration_s": 10,
  "continue_at_end": false
}
```

Every execution field is required; the visualizer fills in none and keeps no default for the
native timing fields (control and TO rates, solve latency, latency compensation).
Simulation and command rates are positive and obey `simulation_hz >= control_hz >= to_hz`.
`to_hz=0` means back-to-back requests; a positive TO rate sets request slots.
`solve_latency_s` is `"measured"` or finite nonnegative seconds.
Measured latency is native `Plan.stats["wall_s"]`, exposed by the solver child as
`stats.step_wall_s`, not CUDA-event time or the whole solver RPC. Numeric latency
is declared simulation time; it does not shorten a real computation. Commands
default to 500 Hz, as `tiago_mpc`'s experiments (Felix, 2026-10-23); simulation
stays at 1000 Hz and TO at 100 Hz. What is recorded follows the control events,
not a setting; see [Recording](#recording).

**Latency compensation** is one optional checkbox, enabled by the native loop default. When enabled,
execution solves from the state forecast for its next command activation tick.
The native latency predictor uses its own `LatencyCompensation` model defaults;
matching that model to a changed simulated plant is an explicit configuration
choice. It evaluates the same command law as execution, including feedback and
friction compensation, then applies the same effort handling. Laws and policies
are pure callables. Forecasting propagates private robot state without publishing
actual commands or breach events.
Declared latency forecasts that delay; measured latency uses the previous completed
solve's native wall time, initially the package's 5 ms estimate. It never uses the
current solve's duration to predict its own input. Actual availability still charges
the declared/current measured delay. An early result waits for its predicted origin;
a late result keeps that origin and its resulting age. Reset, anchors and settings
changes start a fresh forecast. An instantaneous preview remains a solve from the
displayed measured state, without an execution delay. Prediction runs in the CPU
simulation coordinator and does not change the physical-robot lease policy.

`max_plan_age_s` is null by default, disabling the additional age deadline. A
finite positive value enables it. This does not extend a plan's finite horizon:
the native loop ends with `lease_expired` when the active plan cannot supply a
valid command. There is no implicit hold of the final knot beyond its horizon.
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
  kind change starts from the new task's saved session. Validation and numerical
  behavior match `set_settings`. Both support `expected_settings_version` and
  reject stale writes with HTTP 409 plus current `settings`. A patch changing
  only `execution.continue_at_end`, without anchor/reset, shares that playback
  preference without changing generation/version, history or numerical work.
  [Agent controls](agent-api.md) documents current-settings reads and examples.
- `reset_task_settings`: restore all four active-task settings groups from its
  effective defaults in one version-guarded, validated transaction. It clears
  only the active task's session overrides. Other task sessions and defaults stay
  intact. The browser discards invalid drafts and records one undoable settings
  change; the usual start-pose and history replacement rules apply.
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

**Obstacle edits keep On Play running (2026-11-02).** A settings edit pauses
playback, except an edit of the Live obstacles in the viewport (move, resize,
remove, paste) or a settings undo or redo (Ctrl+Z) made while On Play plays;
typed values in the obstacle list pause as other settings do. A drag or scale submits once, when
it ends. That edit starts its new segment from the state displayed
when it is submitted, not when it began, and playback continues: the browser
follows the new segment's tip, which Play extends as usual. Any other edit
before the submission makes the transaction an ordinary paused one.

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
It owns the plant and `NativeSession`, and calls a separate persistent
`solver_worker` through `SimulatorAdapter`/`SolverProcess`. The solver child
owns `tiago_mpc`'s `Mpc` and its CUDA state in its profile's prepared
interpreter; the coordinator imports no compiled GATO module.
A native solve holding that child's GIL cannot block HTTP or CPU plotting.
The coordinator holds experiment GPU leases across construction, calls and
disposal; the child borrows those leases for each RPC. No worker is started per
ordinary solve, and settings changes never compile. See [solver profiles](solver-profiles.md)
for switching and lease lifetimes, and [inspection](inspection.md) for the
separate temporary Run again child and its explicit Stop behavior.

Ordinary execution uses nonblocking requests and preallocated shared control
arrays, with a small private-socket notification per submission/result. The
plant advances under the existing plan while the child solves. Declared latency
allows advancement to the first command tick at/after availability and the
predicted origin. Measured latency is unknown until receipt, so the first
possible command tick is a conservative barrier. Zero declared latency waits
immediately. Scheduling/activation still belong to the shared native loop.

Solve captures use a separate recording ring in RAM-backed mmap files under
`solver-buffers/`. Its byte budget defaults to 256 MiB, configurable at server
startup with `TIAGO_VISUALIZER_RECORDING_BUFFER_MIB` (integer MiB, up to 4096).
The slot count is derived from that budget, including headers: normally 1023
slots, rather than the previous 64. Slot capacity is `max(256 KiB, 32*max_sqp_iters+64 KiB)`:
four per-iteration diagnostic channels at eight bytes each, plus fixed-horizon
data/metadata. The supported N128/100000-iteration fixture fits without truncation;
the default budget accommodates it. Pages are allocated as touched. Normal
five-iteration slots remain 256 KiB. Budgets must accommodate at least 64 slots
for the selected diagnostic configuration; insufficient budgets and oversized
captures fail clearly instead of truncating data.

The child reserves a slot, writes the shared control result and sends its
notification **before** constructing/serializing the capture. The coordinator
forwards the reservation's locator; only the independent ingestion process waits
for its payload readiness. The same child publishes the capture before receiving
the next request, so its owned initial state/reference/Plan and diagnostics remain
stable even when the coordinator reuses the control arrays. A discarded reserved
slot cannot be resurrected by late publication. A producer that ends before
publication yields an explicit error and releases the slot. Recording failures
quarantine the idle controller until leased reconfiguration/close; they do not
inject unsolicited control replies or deliberately tear down CUDA after pause.

Slots apply lossless backpressure when full. Retiring a ring keeps outstanding
published slots readable until consumed; cancelled/stale packets, failed queue
emissions and closed receivers release their slots. Shutdown drains queued
packets even after coordinator exit. Buffers
belong to the coordinator PID and ended owners' leftovers are removed at the
next allocation. These are implementation capacity bounds, not data dependencies.
Numerical batches contain at most 16 solve captures, with at most two batches
queued between the numerical thread and coordinator owner. Reporting forwards records
early after 32 captures to free slots, while browser announcements retain the
configured report deadline. A slow report rate therefore cannot strand the
producer behind records that the coordinator has not published yet.

A dedicated CPU ingestion process drains numerical packets in FIFO order. It
copies raw capture bytes and releases the solver slots without decoding their
diagnostics. It forwards owned binary packets through a separate byte-bounded
queue; only the HTTP/history process deserializes captures, derives FK, formats
statistics and encodes JSON. Pause, completion and profile messages stay ordered
after their preceding records. The ingestion queue defaults to another 256 MiB,
configured by `TIAGO_VISUALIZER_INGEST_BUFFER_MIB` (1–4096 integer MiB). Its
budget bounds queued serialized payload, not total RSS: the solver ring,
in-flight packets, multiprocessing serialization and rendered history consume
additional memory. Byte credit is returned when history receives a packet,
before expensive presentation work. A packet larger than the configured queue
budget is an explicit recording failure. Queue occupancy, peak byte usage and
capacity-wait time are available through `service.ingestion.metrics()` for
diagnostics. Shutdown drains/discards owned captures; stale generations remain
filtered by the history owner. An ingestion failure stops simulation with an
explicit error rather than silently losing records.

Both buffers retain lossless backpressure for simulation. They absorb transient
consumer delays but cannot compensate indefinitely for slower consumers. They
are not a real-robot telemetry policy: physical execution must not wait for
recording capacity, and would require explicit diagnostic dropping/gap markers
or a command/safety-system stop policy when recording is mandatory.

Commands and output chunks have bounded queues. Ingestion drains child output
independently of rendering and SSE clients; history retains numerical data before any latest
frame coalescing. Backpressure may slow generation but never drops history.
`NativeSession` runs one native invocation on a retained thread. It publishes
detached batches approximately every 10 ms of simulation without parking; only
a full batch queue applies reporting backpressure. The coordinator reads the
immutable `progress` snapshot returned with each batch, never the live adapter
or numerical counters. Snapshots include interval costs so cancellation restores
the exact committed tip and cannot charge unpublished work to retained history.
A callback in `before_tick_callbacks` blocks for explicit Pause and requested end boundaries;
resuming releases it without recreating the controller, pending plan, command
law or predictor. Pause drains the queued and final partial batches before its
acknowledgement. On Play retains its at-most-1× pacing and rebases its wall-time
anchor on resume; it uses short windows when ahead and runs continuously while
catching up to wall time. Precalculation is unpaced.
The gate runs before result collection. Outstanding work can finish while paused;
its reply stays unread until resume, preserving pending activation and optimizer
state. Releasing coordinator GPU leases closes its descriptors without explicitly
unlocking them: the solver child's shared descriptors retain the locks until its
solve and capture publication finish. Cancellation wakes the gate, joins the
invocation and disposes of unread results before replacing the session.
An applied-torque breach marks a pause request in the Tick callback; the native
loop collects outstanding work and re-enters the same gate before more physics.
The gate can therefore see the same timestamp twice, without a duplicate state
record. Ordinary command ticks capture owned arrays without taking the gate's
condition lock. An asynchronous Pause arriving after a nonblocking result poll
cannot park that callback while a solve is pending: the native post-Tick check
collects it and revisits the boundary before physics or lease release.
Compact numerical control/schedule tuples are expanded in the
consumer; a reach target is cached for the invocation.

Cancel sets a per-invocation flag and wakes the callback. The native loop checks
the flag after wake and after a solve, before further commands or integration.
Reset, reconfiguration and profile replacement join the old invocation before
discarding it, then construct a fresh plant, controller and forecasting state.
Cancellation does not interrupt a native solver call. Pause adds no special
memory-compaction or garbage-collection policy.

`settings_version` identifies effective settings. `generation` identifies a
particular history/job. A replacement history gets a new generation immediately
in the parent. A separate cancellation revision invalidates in-flight work while
retaining the current generation on Cancel. Ordinary Pause does not increment
the cancellation revision. Old child outputs cannot
overwrite new state; already committed records for retained history still drain.
Preserve or clear retained history intentionally at each command boundary;
cancelled work must never be presented as a completed requested recording.

## Authoritative history

Existing SSE `plan`, `state`, and `status` events remain useful for previews and
current status. They are not the playback recording. The history endpoint is:

```
GET /api/live/history?generation=G&after=C&limit=256
```

The browser uses `GET /api/live/playback` with the same selectors when the
schema advertises `live_playback.version=1`. This projection preserves every
non-plan record and the exact history cursor. Play plans are represented by
`summary:true`, their identity, timing, horizon and statistics; prediction
arrays, reference grids and diagnostics remain in authoritative full history.
Preview plans remain full, including when their sequence overlaps a play solve.
The projection is encoded once during ingestion into a compact companion file.
Full and compact indexes publish together only after both writes succeed.

`GET /api/live/plans?generation=G&ids=1,2` retrieves up to 32 distinct full
predictions in requested order through the retained plan index. It does not
scan history or repeat segment context. Both endpoints support gzip; stale
generations return 409, invalid selectors or missing plan IDs return 400.
`GET /api/live/events?compact=1` projects play predictions to summaries as well;
preview predictions remain full. Existing full history/SSE clients, server-side
plotting, Freeze exports and solve inspection retain their existing contracts.

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
control events, not at physics steps. `NativeSession` records every command,
every requested plan and every interval, and the simulated state at every command tick.
TO requests are quantized to command ticks, including at noncommensurate rates.
It also records the state at the end of each call (job end,
pause, a bounded chunk, which ends on a command tick) and at a detected breach.
`SolveCompleted` messages preserve every returned plan, including plans that
never activate. Separate Tick and Diagnostic callbacks supply commands and
numerical diagnostics; each callback group receives only its own payload type.
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
             "end_effector_frame": "...", "position_tol_m": 0.05, "speed_l1_tol_rad_s": 1.0,
             "world_from_root": [[...4×4...]], "collision": null}}
```

`settings` are the segment's complete effective settings: `config` (`to_dict(MpcParams)`
with the `plant` group: integrator, plant friction, limit handling and start pose), `task` and
`execution` (rates, calculation mode, duration); `source` is the simulator
checkout's identity. `simulator_identity`, `solver_profile`, `model_identity`,
`problem_configuration` and the bounds identify the plant, the predictor and the
installed problem. `task_path_xyz` is the figure-eight path (null for a reach);
`position_tol_m` and `speed_l1_tol_rad_s` are the arrival rule. `world_from_root`
(row-major) places the reduced arm's root frame (`torso_lift_link`) in the
display world at Live's body posture. `collision` is null while
`tiago_mpc`'s collision rows are off; with them it holds the spheres the rows see,
`{"arm": {"<link>": [[x, y, z, r], ...]}, "body": [...], "obstacles": [...],
"capsules", "boxes", "planes", "mechanism", "margin_m", "rho", "posture"}`: the arm's cover in its links'
frames, the body's cover and the obstacles in the root frame (capsules, boxes
and planes in `Collision`'s layouts), and the body
posture's joint positions, which must equal Live's drawn body. State, control,
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

Felix, 2026-11-03. Virtual execution accepts finite, correctly shaped plans.
Command laws return native `Command | Fault`; the loop's separate
`effort_handling` argument applies the selected effort policy to each `Command`,
returning `Command | Fault`. Requested and applied torque remain separate.
Faults propagate directly without an array-return compatibility fallback.
Two orthogonal simulation settings in `config.plant` handle them in Live
([settings](live-api.md#settings-object)):

- **Clip effort** (`clip_effort`, default true): at every command tick the
  selected law's total requested torque is clipped by native `EffortClip` to
  ± `tiago.limits().effort` before `SimPlant.apply`. The state and control records carry the applied (clipped)
  torque; a control record whose command clipping changed adds
  `planned_torque_nm`, the total requested torque before clipping.
  `mpc_torque_nm` retains the raw knot torque, and `requested_torque_nm` the
  complete law output before clipping. Every interval record
  carries `clipped_commands`, the number of clipped commands in it. Plans keep their
  planned torques.
- **Stop on breach** (`stop_on_breach: {position, velocity, torque}`, all
  true): the native plant's substep callback checks simulated values at full rate, never only the
  recorded ones: position and velocity at every physics endpoint against
  the raw URDF position and velocity limits, the applied torque (after
  clipping) at every command against the effort limit. Planned knots are never
  checked. A torque breach parks at the next command tick after its applied command.
  A position or velocity breach queues a native `Diagnostic` with its exact physics
  timestamp and state; the callback receives it and parks at the next command
  boundary. Detection is full-rate while stopping can lag by the remainder
  of one command period. The detection state is recorded, including between
  command ticks, with a breach record and the partial interval:

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
  the session stays ready, so `play` continues from the delivery boundary (in
  Manual/Automatic mode it calculates `duration_s` from there). The browser
  stops playback where it crosses a breach record, marks breaches on the
  history track, and Play at a breach-ended tip continues in every mode.

  Re-arming rule: a quantity of a joint breaches when it starts to be beyond
  its limit and re-arms once it is back within, so a value that stays beyond
  pauses once, not on every following tick. A value already beyond when a
  session starts (an anchor or settings change from a state beyond a limit) is
  armed only once back within. With clipping on, the applied torque cannot
  exceed the effort limit, so the torque box matters once clipping is off.

Native `run_virtual_time` defaults to `effort_handling=EffortClip()`. Live sets
`EffortClip(effort=...)` with the watched limits while clipping is enabled,
and `None` otherwise, leaving torque breaches to its pause watcher. Effective
settings record `law`, `safety`, `compensation` and `effort_handling` separately.
Native experiments can select `RejectOnEffort` or another callable accepting
`Command` and returning `Command | Fault`. Native `ExecutionSafety` implements
structural `SafetyInterface.validate(plan, t, state) -> Fault | None` with a
100 ms default age limit; Live explicitly disables age expiry by default.
Custom safety objects are allowed, but finite horizon validity is always
enforced. Robot execution retains its stricter safety checks.

## Simulation clock and plan execution

Simulation time advances according to the native loop's command and physics rates.
An asynchronous solve overlaps the independent plant interval; the loop waits at
the first possible activation boundary if its result has not arrived. The plan then
waits for its measured or declared latency while the old plan continues. Physics is `tiago_mpc`'s `SimPlant` (RK4 or semi-implicit Euler,
[friction](friction.md)) with substeps of at most 1/`simulation_hz`: each integration chunk applies the held command and advances
the plant to the chunk's end time. Every session (Reset, anchor, settings
change, rollback) starts a fresh `SimPlant` at the current native state on a
simulation clock at the current time, because that clock never moves backward.
Both execution paths use the native command schedule and plant substeps;
the observer never reconstructs or normalizes their integration grid.
At each command tick the native loop activates an available pending plan and
uses its `Schedule` when no solve is pending. Missed TO slots are
skipped, never queued. A new solve with positive latency remains pending; zero
declared latency can activate at its request tick. The active plan supplies the
command, then physics integrates. Bounded reporting/precalculation endpoints
round up to a command tick; continuous On Play has no duration endpoint.

At stationary startup no command has been applied: `SimPlant` holds the state
until the first plan activates, as the package loop does. A fresh session at a
committed tip preserves its last applied torque while waiting. An anchor supplies
q/qd/time without a held-command checkpoint: if it is moving, zero effort is
applied during the wait so its dynamics continue. The initial state records
`startup_command_source` as `position_hold`, `held_command` or
`zero_effort_moving_anchor`. Reset/anchors never borrow an unrelated tip torque.
Ordinary chunks and Pause retain pending plans; cancellation/rollback replaces
the session and discards its pending result.

Plan records keep `sim_time_s` at the actual request/history time. The separate
`plan_origin_time_s` dates the initial condition, in the future when compensated;
`measured_time_s` retains the original observation. Knot times remain offsets
from the plan origin. `request_time_s`, `available_time_s`, `scheduled_activation_time_s`,
`solve_latency_s` and `latency_overrun` describe the request and its earliest
possible activation; `controller_wall_s` measures the child's native controller
call, excluding the independent forecast and asynchronous recording consumer.
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
beyond the effort limit ([limit handling](#limit-handling)). At every control
tick the shared loop evaluates the configured command law; by default the
visualizer passes none and `run_virtual_time` uses its own default law
(`FrictionFeedforward()`: URDF coefficients over `PlanFeedback()`), followed by separate `EffortClip` effort handling. It holds that
resulting command until the next update. Native validation rejects nonfinite
arrays or invalid layouts; the RPC adapter additionally checks configured N, knot interval and request
timestamps before publishing a solve. Age expiry is optional, horizon expiry
is enforced, and a native termination is reported to the coordinator instead
of starting another invocation implicitly. The upstream controller warm-start
heuristic remains intact.

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

`solve_wall_s` measures the child's native controller call, including native plan
construction; the native GATO-step timing remains separate. `physics_wall_s`
measures plant integration and its step observers. These resource costs can
overlap and must not be added. `controller_foreground_wall_s` records the
visualizer adapter's request submission and result-wait time. `total_wall_s` measures active native invocation time, including
command evaluation and observer capture, excluding time parked in the callback,
deliberate pacing sleeps, rendering and transport work.
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
physics or total active computation exceeds the actual simulated interval
duration. Red wins when both conditions hold. Tooltips show the separate
costs and explain combined-only overruns without attributing them to physics
alone. Generation real-time factor compares simulated progress with generation
wall time; it never changes recorded playback speed. These are diagnostic
execution measurements, not experiment benchmark evidence.

ASAP can request many more solves than a fixed-rate run. If computation
and recording cannot keep up with simulation time, live playback buffers at the
growing history edge. That is slower-than-real-time simulation, not a missed
ASAP solve deadline. A declared latency remains a physical availability delay
regardless of TO mode; for example 50 seconds holds the initial command/pose
until the first plan becomes available. The measured-latency checkbox is
independent of the ASAP checkbox.
