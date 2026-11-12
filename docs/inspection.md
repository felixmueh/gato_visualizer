# Episode and Solve inspection

Design decisions agreed with Felix on 2026-10-21. The Episode/Solve UI and
inspection of retained diagnostics are implemented. Run again records final
predictions from independent cold solves with increasing SQP caps. Ordinary episode solves
retain their final plan and lightweight diagnostics; older data may lack the
inputs required to rerun. Exact optimizer checkpoint/resume is not offered.
Canonical terminology is in [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md).

## Source and inspection context

The main source comes from Live computation or Replay; Episode and Solve have
separate inspector tabs. An MPC episode may provide saved solves; a standalone
solve is also a valid source. Episode
inspection is unavailable when no episode accompanies a standalone solve.

The Episode tab hosts episode plots and aggregates. The Solve tab hosts the
selected solve's plots, diagnostics and iteration controls. Changing inspection
tabs does not itself start computation, pause execution, or change the main
timeline's clock. Selecting a solve changes the inspected prediction without
rewriting recorded episode motion.

## Episode analysis range: the aggregate window

Felix, 2026-10-22: select the aggregate window as left and right bounds on the
timeline, either of which may be unbounded. Every episode plot and aggregate
uses it (`EpisodeView.states/plans/intervals/bounds`); there is no separate
range selector.

The expanded timeline owns the window. Shift-drag selects it; bracket handles
move each bound; dragging a bound onto its outer data edge, or double-clicking
it, makes that side unbounded, shown by a muted open bracket at the edge. An
unbounded end follows newly retained Live history, so aggregates keep growing;
an unbounded start begins at the first retained sample. Both unbounded (the
default) is the entire episode: all currently available active history,
including precalculated samples beyond the playback cursor. Excluded time is
dimmed on the timeline; the Episode header mirrors the window in a chip with a
clear button. The reset arrow or Esc on the timeline also clears it.

The playback cursor and zoom are independent of the window: moving either never
re-evaluates aggregates. During Live playback, plots reveal data only up to the
playback cursor (presentation only; see [presentation](presentation.md#plot-growth-during-live-playback--felix-2026-10-22)).
Aggregates still use the whole window. Like zoom, the window is per-source presentation state
and resets when the recording or Live generation changes; it is not saved. The
earlier Through cursor mode was removed with the selector; the backend still
accepts `through_cursor` for API clients.

## Solve selection and pinned state

Follow cursor selects the recorded solve associated with the displayed episode
state/control sample. Prefer the recorded plan association; any timestamp-based
fallback must be explicit rather than silently substituting the newest solve.
Preview solves remain distinguishable from recorded controller solves.

Pin solve freezes the selected solve and its SQP iteration selection while the
episode cursor and Live computation can continue. Show a persistent muted-red
badge/border and visible Pinned text with the solve identity and episode
timestamp where available. The pinned Solve's 3D prediction uses the same red
(the `--pin-red` custom property in `src/plots.css`). Colour is supplemental to
the text and toggle state.
Returning to Follow cursor clears the pinned treatment. Plot placement on the
timeline uses the label Show on timeline to distinguish it from Pin solve.

## Per-solve cursor: SQP iterations

The solve cursor selects a discrete SQP iteration, not time. Show the initial
guess as Seed when available, then recorded SQP iterations with their actual
indices and statuses. Do not invent intermediate records to fill the requested
iteration cap. A rejected step or early stop can legitimately have no new
trajectory snapshot.

Selecting an iteration updates graph markers on iteration-index plots, the
iteration-specific data of other solve plots, and the 3D prediction when that
iteration's trajectory was recorded. Missing trajectories or metrics remain
explicitly unavailable; do not substitute the final trajectory as though it
belonged to every iteration. For a metrics-only iteration the final plan stays
as labelled, faded context. A recorded trajectory that has not arrived yet keeps
the previously shown trajectory on screen and dims the strip label (tooltip:
loading) instead of falling back to the final plan. Moving the SQP cursor never
cancels an in-flight plot response. Solver-iteration selection does not advance
the robot's recorded episode state.

Prediction-horizon scrubbing is deferred. Horizon-time profiles may still show
the selected iteration's predicted positions/velocities/controls, but no second
horizon cursor or prediction playback is introduced by this design.

Agreed initial control placement: a compact, labelled SQP iteration strip in
the Solve inspector, with previous/next buttons, Seed / iteration k of K, and
a horizontal slider. Keep it distinct from the episode's bottom timeline.
Use Pin solve to keep incoming Live solves from replacing the selected solve
mid-inspection. Run again automatically pins its separate result; Follow episode
returns to the original source and cursor association. Automatically pinning
ordinary solves on iteration manipulation remains a proposed refinement.

## Run again — implemented 2026-10-21

Run again creates a separate inspection result linked to the selected solve,
using its captured
initial state, exact reference, bounds and problem settings. Keep the original
episode plan immutable; never advance the plant or episode clock, or change
global Live defaults through this action. Record the implementation/model
identity actually used, including any difference from the original solve.

The captured bounds are the three installed limit row groups (position,
velocity, torque). A collision row group that `tiago_mpc` appends after them
(`MpcParams.collision`) is not captured separately: the captured problem
configuration installs it again with its environment (2026-11-02).

Offer an editable maximum SQP cap K and optional per-solve wall budget. Run
independent solves with caps 1, 2, 3, … K. Record each run's actual completed
iterations and stop reason separately from its requested cap.
Preserve existing practical zero-PCG stopping: a cap is an upper bound, not a
demand to execute every iteration. Do not promise immediate graceful Stop
without an iteration-boundary cancellation mechanism.

Current recordings lack the incoming warm trajectory and private optimizer
state. Initially use an explicitly labelled cold start from the captured robot
state. This is a fresh solve, not a reproduction of its original initialization
or exact resumption. Original-seed selection requires real seed capture first;
even a trajectory seed alone is not a complete optimizer checkpoint.

Retain the held-state seed and each capped solve's final q/v/u trajectory in
binary arrays with shared metadata stored once. Label the cursor as an SQP cap:
these are independent cold solves, not iterations of one optimizer invocation.
Each run starts from a new MPC with the same captured q/qd at every seed knot,
zero seed torques, fresh dual/rho state and exact captured bounds/masks.
Continue retaining
final plans and available lightweight scalar diagnostics for ordinary episode
solves. A thousand float32 trajectory snapshots costs about 2.54 MiB at N32 or
10.23 MiB at N128, before metadata; retaining them for every solve multiplies
that cost by the episode's solve count. Full linear-algebra workspace capture
is outside this initial feature.

## Independent capped solves

Inspection uses the ordinary native `BSQP.solve` API and a cached compatible
module. It does not require a native trajectory-capture extension or changes to
`tiago_mpc` or GATO. A fresh MPC is constructed for each cap, and no controller
step, warm-up solve or warm-start shift runs between snapshots. Early stopping
can produce equal trajectories at several caps; these remain distinct runs with
their own actual counts. The optional wall budget applies separately to every
run. Without early stopping, K runs can perform K(K+1)/2 SQP iterations, plus
solver construction work. Stop terminates the isolated child and retains no
partial comparison. Binary snapshots stay out of JSON responses; plots decode
only the selected prediction.

The visualizer retains ordinary solves' final q/v/u, initial state, exact
reference, effective configuration, installed bounds/masks, model/source identity
and available scalar traces. Current configurations retain the native `CostMenu`
and `SolverSettings`. Run again updates that captured menu with the exact captured
reference before solving; absent orientation targets remain absent. Recordings
using the previous `SolverParams` cost API remain viewable, but require their
original MPC checkout to rerun. It does not retain their incoming warm trajectory
or private optimizer state. Historical sources without complete captured inputs
cannot be rerun safely and explain that limitation in the inspector.

The public API does not expose complete checkpoint/restore/resume. Run again
constructs independent solvers with labelled cold initialization. The series'
total time is distinct from each run's reported solve time. A final prediction used as context for
missing historical snapshots is labelled as context, never as an iteration.

## Consequences for the plotting contract

The authoring, directory and verification design is in [plotting.md](plotting.md).

- A plot declares Episode and/or Solve input context and required/optional data.
- Episode time, SQP iteration, prediction-horizon time and measured wall time
  remain explicit axis identities.
- The host owns the episode cursor, selected/pinned solve, SQP iteration cursor
  and episode analysis range; plugin parameters are separate user inputs.
- Iteration-history plots follow the SQP cursor with a graph marker. Plots of
  the selected iteration's prediction change their data when it changes.
- Episode-time plots can share the episode timeline. An SQP-index plot cannot
  be placed on that timeline as though its index were elapsed seconds.
- Plot computations are read-only; Run again is a Solve-inspector action,
  not an effect of evaluating a plot.
- Standard and custom plots use the same contract and availability rules.

## Fresh inspection service and binary data flow

Run again uses the currently active compatible solver profile in a temporary
isolated child. The normal Live child remains idle with its private controller
state intact. The coordinator pauses Live calculation at a committed numerical
chunk boundary, without invalidating its revision, rewinding history, resetting
the controller, or stepping the plant for the inspection. Unlike ordinary Pause,
this handoff waits for its own outstanding solve and capture to finish before
releasing the GPU lease. The control reply stays unread for resume; an inspection
timeout leaves the paused invocation intact. A later Play resumes
that retained controller/session. There is one active GPU computation under the
same canonical GPU leases as Live and experiments. The extra idle process and
CUDA context can consume resources; inspection timings are diagnostics rather
than benchmark evidence. Inspection never interrupts an external experiment;
a failed nonblocking lease acquisition reports a terminal `busy` job.

The selected problem must contain native initial q/qd/task time, the exact
native reference, the effective `MpcParams` (`problem_configuration`, the
`to_dict(MpcParams)` the solve used), and explicitly captured installed
constraint rows. `constraint_bounds_native` records the actual native
position/velocity/torque bounds and activity masks once after configuration.
These are separate from display/physical `joint_limits`; compiled default
margins and offsets must never be inferred from a physical-limit table.
Historical records without exact constraint capture report unavailable. Missing
native configuration type metadata also reports a pre-migration recording;
the viewer does not reconstruct old parameter dataclasses from display data.
Missing Replay references, configuration or state are also unavailable, including a
position-only replay with enough geometry to draw a trajectory. Solves recorded
before the migration to `tiago_mpc` main carry the old configuration shape
(`solver_params`, `controller`) and report "Run again unavailable:
pre-migration recording"; there is no converter (Felix, 2026-10-22).

Frozen Live episodes construct cold inspection inputs on demand (2026-11-12).
The saved prediction's first q/qd knot supplies the initial state at its recorded
origin time. The recorded task settings and reference anchor regenerate Reach
or Figure-eight targets at the prediction's knot times, including knots beyond
the episode's end. The recorded coordinate transform places them in the native
reference frame. Configuration, installed bounds and model identity come from
the shared provenance already in the replay. No per-solve initial-state or
reference copies, or separate inspection context, are exported. This cold solve
uses the saved prediction's start; it does not claim to reproduce the original
request state or optimizer initialization. Replays lacking the required task,
velocity or shared problem context remain unavailable for Run again.

The CPU profile preflight checks a compatible cached module for the captured N
and predictor model. The child constructs each `Mpc` from the captured
`MpcParams`, changing only `solver.max_sqp_iters`, using `find_binary` without
compilation. It calls `BSQP.solve` once per cap with an identical held-state seed,
preserving the solver's practical zero-PCG stop. This is neither the original
warm initialization nor exact optimizer continuation. Requested cap/budget,
actual completed count, stop reason, original selection, and the model, binary,
process epoch and source actually used are retained independently.

The solver child writes `<runtime>/solve-inspections/p<pid>/<id>/iterations.npz`
(float32 native-coordinate XU snapshots) and captures the hashed full/reduced
URDF inputs used for later CPU FK. Per-run diagnostics and requested/actual counts
are metadata; common problem/model values are stored once. It
publishes `metadata.json` last.
The retained FK context includes the fixed torso/body joint posture used by the
inspection solver. Both the grasp paths and torso-frame references use that
posture when decoded, so they align with the displayed robot.

Results are RAM-backed runtime files ([runtime files](execution-api.md#runtime-files))
and keep only what is still needed (Felix, 2026-10-23): each belongs to the source
it was run from, a Live generation or a replay (recording and revision; a result
run from a result inherits its source). It is deleted when that source stops being
current: a new Live generation (Reset, settings or profile change, precalculation),
or loading another recording or a new revision of it (the server's current replay is
the one most recently loaded by any browser). A job that ends after its source
changed reports `failed` and keeps nothing; failed and cancelled jobs leave nothing;
shutdown and source restart delete all results, and start deletes those of ended
servers (by owner pid). Results do not survive a restart. The shared metadata, captured problem
and effective configuration are written once. The socket returns only a small
artifact descriptor: full traces never become JSON RPC, HTTP or plot context
arrays. Seed is index 0 after native initialization; 1..K are the actual outer
iterations, including unchanged zero-PCG and rejected-step snapshots.

The CPU plot reader loads the selected binary artifact once and keeps its
arrays read-only while scrubbing. It decodes only the requested snapshot to
native q/v/u, including joint 6, and computes its FK in Python. Context iteration
entries contain only index, status, has_prediction and scalar statistics.
`selected_solve.selected_prediction` is the sole selected-iteration prediction;
`selected_iteration` echoes the request so the browser can reject stale results.

For smooth scrubbing the Solve inspector also prefetches end-effector paths:
when `selected_solve.capabilities.iteration_paths` is true, a catalog request
with `selection.iteration_paths: k` (separate browser channel) returns a
top-level `iteration_paths: {start, stop, ee_xyz}` for the aligned chunk of
snapshots containing k. A chunk holds at most 32768 knots (1024 snapshots at
N32), coordinates are rounded to 1 µm, and each is computed once per trace. The
browser keeps at most four chunks plus 64 single snapshots of the selected
Solve and discards them when the Solve changes. Paths only feed the 3D view;
plots still use the full selected snapshot.
A standalone inspection source has no episode. It does not replace the source
of the Episode inspector or advance the episode cursor.

## Fresh inspection HTTP contract

`POST /api/solve-inspections/capability` accepts `{source, selection, profile_id}`
and returns `{available, reason, initialization: "cold_state"}` with selected
profile/capability details when available. Source/selection use retained IDs,
never browser-uploaded problems or file paths. This CPU-only check can take as
long as the selected interpreter's bounded source preflight.

`POST /api/solve-inspections` additionally requires integer `sqp_iters` in
1..10000 and optional positive finite `budget_s` (null means no wall budget).
Only the currently active profile is accepted. `selection.solve_id` is the
opaque selected ID; `solve_seq` is an alias and `trajectory_index` supports
Replay selections. The response is HTTP 202 `{id, job_id, state, requested, ...}`.
One job runs at a time and at most two wait. The 256 MiB inspection snapshot
allocation ceiling is also checked before construction.

`GET /api/solve-inspections/jobs/<id>` returns `pending`, `running`, `completed`,
`failed`, `cancelled` or `busy`. Running jobs expose `phase` and `message`.
Completed jobs include `{source: {kind: "inspection", id}, mode,
solves_run, max_sqp_cap, stop_reason, requested, original, original_solve_id,
actual_solver_profile}`. Artifact metadata records every run's requested cap,
actual iteration count and stop reason.
The existing plot endpoints accept `{kind: "inspection", id}` as their source
while the result's source is current, also after job expiry; afterwards they
report the result as no longer available.

`POST /api/solve-inspections/jobs/<id>/stop` requires `{}`. It cancels a queued
job before construction or explicitly terminates only the isolated inspection
child. The coordinator retains the GPU leases until that child exits. There is
no graceful mid-SQP checkpoint and no partial trace result. Ordinary Live
Pause/cancel never uses this termination behavior. Jobs remain distinct from the
original episode records; failed or interrupted jobs leave no files.
