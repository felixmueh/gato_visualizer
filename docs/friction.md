# Simulator and predictor friction

Live has two independent switches in the **Friction** group: Simulator friction
and Predictor friction. Both default to off, so plant and predictor are
loss-free (Felix, 2026-10-22, matching `tiago_mpc`'s friction opt-in). This is a
dynamics choice, separate from costs, torque penalties and ADMM bounds.

```json
"plant": {"friction": false},
"friction": null
```

- **Simulator friction** is the visualizer's `config.plant.friction` (boolean).
  On, the coordinator gives `tiago_mpc`'s `SimPlant` the URDF friction
  (`tiago.urdf_friction()`, no width): viscous plus hard-sign Coulomb torque,
  recomputed at every RK4 stage. There is no stick/slip plant.
- **Predictor friction** is `MpcParams.friction`: `null` (loss-free) or the
  `Friction` with the URDF coefficients and a tanh Coulomb width of
  **0.03 rad/s** (`live_mpc.PREDICTOR_SMOOTHING_RAD_S`). The width is fixed and
  not settable: each width is its own compiled GATO plant (Felix, 2026-10-22).
  The schema offers the two values as one choice.

Passive torque is subtracted once from actuator torque in both models. Armature
is not modelled. The coefficients are the reduced right-arm URDF's friction and
damping values (`tiago.urdf_friction`); the schema's `friction` object reports
them with the simulation and prediction laws, and the Friction group shows them.

Both switches belong to the numerical `config`, not presentation preferences.
Editing them uses the ordinary settings transaction: a new history segment
starts from the displayed native q/qd and task time. Use Reset between
comparisons when the same initial state is desired. For a mismatch check,
enable Simulator friction only; with both on, the Coulomb laws still differ
(hard sign in the simulator, tanh in the predictor). Plans record the
`MpcParams` they used, and states the simulator identity with its friction, so
the difference stays visible in metadata. Run again rebuilds the captured
`MpcParams`, including its predictor friction, not the current UI values.

Predictor friction with the loss-free plant plans torques far beyond the effort
limit within a few solves. Since `tiago_mpc` 436b419 `Mpc` returns such plans
instead of refusing them, and Live's [limit handling](execution-api.md#limit-handling)
decides (Felix, 2026-10-23). Checked on the GPU at the defaults (N 32, 2 s
Manual reach, 2026-10-23; scripts and results in `_expr_data/limits-check/` of
the `live/limit-handling` worktree): loss-free completes with
no clipped command and no breach (at most 15 Nm); predictor friction pauses at
0.019 s on a velocity breach (joints 5, 6, 7 above 2.5 rad/s) before any command
is clipped; with the velocity stop off, clipping limits 4 commands (planned up
to 372 Nm) and the arm leaves joint 7's position limit at 0.038 s; with Clip
effort off and only the torque stop on, Live pauses at 0.030 s on joint 7's
371.7 Nm (and joint 5's −28 Nm), continues to a new breach at 0.040 s (joints 6,
1–4) and then fails with a nonfinite simulated state.

Hard-sign Coulomb friction with viscous damping is unstable in the explicit RK4
plant at the default 1 ms step (see the diagnosis below); retaining such
failures is preferable to silently changing the plant law. These controls give
simulation comparisons, not physical-robot qualification.

## Compiled variants

Predictor friction changes the compiled GATO module. The schema advertises
`available_N_by_friction.off` and `.on`, from `tiago_mpc`'s `find_binary` per
offered N in the source probe; `available_N` is their union. Selecting a
predictor/N that is not compiled fails with "Not compiled" and never compiles.
Simulator friction needs no module.

Source / Build compiles the friction variant when **Predictor friction modules**
is checked (`prediction_friction: true` in the build request; loss-free is the
default). The command-line equivalent:

```sh
/path/to/selected/python scripts/source_probe.py build \
  --mpc-root /path/to/tiago_mpc --cache /path/to/tiago_mpc/.cache/host-gato \
  --prediction-friction --N 32
```

This calls `compile_binary` for each N. A running backend learns of modules
built this way only through Apply, which reloads the available knot counts;
**Build selected N** in Settings › Backend lists them in Live without a restart
(for the running solver's checkout, interpreter and cache; Felix, 2026-10-23).

## History

The sections below record the friction work before the migration to
`tiago_mpc` main. Their settings (both on by default, a settable smoothing width,
`joint_dynamics`, `configs/tracking.json`, the stick/slip plant) no longer
exist; the measurements stand as recorded.

### Initial validation, 2026-10-22

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

### Diagnosis of the instability, 2026-10-22

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
which overflows GATO's float32 staging. Both now discard it first. A settings
change after a blow-up anchors at the displayed tip instead; when that state is
beyond float32, the solver child reports "The state is beyond the solver's
range (the plant became unstable); press Reset".

Scripts: `_expr_data/reset-nonfinite/` (`plant_loop*.py`, `predictor_stability.py`,
`armature_bound.py` for CPU checks; `repro.py`, `friction_matrix.py` for Live).

### Stick/slip simulator step, 2026-10-22 (superseded)

Felix accepted the semi-implicit simulator step with Coulomb friction solved as
a constraint; on 2026-10-22 he decided against a stick/slip plant for the
migrated visualizer, which uses `SimPlant`'s law. Checks on the trial branch `visualizer-trial/stick-slip-plant`
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
