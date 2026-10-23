# Plant and predictor friction

The **Friction** group sets the dynamics of the simulated plant and of the MPC
predictor independently. Both default to loss-free (Felix, 2026-10-22, matching
`tiago_mpc`'s friction opt-in). This is a dynamics choice, separate from costs,
torque penalties and ADMM bounds.

```json
"friction": null,
"plant": {"integrator": "rk4", "friction": false, "coulomb_law": "constraint",
          "friction_width_rad_s": 0.03, ...}
```

## Simulated plant

`config.plant` selects how `tiago_mpc`'s `SimPlant` integrates (Felix, 2026-10-23):

- **Plant integrator** (`integrator`): `rk4` (default), GATO's loss-free RK4, or
  `euler`, a semi-implicit Euler step with implicit viscous damping. Without
  plant friction Euler is loss-free too.
- **Plant friction** (`friction`, default off): the URDF Coulomb and viscous
  coefficients (`tiago.urdf_friction`). It needs Euler: the browser disables it
  under RK4 and switches it off when RK4 is chosen; the backend rejects the
  combination.
- **Coulomb law** (`coulomb_law`, used with plant friction; default
  `constraint`, `tiago_mpc`'s default):
  - `constraint`: a coupled stick/slip solve; a joint holds while the friction
    it needs lies within ±c and slips at c.
  - `sign`: c·sign(v) of the previous step's velocity; can chatter and creep
    near zero velocity.
  - `tanh`: c·tanh(v/width) of the previous step's velocity, the predictor's
    law; creeps below breakaway. **tanh width** (`friction_width_rad_s`,
    default 0.03 rad/s) is shown only for this law.

The coordinator constructs `SimPlant(q, qd, substep=1/simulation_hz,
integrator=..., friction=..., coulomb_law=...)`, with the width in the
`Friction` only for `tanh`. Simulation Hz (default 1000) sets the step.

## Predictor

**Predictor friction** is `MpcParams.friction`: `null` (loss-free) or the URDF
coefficients with tanh Coulomb of width **0.03 rad/s**
(`live_mpc.PREDICTOR_SMOOTHING_RAD_S`). The width is fixed: each width is its
own compiled GATO plant (Felix, 2026-10-22).

## Both models

Passive torque is applied once in each model; armature is not modelled. The
group lists the coefficients, which are questionable (see `AGENTS.md`).
Editing any of these settings starts a new history segment from the displayed
native q/qd and task time; use Reset when comparisons need the same initial
state. With plant friction `tanh` at 0.03 rad/s, plant and predictor share the
friction law; the integrators still differ. The segment header records the
settings and the simulator identity (`integrator`, `friction`, `coulomb_law`);
plans record the `MpcParams` they used. Run again rebuilds the captured
`MpcParams`, not the current UI values. These are simulation comparisons, not
physical-robot qualification.

## Compiled variants

Predictor friction changes the compiled GATO module; plant friction needs none.
The schema advertises `available_N_by_friction.off` and `.on`, from
`tiago_mpc`'s `find_binary` per offered N in the source probe; `available_N` is
their union. Selecting a predictor/N that is not compiled fails with "Not
compiled" and never compiles.

Source / Build compiles the friction variant when **Predictor friction modules**
is checked (`prediction_friction: true` in the build request; loss-free is the
default). The command-line equivalent:

```sh
/path/to/selected/python scripts/source_probe.py build \
  --mpc-root /path/to/tiago_mpc --prediction-friction --N 32
```

This calls `compile_binary` for each N into `tiago_mpc`'s default cache
(`--cache` overrides it). **Build selected N** in Settings › Backend lists the
new modules in Live without a restart (for the running solver's checkout,
interpreter and cache; Felix, 2026-10-23); otherwise Apply reloads them.

## Findings

Simulation diagnostics, not reaching qualification.

- **Plant options (2026-10-23, `tiago_mpc` `sim/plant-options` 07bbbba, N 32,
  loss-free predictor, 2 s Manual reach at the default rates):** every option
  completes without a clipped command or breach. Loss-free RK4 and loss-free
  Euler arrive at 1.842 s (final distance 4.3 cm, max |qd| 1.05 rad/s). With
  plant friction the arm lags: tanh 0.03, sign and constraint end within 0.5 mm
  of each other, 12.1 cm from the target, without arriving (max |qd|
  0.54 rad/s). Interval wall time per simulated second is about 0.51 s, 0.61 s
  for constraint (physics 0.21 s instead of 0.10 s). Script and results:
  `_expr_data/friction-smoke/` of the `ux/plant-friction-options` worktree.
- **Predictor friction with a loss-free plant (2026-10-23, `tiago_mpc`
  436b419, N 32, 2 s Manual reach):** plans torques far beyond the effort limit
  within a few solves, which [limit handling](execution-api.md#limit-handling)
  then decides. Live paused at 0.019 s on a velocity breach (joints 5–7 above
  2.5 rad/s); with the velocity stop off, clipping limited 4 commands (planned
  up to 372 Nm) and joint 7 left its position limit at 0.038 s; with Clip
  effort off, the torque stop paused at 0.030 s (joint 7, 371.7 Nm) and the run
  later failed with a nonfinite simulated state. Loss-free completed without
  clipping or breach.
- **Predictor stiffness (2026-10-22):** GATO's explicit velocity update at the
  knot interval is stable only for dt < 2/λ of M⁻¹B: 0.51 ms for viscous
  damping and 0.07 ms with the tanh slope at 0.03 rad/s, against 10 ms knots,
  set by joint 7's link-only inertia (0.00077 kg m²). With the supplied
  right-arm armature added to M these bounds become 122 ms and 14 ms. Armature
  stays inactive; enabling it is a model decision for Felix.

After a blow-up, Reset and the solver child discard the nonfinite state
instead of seeding GATO with it; a settings change then anchors at the
displayed tip and, when that state is beyond float32, reports "The state is
beyond the solver's range (the plant became unstable); press Reset".
