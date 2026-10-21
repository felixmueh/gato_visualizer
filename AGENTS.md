# Agent instructions

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
  supported set during setup and never compile in response to a UI change.
- **Later, not now:** live plots, for example of solver convergence.

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

## Model and coordinates

The canonical full model is `models/tiago_pro/tiago_pro.urdf` in `tiago_mpc`.
Recorded plant states use native joint coordinates. Saved solver predictions
use the GPU convention and require the recorded `signs` conversion, including
joint 6. Do not apply that conversion to recorded native states.

All displayed points must share the full robot's root frame. Derive the
reduced arm's torso-to-world transform from the full URDF rather than adding
a guessed offset. Playback uses sample timestamps, with interpolation between
samples. Prediction playback is distinct from recorded simulated MPC motion.

## What the display claims

Label what each element shows: a prediction is not executed motion, and
simulated time is not solver time. Show the solver's work and status for each
displayed plan (SQP, PCG and ADMM iterations, constraint violation); a finite
plan does not show that the solver converged. Play mode uses the fixed pacing
of `tiago_mpc` unless a mode states otherwise. Visualizer runs are diagnostics,
not experiment or timing evidence.

## Host environment and GPU

Run on the host with `tiago_mpc`'s interpreter `../tiago_mpc/venv-host`. If the
backend needs further packages, give this repository its own venv instead of
installing them there. Keep the visualizer's compiled GATO modules, including
the prebuilt N set, in this checkout's ignored `.cache/gato`: set
`GATO_CACHE_DIR` before importing `reach_sim`, which otherwise defaults it to
`tiago_mpc`'s cache. `runtime_urdf()` rewrites `tiago_mpc/.cache/models` with
identical content, as every `reach_sim.py` run does. The container
(`gato-felix-container`, which mounts `impl/` at `/workspace`) owns
`tiago_mpc/.venv` and `tiago_mpc/.cache/gato`; do not modify them. nvcc 12.9
rejects the host's GCC 15; Felix's shell sets `CUDAHOSTCXX=/usr/bin/g++-14`.
The container uses host networking, so its servers occupy host ports.

The GPU is shared with experiment runs. Use one solver process, solve only while
a view needs it, and pause solving while a GPU timing run holds the locks used by
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
  Do not invent motion or rerun a retained experiment just to populate the UI.
- A clickable viewer URL (normally `http://192.168.178.82:8090`) and the exact
  library path(s) to select. New files appear through the watched catalog;
  changed files require explicit Reload so ongoing playback stays intact.
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
edits. Remove worktrees after merging their branches; first retain any loose
changes or results that still matter. Do not delete branches without the user's
approval.
