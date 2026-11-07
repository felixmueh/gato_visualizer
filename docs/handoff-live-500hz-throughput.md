# Handoff: Live at TO 500 Hz falls behind real time

Current integration, 2026-11-07: native branch
`integration/shared-loop-consolidation-2` is in
`../tiago_mpc-shared-loop-integration`; visualizer branch
`integration/shared-loop-consolidation` is in
`../tiago_mpc_visualizer-shared-loop-integration`. Their main bases are native
`221acad` and visualizer `41d7bd3`. Neither main checkout was changed.
The old loop-events/live-loop trials and redundant refactor branches have been
retired. Historical summaries and reproduction scripts remain under the current
worktrees' `_expr_data/shared-loop/`; superseded raw captures were removed.
Servers mentioned below are historical and have been stopped.
Current-main orientation/cost-menu settings,
orientation display/IK and asynchronous-settings Play behavior must survive.

The final API migration uses separate tick, solve-completed and diagnostic
callbacks. Pause retains unread replies; inspection waits for its own worker to
finish before taking the GPU. Normal, latency-compensated and terminal-outstanding
GPU conformance cases have zero array differences. Chromium verified compact
playback, exact orientation exports, retained pause/resume and reset without
JavaScript errors. Final checks and the cleanup manifest are in
`_expr_data/native-api-migration-20261107/`; only the latest identical refactor
replay remains in the shared `ingest/visualizer-shared-loop` directory.

Integration order:

1. Retain the prepared GATO dependency. Felix confirmed that the merged setup
   should use the local armature + collision-cache work until upstream includes
   it. The native integration selects
   `../GATO/.worktrees/tiago-combined`, containing the local armature and
   collision-cache changes. These dependency sources were not changed by this refactor.
   GRiD remains `../GRiD-tiago-armature-060`. The two repository changes alone
   do not package those external dependency sources.
2. Review and merge the native shared-loop change first. Advance the stable
   `visualizer/base` source explicitly to include it, then sync that checkout's
   own environment. A source without the required hooks fails the probe.
3. Review and merge the visualizer change, then select the updated native source.
   Before merging, the two integration worktrees can be used together explicitly.
4. If either main advances during review, replay that integration commit onto
   its new main and repeat the affected checks, native first and visualizer second.

The initial replay of the preserved trial commits preceded consolidation.
Native review checkpoints remain in its integration branch history; the final
loop is committed before the visualizer API migration. No main branch is advanced here.

The consolidation separates `history_store.py` from service orchestration,
`src/live-history-paging.js` from Live settings/playback state, and
`src/live-prediction.js` from transport and rendering. Unused presentation
helpers and the circular session reexport are removed. Generation/cursor state
has one owner; explicit ownership comments cover the native gate, committed
progress, shared control buffers and recording-slot retirement. Integration
also preserves optional orientation references across shared-memory and warmup
transport, compact historical display and exact prediction export.

Validation on the integrated code: 594 native tests plus 67 subtests, mypy,
500 visualizer Python tests (two adapter-specific skips), 518 frontend tests,
and the production frontend build passed. Three-second GPU conformance at
500 Hz commands / 100 Hz TO / declared 5.5 ms latency compared 1501 command-tick
states and all commands/plans with zero array differences. A real Chromium
check ran a 0.4 s orientation-enabled case with 500 Hz simulation/control and
ASAP TO, retained 201 states, scrubbed and hydrated exact export predictions,
and reported no JavaScript errors. This is functional/numerical validation,
not a fresh throughput claim. Logs, source identities, review commit IDs and
the dependency patch are under each integration worktree's
`_expr_data/shared-loop/consolidation/`. These November 3 results describe the
earlier integration. Final API migration checks are under
`_expr_data/native-api-migration-20261107/` in the visualizer and
`_expr_data/shared-loop/native-integration-final-tests.log` in the native checkout.

Latest follow-up, 2026-11-03, browser data churn: playback now reads a compact
companion JSONL stream with identical cursors and full state/control/event
records, but prediction summaries instead of horizon arrays. Indexed prediction
requests run independently, with a generation-scoped 128-plan LRU cache and
at most 32 plans per request. Playing geometry selects a 60 Hz display-time
grid with 18 frames of lookahead; paused selection and animation export hydrate
the exact recorded solves. Motion retains every sample. Full backend records,
inspection, and replay export remain lossless. FK/serialization of the full
server recording still happens; this change removes browser/network churn.

On the measured 1024-record page, gzip payload fell from 2,067,350 to 125,678
bytes (16.45x). This excludes separately requested display predictions, so it
is not a claim of a 16x reduction in all traffic. Eager unused metric-history
rebuilds were removed, and live path/prediction geometry reuses allocated GPU
buffers. API, cache, delayed-download, scrub/export and geometry tests cover
the new path. Evidence is under `_expr_data/shared-loop/compact-playback/`.

Validation: 464 frontend tests; 459 Python tests with two skips, followed by
10 passing compact-API tests including the preview/Play sequence collision
regression; production frontend build passed. Chromium exercised a 3 MiB/s
connection with the first prediction download held for three seconds: motion
continued, exact paused/export predictions loaded, and no JavaScript errors
occurred. Full robot rendering in this container's software-rendered browser
was slow; a second diagnostic hid the robot to separate rendering load from
delivery and verified that pending predictions do not redisplay stale geometry.
In that diagnostic the median compact-page resource duration was 70.7 ms;
buffering still occurred. These browser checks are functional evidence, not a
hardware-accelerated laptop performance qualification. The updated isolated
viewer is **http://192.168.178.82:8132/**.

The separate native follow-up retained reduced state-vector allocation and
frictional Euler matrix allocation in the authorized trial checkout. A focused
Euler microbenchmark improved from 106.1 to 71.9 us; 600 randomized numerical
cases and the full production fixed-latency run (1001 states, 999 commands,
1000 plans) matched exactly. Native validation passed 457 tests plus 67
subtests. This did not demonstrate sustained real time: frozen-runtime
alternating measured-latency calculation RTF was 0.887/0.929 before and
0.873/0.900 after. Shared-desktop timing and variable solve counts limit that
comparison. GC was only about 10–17 ms per three simulated seconds. Remaining
candidates include result serialization, GATO reset_rho and ASAP scheduling
against native compute latency rather than actual result arrival. Changing
that timing policy would change the simulated workload and was not done.
Evidence and the isolated native patch are under
`_expr_data/shared-loop/realtime-followup/`.

Latest follow-up, 2026-11-03, buffered ingestion at 1 kHz controls: a dedicated
CPU process now drains raw solve captures before history deserialization, FK and
JSON processing. The producer ring and separate byte-bounded ingestion queue
each default to 256 MiB. Simulation remains lossless and blocks only when its
bounded queues fill; this does not implement a real-robot telemetry policy.
Startup budgets and ownership are documented in the execution contract.

Three before/after production-pipeline trials used the current reaching target,
N32, one SQP iteration, frictional Euler physics and controls at 1000 Hz,
measured latency, compensation off, ASAP TO and three simulated seconds.
Mean reported calculation RTF improved from 0.805 to 0.924; numerical compute
RTF was 0.921 before and 0.931 after. Command-to-completion wall time, including
initialization/warmup and final history drain, was 4.286 s before and 4.194 s
after. Thus the steady history penalty decreased, but end-to-end improvement is
small and 1 kHz real-time operation is still not sustained. These are sequential
shared-desktop diagnostic windows, not isolated or fixed-work timing: measured
latency changes the number of solves. HTTP/browser activity was excluded.
Peak buffered payload was 3.68 MiB, with zero ingestion-capacity wait.

Validation: 450 Python tests, two skips; process-level slow-consumer, bounded
backpressure, stale-generation, shutdown and ingestion-crash tests. A separate
fixed-1-ms-latency run through the full production pipeline retained exactly
equal numerical records for 1000 plans, 1001 states and 999 applied commands
before/after. Cross-channel arrival interleaving and measured overrun events
can differ; conformance compares each numerical channel in order. Review found
four lifecycle/filtering issues, all fixed; no remaining high-severity finding.
Raw timings, conformance records, test logs and source hashes are under
`_expr_data/shared-loop/buffered-ingestion/`. The updated demo is on port 8131;
the prior paused viewer on 8130 remains available.

Latest state, 2026-11-03, asynchronous batch publication: ordinary reporting no
longer parks the numerical invocation. Two bounded batches carry detached
records and immutable committed progress snapshots to the coordinator owner.
Explicit Pause drains and quiesces; cancellation restores state and interval
costs to the consumed checkpoint. Paced Play uses short windows when ahead,
but catches up without a stop at every batch when behind wall time. Forecast
and capture serialization remain unchanged. Control submission combines the
lease and request notification in one send, and float32-range validation uses
the shared input directly instead of rebuilding its state vector.

Validation: 436 visualizer Python tests, two skips; bitwise GPU conformance for
three simulated seconds / 1500 solves at 500 Hz. Native code is unchanged from
the previously verified 457-test snapshot. Astra re-reviewed the pause race,
cancelled handoff ownership, terminal errors and interval checkpoints; all five
findings were fixed. The actual coordinator/solver/history pipeline also ran
three two-second trials and GPU Pause/resume checks, preserving every state,
command and returned plan.

| Measurement, previous readiness split → asynchronous batches | Before | After |
| --- | --- | --- |
| Profiled gap between native solves | 672 µs | 596 µs |
| Profiled boundary callback wall time | 70 µs | 29 µs |
| Unprofiled numerical visualizer wall, 2 simulated seconds | 2.918 s | 2.844 s |
| Numerical visualizer overhead over asynchronous bare loop | 6.8% | 3.8% |
| Actual worker/FK/JSON/history pipeline wall, 2 simulated seconds | 3.430 s | 3.413 s |

The numerical comparison uses three rotating-order repeats. The production
pipeline measurements include initialization, warmup and final consumer drain;
they exclude HTTP/browser activity. GPU desktop load varies. The remaining
production difference is small enough that no meaningful end-to-end speedup or
performance parity is claimed. Raw results, failures, test logs and the review
are in `_expr_data/shared-loop/async-batches/`; the current receipt is
`validation-receipt.json` there. Earlier windows below remain historical evidence.

Previous readiness-split state, 2026-11-03: the profiling issues are fixed and control readiness
now precedes recording serialization. Torque breaches quiesce before parking;
shutdown returns all known recording ownership; interval physics/total costs
share a boundary. Ordinary recording errors quarantine the idle controller
until leased reconfiguration/close. Command ticks avoid the condition lock
unless entering a reporting/pause gate, reach targets are cached, and compact
control/schedule observations are expanded by the consumer. Ring capacity is
derived from the SQP cap and qualified for N128/100000-iteration diagnostics.
Astra's high-effort follow-up has no unresolved P1/P2 findings in these paths.

Validation: 457 native tests including mypy; 426 visualizer Python tests with two
skips. Three-second 500 Hz GPU conformance remains bitwise identical for states,
commands and all returned plans. One earlier full-suite attempt exposed a race
in the abrupt-parent-death test's immediate lock assertion; the test now waits
within its existing bounded lifetime checks for actual final file release, and
the full suite passed. Original logs remain retained.

Matched diagnostic snapshots (old numerical files restored into an isolated
runtime copy; old native loop loaded explicitly) and the updated implementation
show these instrumented steady means over 1,499 transitions each:

| Critical-path part | Before | After |
| --- | --- | --- |
| Native completion → control notification | 146 µs | 44 µs |
| Owned plan → next submission | 439 µs | 378 µs |
| Total gap between native requests | 836 µs | 674 µs |
| Callback boundary thread CPU | 59 µs | 29 µs |

The inter-solve gap fell about 19%. Its excess over async headless fell from
263 to 152 µs. Recording publication still costs about 98 µs, now overlapping
coordinator work instead of preceding the control notification. Forecasting
is unchanged. Short unprofiled three-repeat/two-second windows gave recording
overhead versus async headless of 8.5% before and 6.5% after. Absolute numerical
visualizer wall time was 2.986 versus 2.974 s; that is little overall change
amid varying desktop GPU activity. Overhead against in-process headless was
8.7% versus 11.3% in those windows. These results establish reduced targeted
host costs, not isolated end-to-end speedup or performance parity. HTTP/browser
remain excluded; the profiling consumer includes production rendering/history
and retains the old redundant discard for matched before/after instrumentation.

Current evidence: [readiness-split receipt](../_expr_data/shared-loop/ready-split/validation-receipt.json),
[Astra follow-up](../_expr_data/shared-loop/ready-split/astra-readiness-review.json),
`ready-split/profile-before/`, `profile-after/`, `throughput-before/`,
`throughput-after/` and `gpu-conformance/`. The sections below retain earlier
investigations; their pending findings are resolved by this latest state.

Implementation update, 2026-11-03: the approved shared-loop design is now in
`/workspace/tiago_mpc_visualizer-live-loop` and native trial
`/workspace/tiago_mpc-visualizer-trial-loop-events`, uncommitted and isolated
from both original checkouts. Live invokes `run_virtual_time` through
`NativeSession`; command-law effort policy, typed observations, cooperative
pause/cancel/reset and configurable age expiry replace the independent loop.
Diagnostics remain binary until presentation. See the current
[execution contract](execution-api.md) and [ADR 001](adr/001-upstream-and-clocks.md).

Validation: 411 visualizer Python tests (two expected skips), 454 browser tests,
450 native tests, native mypy and frontend build passed. Astra reviewed the
design and integration. Logs and task-only diffs are under
`_expr_data/shared-loop/` in each worktree.

GPU follow-up, 2026-11-03: the experiment locks were free; desktop GPU activity
remained around 20%, so these are diagnostic timings. Three-second numerical
comparisons were bitwise identical for states, applied commands and all returned
plans: 100 Hz TO with 5.5 ms declared latency, and 500 Hz TO with 2 ms latency
and compensation. The latter also passed with combined GATO armature support
and collision-cache commit `c610c34`. Comparing before/after GATO outputs also
gave exactly equal arrays. The native trial now selects the isolated
`/workspace/GATO-tiago-armature-collision-cache` worktree; its 14 armature
checks and the native/visualizer Python suites passed again.

Unpaced matched-work timing, three repeats of two simulated seconds, N32,
loss-free RK4, 1000 Hz physics, 500 Hz commands/TO, 2 ms declared latency and
compensation, excluding setup/warm-up:

| GATO dependency | Headless real-time factor | NativeSession/RPC real-time factor | Visualizer/headless wall time |
| --- | --- | --- | --- |
| Armature support | 0.756 | 0.533 | 1.419× |
| Armature + collision cache | 0.739 | 0.520 | 1.422× |

This comparison includes native simulation and visualizer record capture/RPC;
it excludes HTTP, JSON/disk history and the browser. It uses the same static
reference with arrival stopping disabled on both sides. Final states matched
exactly in every timing run. Before the dependency change, mean native solver
time was 2.14 ms on both paths, and RPC/capture added about 0.93 ms per solve.
The native Python forecast took roughly 130–150 microseconds, not a few
microseconds. The earlier C++ feasibility probe is not a production path.
Performance parity remains unmet: the dominant gap is serial RPC/capture.
The collision cache optimizes collision rows, which this workload does not
enable; this is compatibility evidence, not a collision-workload speedup test.

Raw timings: [before](../_expr_data/shared-loop/throughput-before-collision-cache/summary.json),
[combined](../_expr_data/shared-loop/throughput-with-collision-cache/summary.json).
Numerics: [500 Hz combined comparison](../_expr_data/shared-loop/gpu-conformance-500hz-collision-cache/comparison.json).

Asynchronous implementation follow-up: the coordinator and solver now remain
separate for every profile, with shared control arrays and a separate lossless
recording ring. The co-location draft was removed. The loop advances independent
physics before waiting at the activation boundary; reporting/pause quiesces
outstanding GPU work. Producer/consumer ownership, full-buffer backpressure,
retired-ring lifetime, real process overlap and reset/resume are CPU tested.
Capacity-triggered draining is independent of browser report cadence, including
the 1 Hz report / 100 kHz command stress fixture. The final suites passed 456
native tests (including mypy) and 416 visualizer Python tests (two skips).
The forecast is unchanged. GPU conformance at 500 Hz remained bitwise identical.

The final matched three-repeat/two-second diagnostic compares in-process
headless, the same asynchronous engine without recordings, and the numerical
visualizer with an independent recording consumer (HTTP/FK/JSON/browser excluded):

| Scheduling | In-process headless RTF | Async headless RTF | Async + recording RTF | Recording / async headless wall |
| --- | --- | --- | --- | --- |
| Normal OS scheduling | 0.904 | 0.884 | 0.781 | 1.132× |
| Three separate physical cores | 0.749 | 0.733 | 0.668 | 1.096× |

These are separate diagnostic windows, not isolated GPU benchmarks. Do not
compare their absolute RTFs or the earlier windows as a controlled A/B speedup.
Current recording overhead is about 10–13%; total additional wall time against
in-process headless is about 12–16%. Parity remains unmet. The unprofiled CPU
fake-solver control path dropped from about 712 microseconds (old RPC/capture)
to 249 microseconds with shared arrays and recording publication, or 165 without
recording. These CPU figures include the fake solver's numerical wrapper and
process scheduling, and are not a decomposition of actual GPU solves.

Artifacts: `_expr_data/shared-loop/throughput-async-final/`,
`throughput-async-pinned/`, `shared-control-cpu-comparison.json`,
`gpu-conformance-500hz-async/`, and `async-validation-receipt.json`.

Profiling follow-up, 2026-11-03: cross-process monotonic-clock spans, thread CPU
times and a separate cProfile pass identify the added critical path. The long
run records 1,500 solves over three simulated seconds; the table uses its 1,499
steady solve-to-solve transitions, excluding startup/warm-up/final drain. This
is an instrumented shared-desktop diagnostic, not an isolated speed comparison.

| Mean time per transition | Async headless | Async visualizer | Added |
| --- | --- | --- | --- |
| Native controller request | 2,273 µs | 2,332 µs | 60 µs |
| Native completion → control notification | 30 µs | 136 µs | 106 µs |
| Notification → owned plan | 90 µs | 85 µs | −5 µs |
| Owned plan → next submission | 245 µs | 417 µs | 172 µs |
| Submission → next native request starts | 150 µs | 157 µs | 7 µs |
| Total gap between native requests | 516 µs | 796 µs | 280 µs |

The added gap is primarily coordinator observation/callback/batch work and
recording publication before the control notification. `RecordingRing.put`
averages 92 µs, including 74 µs in pickle; this is serialization work, rather
than sustained full-ring backpressure. Native controller time remains the
largest overall cost, with GPU activity varying between windows. Forecasting
is common to both paths and unchanged. Observed physics averages 279 µs per
command interval, with about 90% overlapping the native request in this run.

A consumer using the production resolve/discard/render/HistoryStore functions
takes about 0.67 ms for rendering and 0.70 ms for JSON/history per solve, plus
0.08 ms for consumption. It runs independently and keeps up with the roughly
3.13 ms numerical cycle. HTTP/SSE/browser behavior is not included. Short
instrumented passes were 3–8% slower than nearby unprofiled passes, including
both instrumentation and changing GPU activity; use the spans for attribution.
The existing throughput harness subtracts explicit warm-up but still includes
predictor/stream initialization; steady-cycle attribution avoids that setup.

Astra (`gpt-6-astra`, high) recommends keeping the process boundaries and shared
native loop. Its correctness review found: torque-breach Tick parking can
expose a pending solve before lease release; closed/unsuccessful output paths
can lose recording-slot ownership; and asynchronous collection can charge an
interval's physics one boundary ahead of total wall. CPU probes reproduced a
parked pending request, a failed-emission slot leak, and physics costs of
400/200/0 µs for equal intervals that should each receive 200 µs. These findings
remain unfixed in this diagnostic follow-up. The review also notes redundant
successful-record discards (about 8 µs/solve in the consumer), and a 256 KiB
capture cap not qualified for every accepted diagnostic iteration count.

Next changes should fix those ownership/accounting paths, reduce record-derived
work in the coordinator, then separate control readiness from recording
readiness. Moving the notification alone would expose an unreadable recording
locator; it needs explicit lifetime/readiness semantics. No evidence supports
removing the forecast, dropping history or changing process ownership.

Artifacts: [profiling receipt](../_expr_data/shared-loop/profiling/profiling-receipt.json),
[interactive cycle trace](../_expr_data/shared-loop/profiling/profile.html),
[Astra architecture review](../_expr_data/shared-loop/profiling/astra-architecture-review.json),
[CPU reproductions](../_expr_data/shared-loop/profiling/review-reproductions.json).
The same directory contains raw spans, Chrome trace JSON, pstats, text profiles,
scripts, unprofiled reference runs and logs. Production code was not changed.

The remainder is the original investigation and its proposed fixes, retained
as historical context; its file locations and scheduling contracts predate
the shared-loop implementation.

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
