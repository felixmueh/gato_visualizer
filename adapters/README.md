# TIAGo settings adapters

The visualizer owns standard display metadata and settings adaptation in this
directory. `tiago.py` is the default adapter: native settings remain those of
the selected `tiago_mpc` package. `friction_compensation.py` supplies the
experimental armature, plant-friction and execution-law controls for the
friction-compensation worktree.

`obstacle_avoidance.py` edits `tiago_mpc`'s collision rows and the execution law
for the obstacle-avoidance demo (below).

A checkout may select a different adapter through its optional, locally ignored
`_visualizer/_settings.py`; a symlink to this directory selects the experimental
adapter without copying its code into `tiago_mpc`. The local override takes
precedence over `tiago.py`. Source Apply reloads changed code and captures the
resolved adapter's actual path and hash. See [source settings](../docs/source-settings.md)
for loader, ownership and explicit Build behavior. Plot modules remain separate;
the underscore-prefixed override is not a plot.

The selected checkout's interpreter imports the adapter. The three plain
functions are CPU-only:

- `describe()` returns finite JSON descriptors for separate `simulation` and
  `predictor` value scopes, with explicit defaults, parameters and native fields
  owned by each builder. Field shape is fixed; law selection changes visibility.
- `build_simulation(values, base_sim_config)` returns native `(SimConfig, law)`;
  the law returns `Command | Fault`, retaining requested and applied torque.
- `build_predictor(values, base_mpc_params)` returns native `MpcParams`.

Builders are only needed for the scopes an adapter claims. The default adapter
returns no extra scopes, so ordinary native objects and `SampleKnot` are kept.
No adapter registry or installation into the selected environment is required.

Pass complete values based on that scope's `defaults`; apply edits to a copy.
Returned native objects are the effective settings to display and record.
Requested values retain inactive widths; turning armature off returns exactly
seven zeros, not a different inertia fallback. Joint armature, friction
coefficients and PD gain vectors stay in code. Hidden/inactive fields remain
validated. Native objects use joint
order 1–7, including joint 6's sign.
Both tanh-width descriptors have an exclusive zero lower bound, matching the
native requirement that width is strictly positive.

## Experimental friction-compensation adapter

Simulation owns only `armature`, `friction.coulomb_nm`,
`friction.viscous_nm_s_per_rad` and the separate `law` slot. It preserves base
friction enable/disable and its separate `SimConfig.friction_law`
(`StickSlip`, `Sign` or `Tanh` law/width), plus
q, qd, substep, integrator and real-time pacing. A disabled base friction stays
`None`; the adapter does not silently enable it. Choose the native
integrator explicitly, including Euler for StickSlip.

The UI exposes plant armature enablement, the execution law
and external feedforward's scalar tanh width. Native plant friction enablement,
Coulomb law and its scalar width remain independent ordinary simulation
controls. These changes have descriptor `effect="runtime"`: no predictor build
is needed. PD gain vectors, per-joint armature and all Coulomb/viscous vectors are absent
from requested values and descriptors; the normal backend rejects extra vector
keys. Effective native objects still serialize the complete actual coefficients.

Simulation defaults use supplied armature and the retained proximal friction
prior with nominal wrists; default execution is `SampleKnot`. The `pd`, `ff`
and `both` selections use the same gain vectors and loss profile as the
locked tuning presets. `tiago_mpc.ARMATURE_KG_M2`, `PD_KP` and `PD_KD` now
own the fixed model values; `PlanFeedback()` uses those gain literals.
Toggling armature does not recompute them. Only the retained coefficient prior
and default external-FF width come from
`experiments.controller_tuning.TUNED_FEEDFORWARD`; its coefficient-only
`friction` and separate `evaluation` preserve the existing demo physics.
Algorithms come from `tiago_mpc` package laws. This adapter requires the
coefficient-only friction API promoted on 2026-10-28, native `Command | Fault`
law results and that retained preset. Native wrappers propagate faults; the
adapter does not convert torque-array results.

Predictor ownership is independent: `armature`, the whole `friction` field and
its separate `friction_law` evaluator.
Its three controls are armature enablement, friction enablement and scalar tanh
width, each marked `effect="compiled_model"` for explicit build handling.
Defaults are supplied armature on, predictor friction off and a visible tanh
width of **0.2 rad/s**. Enabling friction uses the nominal URDF joint
coefficients in code and exactly the displayed width. There is no hidden 0.03
substitution.
Costs, bounds, N, knot interval, warm-start and time-budget fields stay as given
by the active base profile.

Plant/law changes never change predictor values automatically. In particular,
external feedforward with predictor friction enabled is rejected before the
plant starts, even when their coefficient profiles differ. Nested feedforward
is also rejected. Internal predictor friction remains valid with default/PD,
and physical plant friction is independent. Predictor width or enablement changes can require a different
native binary; only the backend's explicit **Build** action may compile it.
These adapter functions neither probe binaries nor compile or load a solver.

The backend keeps simulator-source and solver-profile ownership separate,
preserves base timing/state fields, and records requested values plus `to_dict`
of the actual objects with the adapter source identity. Replays show captured
values without importing historical code. This adapter adds no robot
qualification or physical tuning runner.

Its focused CPU checks run from the visualizer root with the selected friction
checkout's prepared environment:

```bash
env -u PYTHONPATH -u ROS_DISTRO \
  TIAGO_MPC_ROOT=/workspace/tiago_mpc \
  /workspace/tiago_mpc/.venv-container/bin/python \
  -m unittest tests.test_friction_adapter -v
```

The focused tests cover fixed coefficients, exact-zero armature disablement,
native serialization and commands, scalar widths, descriptor effects,
and rejection of coefficient/PD gain vectors in API settings. They skip before importing
the experimental adapter when the selected native source lacks its APIs or
tuning presets.

## Obstacle-avoidance adapter

`obstacle_avoidance.py` needs a source with `tiago_mpc.collision` (`Collision`,
`arm_cover`, `body_cover`, `body_posture`). The predictor owns `collision`, the whole
`MpcParams.collision`: **Collision rows** on/off and the **Arm cover** (a stored
arm cover, compiled into the GPU URDF) are compiled variants
(`effect="compiled_model"`; off is `None`, the module without rows); **Rows**
(enforced `admm` or reported only `telemetry`), **Body cover** (a stored body
cover in the environment, or Off: obstacles only), **Margin** and the obstacle lists (kind `shapes`
in `torso_lift_link`, at most 16 each, sizes 5 mm to 0.5 m): **Obstacles**
(spheres), and **Capsules**, **Boxes** and **Planes** when the source's
`Collision` has those fields (`tiago_mpc` a14b746, 2026-11-03) are runtime
values of one module; the solver applies them through
`set_collision_environment(**Collision.environment())` without a rebuild. Defaults are `Collision()`'s, rows on.
The covers are chosen by name from `tiago_mpc/data/collision/`; rho stays
`Collision`'s default (the base's when it already has rows), and the body posture
is the body cover's (`body_posture`), at which Live draws the body. The simulation owns only `law`: default
(plan torque, `SampleKnot`) or PD feedback (`PlanFeedback()`, the stored gains),
which is the default, as in `tiago_mpc`'s experiments. The plant stays native.

Its CPU checks are in `tests/test_obstacle_adapter.py`; run them with
`TIAGO_MPC_ROOT` set to the collision source and that source's interpreter.
