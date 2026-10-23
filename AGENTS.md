# Agent instructions

## Start here

Read [README.md](README.md) for launch and user workflows,
[UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) for domain terms, and
[the architecture guide](docs/architecture.md) for process ownership, source
files, checks and accepted decisions. Follow the topic links there for the
area being changed; update its existing contract when behavior changes.

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
avoids changes to `tiago_mpc`, including its `external/gato`. Locate it through
the configurable path (`--mpc-root` / `TIAGO_MPC_ROOT`, default
`../tiago_mpc`). Do not add a submodule or move this repository unless Felix
decides so.

The producer-side replay exporter is the explicitly requested exception:
`tiago_mpc/experiments/replay.py` (`export_replay`, `save_replay`; it moved
there from `experiments/tools.py` with the 2026-10-22 `tiago_mpc` refactor).
Keep one lightweight implementation there; visualizer tests can use it to
create portable recording fixtures.

### The tiago_mpc API the visualizer uses — Felix, 2026-10-22

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
- **Settings are `asdict(MpcParams)`** plus the visualizer's `plant` group
  (simulator friction); `task` and `execution` are unchanged. No configuration
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
- **Default `tiago_mpc` root is `../tiago_mpc`.** The frozen
  `tiago_mpc_vis_baseline` worktree is no longer used.
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
- **Every reseed warms up.** Configuring, Reset, anchors, previews, rollback
  and resuming Play reseed the solver child's controller with `Mpc.warmup`
  from that state and the task reference a request then gets; with `warmup`
  off that is the plain controller reset. A reseed repeating the previous one
  with no solve in between is skipped. The warm-up is no plan, creates no
  record, is not part of interval timing and, like a solve, has no RPC
  deadline.
- **Build refreshes Live without a restart.** Building only adds modules for
  the same interpreter and cache, so a successful Build into the active
  solver's own checkout, interpreter and cache updates the available N in the
  running backend and browser. Apply and its restart remain for source,
  interpreter or cache changes.

### Trial changes to tiago_mpc — Felix, 2026-10-22

To try a change to `tiago_mpc` from visualizer work, create a `tiago_mpc`
worktree; this is always fine. Mark it clearly as a visualizer trial: a sibling
directory `../tiago_mpc-visualizer-trial-<topic>` on branch
`visualizer-trial/<topic>`. Select it through Source / Build or `--mpc-root`.
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

### Visualizer timing ownership — Felix, 2026-10-21

The visualizer owns its scheduling, precalculation and playback. Reuse the
existing upstream MPC controller and `tiago_mpc` simulation steps directly.
Do not require a shared timing engine in `tiago_mpc`: its self-contained
experiments and real-robot execution have their own timing requirements.
Keep upstream GATO unchanged. Accept its existing heuristic warm-start behavior;
exact warm-start time alignment is not a prerequisite and has no UI option.

Expose simulation, control and TO/replanning frequencies separately from the
prediction knot interval. The simulation clock follows the requested schedule;
slow computation reduces wall-clock real-time factor. Record MPC and physics
costs separately. Replay-bar overruns are red for MPC and yellow for simulation,
with red taking precedence when both apply. Identify combined-only overloads
explicitly rather than claiming that physics alone exceeded its budget.

Manual and automatic precalculation run the full closed-loop simulation for the
requested duration. New parameter edits invalidate obsolete calculation jobs;
automatic jobs use a frozen displayed starting state. History playback follows
recorded simulation timestamps at 1x, with a separate "Continue simulation at
end" toggle. Imported Replay recordings remain independent of Live settings.

Import `tiago_mpc` code unchanged instead of re-implementing it. Which code
that is changed on 2026-10-22; see "The tiago_mpc API the visualizer uses"
above. Re-implement only what the visualizer's own clocks need: the multirate
schedule and its zero-order hold of a plan's knot torques (as `tiago_mpc`'s
`sample_knot`, except that it holds the last torque past the horizon).

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

Conformance (Felix, 2026-10-22, replaces the comparison with `reach_sim.py`):
the opt-in GPU script `scripts/check_conformance.py` runs
`experiments.reach.reach` with `SimPlant` and `Mpc` in-process, then the
visualizer's adapter, solver child and multirate session at the same rates,
start, target and `MpcParams`, and compares states at every command tick,
commands and plans, so drift in `tiago_mpc` fails loudly. By default the
reference steps on the session's 1 ms grid for 3 s without arriving, and the
comparison is bit for bit. It covers the default loss-free reach, not every
profile, friction or inspection path. Since `tiago_mpc` 31c405a (Felix,
2026-10-23) both sides use `TIAGO` without the SQP time limit and with the
warm-up (`run()` warms up before its first tick, the session's configure
reseeds the same way), at the reach's default rates: 500 Hz commands, a
control update per 10 ms knot.

## Model and coordinates

The canonical full model is `models/tiago_pro/tiago_pro.urdf` in `tiago_mpc`.
Recorded plant states and portable NPZ predictions use native joint coordinates.
Legacy packed solver predictions and raw inspection XU arrays use the GPU
convention and require their recorded `signs` conversion, including joint 6.
Live plans arrive native from `tiago_mpc`'s `Plan` (states and knot torques);
the solver child applies the GPU signs only where it touches GATO directly
(controller reset, installed bounds, inspection). Do not sign-convert native
data again.

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

**Friction defaults — Felix, 2026-10-22** (supersedes the both-on UI default
and the stick/slip plant of `visualizer-trial/stick-slip-plant`): plant and
predictor are loss-free by default, matching `tiago_mpc`'s friction opt-in.
Simulator friction is `SimPlant`'s hard-sign Coulomb plus viscous law; there
is no stick/slip plant. Predictor friction is a compiled variant whose tanh
width is fixed at 0.03 rad/s and not settable, since each width is its own
compiled plant.

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
  pauses calculation and playback at the breaching tick with a message naming
  joint, quantity, value and limit; Play continues. A quantity of a joint
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
cell commits on Enter, reset arrows restore one joint or all. A pose outside the
MPC planning box (URDF range less `joint_margin_rad`) is flagged, not blocked.
Elsewhere, in Replay or locked, the tab is read-only as before. Task geometry
(reach target, figure-eight start) stays tied to `Q_START`. Replay's default
scene shows the arm at `Q_START`. "Start pose" is the one term; the former
"starting pose" of the default scene is the same thing.

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

The visualizer's independent simulation/control/TO clocks govern generation;
recorded playback uses simulation timestamps at 1x. Visualizer runs are
diagnostics, not experiment or timing evidence.

## Defaults are never hidden — Felix, 2026-10-22

Do not hide the defaults we rely on. A setting the visualizer can change is
shown with the value actually in effect, including any default we choose or
resolve (for example `tiago_mpc`'s `MpcParams` defaults), never as an empty
field that silently means "whatever the code does". A value we cannot change,
such as a solver-internal default, is simply used and needs no display or
report. Display what was resolved and handed to the solver, not what was
requested, so display and solver cannot disagree.

Since the settings became `asdict(MpcParams)` (Felix, 2026-10-22), every
`MpcParams` field is shown with its value, including `ee_frame`, `warmup`,
`max_sqp_time_s` and `warm_start`; values the visualizer cannot change appear as
fixed choices. A `max_sqp_time_s` of None (Live's default, 2026-10-23) shows as
"none".

## Host environment and GPU

Run on the host with the selected `tiago_mpc` checkout's interpreter, preferring
`venv-host/bin/python` and falling back to `.venv/bin/python`. Do not install
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
default cache follows `tiago_mpc`'s convention, `<checkout>/.cache/host-gato`
for host interpreters and `<checkout>/.cache/gato` for the container's `.venv`.
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
`--mpc-root`, then `TIAGO_MPC_ROOT`, then the saved selection, then `../tiago_mpc`.
An explicit Apply replaces launch-time source/environment overrides for that
restart. nvcc 12.9 rejects host GCC 15; Felix's shell uses
`CUDAHOSTCXX=/usr/bin/g++-14`. Do not change toolchain settings silently.

The GPU is shared with experiment runs. Use one persistent Live solver process;
explicit Run again may use a separate temporary child while Live is idle, with
only one GPU computation at a time. Solve only while a view needs it, and pause
solving while a GPU timing run holds the locks used by
`tiago_mpc/experiments/random100/run.py`.

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

## Coordination

Use bounded parallel implementation and review when useful. Coordinate shared
edits. Queue worktree cleanup after merging branches. At the end of the work
session, inspect loose changes/results and propose the exact paths and branches
to remove, stating where useful work is retained. Do not remove worktrees or
delete branches automatically; wait for approval. Do not interrupt ongoing tasks
with cleanup proposals.
