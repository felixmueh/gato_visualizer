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

## Relationship to tiago_mpc — Felix, 2026-10-21

`tiago_mpc` keeps changing and the visualizer must follow it, but this project
avoids changes to `tiago_mpc`, including its `external/gato`. Locate it through
the configurable path (`--mpc-root` / `TIAGO_MPC_ROOT`, default
`../tiago_mpc`). Do not add a submodule or move this repository unless Felix
decides so.

The producer-side replay exporter is the explicitly requested exception:
`tiago_mpc/experiments/tools.py`. Keep one lightweight implementation there;
visualizer tests can use it to create portable recording fixtures.

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

Import `tiago_mpc` code unchanged instead of re-implementing it. With
`examples/` on `sys.path`, `reach_sim.py` imports without running and provides
the model preparation and joint-6 GPU signs (`runtime_urdf`), the model check
(`check_model`), the task constants and the plant integrator (`rk4`).
`reaching_config.load_configuration` resolves complete configuration files, so
live settings become such a file. Re-implement only what cannot be imported,
currently the episode loop in `reach_sim.main()`: controller construction, the
signed limit bounds, and control and plant stepping. A conformance test runs the
unchanged `reach_sim.py` and the visualizer's loop with the same configuration
and requires identical GPU outputs, so drift in `tiago_mpc` fails loudly.
The tracked `scripts/check_conformance.py` checks the synchronous adapter path;
it does not qualify every production multirate/profile/inspection path.

## Model and coordinates

The canonical full model is `models/tiago_pro/tiago_pro.urdf` in `tiago_mpc`.
Recorded plant states and portable NPZ predictions use native joint coordinates.
Legacy packed solver predictions and raw inspection XU arrays use the GPU
convention and require their recorded `signs` conversion, including joint 6.
The solver child converts ordinary Live predictions to native coordinates
before returning them. Do not sign-convert native data again.

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

## What the display claims

Label what each element shows: a prediction is not executed motion, and
simulated time is not solver time. Show the solver's work and status for each
displayed plan (SQP, PCG and ADMM iterations, constraint violation); a finite
plan does not show that the solver converged. The visualizer's independent
simulation/control/TO clocks govern generation; recorded playback uses simulation
timestamps at 1x. Visualizer runs are diagnostics, not experiment or timing evidence.

## Host environment and GPU

Run on the host with the selected `tiago_mpc` checkout's interpreter, preferring
`venv-host/bin/python` and falling back to `.venv/bin/python`. Do not install
packages into these environments. Source / Build settings may select a different
prepared interpreter and persist that selection in the visualizer config.

**Source/build update — Felix, 2026-10-21:** reuse the selected project's
`.cache/gato` by default, with an explicit optional cache override (including
this visualizer's existing `.cache/gato`). Do not copy compatible binaries or
build duplicates. Validate actual current GATO model/frame/native/toolchain/
Python ABI/GPU architecture identities and loadability; do not trust manifest.N
as the complete built set. Source checks and normal settings/N changes never
compile. Explicit Build selected N uses half the usable CPU cores and GATO's
internal cache-write coordination; it does not pause Live or acquire GPU
experiment locks. Only missing/stale selected modules build unless the user
explicitly requests rebuilding. The user authorizes these selected project-cache
writes; older private-cache-only/container-cache prohibitions are superseded.
Keep compiler logs, receipts, temporary models and rebuild backups beneath this
checkout's ignored `_expr_data/`. Do not modify upstream sources or packages.

Applying a source/cache/interpreter or newly built set fully restarts the backend
and its numerical worker; never swap Python/CUDA imports in an existing worker.
Reconstruct source-bound robot/render/replay objects and start fresh Live history;
retain saved replays/disk history and compatible UI settings. Path precedence is
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

- A portable replay exported with main `tiago_mpc/experiments/tools.py` into
  the shared ingest directory. Include actual native joint positions and sample
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
