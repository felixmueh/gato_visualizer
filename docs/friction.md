# Simulator and predictor friction

Live has two independent switches in the **Friction** group. New UI defaults enable both, with predictor smoothing **0.03 rad/s**. This is a dynamics choice, separate from costs, torque penalties and ADMM bounds. Existing configurations without any explicit losses keep their loss-free behavior. Explicit upstream `joint_dynamics` is honored for the simulator and its smooth predictor even without a visualizer `friction` field; captured predictor settings remain supported for Run again.

```json
"friction": {
  "simulation": true,
  "prediction": true,
  "predictor_smoothing_rad_s": 0.03
}
```

The switches belong to the numerical `config`, not presentation preferences. Editing them uses the ordinary settings transaction: a new history segment starts from the displayed native q/qd and task time. Use Reset between comparisons when the same initial state is desired. To inspect mismatch first, enable Simulator friction and disable Predictor friction; then enable both and Reset for the matched-coefficient comparison. Both enabled still means **different Coulomb laws**: hard sign in the simulator and smooth tanh in the predictor.

Simulator friction calls the selected checkout's `tiago_mpc.joint_dynamics.plant_rk4`, recomputing viscous plus hard-sign Coulomb torque at every RK4 stage. Sign(0)=0; this is not a stiction model. Predictor friction uses its existing smooth-friction generated module, with tanh velocity width configurable from 0.001 to 1 rad/s. The width is a runtime solver parameter and does not require a different binary. Passive torque is subtracted once from actuator torque. Armature remains inactive metadata in both models; no inertia is added.

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
