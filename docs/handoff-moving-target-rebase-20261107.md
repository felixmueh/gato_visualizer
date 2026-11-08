# Handoff: rebase the moving-target and mouse-target work onto the new mains

For the agent doing the rebase. Written 2026-11-07. Felix explicitly requested
this rebase. Every other rule of both repositories still applies. The most
important:
- **tiago_mpc:** leave the changes uncommitted for Felix.
- **Visualizer:** commit your own changes on the experiment branches once the
  tests pass, and do not push (AGENTS.md, "Coordination").
- Never use bare `git stash`, and never touch port 8090.
- Run compiles, test suites and benchmarks one at a time, under
  `flock /var/home/felix/_Uni/MasterThesis/impl/.locks/heavy.lock` (in the
  container: `/workspace/.locks/heavy.lock`).

## What moved on main

Both mains now run the **shared native loop**, which should simulate much faster
than the setup the work was built on.

| Repository | Old base of the work | New main |
|---|---|---|
| `impl/tiago_mpc` | `f169a20` | `e25e8b7` "Simplify virtual-time scheduling and request preparation" |
| `impl/tiago_mpc_visualizer` | `2ceaea1` | `b56d28e` "Document the shared-loop merge…" |

- **tiago_mpc changes since `f169a20`:**
  - GATO 0.1.7 and grid-rbd 0.6.0.
  - "Follow GATO's defaults and record the values GATO resolved" (`1870787`).
  - Orientation tracking with native cost-menu objectives (`221acad`).
  - The shared loop, with execution policies and simplified request
    preparation (`192a624`..`e25e8b7`).
- **Visualizer changes since `2ceaea1`:**
  - Felix committed the previously uncommitted work (`f8513bd`).
  - Cost menus and orientation controls.
  - Live now runs through tiago_mpc's native loop (`e53afcb`, `bacb5b1`).
- **Background:** [the 500 Hz handoff](handoff-live-500hz-throughput.md)
  holds the throughput problem and, at its top, the merge note. Merge records:
  each main's `_expr_data/shared-loop/` and
  `_expr_data/shared-loop-merge-20261107/`.
- **Uncommitted work on tiago_mpc main itself:** `AGENTS.md` and
  `pyproject.toml` (Felix's). Leave it alone.

## The three worktrees to rebase

Rebase each one **in place**. Live servers and configurations point at these
paths, and the 2026-11-06 rule says to leave existing worktrees where they are.
Last time this was done as follows:

1. Save the patches and untracked files to the worktree's
   `_expr_data/rebase-20261107/`, together with a pristine copy for comparison.
2. Move the branch to the new main.
3. Re-apply by hand.

`_expr_data/rebase-20261101/` holds the previous round's patches and
`gpu_checks.py`, as a model.

### 1. `impl/tiago_mpc-visualizer-trial-moving-target`

Branch `visualizer-trial/moving-target` at `f169a20`. Everything is uncommitted:
17 tracked files are modified, and several new files are untracked.

- **PositionWeights:** a per-knot position weight table, built from
  peak/spread/total/floor, in `tiago_mpc/mpc.py`, `record.py`, `__init__.py`,
  `tests/test_mpc.py`, the README and `docs/decisions.md`.
  - The default `PositionWeights()` must produce plans **bit-identical** to
    `position_weights=None`. The check is `_expr_data/rebase-20261101/gpu_checks.py`.
  - **Main changed the cost interface itself:** native cost menus, and GATO
    defaults resolved and recorded. How PositionWeights maps onto the menus is
    a design decision. **List the options for Felix (grilling skill); don't
    pick one.**
- **Tasks receive the measurement time:**
  - `TaskInterface.at(t, n, dt, measured_t)`. The docstring explains it: a
    reference that is known in advance ignores `measured_t`; an observed target
    uses nothing later than it.
  - Main still has `at(t, n, dt)`.
  - Main's request preparation was rewritten, so thread `measured_t` into the
    new call sites: `loops.py:352` and `:621`, `latency_compensation.py:175`,
    `replay.py:43` and `controller_tuning.py:120`.
  - Then update every task: reach, figure8, HoldPosition, the orientation task
    that is new on main, the test tasks, and the README sentence.
  - Under compensation, `measured_t` is the time of the measured state. In
    warmup it is 0. In replay and controller tuning it is `t`.
  - **Check first** whether main's new `Prediction` and request-preparation code
    already carries the measurement time somewhere you can reuse.
- **Untracked:**
  - `experiments/moving_target.py`: MovingTarget with presets, and an optional
    constant-velocity forecast (`forecast`, `velocity_window_s`).
  - `experiments/tracking_study/`: the study; its report is `REPORT.md` in the
    `_expr_data` tracking-study directory.
  - Tests: `test_moving_target.py`, `test_mpc_variants.py` and
    `test_tracking_study.py`.
- **Also:** the `mpc_variants.py` signs fix and the stats-key fix.

### 2. `impl/tiago_mpc_visualizer-moving-target`

Branch `experiment/moving-target` at `2ceaea1`.

- **What is staged** is the old main's uncommitted state, the baseline at the
  time. It should now be contained in `f8513bd`; verify that, then discard it.
- **The prototype** is the unstaged diff (21 files) plus the untracked files
  `src/moving-target.js`, `src/position-weights.js` (with its test) and
  `tests/test_moving_target.py`.
  - It adds the moving-target task with its presets, the forecast fields in
    `adapters/tiago.py` (`MOVING_TARGET_VIEW_FIELDS`), and the PositionWeights
    editor.
  - It also changes the reference plumbing: `solver_adapter.task_reference` and
    `update_tracking_reference` with `measured_s`, and `solve_snapshot` passing
    `initial.measured_t`.
- **Main now runs Live through the native loop.** So the visualizer-side
  reference plumbing is probably obsolete. The moving target should most likely
  enter as a tiago_mpc `TaskInterface`, from worktree 1, that the native loop
  queries.
  - Find out how main's Live obtains its reference, and port the *behaviour*,
    not the old lines.
  - If the clean route needs a structural change in either repository, stop and
    list the options for Felix.

### 3. `impl/tiago_mpc_visualizer-mouse-target`

Branch `experiment/mouse-target` at `2ceaea1`. Same pattern: the old main
baseline is staged, and the prototype is unstaged plus untracked.

- **The prototype:**
  - `mouse_target.py`: a TargetDynamics spring-damper, with
    `INPUT_CHUNK_S` = .02.
  - `src/mouse-target.js` with its test, and `tests/test_mouse_target.py`.
  - Edits to `live_mpc.py`, `solver_adapter.py`, `live.js`, `main.js` and
    `task-reference.js`.
- **Asynchronous input:** mouse input arrives while the run is going. Check how
  it fits main's "observed asynchronous clients" (`192a624`) and the
  asynchronous settings updates (`61430ec`).
- **Not supported yet:** shaped weights (patching `position_weights` is
  rejected) and the forecast. Merging these into the moving-target prototype
  waits for Felix's go. **Do not do it in this rebase.**

## Order and checks

1. **tiago_mpc trial first**, since both visualizer prototypes depend on its task
   interface and PositionWeights.
   - Tests: the full suite with mypy (`uv run pytest`), as the repo's AGENTS.md
     describes. It ran in the container `tiago-mpc-dev` with
     `unset PYTHONPATH`.
   - GPU: `gpu_checks.py` (adapted), and the short many_jerks smoke run, hold
     against forecast.
     - The earlier result at 50 Hz, with default weights and limits kept: hold
       RMSE 79 mm / max 171 mm; forecast RMSE 47 / 112 mm (data in
       `_expr_data/forecast-20261103/`).
     - Report numbers that differ. The fitted friction and armature are
       already in `f169a20`, so a big change points at the rebase.
2. **Then the two visualizer worktrees.**
   - Select the trial as the MPC source, check the source probe, and run
     `npm test`, `npm run build` and the Python suite.
   - Record the failures that already exist on clean main first, so that you
     report only the new ones.
   - The trial's 8 old failures (stale defaults, fixture hash) may be gone on
     the new main.
3. **Measure the speed, with 1 SQP iteration at 500 Hz.**
   - **Felix (2026-11-08): 500 Hz works only with 1 SQP iteration.** Every
     configuration so far used 5 (`max_sqp_iters` 5): 8092, the 500 Hz
     analysis and all the tracking-study runs. A 5-iteration solve takes about
     2 ms at the median and up to 4.7 ms at p90, so it does not fit the 2 ms
     update period.
   - Measure Live at TO 500, control 500, simulation 1000 Hz, compensation on,
     `max_sqp_iters` 1, with Live's normal measured latency. Measure
     precalculate and On Play, in `calculation_rtf` and the per-part wall
     times.
   - For comparison, also measure the same configuration with 5 iterations.
     This shows how much of the old slowness was the settings and how much
     was the loop.
   - Old baseline (5 iterations, old loop): 0.35–0.49× real time; details in
     `/var/home/felix/_Uni/MasterThesis/research/visualizer-500hz-live-throughput.md`.

**GPU:**
- One job at a time; check `nvidia-smi` first.
- Wrap command-line runs in
  `flock /workspace/GATO-upstream-contributions/.gpu.lock flock /tmp/a2rlab-timing.lock flock /workspace/GATO/.git/experiment-runner.lock …`.
- Never wrap the visualizer server in `flock`: it takes these locks itself and
  deadlocks.

## Running servers: ask Felix before touching them

- **8092 (moving target) and 8093 (mouse target)** run the *old* code from
  these worktrees. Felix uses them.
  - Rebasing in place changes their files under them.
  - Before restarting either, save its Live settings with
    `scripts/control.py get live`, and ask Felix.
  - Configurations: `_expr_data/moving-target/visualizer-8092.json` and
    `_expr_data/mouse-target/visualizer-8093.json`.
- **8093's weights (q_cost 5000 / N_cost 10000) are known to be bad.** ADMM
  hits its cap, solves take 18.5 ms, and the arm stalls. Propose the defaults
  rather than carrying them over.
- **Test servers:** use free ports other than 8090–8095.

## Open decisions to bring back to Felix (don't decide)

- **The tracking study's 500 Hz results assumed 5 SQP iterations within a
  declared 2 ms.** That includes the best configuration, 35.1 mm against IK's
  35.6 mm. Real-time 500 Hz needs 1 iteration, so these results are
  optimistic. Felix decides whether to re-run them with 1 iteration, as a new
  study. Don't relabel the old rows.
- 8092 runs 5 iterations at 500 Hz. Propose switching it to 1 when it is
  restarted.

- How PositionWeights fits main's cost menus.
- The route by which the moving and mouse targets enter the native loop, if it
  is not obvious.
- Whether `measured_t` gets an entry in `docs/decisions.md`.
- Older open points that may surface:
  - the controller interface (option C2);
  - per-task settings (option B), from
    `/var/home/felix/_Uni/MasterThesis/research/visualizer-controllers-and-task-settings-design.md`;
  - friction adapter tanh 0.2 vs native 0.1.

**Other tiago_mpc worktrees** (latency-analysis, obstacles, visualizer-base)
will need `measured_t` in their tasks if this interface lands. Note this; don't
change them.

## Report back

For each worktree, report:
- the new base;
- what was re-applied as is and what was re-expressed (and why);
- the tests before and after;
- the GPU check results;
- the speed numbers;
- the servers' state;
- the decisions listed above.
