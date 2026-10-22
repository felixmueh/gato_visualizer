# Simulator and predictor friction

Live has two independent switches in the **Friction** group. New UI defaults enable both, with predictor smoothing **0.03 rad/s**. This is a dynamics choice, separate from costs, torque penalties and ADMM bounds. Existing configurations without any explicit losses keep their loss-free behavior. Explicit upstream `joint_dynamics` is honored for the simulator and its smooth predictor even without a visualizer `friction` field; captured predictor settings remain supported for Run again.

```json
"friction": {
  "simulation": true,
  "prediction": true,
  "predictor_smoothing_rad_s": 0.03
}
```

The switches belong to the numerical `config`, not presentation preferences. Editing them uses the ordinary settings transaction: a new history segment starts from the displayed native q/qd and task time. Use Reset between comparisons when the same initial state is desired. To inspect mismatch first, enable Simulator friction and disable Predictor friction; then enable both and Reset for the matched-coefficient comparison. Both enabled still means **different Coulomb laws**: stick/slip (or hard sign, see below) in the simulator and smooth tanh in the predictor.

Simulator friction calls the selected checkout's `tiago_mpc.joint_dynamics.plant_step` when it exists, with the law `coulomb_stick_slip_viscous` (accepted by Felix on 2026-10-22; currently only on the `tiago_mpc` trial branch `visualizer-trial/stick-slip-plant`). That step is a semi-implicit Euler step with implicit viscous damping and Coulomb friction solved as a stick/slip constraint for the end-of-step velocity: a joint holds exactly while the remaining torque stays within ±c and slips with friction c otherwise. It is stable at the default 1 ms step without armature. Sources without that step fall back to `plant_rk4`, viscous plus hard-sign Coulomb torque recomputed at every RK4 stage (sign(0)=0), which diverges at 1 ms for the light wrist. Neither law models stiction. Predictor friction uses its existing smooth-friction generated module, with tanh velocity width configurable from 0.001 to 1 rad/s. The width is a runtime solver parameter and does not require a different binary. Passive torque is subtracted once from actuator torque. Armature remains inactive metadata in both models; no inertia is added.

Coefficients come from the selected checkout's `configs/tracking.json` joint-dynamics payload, checked against its canonical reduced right-arm URDF. Exact upstream provenance is retained so generated model identity matches the prepared cache. At the current source, Coulomb Nm is `[1.66, 1.15, 1.16, 0.912, 1.25, 0.473, 0.56]`; viscous Nm·s/rad is `[4.7, 9.69, 5.3, 4.2, 3.66, 2.95, 2.95]`. These are Felix's actual supplied values; no guessed arm parameters are introduced. Source paths/hashes, effective laws/vectors/widths, and simulator/predictor mismatch are retained in plans, simulator metadata and captured inspection problems. Historical records retain their original metadata.

The selected source supplies both the plant helper and predictor implementation. A named solver profile can differ from the simulator source, so recorded profile metadata identifies each. Native coordinates and the joint-6 GPU conversion remain unchanged. Cold Run again reconstructs the captured predictor law, vectors and width rather than taking the current UI defaults; it does not advance the simulator.

## Prepared binaries

The schema advertises `available_N_by_friction.off` and `.on`, while `available_N` is their union. Selecting an unavailable mode/N fails explicitly and never compiles. Source / Build has an explicit smooth-predictor choice (`prediction_friction: true` in its build request); loss-free remains the build request default. Both variants use the selected project's existing cache. For a command-line equivalent:

```sh
/path/to/selected/python scripts/source_probe.py build \
  --mpc-root /path/to/tiago_mpc --cache /path/to/tiago_mpc/.cache/gato \
  --prediction-friction --N 32
```

This is an explicit build action. Ordinary configuration, preview, Play and inspection only qualify/load current binaries; they do not call registration or a compiler. Compatibility includes generated model/frame, native sources, toolchain, ABI and architecture. A previously present smooth binary may be stale. Build only the selected missing/stale variant, then Apply/restart using the existing workflow.

Hard-sign Coulomb friction can produce integration-sensitive behavior near zero speed; retaining those outcomes is preferable to silently changing the plant law. These controls provide simulation comparisons, not physical-robot qualification or a claim that smooth friction resolves previous solver failures.

## Initial validation, 2026-10-22

The CPU checks for independent settings, prepared-module selection, provenance
and inspection reconstruction passed. Legacy loss-free conformance also passed:
all three plans, states, timestamps and applied controls matched the upstream
reference bit for bit after aligning the selected interpreter's toolchain PATH.

The initial friction-enabled dynamics checks failed. The standalone upstream
reaching configuration with both laws enabled and a **3 ms plant step** produced
an extremely large finite state during the first 10 ms interval, then failed on
the second solve with a nonfinite prediction. The distinct visualizer check with
**simulator friction only and a 1 ms plant step** also failed on the second solve
at simulated time 0.01 s, reporting nonfinite prediction/torque and error status.
The planned both-on visualizer check was held after this shared plant failure.
Raw records are retained under `_expr_data/friction/native/` in the main checkout.

The requested new UI defaults remain both on, but these dynamics are **not
qualified**, and deployment was held after these checks. Passing control-plumbing
checks does not resolve the dynamics failure. No cause was established; no
timestep change, model change, solver repair or smaller-step follow-up was run
as part of this validation.

## Diagnosis of the instability, 2026-10-22

The validation above stands as recorded; this later diagnosis adds a cause.

- **Plant:** viscous damping is stiff for the explicit RK4 plant. At the
  start posture the largest eigenvalue of M⁻¹B is 3922 1/s, set by joint 7's
  link-only inertia (0.00077 kg m²). RK4 is stable only for h < 2.785/λ ≈
  0.71 ms. A CPU-only Pinocchio loop with viscous damping alone diverges at
  0.8, 1 and 3 ms and stays bounded at 0.7 and 0.5 ms; hard-sign Coulomb
  chatter only seeds the growth from rest. GATO is not involved.
- **Visualizer, 0.5 s at the default 1 kHz:** loss-free completes; simulator
  friction (with or without predictor friction) diverges; predictor friction
  with a loss-free plant also diverges (plan torque 850 Nm at 30 ms, then a
  nonfinite plant state). At **5 kHz**, both laws on and simulator-only each
  complete 0.5 s with torques near 8 Nm and speeds below 1 rad/s. These are
  bounded diagnostics, not reaching qualification.
- **Predictor:** GATO's explicit velocity update at the knot interval is stable
  only for dt < 2/λ: 0.51 ms for viscous damping, 0.07 ms with the tanh slope
  at width 0.03 rad/s, against 10 ms knots.
- **Armature:** with the supplied right-arm armature added to M, these bounds
  become 170 ms (plant), 122 ms (viscous predictor) and 14 ms (tanh predictor).
  The coefficients describe joints with large reflected rotor inertia, while
  both models use link inertia only. Armature stays inactive; enabling it is a
  model decision for Felix.

Reset after such a failure previously failed with `reset x0 must be finite`:
the solver child and the worker both reseeded GATO from the blown-up state,
which overflows GATO's float32 staging. Both now discard it first.

Scripts: `_expr_data/reset-nonfinite/` (`plant_loop*.py`, `predictor_stability.py`,
`armature_bound.py` for CPU checks; `repro.py`, `friction_matrix.py` for Live).

## Stick/slip simulator step, 2026-10-22

Felix accepted the semi-implicit simulator step with Coulomb friction solved as
a constraint. Checks on the trial branch `visualizer-trial/stick-slip-plant`
(worktree `impl/tiago_mpc-visualizer-trial-stick-slip`):

- **Correctness:** CPU tests check the stick/slip optimality conditions over
  random states, exact holding below breakaway, stability at 1 ms, and
  agreement of 1 ms steps with a 0.05 ms reference (`tests/test_plant_stick_slip.py`).
- **Accuracy:** with the supplied armature at 1 ms, a 2 s replay of MPC
  torques stays within 0.17 mrad of a 0.02 ms reference; sign RK4 is 1.3 mrad
  off and creeps 1 mrad per second where the joint should hold. Without
  armature, sign RK4 diverges and the stick/slip step stays within 0.6 mrad.
- **Cost:** about 110 µs per step with armature and 150 µs without (sign RK4:
  60 µs), using an exact active-set solve with a coordinate-descent fallback.
- **Live:** with the trial checkout as simulator and main's GATO as solver
  profile, simulator friction on at 1 kHz, a 2 s reach completed (2001 states,
  max |qd| 0.54 rad/s) in 1.65 s of wall time; the same setting with the sign
  law diverged within 10 ms.

Scripts: `_expr_data/reset-nonfinite/stick_slip_compare.py`,
`stick_slip_no_armature.py`, `stick_slip_live.py`.
