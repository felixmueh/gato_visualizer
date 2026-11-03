> Historical migration notes (2026-10-24). The current integration is documented
> in [the 2026-10-26 handoff](handoff-tiago-mpc-api-20261026.md).

# Handoff: tiago_mpc API changes of 2026-10-24 and what they break here

For the visualizer session. Written 2026-10-24 against tiago_mpc `main` at
`ff7ee86`, **plus uncommitted changes in its working tree** that Felix is
reviewing: the friction laws and the plain package root. Line numbers here are
from a grep of this repository's working tree on that day. This checkout has
uncommitted work of its own, so the numbers may have shifted. Do not commit
here (AGENTS.md, "Coordination"); leave the changes for Felix.

## 1. Friction: Coulomb laws as data (uncommitted in tiago_mpc)

### What changed
- **New types:** `tm.Friction(coulomb_nm, viscous_nm_s_per_rad, law=tm.StickSlip())`. The law is one of three frozen dataclasses:
  - `tm.Tanh(width_rad_s)`: smooth; the only law GATO predicts;
  - `tm.Sign()`: explicit sign of the old velocity;
  - `tm.StickSlip()`: the coupled stick/slip solve, formerly the "constraint" law.
- **Saved form:** each law carries a `name` field (`"tanh"`, `"sign"`, `"stick_slip"`), so `asdict` keeps the law apart. `tiago_mpc.dynamics.LAWS` maps names back to classes, and `MpcParams.from_dict` rebuilds the law.
- **`tiago.urdf_friction(law=StickSlip())`** takes a law object. It used to take `urdf_friction(width)`.
- **`SimPlant(q, qd, *, substep, friction, integrator, clock)`** has no `coulomb_law` argument any more.
  - With friction it defaults to `"euler"` (all three laws).
  - `"rk4"` with friction now works again for `Tanh` and `Sign`, through `dynamics.plant_rk4`; it needs about 0.1 ms substeps with the URDF's damping.
  - `"rk4"` with `StickSlip` raises.
- **`MpcParams.friction`:** `None` or a `Friction` whose law is a `Tanh`. GATO reads `friction.law.width_rad_s`.
- **`SimPlant.settings`:** the `coulomb_law` key is gone. The law is at `settings["friction"]["law"]["name"]`, with `width_rad_s` inside `law` for tanh.
- **Old parameters no longer load:** dicts whose `friction` has a top-level `width_rad_s` and no `law` fail in `MpcParams.from_dict`.
- **Unchanged:** simulated states are bitwise identical to before for every law, and plant names (compiled modules) are unchanged.

### What breaks here (found by grep, not edited)
- **`solver_adapter.py`:**
  - lines 47, 55, 110, 119: `coulomb_law` passed to `SimPlant`;
  - line 108: `urdf_friction(width or None)`.
- **`live_mpc.py`:**
  - line 122: `predictor_friction['width_rad_s']`, which is now under `law`;
  - lines 31, 33, 75–89, 102, 129: the settings `plant.coulomb_law` (`"tanh"`/`"sign"`/`"constraint"`) and `plant.friction_width_rad_s`;
  - line 369: names `tiago.urdf_friction` as the source.
- **`scripts/source_probe.py`:**
  - lines 51–52: check for a `coulomb_law` parameter on `SimPlant`;
  - line 61: `tiago.urdf_friction(PREDICTOR_SMOOTHING_RAD_S)` passes a float.
- **`src/live.js:442`:** the `plant.coulomb_law` field.
- **Python tests:**
  - `tests/tiago_mpc_source.py:55`;
  - `tests/test_friction.py:19–57`;
  - `tests/test_solver_boundary.py:235–246`;
  - `tests/test_live_mpc.py:42–128`;
  - `tests/test_source_runtime.py:211–283`.
- **JS tests:** `src/live.test.js:55`, `src/source-settings.test.js:179–199`, `src/live-settings.test.js:1095–1167`. They use a top-level friction `width_rad_s` and `coulomb_law: 'constraint'`.
- **Docs:** `docs/live-api.md:69–70`, `docs/friction.md:10–54`, `docs/architecture.md:116`.
- **Saved runs:** any saved predictor-friction dict passed to `MpcParams.from_dict`.

### Mapping the visualizer's own settings
- `plant.coulomb_law` with `plant.friction_width_rad_s` translates to a law object:
  - `"tanh"` → `Tanh(width)`;
  - `"sign"` → `Sign()`;
  - `"constraint"` → `StickSlip()`.
- **Open for Felix:** whether the visualizer's settings keys and UI labels follow the new names (`stick_slip`, "stick-slip") or keep their own. "Defaults are never hidden" applies.

## 2. Package root: plain re-exports (uncommitted in tiago_mpc)

- **`import tiago_mpc as tm`** gives the experiment-facing names through plain imports in `tiago_mpc/__init__.py`. The lazy `__getattr__` is gone.
- **New names:** `tm.Tanh`, `tm.Sign`, `tm.StickSlip` and `tm.ee_position`.
- **Importing may load Pinocchio** (Felix, 2026-10-24): importing `tiago_mpc` may load Pinocchio and GATO's Python package, but never ROS (only creating a `RosPlant` does) and never GATO's compiled module (only the MPC process). `tiago.py` and `sim.py` import Pinocchio at module level again, and `experiments/replay.py` no longer promises NumPy only.
- **What that affects here:**
  - `docs/replay-format.md:12-13` says the exporter "needs only NumPy and Python's standard library (… `tiago_mpc.tiago`, which loads only NumPy)". That is now stale.
  - `tests/tiago_mpc_source.py:12-14`, `replay_exporter()`: the import isolation still works, but only in an environment that has Pinocchio. The same goes for its callers: `tests/test_replays.py`, `tests/test_end_effector.py` and `tests/test_live_freeze.py`.
  - `live_freeze.py:114`: the freeze path now loads Pinocchio through `experiments.replay`.
  - `README.md:486`: check the claim that tests needing `tiago_mpc` need no extra Python packages.

## 3. One end-effector point (committed, `ff7ee86`)

- **`tm.ee_position(q)`** is `fk(q, GRASP_FRAME)`.
- **`experiments.reach.Reach`** has no `ee_frame` any more. `reach()` raises unless `mpc.params.ee_frame == GRASP_FRAME`.
- **random100** reaches grasp-frame targets: a new protocol, not comparable to old runs.
- **`MpcParams.ee_frame` still exists.** `live_mpc.py` offers its own `ee_frame` choice and builds `MpcParams` directly. That still works, but it must not call `experiments.reach.reach` with the flange.

## 4. Decided or planned next in tiago_mpc (not implemented yet)

### Timing
- `run_simulation` and `run_robot` likely become one `run(...)` with:
  - `solve_latency`: `0.05`, `"measured"`, or `None` for real time;
  - `update_period`: `None` means back to back.
- `SimPlant(sync_real_time=…)` replaces its `clock` argument and warns when it can't keep up. The plant interface loses `clock`.
- This affects `solver_adapter.py:172`, which builds `Clock.simulation(t)`, and the uses of `plant.advance` (`execution_session.py:280`).
- Some details are still open with Felix.

### GATO 0.1.5 with uv
Plan: `/home/felix/_Uni/MasterThesis/research/tiago-mpc-gato-0.1.5-and-uv-plan.md`.
- **The environment:**
  - upstream `gato-mpc==0.1.5` from PyPI, with `grid-rbd==0.5.5`;
  - one uv environment per checkout: `.venv` on the host, `.venv-container` in the container;
  - the `external/gato` submodule removed.
- **Here:** `live_mpc.py:40–52` requires GATO from `external/gato`, `source_runtime.py:30–37` and `:210` select the environment names and read the submodule commit, `solve_inspections.py:34–39` fingerprints `external/gato`, and the note in `requirements.txt` needs updating.
- **Per-iteration trajectory capture (`ITERATION_CAPTURE_AVAILABLE`) is not in 0.1.5.** Felix decided on 2026-10-24 to drop it rather than patch GATO. Only the Solve tab's "Run again" used it (`inspection_worker.py:67`, the per-iteration trajectory plots and controls).
  - **Run again should reconstruct the iterates by consecutive re-solves:** the same cold solve with the SQP limit set to k = 1, …, K, where result k is iterate k.
  - **Precondition:** a ground-truth check against the fork's real capture, plus a determinism check on 0.1.5.
- **Per-iteration statistics need no capture:** they come from the solve's own `SolverStats`. Per SQP iteration it has:
  - PCG iterations and time;
  - the accepted merit (`min_merit`);
  - the line-search step size, where −1 marks a failure;
  - in 0.1.5, device time per stage (`stage_times_us`: kkt, schur, linsys, merit, line search).

  Per solve it adds the initial and final merit, the KKT-convergence flag, the row-group violations, the last ADMM residuals and, new in 0.1.5, the dynamics defect. tiago_mpc's `Mpc` currently keeps only totals; recording these per plan, and carrying them in replays, is planned.
- **Later:** per-plan solve certificates from `gato.certificate` (primal violation, active rows, and possibly dual and complementarity residuals) in `plan.stats`, so that replays and Live can show whether a solve met its constraints.

## 5. After the uv and GATO 0.1.5 merge (migration done in `impl/tiago_mpc-gato015`, not merged)

The migration found:
- the loss-free solves, the default reach and all 100 random100 trajectories bitwise identical between the fork and 0.1.5;
- the figure eight a new baseline, because the friction implementation changed.

Follow-up here, after the merge:
- **`live_mpc.py`:**
  - lines 40–52 (`import_tiago`) insert `external/gato/python`; use the selected checkout's environment instead;
  - line 64 reads `gato_commit`; use `tm.gato_source()`.
- **`source_runtime.py`:**
  - lines 30–37: the interpreters become `.venv` on the host and `.venv-container` in the container, instead of `venv-host` and `.venv`; `tests/test_source_runtime.py` and `tests/test_source_settings.py` follow;
  - line 210: replace the `external/gato` git identity.
- **`solve_inspections.py:34`:** fingerprint the installed or editable GATO instead of `external/gato`.
- **Iteration capture:** already gated, so it reports as unsupported. "Run again" moves to re-solves (section 4).
- **Stale mentions:**
  - `requirements.txt` line 1 (`../tiago_mpc/.venv`);
  - README lines 17–19 and 73–77;
  - AGENTS.md lines 65 and 429 (`venv-host`, `external/gato`).
- **Ordering hazard:** the container's solver worker uses `/workspace/tiago_mpc/.venv`, which is where the host's new `.venv` will go after the merge. The container's environment must move to `.venv-container` first (tiago_mpc's `MIGRATION-NOTES.md`).
