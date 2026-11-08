# Agent instructions

## Start here

Read [README.md](README.md) for launch and user workflows,
[UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) for domain terms, and
[the architecture guide](docs/architecture.md) for process ownership, source
files, checks and accepted decisions. Follow the topic links there for the
area being changed; update its existing contract when behavior changes.

For programmatic control, read [the agent API guide](docs/agent-api.md).
`scripts/control.py` reads current settings and the schema, patches Live and
presentation settings, sends simulation commands, and selects MPC sources or
solver profiles. Open viewers reflect shared settings changes. Use partial
patches and the documented version checks when editing an existing session.

Current Live uses a simulation coordinator plus a persistent solver child;
plots run in a separate CPU process. Report frequency and playback buffering
are presentation settings, independent of simulation/control/TO rates.
[Presentation settings](docs/presentation.md) documents their defaults and
lossless reporting. Run again is a separate cold inspection solve; exact
optimizer continuation remains unavailable.

## Goal: interactive MPC visualizer — Felix, 2026-10-21

This repository becomes an interactive visualizer for the TIAGo MPC in
`tiago_mpc`. It runs on the desktop host, not in a container, and Felix views
it in a browser on his laptop. It has a browser frontend, a Python backend, and
a small API around the MPC.

- **3D view:** pan, zoom and rotate around the full TIAGo, loaded from the
  canonical URDF. The view stays responsive while the solver runs.
- **Prediction mode:** from the current state, solve and draw the predicted
  trajectory, for example as a 3D tool-path line.
- **Play mode:** run closed-loop MPC. It replans continuously, executes the
  plan on the simulated plant, and updates the robot motion and the displayed
  prediction. Real time is the goal; the first version may run slower if the
  UI says so.
- **Replay:** saved recordings remain viewable, as in the existing MVP.
- **Tasks:** reaching first, then figure-eight tracking and others.
- **Live settings:** every setting can change while viewing, and the
  prediction follows immediately. This covers the cost weights, SQP iteration
  cap, PCG cap and tolerance, ADMM parameters, knot interval, and the number
  of knot points N. Each N needs its own compiled GATO module: prebuild the
  supported set during setup. Normal parameter/N changes never compile. The
  explicit Source / Build action may compile additional selected N values.
- **Inspection:** Python plot functions produce specs for Episode and Solve
  inspectors. Keep numerical derivations in Python and use the shared browser
  renderer for both the application and offline author checks.

The first deliverable is the interactive trajectory visualizer: prediction
mode with live settings, and play mode.

## UI design: let the design carry the information — Felix, 2026-10-22

Show state through layout, controls and visual encoding (selected values,
highlighting, reset arrows, colour). Add text only where it is really needed;
put secondary details in hover tooltips instead of permanent text, and do not
repeat what a control already shows. Match the existing dark blue palette and
code idiom; dialogs use the same palette as the workbench.

## Relationship to tiago_mpc — Felix, 2026-10-21

`tiago_mpc` keeps changing and the visualizer must follow it, but this project
avoids changes to `tiago_mpc`, including its GATO dependency, unless explicitly
authorized. Live requires the selected source to provide the shared-loop
callback, cancellation and command-law API. Locate it through
the configurable path (`--mpc-root` / `TIAGO_MPC_ROOT`, default
`../tiago_mpc-visualizer-base`). Do not add a submodule or move this repository unless Felix
decides so.

**Sources follow tiago_mpc main — Felix, 2026-11-08.** The visualizer supports
`tiago_mpc` main and branches based on it; it keeps no backwards compatibility with
older `tiago_mpc` interfaces (no detection, no fallbacks; an older source may fail
loudly). Selecting another checkout (Source / Build, `--mpc-root`) is for comparing
minor modifications of the code, not different interfaces: an interface change
lands on `tiago_mpc` main first, and the visualizer follows it.

The producer-side replay exporter is the explicitly requested exception:
`tiago_mpc/experiments/replay.py` (`export_replay`, `save_replay`; it moved
there from `experiments/tools.py` with the 2026-10-22 `tiago_mpc` refactor).
Keep one lightweight implementation there; visualizer tests can use it to
create portable recording fixtures.

### The tiago_mpc API the visualizer uses — Felix, 2026-10-22

**Settings ownership — Felix, 2026-10-27:** descriptors and UI-to-native adapter
functions belong to this visualizer repository (`adapters/`). Features, such as
the collision rows (2026-11-08), go into the bundled standard adapter
`adapters/tiago.py`. An optional locally ignored `<checkout>/_visualizer/_settings.py`
override remains only for a local experiment with a modified checkout. The friction
controls (armature, predictor friction, execution laws) were folded into the
standard adapter on 2026-11-08.
Keep native algorithms/defaults in `tiago_mpc`; require no tracked visualizer
hook or tests there. Preserve resolved values, actual adapter path/hash and
explicit model availability/Build checks. See `docs/source-settings.md`.

**Common compilation controls — Felix, 2026-10-27:** offer all supported knot
counts and allow uncompiled predictor settings as editable drafts. Shade missing
models and show one explicit Compile action at the top center of the viewport.
Resolve actual native parameters and ask `find_binary`; never duplicate cache
identity in the visualizer. Build exactly the frozen draft through the existing
Build service, then recheck the latest draft before accepting it. Retain edits
made during Build and reject stale source/profile/cache/adapter results. Field
`effect` metadata declares runtime versus compiled-model check dependencies;
native lookup decides availability. Runtime annotations reuse readiness, while
unannotated predictor fields are checked conservatively. Goal/task, execution
and simulation/law edits never invalidate predictor readiness. Keep checks
asynchronous and hidden, with target handles editable during checks. Keep
per-joint friction and armature coefficients in code;
expose enablement toggles, laws and smoothing widths. PD gain vectors stay in
the code-owned tuned preset as requested later in the same session.

**Timing and comparison UI — Felix, 2026-10-27:** use the shared time-input
parser for typed Hz/period units; retain numeric API units and equivalent typed
spelling. Measured latency and as-fast-as-possible TO are separate checkboxes
with disabled, retained numeric drafts. Task setup belongs directly below Task;
keep plant controls together and distinguish them from MPC bounds. Comparison
plots use a contextual tab and their own extensible `@plot_comparison` functions,
including tracking, smoothness and a generic recorded-channel plot. Analysis
runs in the separate CPU worker. Preserve all recorded samples/statistics;
avoid needless prediction geometry when comparing execution. See `docs/plot-api.md`.

Supersedes the 2026-10-21 import list under "Visualizer timing ownership"
(`reach_sim.py`, `reaching_config`). Reason: the `tiago_mpc` refactor removed
`reach_sim.py`, the JSON configurations and their resolver; the visualizer
follows the package API that experiments use, without shims.

- **Compilation is explicit in `tiago_mpc`.** `find_binary(params)` is a
  read-only lookup; `compile_binary(params, use_cache=True, jobs=…)` compiles on
  the CPU (a no-op when cached); `Mpc(params, binary)` only loads and never
  compiles. Live constructs `Mpc` from `find_binary(params)` and reports
  "not compiled" otherwise. The visualizer has no module discovery or plant
  naming of its own.
- **Settings are `to_dict(MpcParams)`** plus the visualizer's `plant` group
  (the simulated plant); `task` and `execution` are unchanged. No configuration
  files are written.
- **Live** steps `tiago_mpc.sim.SimPlant` in the simulation coordinator (a
  fresh plant on Reset, anchor or rollback, on a simulation clock) and runs
  `Mpc` in the visualizer's own solver child (ADR 002 unchanged). The
  coordinator imports no compiled GATO module. Diagnostics come from
  `mpc.step`, plan statistics from `Plan.stats`.
- **Replays:** the MPC-bound overlay comes from the replay's
  `provenance.params`. The legacy default recording loader is gone; the app
  starts at the start pose.
- **Run again on recordings from before the migration** reports
  "unavailable: pre-migration recording"; there is no converter.
- **Stable default source (Felix, 2026-10-24):** use the sibling
  `../tiago_mpc-visualizer-base` worktree on `visualizer/base`. Advance it only
  when Felix requests it, from a clean worktree with `git merge --ff-only main`,
  then sync its own uv environment and use Source Apply to restart the backend.
  Do not automatically track main or copy its uncommitted working changes.
  The older `tiago_mpc_vis_baseline` worktree remains retired.
- **Current package API (Felix, 2026-10-28):** stable base is `221acad` (TIAGo main with GATO 0.1.7 and native cost menus, advanced 2026-11-03): its settings follow GATO's defaults, so a None in `MpcParams` (warm_start, reset_rho_each_step, admm_linsys, linsys, the thresholds, the `AdmmLimits` fields) is offered as the choice "GATO default". An MPC's `params` are the values GATO resolved; the solver worker's configure reply sends them as `resolved`, `effective_settings.params` holds them, and the panel shows them as "GATO default (value)" while a field follows GATO. Friction holds coefficients only; `SimConfig.friction_law` and `MpcParams.friction_law` select evaluation separately, and predictor armature is explicit.
  Construct the plant with `SimConfig(q=..., qd=..., substep=..., friction=...,
  friction_law=..., integrator=...).build()`, then call `start(VirtualClock(sim_time_s))`.
  Friction is coefficient-only; `MpcParams.friction_law` and `SimConfig.friction_law`
  select their laws separately. The standard adapter keeps the native defaults without
  controls; a source settings adapter (docs/source-settings.md) may control both.
  State/Plan live in `tiago_mpc.interfaces`. Native configurations round-trip
  through `record.to_dict` / `from_dict`, with fixed `type` metadata hidden
  from UI controls; never discard friction-law identity with `asdict`.
  GATO identity comes from `record.provenance()["gato"]`. Solver calls use
  `Mpc.request` and `Mpc.result`; `Mpc.step` holds the latest raw result for
  diagnostics. The conformance reference uses `run_virtual_time` with explicit
  declared `solve_latency_s=.0055` on both sides. Since 2026-11-03 the visualizer
  invokes `loops.run_virtual_time` directly through `NativeSession`, retaining
  reporting/history ownership. `NativeSession` constructs native
  `VirtualTimeSettings` and passes required `settings=` and a finite `duration=`;
  that object contains only command/update periods and solve latency.
  Compensation, `ExecutionSafety(max_plan_age_s=...)` and effort handling are
  separate invocation arguments. The source probe requires this API;
  the old `VirtualTime` name and combined settings have no fallback.
  Normal Live uses measured solve latency. Its simulation process relaxes the
  native experiment duration guard and uses a finite maximum duration, ending
  by cancellation; conformance uses its actual finite test duration.
- **The reduced arm is derived, not a file in the checkout** (tiago_mpc,
  2026-10-23). `tiago.arm_urdf()` derives it with the grasp frame from
  `models/tiago_pro/tiago_pro.urdf` into the cache (`GATO_CACHE_DIR`) and
  returns its path; `tiago.runtime_urdf(friction)` the GPU copy. The display
  model is still read from the checkout's full URDF and meshes, which must be
  real files: a Git LFS pointer is a source error.

### Warm-up and the SQP time limit — Felix, 2026-10-23

Follows `tiago_mpc` 31c405a (steps 15 and 16), which the source probe now
requires: `MpcParams.budget_s` became `max_sqp_time_s` (default 10 ms, wall
clock only) and `warmup` a boolean with `Mpc.warmup(state, reference)`.

- **No SQP time limit by default.** Live and precalculation run on the
  simulation clock, so Live's default is `replace(TIAGO, max_sqp_time_s=None)`,
  shown as "none"; the user can still set a limit. `warmup` keeps `TIAGO`'s
  default (on).
- **Every reseed warms up.** Configuring, Reset, anchors, previews and rollback
  reseed the solver child's controller with `Mpc.warmup`
  from that state and the task reference a request then gets; with `warmup`
  off that is the plain controller reset. A reseed repeating the previous one
  with no solve in between is skipped. Ordinary Pause/resume retains the native
  invocation, pending plans and warm state without reseeding. The warm-up is no plan, creates no
  record, is not part of interval timing and, like a solve, has no RPC
  deadline.
- **Build refreshes Live without a restart.** Building only adds modules for
  the same interpreter and cache, so a successful Build into the active
  solver's own checkout, interpreter and cache updates the available N in the
  running backend and browser. Apply and its restart remain for source,
  interpreter or cache changes.

### Trial changes to tiago_mpc — Felix, 2026-10-22

To try a change to `tiago_mpc` from visualizer work, create a `tiago_mpc`
worktree; this is always fine. Mark new trials clearly: directory
`<tiago_mpc-main-checkout>/worktrees/visualizer-trial-<topic>` on branch
`visualizer-trial/<topic>`. Select it through Source / Build or `--mpc-root`.
Use relative Git links as described below; leave existing trial worktrees where they are.
Never commit, merge, rebase or cherry-pick anything onto `tiago_mpc` main
without discussing it with Felix first; report what the trial showed and
propose the change instead.

### Plotting and solver inspection

Use the typed `gato_visualizer.plotting` API with `@plot_episode` and
`@plot_solve`. Always load bundled `plotters/`; the configurable extra directory
defaults to `<selected tiago_mpc>/_visualizer`. See `docs/plot-api.md` and
`docs/plot-authoring.md` for the contract and deterministic offline checks.
Plot evaluation runs in a separate CPU process and must not enter the native
MPC critical path. Missing recorded telemetry stays unavailable. The `.solver`
escape hatch is for explicitly attached local prototypes, never a current
mutable solver masquerading as a historical Solve.

The episode cursor follows recorded simulation time. The Solve inspector's
separate cursor selects recorded SQP iterations; it is not a horizon cursor.
Pinning retains the selected Solve and SQP iteration without pausing execution.
Only render intermediate trajectories when actually recorded. Exact Continue
SQP requires an optimizer checkpoint API; do not substitute another warm-seeded
solve while describing it as exact continuation.

### Shared execution loop — Felix, 2026-11-03

This supersedes the 2026-10-21 independent timing-engine decision. Live and
experiments use `tiago_mpc.loops.run_virtual_time`; do not duplicate scheduling,
activation, forecasting or command evaluation here. `NativeSession` retains a
single invocation on a coordinator thread, publishes detached batches through a
bounded queue, and parks its before-tick callback for Pause/end boundaries.
Read committed `progress` snapshots from the owner; the native thread owns the
live adapter and numerical counters. Pause drains published batches and parks
before result collection, retaining an unread solve until resume. Closing the
coordinator's GPU descriptors leaves outstanding child work holding its leases.
Cancel sets a per-invocation flag and
wakes/joins it before replacement. Reset/settings/profile changes create fresh
plant, controller, law and forecast state. On Play wall-clock pacing stays here
and rebases on resume; precalculation is unpaced. No special pause memory policy.

Use separate native Tick, SolveCompleted and Diagnostic callback sequences; every returned plan
is observable even if never activated. Full-rate physics observers queue breach
events until the next command boundary, retaining exact detection time/state.
Command laws return native `Command | Fault`. The separate `effort_handling`
argument defaults to `EffortClip`; experiments can select `RejectOnEffort`.
Live passes `EffortClip` with its watched effort limits when clipping is enabled,
and `None` otherwise so its breach watcher can pause on applied torque.
Effort handlers accept `Command` and return `Command | Fault`; a law or handler
fault propagates without an array conversion fallback. `ExecutionSafety`
implements structural `SafetyInterface.validate(plan, t, state) -> Fault | None`;
custom safety objects are allowed, while the finite horizon is always enforced.
Latency prediction evaluates the same law and effort handling with private
hypothetical state. Keep forecast computation in the numerical path.
`ExecutionSafety.max_plan_age_s` is configurable, null in Live by default;
finite horizon validity still applies and there is no implicit final-knot hold.
The physical robot retains stricter safety checks.

Keep the solver and numerical coordinator in separate processes for every
profile. Requests are asynchronous; advance the independent plant interval
before waiting at a possible activation boundary. Use preallocated shared
control arrays plus small notifications, and a separate bounded recording ring
consumed by the raw ingestion process. It releases slots before the HTTP/history
process decodes captures or derives geometry. Preserve every observation with explicit
backpressure. Reclaim stale/cancelled slots and retain retired rings until their
published records are consumed. Close borrowed GPU descriptors without explicit
unlock so outstanding child work retains its leases. Move diagnostic formatting, FK and JSON out of the numerical path;
measure total wall directly because physics and solver costs overlap. Keep upstream GATO unchanged and native warm-start behavior intact.
See [ADR 001](docs/adr/001-upstream-and-clocks.md).

Expose simulation, control and TO/replanning frequencies separately from the
prediction knot interval. The simulation clock follows the requested schedule;
slow computation reduces wall-clock real-time factor. Record MPC and physics
costs separately. Replay-bar overruns are red for MPC and yellow for simulation,
with red taking precedence when both apply. Identify combined-only overloads
explicitly rather than claiming that physics alone exceeded its budget.

Manual and automatic precalculation run the full closed-loop simulation for the
requested duration. New parameter edits invalidate obsolete calculation jobs;
automatic jobs use a frozen displayed starting state. History playback follows
recorded simulation timestamps at the session playback rate, with a separate
"Continue simulation at end" toggle. Imported Replay recordings remain
independent of Live settings.

**Live commands at 500 Hz — Felix, 2026-10-23.** Live's default Control Hz (the
thesis's command rate) is 500, as `tiago_mpc`'s experiments; simulation 1000 Hz
and TO 100 Hz are unchanged, and the labels stay.

**Live history format — Felix, 2026-10-23** (replaces the **Record every**
setting `record_every` of the same day). Two rules:

- **Record at the control events.** The history records every command, plan and
  timing interval and the simulated state at every command tick and every TO
  update (the union of both), plus the end of each call and a breaching tick.
  Physics still integrates at Simulation Hz; nothing the session computes
  (breaches, plan exhaustion, overruns, clipping counts) depends on what is
  recorded. There is no recording setting and no "thinned" label.
- **Constant context once per segment.** Each generation's history starts with a
  `segment` header holding everything constant within it: the complete effective
  settings (config with its plant group, task, execution), the source identity,
  simulator and solver-profile identities, problem configuration, joint limits,
  MPC and constraint bounds, task path and anchors, arrival rule. State, control,
  plan, breach and interval records keep only their own data and name their
  segment by `generation`. Every reader (history store, plots, previews, Run
  again, browser) takes the context from the header; the browser receives it once
  per segment. Histories without a header (recorded before this change) fail
  clearly; there is no converter.

See [recording](docs/execution-api.md#recording) and
[segment header](docs/execution-api.md#segment-header).

**The Live history keeps only the current run — Felix, 2026-10-23.** A run's
history file and its preview captures are deleted when the run stops being the
current one (a new generation, Reset, settings or profile change, shutdown or
restart); files left by ended server runs are deleted at start; solver-process
logs keep the last 16. Readers of a replaced run get "History changed". Runs kept
on purpose (a later comparison feature) go through `HistoryStore.kept`.

**Avoid excessive disk writes — Felix, 2026-10-23.** Runtime scratch such as the
Live history lives in RAM-backed files (tmpfs, Linux only); write to disk only
what must persist. Reasons: the visualizer must run on HDDs, and SSD wear. The
runtime directory is `<system temp>/tiago-mpc-visualizer-<uid>/` (Python's
`tempfile.gettempdir()`, `/tmp` on this host, which is tmpfs; mode 0700),
overridable with `TIAGO_VISUALIZER_RUNTIME_DIR` (`runtime_files.py`); it holds the
Live history, preview captures, Run again results, solver-process and coordinator
logs. The server and its children use the normal system temp directory; nothing
points `TMPDIR` into the checkout (Felix, 2026-10-23). Uploads, config, builds and their logs and
exported replays stay on disk; the config file is rewritten only when a setting
changes. **Run again results keep only what is still needed (Felix, 2026-10-23):**
they belong to the Live run or loaded replay they came from and are deleted when it
stops being current (new generation, another recording or revision loaded), on
failure or cancellation, at shutdown and, as leftovers of ended servers (pid-owned
directories), at start. They no longer survive a restart.
Startup warns when the directory is not on tmpfs (for example a distribution whose
`/tmp` is on disk; then set the override to a tmpfs such as `/dev/shm`) or nearly
full. See [runtime files](docs/execution-api.md#runtime-files).

Conformance (amended 2026-11-03): `scripts/check_conformance.py` runs the
same native loop headless with in-process `Mpc` and through Live's adapter,
solver child and `NativeSession`. Compare every command-tick state, command and
returned plan, including unused plans, on the native integration grid. Default:
loss-free RK4 reach, 1000 Hz physics, 500 Hz command, 100 Hz TO, 5.5 ms declared
latency, age expiry off, no SQP time limit, warm-up on. Additional rates/latency
and compensation are explicit options. Do not normalize tick times with a
second integration grid. Retain raw outputs; this proves only the selected
numerical case, not throughput or all-profile equivalence. Historical results
from the old scheduler are historical evidence only.

## Session model — Felix, 2026-10-23

Live always has a browser-owned session with main track Live (current generation,
offset 0), one session clock, transport and focus. Library recordings and RAM
freezes are immutable replay tracks, aligned by presentation-only offsets;
freezes default to 0, library replays align starts. Focus remains on Live in
this phase; scene/Joints/Episode/Solve reads go through the focused track.
Settings and the target gizmo always edit Live; a pinned Solve keeps its source.
Live history playback may run at 0.25–4×, with 1× forced while following a
growing Live tip. Stop plays to the session end; Continue retains Live's tip
extension/waiting. The aggregate window and zoom belong to session time and
survive generation changes. The UI has one Live workspace without Replay/Live
tabs. The searchable Add track dialog previews recorded paths and owns imports;
existing `?replay=` links add a track without changing focus or the main run.
Freeze exports through the selected `tiago_mpc`'s `save_replay`, rewinds the
cursor to the run start, and retains up to eight files in the server-owned
RAM runtime directory. Track loading never switches the legacy current Replay.
Do not add focus switching, Keep, comparison plots, session persistence or
historical branch browsing in this phase. Replay names are editable, initially
A/B/C. The compact ruler sits above Live and aggregate barriers/shading span
all rows. Hover settings above Precalculate edit duration; those above Ghost
arms edit optional fixed spacing and a strict total maximum. Ghosts cycle
off/Live/all tracks; fixed-spacing keyframes follow the aggregate range from
its left edge, truncating the prefix at the maximum. With spacing disabled,
each source's allocated count spans the whole aggregate range, including
endpoints, restricted to recorded support. Zoom never changes ghost selection.
UI settings set start/end opacity (55%/25% defaults), interpolated by aggregate
time independently of the cursor. Recorded On Play playback respects
Stop; starting an empty On Play run still calculates continuously until paused.
Live's Arm button hides/restores the solid right arm without hiding ghosts,
changing the session clock or requesting numerical work. Other tracks keep
their Arm/Dot display toggle.
See [presentation](docs/presentation.md#session-and-tracks).

## Model and coordinates

The canonical full model is `models/tiago_pro/tiago_pro.urdf` in `tiago_mpc`.
Recorded plant states and portable NPZ predictions use native joint coordinates.
GATO works in native coordinates too: `tiago_mpc`'s GPU URDF keeps joint 6's
-z axis (2026-10-30), so Live plans, controller resets, installed bounds and
new inspections need no sign conversion. Legacy packed solver predictions and
raw inspection XU arrays saved before then use the GPU convention and decode
with their recorded `signs`; new inspections record all +1. Do not
sign-convert native data.

All displayed points must share the full robot's root frame. Derive the
reduced arm's torso-to-world transform from the full URDF rather than adding
a guessed offset. Playback uses sample timestamps; Live defaults to sample hold
with optional interpolation, while imported Replay interpolates between samples.
Prediction playback is distinct from recorded simulated MPC motion.

## Simulator versus MPC model — Felix, 2026-10-22

The simulator may be more realistic than the MPC's predictor model (for
example armature or friction in the plant only); a simpler MPC model is
expected, as on the real robot. A plant/predictor difference is a supported
configuration, not a defect. Label which model each displayed element uses and
keep the difference visible in metadata.

The supplied arm friction, damping and armature values are questionable.
Develop with them, keep coefficients configurable, and make plant/predictor
coefficient mismatch easy to set up for robustness checks; identified values
come later and matter for tuning, not for the design.

**Friction defaults — Felix, 2026-10-26:** simulate with URDF friction,
the constraint Coulomb law and semi-implicit Euler by default. Predictor friction
retains its separate loss-free default. This supersedes the older loss-free
simulated-plant default. The plant (`config.plant`) maps onto `SimPlant`'s options:
integrator RK4 (loss-free only) or semi-implicit Euler (default); plant friction (URDF coefficients, Euler
only) with a tanh (settable width, default 0.03 rad/s), sign or constraint
(default) Coulomb law. Predictor friction is a compiled variant whose tanh width
is fixed at 0.03 rad/s and not settable, since each width is its own compiled
plant. See [friction](docs/friction.md).

**Limit handling in Live — Felix, 2026-10-23.** `tiago_mpc` 436b419 moved the
raw-effort check out of `Mpc.result()` into its own `run` loop, so the solver
child now receives plans whose torques exceed the raw URDF effort limit; the
visualizer's own loop decides what to do with them. Two orthogonal simulation
settings in `config.plant` (the **Limit handling** group), never part of
`tiago_mpc`'s robot path, which never clips:

- **Clip effort** (`clip_effort`, default on): each command is clipped to ± the
  raw URDF effort limit (`tiago.limits().effort`) before it reaches `SimPlant`.
  A clipped command records its `planned_torque_nm`; each interval counts its
  `clipped_commands`.
- **Stop on breach** (`stop_on_breach.position` / `.velocity` / `.torque`, all
  on): judged only on simulated values, at full rate (every physics endpoint
  for position and velocity against the raw URDF limits, every command for the
  torque actually applied after clipping, so with clipping on the torque box
  cannot trigger). Planned knots that are never applied never breach. Live
  pauses calculation at the next command boundary and playback at the detected
  breach, with a message naming joint, quantity, value and limit; Play continues. A quantity of a joint
  breaches when it starts to be beyond its limit and re-arms once back within
  it, so a value that stays beyond pauses once; a value already beyond when a
  segment starts is armed only once back within.

See [limit handling](docs/execution-api.md#limit-handling).

**Start pose — Felix, 2026-10-23.** The seven native joint positions the
simulated arm starts from at t = 0 (velocities zero) are a Live setting,
`config.plant.start_pose_rad`, default the simulator source's `tiago.Q_START`,
within the raw URDF position limits. It is in the segment header's settings like
every Live setting. Changing it starts a new run at t = 0 from it, as Reset (not
an anchor in the middle of a run); Reset returns to the configured start pose.
The Joints tab edits it: a lock left of Gauges/Numbers, locked by default and
remembered per viewer, keeps the tab read-only; unlocked, in Live with the
cursor at t = 0, the position column (headed START) is the start pose: dragging
a gauge shows the arm at once (scene only) and commits on release, a Numbers
cell commits on Enter, a reset arrow beside a modified joint restores that joint.
A Reset button left of the lock, always shown (also locked), is disabled while the
start pose is the default and otherwise, even mid-run, restores the whole start pose in one
settings change; it replaces the former all-joints arrow and the lock's dot. A pose outside the
MPC planning box (URDF range less `joint_margin_rad`) is flagged, not blocked.
Away from t = 0 or locked, the tab is read-only as before. Recorded comparison
tracks stay read-only. Task geometry (reach target, figure-eight start) stays tied
to `Q_START`. The initial scene shows the arm at `Q_START`. "Start pose" is the one term; the former
"starting pose" of the default scene is the same thing.

## Browser checks — Felix, 2026-10-23

**Viewport start-pose editing — Felix, 2026-10-24.** Viewport editing does not
require a lock; the Joints tab's lock protects only its gauges and number fields.
Changing that lock must not clear viewport selection or cancel a viewport drag.
Keep the existing Live, paused, t = 0 eligibility. Click an arm link for its single native-axis joint
ring, or the gripper/grasp handle for browser pose IK. Both edit
`plant.start_pose_rad`, preview locally and commit once on release, starting a
new run at zero. Escape cancels a drag. Rings clamp to raw URDF limits; IK uses
the planning box per joint when the drag began inside it, otherwise raw limits.
Flag planning-box excursions in amber. An unreachable request gets a tether
and snaps to the achieved grasp point on release. Grasp pose editing supports orientation, with Shift during translation freeing it.
There are no collision checks or editing during playback/Replay. Keep the CPU FK/Jacobian
fixture and runtime recorded-grasp guard; metadata comes from the simulator
source even when a separate solver profile is selected.

Playwright (a pinned devDependency; Chromium only, in `~/.cache/ms-playwright`,
installed with `npx playwright install chromium`) lets an agent check the real
UI headlessly. Start your own server on your own port (`./scripts/start.sh --port
<port> --config _expr_data/<name>.json`, GPU rules apply once Live solves), write
the script under `_expr_data/` (ES module, `import { chromium } from 'playwright'`,
`chromium.launch()`, `page.goto('http://127.0.0.1:<port>/')`), save screenshots
there too, and stop the server afterwards. Never drive Felix's viewer on port
8090; read-only screenshots of it only if he asks. Rebuild (`npm run build`)
after frontend changes; the server serves `dist/`.

## What the display claims

The display must not let a viewer mistake one kind of data for another: a
prediction is not executed motion, simulated time is not solver time, a finite
plan does not show that the solver converged, and a final plan shown as context
is not a recorded intermediate iterate. Show the solver's work and status for
each displayed plan (SQP, PCG and ADMM iterations, constraint violation).
Missing telemetry stays visibly unavailable.

Make these distinctions visible through the design, not through explanations
(Felix, 2026-10-22): line style, colour, fading, placement, the control's own
value, or a short badge whose tooltip gives the reason. Only a distinction that
changes how the current display is read needs a cue without hovering; usage
hints, reasons for disabled controls, provenance and background belong in
tooltips, the docs, or nowhere. Mark each distinction once, at the element it
concerns. Do not add caveats for unlikely misreadings or repeat a label across
panels; permanent text is a last resort of a few words.

The shared native simulation/control/TO clocks govern generation;
recorded playback uses simulation timestamps at the session playback rate,
forced to 1× while following a growing Live tip. Visualizer runs are
diagnostics, not experiment or timing evidence.

## Defaults are never hidden — Felix, 2026-10-22

Do not hide the defaults we rely on. A setting the visualizer can change is
shown with the value actually in effect, including any default we choose or
resolve (for example `tiago_mpc`'s `MpcParams` defaults), never as an empty
field that silently means "whatever the code does". A value we cannot change,
such as a solver-internal default, is simply used and needs no display or
report. Display what was resolved and handed to the solver, not what was
requested, so display and solver cannot disagree.

Settings use native `to_dict(MpcParams)` (refactor, 2026-10-26); every
`MpcParams` field is shown with its value, including `warmup`,
`max_sqp_time_s` and `warm_start`; values the visualizer cannot change appear as
fixed choices. Serialization `type` tags are fixed metadata, not parameters.
A `max_sqp_time_s` of None (Live's default, 2026-10-23) shows as
"none".

Since `tiago_mpc` 9dbde7f (Felix, 2026-10-24), the MPC always tracks
`tiago.GRASP_FRAME`; `ee_frame` is no longer a parameter. Frame identity belongs
to model/segment metadata and remains recorded on historical replays.

## Host environment and GPU

Run with the selected `tiago_mpc` checkout's uv interpreter: `.venv/bin/python`
on the host, `.venv-container/bin/python` in Docker or Podman (Felix, 2026-10-24).
Never fall back to the other platform's environment. GATO comes from that
environment's installed package; do not add `external/gato` to `PYTHONPATH`. Do not install
packages into these environments. Source / Build settings may select a different
prepared interpreter and persist that selection in the visualizer config.

**Source/build update — Felix, 2026-10-21:** reuse the selected project's
GATO cache by default, with an explicit optional cache override. Do not copy
compatible binaries or build duplicates. Source checks and normal settings/N
changes never compile. Explicit Build selected N uses half the usable CPU cores
and GATO's internal cache-write coordination; it does not pause Live or acquire
GPU experiment locks. The user authorizes these selected project-cache writes;
older private-cache-only/container-cache prohibitions are superseded. Keep
compiler logs and receipts beneath this checkout's ignored `_expr_data/`. Do
not modify upstream sources or packages.

**Build through tiago_mpc — Felix, 2026-10-22** (supersedes the visualizer's
own identity validation and module discovery, and the rebuild backups): the
default cache is `tiago_mpc`'s own default (Felix, 2026-10-23; supersedes
`<checkout>/.cache/gato`). Without an explicit cache override the visualizer
chooses no cache: `GATO_CACHE_DIR` stays unset in every process it starts
(solver child, Build, probe) and `tiago_mpc.util.cache_root()` decides, which is
the **main** checkout's `.cache/gato` also for a worktree, shared by host and
container (GATO keys modules by toolchain and Python ABI, so both sides' builds
coexist). The visualizer does not repeat that lookup: `source_runtime.default_cache`
asks `cache_root()` in a subprocess, and the probe reports it as
`selection.effective_cache`; Settings show that path labelled as `tiago_mpc`'s
default. An explicit override (template or path, or a launch-time
`GATO_CACHE_DIR`) sets `GATO_CACHE_DIR` as before.
The source probe asks `find_binary` for each offered N, with and without
predictor friction; `tiago_mpc` and GATO own the cache keys. Build selected N
calls `compile_binary` per N in a CPU-only subprocess of the selected
interpreter. Rebuild passes `use_cache=False`, which unlinks the old module
(processes that loaded it keep their mapping); there are no backups.

Applying a source/cache/interpreter fully restarts the backend and its
numerical worker; never swap Python/CUDA imports in an existing worker. A Build
into the running solver's own checkout, interpreter and cache only adds modules
and is listed without a restart (Felix, 2026-10-23, above).
Reconstruct source-bound robot/render/replay objects and start fresh Live history;
retain saved replays and compatible UI settings. Path precedence is
`--mpc-root`, then `TIAGO_MPC_ROOT`, then the saved selection, then
`../tiago_mpc-visualizer-base`.
An explicit Apply replaces launch-time source/environment overrides for that
restart. nvcc 12.9 rejects host GCC 15; Felix's shell uses
`CUDAHOSTCXX=/usr/bin/g++-14`. Do not change toolchain settings silently.

The GPU is shared with experiment runs. Use one persistent Live solver process;
explicit Run again may use a separate temporary child while Live is idle, with
only one GPU computation at a time. Solve only while a view needs it, and pause
solving while a GPU timing run holds the locks used by
`tiago_mpc/experiments/random100/run.py`.

**Memory-heavy commands: one at a time — Felix, 2026-11-03:** parallel builds
by several agents exhausted the 15 GiB host and froze the desktop. Run every
compile (GATO module builds, `uv sync` or `pip install` of large packages),
test suite and benchmark under the shared lock, on the host
`flock /var/home/felix/_Uni/MasterThesis/impl/.locks/heavy.lock <command>`
and in the container `flock /workspace/.locks/heavy.lock <command>` (the same
file). `flock` waits for the holder; for long waits run the command in the
background. Never launch several subagents that compile at the same time.

## Experiment storage and presentation — Felix, 2026-10-21

The shared replay handoff is **`impl/_expr_data/ingest/` on the host** and
**`/workspace/_expr_data/ingest/` in the container**. These are the same mounted
directory. This replaces the proposed shared `_expr_results` name. The default
`visualizer.json` points to `../_expr_data/ingest` relative to this checkout.
Use study/cohort subfolders and descriptive, distinct `.npz` names; the library
shows paths such as `reaching/study/run_017`. This is an explicit exception to
the earlier prohibition on shared experiment destinations for replay handoffs.

Keep raw measurements, logs, source/config snapshots, intermediate analyses and
other experiment artifacts in the owning checkout/worktree's ignored
`_expr_data/`. The shared directory holds portable replay exports, not a second
raw-data archive. Preserve existing recordings and historical provenance; do
not move or rewrite them for this change. The frozen master-thesis archive
`/workspace/experiment_data_ma_frozen_archive/` remains read-only; never recreate
`/workspace/experiment_data/` or export this work to GATO's `thesis_results/`.

Unless Felix explicitly requests a particular plot, present experiments as:

- A portable replay exported with main `tiago_mpc/experiments/replay.py`
  (`export_replay`, `save_replay`; formerly `experiments/tools.py`) into the
  shared ingest directory. Include actual native joint positions and sample
  timestamps, the task reference, and saved predictions when available/useful.
  Include recorded velocity, actuator torque and historical limits when available; these are optional, so position-only exports remain simple. Do not invent motion or rerun a retained experiment just to populate the UI.
- A clickable direct link per replay,
  `http://192.168.178.82:8090/?replay=<library path without .npz>` (for example
  `?replay=reaching/study/run_017`), instead of a viewer URL plus a path to
  select. New files appear through the watched catalog; changed files require
  explicit Reload so ongoing playback stays intact.
- A brief finding and the relevant recorded outcomes/metrics, including failures
  and material limitations. Distinguish simulated/physical motion, prediction/
  executed motion, and simulation/wall time. Selected examples illustrate a
  study; retain the study's actual cohort outcomes rather than implying that
  a successful example establishes overall reliability.
- Links/paths to the source run and effective configuration/protocol, with model
  and source identities where available. Preserve original outcomes and labels.
  Label any display-only subsampling or conversion and retain the full raw data.

For timing, memory, or other studies without recorded motion, give a compact
metrics table and raw-output links; a replay is not required. Generate the
specific plot when Felix asks for one. Keep the default handoff small and easy
to inspect, without an unsolicited plotting/reporting framework.

## New worktrees — Felix, 2026-11-06

- Leave existing worktrees and their Git links unchanged.
- Create new worktrees under `<main-checkout>/worktrees/<name>`, using the
  repository's main checkout even when working from a linked worktree.
- Use Git's relative linking, not just a relative destination argument:

  ```bash
  git -C <main-checkout> worktree add --relative-paths -b <branch> worktrees/<name> <start-point>
  ```

- Before creating one, ensure the Git clients used on both host and container
  support `--relative-paths` and `extensions.relativeWorktrees`. Do not fall back
  to absolute links or hand-edit Git metadata. See the
  [Git worktree documentation](https://git-scm.com/docs/git-worktree#Documentation/git-worktree.txt---relative-paths).
- Keep `/worktrees/` ignored in the main checkout when creating the directory.
  Resolve dependencies and environment paths for the new location; existing
  worktrees keep their current paths.

## Coordination

Commit your changes in this repository once its tests pass; Felix does not review
them uncommitted (Felix, 2026-11-03). Commit only your own changes, never another
session's uncommitted work, and do not push. Changes to `tiago_mpc` stay
uncommitted for his review (its own AGENTS.md).

Use bounded parallel implementation and review when useful. Coordinate shared
edits. Queue worktree cleanup after merging branches. At the end of the work
session, inspect loose changes/results and propose the exact paths and branches
to remove, stating where useful work is retained. Do not remove worktrees or
delete branches automatically; wait for approval. Do not interrupt ongoing tasks
with cleanup proposals.

## Native cost menus and orientation — Felix, 2026-11-03

The viewer follows `tiago_mpc` main `221acad`: `SolverSettings` contains numerical
settings, and `MpcParams.cost` is a native `CostMenu`. Standard tracking weights
are viewer convenience controls (`config.cost_weights`) that call `default_cost`;
the effective native menu is retained in recordings. Custom menus must keep their
terms and do not receive convenience weight controls. See
[Live orientation and cost menus](docs/live-api.md#orientation-goal-and-cost-menus).
The current saved source selects main; the stable base worktree has also advanced
to `221acad`. The new adapter requires the native menu API.
