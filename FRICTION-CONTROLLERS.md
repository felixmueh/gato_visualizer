# Friction controllers and timing — handoff, 2026-10-27

Open **http://192.168.178.82:8094/** for the experimental viewer. Its settings
expose default plan torque, friction feedforward, PD, and feedforward + PD, with
editable smoothing width. Per-joint armature, friction coefficients and PD gains
stay in code. Plant and predictor armature are separate toggles.
Predictor friction is independent of external compensation. Predicting the same
friction and adding external compensation is rejected before simulation starts.

The retained comparison payload uses a .28 × .18 m figure-eight, period and
duration 24 s, N32, 30 ms knots, EE running/terminal weights 4/80, mu=1,
qd_cost=.01, u_cost=1e-4 and ADMM rho_u=5e-4. Live settings remain editable;
the latest compile-workflow check preserved the accepted session (feedforward,
both armatures enabled and predictor friction disabled) rather than resetting
its weights. Press Play to calculate and play; change the law to try another
controller. Demo comparison settings do not change package solver defaults.

## Timing

Both updated viewers use measured solve latency by default: native
`Plan.stats.wall_s`, excluding interprocess transport. The plant continues under
the previous command until a new plan is available on a command tick. Plans keep
their original state/time origin. Laws get current simulated feedback at 500 Hz.
TO requests are independent of prediction knots; missed slots are skipped and
overlapping solves are not launched.

The experimental session now uses 1000 Hz physics, 500 Hz command/feedback and
back-to-back TO (`to_hz=0`), as requested later in the session. Main's
package-aligned defaults are 1000/500/100 Hz. Measured latency and as-fast-as-possible
TO have separate checkboxes; their numeric fields are disabled in those modes
and retain their last numeric values. No ideal-timing preset was
introduced. This models optimizer delay on this machine; observation noise,
observation/transport delay, SEA elasticity and actuator-delivery dynamics remain
absent. This is not an identified end-to-end robot timing model.

The session reuses `tiago_mpc.loops.Schedule`. It retains its incremental
multirate/history lifecycle because `run_virtual_time` owns a finite blocking
run, clock, startup/shutdown and stop behavior. Native conformance compares
against `run_virtual_time` with declared 5.5 ms latency on both sides.

Timing inputs accept explicit Hz or time suffixes (`50 Hz`, `0.02 s`, `20 ms`);
bare numbers use the labelled unit. The API remains numeric in its native
units. Task setup is directly under Task; execution timing and prediction
horizon are separate, plant dynamics are grouped, and MPC bounds are distinct
from plant limit handling. Goal/task and runtime edits no longer trigger model
lookups or disable the task handles.

## Comparison plots

Loading at least two recorded runs enables Comparison alongside Episode and
Solve. Its first-use cards show tracking error, time-weighted tracking summary
and smoothness. The **+** catalog includes Recorded channel by run, with any
discovered timed numeric scalar/vector channel. Each card has independent
settings; duplicate it for additional signals. Run names, colours and timeline
offsets carry through. Metrics use the common recorded interval and show
coverage; overlays preserve gaps and end at real support.

The catalog also includes **Squared control effort**: cumulative ∫||τ_applied||² dt
or total by run, in Nm²·s. It integrates actual recorded applied torque with a
zero-order hold and reports coverage; missing torque is not treated as zero.
Comparison catalog, previews and evaluations wait while Live calculates and
refresh after it pauses or finishes. Retained playback permits calculation.

ASAP TO has no nominal deadline, so it no longer produces red deadline markers.
Yellow still identifies simulation/combined computation slower than real time;
playback can buffer when recorded data arrives slower than 1× playback.

The extensible Python API is `@plot_comparison` with immutable `ComparisonView`
and `ComparisonRun` objects, separate from Episode/Solve functions. See
[the contract](docs/plot-api.md#comparison-plots) and
[author instructions](docs/plot-authoring.md#comparative-plot-authorship).
The existing separate CPU worker runs plotting, not the MPC process.

## Sources and branches

The visualizer changes remain **uncommitted** for Felix to review. The package
friction/armature commit was promoted to `c0bcbc8` and fast-forwarded onto TIAGo
main on 2026-10-28. Nothing was pushed; no physical robot execution was performed.

| Checkout | Branch | Role |
| --- | --- | --- |
| `/workspace/tiago_mpc_visualizer` | `main` | Timing fix and controls; running on 8090 |
| `/workspace/tiago_mpc_visualizer-friction-compensation` | `experiment/friction-controllers` | This viewer, source-defined controls and law execution; running on 8094 |
| `/workspace/tiago_mpc` | `main` | Merged package laws/armature and tuning experiment, plus uncommitted latency work; ignored link selects the visualizer-owned adapter |
| `/workspace/GATO-tiago-armature` | `experiment/tiago-armature-015` | Existing narrow armature adapter/cache extension |
| `/workspace/GRiD-tiago-armature` | `experiment/tiago-armature-055` | Existing narrow reflected-inertia code generation |

The viewer branch starts at Git main `01afe4af1ac8c2bc9c2aa0299f942c8bc7b645fe`
and includes the full dirty working-main overlay, including its timing fix and
preexisting migration/UI work. `_expr_data/base-main-20261027/` preserves the
starting source, patch and receipt; Git HEAD alone does not describe it.
Main's selected TIAGo source is the clean stable base at `c0bcbc8`, advanced
with its own environment on 2026-10-28. Main and this viewer were restarted on
8090 and 8094 for the upgraded API. Dev on 8093 remains stopped.

## Package laws and experimental physics

`tiago_mpc.laws` provides `PlanFeedback` and `FrictionFeedforward`;
`tiago_mpc.util` provides `inertia_gains`. All are exported at the package root. They are ordinary callable laws:
PD adds position/velocity feedback around the plan; the feedforward wrapper adds
friction torque using planned velocity and can wrap default plan torque or PD.
Execution computes the total requested torque before configured effort clipping.
Records distinguish base MPC torque, requested total and applied torque. Laws
do not extrapolate beyond the plan; the viewer holds the last valid total command
at the horizon boundary.

Implementations moved from the experiments into the package. Armature and the
fixed tuned PD gains are checked-in model values in `tiago_mpc/tiago.py`; the
adapter uses those package defaults. Friction presets and tuning remain in
`experiments/controller_tuning.py`; since 2026-11-12 the adapter takes nothing
from it and its feedforward uses `tm.urdf_friction()`. Changing armature does not silently retune
the fixed gains. The laws can be passed to a package execution loop; there is no
new robot selection UI or hardware qualification. The manual tuning procedure is
in the TIAGo worktree's `docs/controller-tuning-on-robot.md`.

The provider's plant uses the URDF friction coefficients (`tm.urdf_friction()`)
and supplied reflected inertia. It preserves native
StickSlip/semi-implicit settings. Holding and sliding share one Coulomb threshold.
This is the retained comparison model, not new friction identification.
Predictor friction defaults off; its visible enabled width is .2 rad/s.
Binary availability checks actual native armature, coefficients and width.
Ordinary edits never compile; use the explicit Compile prompt for a missing predictor variant.
Rejected candidates leave accepted model settings unchanged.

## Common model compilation

All supported knot counts are selectable. Uncompiled choices and affected model
controls use a different shade; a centered prompt at the top of the viewport
offers **Compile** for the exact selected N and predictor settings. Advanced
Source / Build remains available for preparing several knot counts.

Descriptors mark runtime and compiled-model check dependencies. Goal/task,
execution, simulation and annotated runtime edits reuse readiness without
another model lookup. Unknown predictor fields are checked conservatively.
Checks stay hidden and asynchronous, with target handles editable throughout.
Readiness
comes from `find_binary` on the actual resolved native parameters in the selected
interpreter and cache. The visualizer does not invent a second binary identity.
Predictor armature and friction select distinct native cache variants; plant
armature and external compensation do not change the predictor binary.

Compilation freezes its request while the draft stays editable. On completion,
the visualizer rechecks the latest draft before accepting it. Runtime cost edits
can reuse the new module; a newer missing combination stays a draft. Profile,
cache, source and adapter changes invalidate stale results. Existing cached
models remain available, and the accepted model stays unchanged while a missing
combination is selected or built. See [the contract](docs/source-settings.md).

## Visualizer-owned settings adapters

The generic extension is on this experimental viewer branch. Standard metadata
is in `adapters/tiago.py`, used for any compatible checkout. An optional ignored
`<selected-tiago>/_visualizer/_settings.py` overrides it and implements `describe()`,
`build_simulation(values, base_sim_config)`, and
`build_predictor(values, base_mpc_params)`. Descriptors are JSON; builders return
native objects in the selected interpreter. Plant/law settings belong to the
simulator source, predictor settings to the active solver profile. Claimed native
fields display actual resolved values read-only. Requested values, effective
objects and provider identity are recorded. Source Apply reloads provider code.

The friction controls are part of the standard adapter `adapters/tiago.py`
since 2026-11-08 (formerly `adapters/friction_compensation.py`, selected by a
local override); its tests also live in this visualizer repo.
New settings within these plant, predictor and law hooks can use an ignored
worktree file. New widget kinds or scheduler behavior still require visualizer changes.
No selected-source JavaScript is loaded. Main has the timing work only.
See [the contract](docs/source-settings.md) and
[the adapter](adapters/tiago.py).

## Verification and remaining limitation

- Main: 305 Python tests, 377 frontend tests, build and CPU browser checks passed.
  Native 3 s delayed conformance passed with equal state, command and prediction
  arrays. Evidence: main's `_expr_data/timing-main-20261027/`.
- Package laws: 343 CPU checks, 67 subtests and import/type checks passed.
  Twenty-four retained command fixtures and three gain fixtures stayed equal;
  historical records still load. Evidence: TIAGo's
  `_expr_data/law-package-20261027/`.
- Experimental frontend: **430 tests** and production build passed. Full Python
  suites passed with the experimental source (**386 tests**) and stable source
  (**373 tests, 7 skipped**). Stable skips are experimental native APIs.
  Coverage includes captured models, provider identity, exact Build refresh,
  draft/profile/cache guards and strictly positive widths.
- Chromium/native smoke passed all four laws (.4 s each, 198 commands each),
  with positive measured startup latency, actual dropdown/gain/reset use,
  independent armature toggles, internal friction, missing-variant rejection and
  explicit Build of a cached model. This is plumbing verification, not a new
  tracking/tuning comparison. Full prior comparisons remain in TIAGo's data.
- The common Compile workflow passed a real missing N24 build, accepted the
  latest runtime cost edit made during compilation, and ran a .12 s native
  prefix with 58 finite commands and positive measured startup delay. Original
  N32 settings and the paused dev viewer were restored. See the
  [current receipt](_expr_data/unified-compile-20261027/RESULTS.md).
- Later browser checks pass 32 target moves/runtime edits with one initial
  model lookup, hidden background checks, timing units/modes and consolidated
  controls. Four retained nominal runs render three seeded comparative plots
  plus a generic joint channel and a 500 ms offset, without Live setting changes.
  A real four-run CPU job completes in 9.3 s cold and 1.1 s warm under the
  unchanged 30 s timeout; these are diagnostic observations, not MPC benchmarks.
- A bounded native ASAP/measured-latency check advanced .3 s in .422 s wall
  time (0.71× real time), with 106 solves, 148 commands and no red deadlines.
  The old rule would have falsely marked 62 intervals red. This verifies
  progress and deadline classification for this prefix, not every reported hang.
- Chromium verifies cumulative and total effort on four retained runs, plus
  deferred catalog/reconfiguration jobs and refresh after calculation stops.
  Backend settings and all three user freezes were preserved across reload.
- Earlier full suites failed the abrupt-coordinator-shutdown lease-release test;
  those receipts remain below. Later full suites, including the current checks,
  passed. Lifecycle code and assertions were unchanged; this does not establish
  a fix for the earlier intermittent failure.

Evidence in this checkout:

- `_expr_data/source-settings-20261027/BACKEND-REPORT.md`: focused results,
  both full-suite failures, passing focused repeat and limitations.
- `_expr_data/source-settings-review-20261027/review.md`: independent review;
  all three findings were addressed before final native/browser checks.
- `_expr_data/source-settings-20261027/frontend-final-all.log`: 381 passing tests.
- `_expr_data/demo-20261027/browser-result.json`: browser/native result;
  `native-{default,pd,ff,both}.json` retains raw records and effective settings.
- `_expr_data/demo-20261027/final-ready.json`: final backend reload, restored
  24 s ready session and zero-width rejection. Window receipts record dev
  restoration; earlier failed harness attempts are preserved beside them.
- `_expr_data/unified-compile-20261027/`: common compile workflow verification,
  native model identity checks, final full-suite logs and bounded review.
- `_expr_data/model-check-interaction-20261027/`: latest UI/mode/comparison
  verification, reviews, preserved failed attempts and real-data CPU diagnosis.
- `_expr_data/to-asap-faults-20261027/`: ASAP progress/classification, effort
  integral known-answer checks, deferred comparison, final suites, browser
  verification and byte-preserved frozen-run reload receipts.

## Restart

After the approved 2026-10-28 cleanup,8094 selects TIAGo main with the same
ignored adapter link and settings. Use its prepared interpreter:

```bash
env -u PYTHONPATH -u ROS_DISTRO \
  TIAGO_VISUALIZER_RUNTIME_DIR=/dev/shm/tiago-visualizer-friction-20261028 \
  /workspace/tiago_mpc/.venv-container/bin/python \
  server.py --host 0.0.0.0 --port 8094 \
  --config _expr_data/demo-20261027/visualizer.json \
  --mpc-root /workspace/tiago_mpc
```

Live settings are runtime state. The latest accepted restoration payload is in
`_expr_data/model-check-interaction-20261027/ready-payload.json`; the earlier demo payload
remains in `_expr_data/demo-20261027/ready-settings.json`.
New logs/results stay in the owning checkout's ignored `_expr_data/`.
