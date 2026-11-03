# Handoff: Live at TO 500 Hz falls behind real time

For the coding agent addressing it. Written 2026-11-03 against visualizer main
`f7f1122` plus its uncommitted working tree. The hot-path files
(`execution_session.py`, `execution_worker.py`, `solver_worker.py`,
`solver_adapter.py`, `solver_process.py`, `execution_bridge.py`, `live_mpc.py`)
are byte-identical to those of the measured state. The measurements and their
caveats are in
[the 500 Hz analysis](/var/home/felix/_Uni/MasterThesis/research/visualizer-500hz-live-throughput.md).
It was a basic analysis: no profiler was run and nothing was fixed.

## Goal

Felix wants Live On Play at TO 500 Hz to run as close to 1× real time as
possible. The settings are control 500 Hz, simulation 1000 Hz, declared latency
2 ms, latency compensation on. Where 1× is impossible, the UI should say so
honestly (AGENTS.md: "Real time is the goal; the first version may run slower if
the UI says so").

**Out of scope:** the 8093 mouse-target case. Its solves take 18.5 ms because
ADMM hits its iteration cap with q_cost 5000. That is solver or task tuning, not
visualizer throughput.

## The problem

Nothing rejects or clamps 500 Hz. In simulation time the requests come exactly
every 2 ms. But `MultirateSession` runs the following serially for each 2 ms
tick:

| Part (medians) | Precalculate | On Play |
|---|---|---|
| Native GATO step (`stats.step_wall_s`) | 1.97 ms | 2.09 ms |
| Python and RPC around it: forecast, reference, snapshot, plan dict | 1.45 ms | 2.3 ms |
| – of which the latency-compensation forecast | ~0.55 ms | |
| – of which RPC framing alone (microbenchmark) | ~0.3–0.5 ms | |
| Plant: 2 SimPlant substeps (`physics_wall_s`) | 0.46 ms | 0.74 ms |
| Scheduler, state and control records | ~0.15 ms | ~0.2 ms |
| **Total per 2 ms of simulation** | **~4.0 ms** | **~5.4 ms** |

- **Result:** 0.45–0.49× real time in precalculate, and 0.35× in On Play
  (`calculation_rtf`), where `mpc_hz` is about 175 in wall time and the
  playback buffer drains. At TO 100 Hz the same configuration reaches 1.5×.
- **Outside the session loop the cost is negligible:** history, JSON and HTTP
  add about 0.13 ms per tick.
- **The solve alone fills the budget.** So no serial loop reaches 1× at
  500 Hz. Real time needs overlap, or a solve under about 1.5 ms.
- **With `solve_latency_s: "measured"`** (Felix's current 8092 setting), any
  solve over 2 ms pushes the next request to the next command tick, i.e. 4 ms
  later (`_next_request_time`). About half the solves then run at 250 Hz, even
  in simulation time. This is correct realistic-timing behaviour, not a bug.
  Mention it in the UI or the docs if it surprises users.

## Where the time goes (code map)

- `execution_session.py:318` `_solve`: it calls `_forecast_initial_state`
  (`:272`, a Python Pinocchio rollout of the held commands, about 0.55 ms), then
  `solver_adapter.solve_snapshot` (`solver_adapter.py:252`, which builds the
  reference and the snapshot), then the RPC to the solver child.
- `solver_worker.py:155-187`: per solve, the child builds a plan dict. It
  includes `diagnostics` (`finite_or_none` over the `DIAGNOSTICS` lists), a
  duplicated `initial_state`, and `_states`/`_torques` of about 23 kB, roughly
  80 % of the history bytes.
- `execution_session.py:440-460`, inside `advance_interval` (`:371`): the
  plant-substep loop, including the breach watch and the state records.
- `execution_session.py:164` `interval_record` and
  `execution_worker.py:90-114`: the metrics (`solve_wall_s`, `physics_wall_s`,
  `total_wall_s`, `calculation_rtf`, `mpc_hz`). Use them to measure.

## Candidate fixes (the gains are estimates, not measurements)

1. **Overlap the plant and the forecast with the GPU solve** (the largest
   lever).
   - A plan requested at t takes effect only at its `available_time_s`, which
     is at least t + 2 ms with the declared latency. Meanwhile the plant
     integrates under the previous plan.
   - So the plant step for [t, t + 2 ms] does not depend on the solve, and can
     run while the child solves. This hides the physics and the record cost
     (about −0.7 to −1 ms).
   - **The safe overlap ends at the earliest moment the new plan could take
     effect.** With declared latency that is t + latency. With measured
     latency it is the next command tick after t, because the latency is
     known only after the solve. If control_hz is above to_hz, that tick can
     come before t + 2 ms.
   - The forecast needs only the state at t, so it is still computed before the
     request.
2. **Cheaper forecast** (about −0.55 ms).
   - Move it into the solver child, batch it, or reuse the plant's own step
     machinery.
   - It must keep its contract: the same physics as the simulated plant,
     separate Pinocchio data, and the law's hold copied.
3. **Lighter hot-path payload** (about −0.5 to −1 ms).
   - Send `_states`, `_torques` and the stats per solve. Defer or subsample
     `diagnostics` and drop the duplicated `initial_state`.
   - **First find every consumer** (Solve inspector, plots, history,
     `docs/live-api.md`) and keep their contracts. Prefer "computed on demand"
     to "removed".
4. **Combined estimate:** 1 to 3 together give about 2.3–2.8 ms per tick, i.e.
   about 0.7–0.85× real time on 8092's configuration. Report what you actually
   reach.

## Decisions for Felix (ask, don't decide)

- If 1× stays out of reach, is 500 Hz labelled in the UI, or offered as
  "unpaced precalculate, then replay"? Precalculate already reaches about 0.5×.
- Any change to what the history or Solve inspector shows. For example, if
  diagnostics are kept only for every k-th solve at high rates.
- Any change that needs `tiago_mpc` itself. AGENTS.md: "this project avoids
  changes to `tiago_mpc`".

## Acceptance

- **Same simulation:** for a fixed configuration and duration, the states,
  plans, commands and event records must equal those of the serial loop. Only
  the wall-time fields may differ. Check this in a test, not just by eye:
  overlap must not change the realistic timing.
- **Numbers:** per-part medians as in the table, baseline vs change.
  - Measure in the same session, alternating, because the host was loaded
    (CPU about 88 % busy) during the analysis.
  - Use 8092's configuration in precalculate and in On Play, and also TO
    100 Hz, as a regression check.
- **Tests:** `npm test`, and the Python suite (`docs/architecture.md`, section
  "Verification"). Record the failures that exist before your change first. In the
  moving-target worktree there were 8, all from old defaults: tanh .03 vs .1,
  velocity_fraction .8, the conformance plan count, the breach test, and the
  URDF fixture hash.
- **Docs:** update `docs/architecture.md`, and `docs/live-api.md` or
  `docs/execution-api.md` wherever behaviour or the payload changes.

## How to run and measure

- **Run in the container** like the existing servers: paths `/workspace/...`,
  `podman exec tiago-mpc-dev`. Start your own server on a free port, with
  `./scripts/start.sh --port <p> --config <your json>`.
- **Ports to leave alone:**
  - Never drive 8090 (Felix's viewer).
  - 8091–8095 are in use by Felix and other sessions, including 8092
    (moving-target) and 8093 (mouse target).
- **Do not wrap the server in `flock`.** It takes the three GPU locks itself
  (`live_mpc.py:294-328`). The wrapper deadlocks it in `gpu_busy`.
- **GPU:** one job at a time; check `nvidia-smi` first.
- **Reading results:**
  - Use `scripts/control.py` (`docs/agent-api.md`) and
    `/api/live/history?generation=<g>`. There is no `/api/live/status`.
  - A settings patch starts a new generation, and old cursors return HTTP 409.
- **Profiling:** py-spy is not installed. Use `cProfile` or `perf_counter`
  probes in a scratch copy, not in committed code.
- **Previous material** (gitignored, in the moving-target worktree):
  `../tiago_mpc_visualizer-moving-target/_expr_data/fps-500hz/`. It holds the
  configuration `visualizer-8096.json` (MPC source
  `tiago_mpc-visualizer-trial-moving-target`; the default base source is fine
  for this work), the server log, `ipcbench.py` (the RPC microbenchmark), and
  `runs/`. `runs/` contains run_A/A3/B/C/D/E, the 8093 history and the
  `agg.py` aggregation.
  - A: precalculate, 8092 configuration
  - A3: A over 3 s
  - B: A without compensation
  - C: TO 100 Hz
  - D: q_cost 5000 / N_cost 10000
  - E: On Play
- **Repository rules:** do not commit, merge, rebase or push. Leave the changes
  uncommitted for Felix. Work in a worktree of your own
  (`experiment/live-500hz`) rather than in main's working tree, and copy main's
  uncommitted state over as the baseline first, as the other experiment
  worktrees did.
