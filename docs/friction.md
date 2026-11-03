# Plant and predictor friction

The **Friction** group sets the dynamics of the simulated plant and of the MPC
predictor independently. The plant defaults to semi-implicit Euler with URDF
friction and the constraint Coulomb law (Felix, 2026-10-26); the predictor
defaults to loss-free. This is a dynamics choice, separate from costs,
torque penalties and ADMM bounds.

```json
"friction": null,
"friction_law": {"type": "Tanh", "width_rad_s": 0.03},
"plant": {"integrator": "euler", "friction": true, "coulomb_law": "constraint",
          "friction_width_rad_s": 0.03, ...}
```

## Simulated plant

`config.plant` selects how `tiago_mpc`'s `SimPlant` integrates (Felix, 2026-10-23):

- **Plant integrator** (`integrator`): `euler` (default), a semi-implicit Euler
  step with implicit viscous damping, or `rk4`, GATO's loss-free RK4. Without
  plant friction Euler is loss-free too.
- **Plant friction** (`friction`, default on): the URDF Coulomb and viscous
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

The coordinator builds `SimConfig(q=q, qd=qd, substep=1/simulation_hz,
integrator=..., friction=..., friction_law=...).build()` and starts it on a
`VirtualClock`. The UI's `tanh`, `sign` and `constraint` choices map to the
separate `SimConfig.friction_law` objects `Tanh(width)`, `Sign()` and
`StickSlip()`. `Friction` stores only Coulomb and viscous coefficients.
Native serialization records the separate law's `type` (`Tanh`, `Sign` or
`StickSlip`), with `width_rad_s` inside a tanh law.
Simulation Hz (default 1000) sets the step. The visualizer retains its Euler-only
friction setting; the upstream plant also supports RK4 with Tanh or Sign.

## Predictor

**Predictor friction** is `MpcParams.friction`: `null` (loss-free) or the URDF
coefficients, evaluated with the separate `MpcParams.friction_law` tanh law.
The ordinary native control fixes its width at **0.03 rad/s**. This checkout's
experimental adapter instead exposes the predictor width, initially **0.2
rad/s**, and independent armature enablement; it records the exact effective
values. Each active width is its own compiled GATO model.

## Both models

Passive torque is applied once in each model. The experimental adapter enables
supplied armature independently in plant and predictor and uses the retained
friction prior in the plant and external feedforward; the predictor uses the
nominal URDF coefficients. Coefficients and PD gains stay in code (see
[adapter ownership](../adapters/README.md)).
Editing any of these settings starts a new history segment from the displayed
native q/qd and task time; use Reset when comparisons need the same initial
state. With plant friction `tanh` at 0.03 rad/s, plant and predictor share the
friction law; the integrators still differ. The segment header records the
settings and the simulator identity (`integrator`, `friction`, `friction_law`,
`armature`, `coulomb_law`);
plans record the `MpcParams` they used. Run again rebuilds the captured
`MpcParams`, not the current UI values. Earlier nested-friction API recordings
remain viewable; their native Run again requires the original checkout and is
unavailable here. External feedforward plus internal predictor friction is
rejected before the plant starts. These are simulation comparisons, not
physical-robot qualification.

Portable recordings using the older embedded `Friction.law` format remain
viewable as recorded motion; Run again reports that their native configuration
format is unavailable. Across a source restart, saved browser settings with the
known URDF coefficients and fixed tanh width retain predictor friction. Other
old coefficient/law combinations are rejected visibly rather than guessed.

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
  was inactive in those historical diagnostics. The later experimental adapter
  enables the supplied armature by default with explicit independent toggles.

After a blow-up, Reset and the solver child discard the nonfinite state
instead of seeding GATO with it; a settings change then anchors at the
displayed tip and, when that state is beyond float32, reports "The state is
beyond the solver's range (the plant became unstable); press Reset".
