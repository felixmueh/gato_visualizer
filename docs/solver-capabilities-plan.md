# Plan for complete solver-option support

Prepared for Felix, 2026-10-26. This is an implementation proposal, assuming
`tiago_mpc` migrates to GATO's `cost_menu`. It does not implement the options
or qualify new solver/model combinations.

Current inspection update (2026-11-09): Run again uses independent cold solves
with increasing SQP caps, so it works without native trajectory capture. See
[the inspection contract](inspection.md). Native per-iteration capture and exact
optimizer continuation remain distinct capabilities in the historical audit below.

Most missing controls require changes to `tiago_mpc`'s public configuration
and the visualizer, rather than new solver algorithms. Three larger dependencies
remain: cost-menu-compatible exact cost curvature, authentic SQP trajectory
capture in the selected GATO package, and complete optimizer checkpoint/resume.
The last two are separate features; trajectory capture does not supply a
restorable checkpoint.

## Scope and source baseline

The scope is the options discussed after the current refactor migration:
disabling ADMM and selecting other limit mechanisms, primary linear solvers,
Hessian options, friction coefficients/widths and integrator combinations,
per-knot costs/posture/external-force updates, additional compiled horizons,
and SQP inspection/continuation. The cost migration also needs to expose the
terms and activations actually supported by `cost_menu`.

The audit used `tiago_mpc` / `visualizer/base` at
`56db0fde4d6feb64209c69ec65f96e53416eae00`, its installed `gato-mpc==0.1.5`,
and the visualizer's current working tree on main `01afe4a`. This matters:
historical inspection documentation describes a GATO fork with capture support,
whereas the current installed package has no such public API.

The existing viewport joint/grasp editor is already implemented. It remains
position-only start-pose editing in Live while paused at t = 0, independent
of the sidebar lock. This plan does not add grasp-orientation manipulation,
collision avoidance, physical-robot operation or arbitrary new cost/constraint
families beyond the APIs described below.

## Capability map

| Capability | Present boundary | Required work and owner |
| --- | --- | --- |
| ADMM off | `tiago_mpc.load_controller` installs ADMM unconditionally; inspection assumes three row groups | **tiago_mpc:** explicit limit mode and conditional bound installation. **Visualizer:** settings, empty-row capture/readers, mode-aware plots and inspection |
| Other limit mechanisms | GATO accepts `off`, `telemetry`, `barrier`, `al`, `admm` | **tiago_mpc:** typed mechanism-specific settings. **Visualizer:** compatible controls and resolved mechanism/bounds in records |
| Primary linear solver | Wrapper fixes `linsys="pcg"`; ADMM's inner solver is already separately configurable | **tiago_mpc:** expose PCG/BDSV policies and thresholds. **Visualizer:** distinguish primary and ADMM policies and report the effective paths |
| Dynamics exact Hessian | GATO exposes an EH build and runtime switch; wrapper only looks up/loads normal binaries | **tiago_mpc:** variant-aware build/find/load. **Visualizer:** probe/build/select the variant and validate combinations |
| Exact cost curvature with the new cost API | GATO 0.1.5 explicitly refuses this switch with an active cost menu | **GATO/GRiD:** define and implement menu-native curvature, including supported activations/terms. Then integrate and validate in both wrappers |
| New cost function | GATO has `CostMenu`, but `tiago_mpc` still uses legacy cost fields/setters | **tiago_mpc:** own the menu, serialization, task-target binding and runtime updates. **Visualizer:** term editor, validation, cost plots and recording |
| Per-knot weights and posture targets | Native wrapper has legacy updates; Live sends only a reference | Migrate these updates to menu data, then carry them through the existing solver request path |
| External-force prediction | Wrapper already has `external_force`; Live does not send it | Expose and record a defined wrench contract; apply it in the solver child. Plant disturbances need their own implementation |
| Custom plant/predictor friction | Native `Friction` accepts coefficient arrays; UI offers URDF coefficients and fixed predictor width only | Expose independent typed configurations; extend explicit builds/probes to the exact predictor configuration |
| RK4 with Tanh/Sign plant friction | Upstream supports it; visualizer blocks all RK4 friction | Remove the broader UI/backend restriction and retain the genuine RK4 + StickSlip restriction |
| More horizons | Native parameters accept N≥2; visualizer offers 8, 16, 24, 32, 48, 64, 96, 128; current selection has N32 binaries | Accept validated explicit N requests, with explicit builds and resource/finite-solve checks per selected variant; ordinary settings never compile |
| Per-SQP scalar diagnostics | Available fields depend on the selected solver | Preserve actual indices/availability and expose the recorded fields; metrics are not trajectory snapshots |
| Run again with intermediate trajectories | Existing visualizer infrastructure expects capture; current GATO 0.1.5 has no capture API | Port/reintroduce native capture upstream, then adapt the existing inspection worker/artifacts |
| Original warm-seed rerun | Ordinary records lack the incoming warm trajectory | Capture that seed explicitly; label a rerun by its actual initialization |
| Exact Continue SQP | No complete public checkpoint/restore API | New GATO checkpoint/resume contract plus controller state and isolated visualizer continuation |

## 1. Make the cost menu the objective contract

### Ownership and serialization

Put the cost definition in `tiago_mpc`'s public parameters, shared by experiments
and the visualizer. The visualizer should edit that native definition, rather
than maintain a second cost language. One menu replaces the legacy tracking
objective; it is not added to `q_cost`, `qd_cost`, `u_cost`, per-knot triples
and the old posture anchor.

Use `CostMenu`, `Term` and `LinearTerm` directly if they meet the native
configuration contract. Otherwise add a small typed configuration in
`tiago_mpc` which constructs them. In either case, register the types with
`record.from_dict` and define JSON-safe array/bound encoding. Current
`to_dict` handles dataclasses and arrays, but `from_dict` does not yet know
these classes. Infinite one-sided bounds also need an explicit portable
encoding; do not rely on nonstandard JSON `Infinity`.

The wrapper should validate a complete menu before uploading it. Native
`CostMenu.apply` uploads multiple fields; do not treat it as a transactional
settings API. Apply updates at the existing serialized request boundary;
reject stale/invalid changes without publishing a partially changed problem.

### Supported terms and controls

For this seven-joint fixed arm, `nx=14` and `nu=7`:

| Menu slot | Feature/residual | Editor and implementation requirements |
| --- | --- | --- |
| `frame_pos` | Grasp-frame position minus target, 3 entries | Position weights and task-generated horizon target; fixed frame identity recorded |
| `state` | `[q; qd]` minus target, 14 entries | Per-joint posture/velocity weights and targets; zero weights disable selected coordinates |
| `input` | Actuated torque minus target, 7 entries | Per-joint effort weights; zero, explicit or `"gravity"` target; gravity needs `q_ref` |
| `linear_x` | `A x + b` minus target | Square 14×14 matrix and 14-entry fields, with advanced array editing/import |
| `linear_u` | `A u + b` minus target | Square 7×7 matrix and 7-entry fields; can couple joints at one knot |
| `orientation` | `log(R_desᵀ R_frame)`, 3 entries | Valid rotation-matrix targets with an appropriate user-facing rotation editor |
| `velocity` | Frame twist `J(q) qd` minus target, 6 entries | Explicit twist frame/order/units verified against the generated model |
| `frame_pos_2` | Second baked frame position minus target, 3 entries | Register/build a second cost frame, then expose its identity and data |

These are eight named slots, with at most one term per slot. The API is not an
arbitrary-length list of residuals. For example, multiple independent posture
activations or an inter-knot torque-slew penalty cannot be expressed merely by
adding another `state`/`linear_u` term. Those extensions would need a separate
upstream design.

Support the native activation choices: `quadratic`, `pseudo_huber`,
`relaxed_log_barrier`, `quadratic_barrier`, `smooth_hinge`, plus disabled terms
or knots. Validate nonnegative finite weights, positive `eps` where required,
ordered bounds, finite targets/matrices and valid rotations. Barrier
activations act on the **feature value**, not feature minus target. They are
only valid on slots with native bound fields: do not offer them for
`frame_pos` or `orientation`.

Targets, weights and bounds support shared vectors, `(N, size)` schedules and
`(B, N, size)` batches. Linear matrices and orientation matrices have their
corresponding matrix shapes. Activations and activation parameters have their
own per-knot rules, not arbitrary per-batch shapes. Live currently uses B=1;
keep that scope visible rather than introducing batching as part of this work.
All state/cost schedules have N knots; input terms are inactive at knot N−1
because there are only N−1 commands.

Provide a compact editor for common reaching/tracking weights and a term editor
for the full native menu. Both edit the same data. For schedules, define how N
changes work: regenerate task-derived samples; require an explicit resampling
or replacement decision for user-provided schedules. Do not silently resize
arrays or discard terminal settings.

### Migrate existing costs deliberately

Construct a reaching menu with grasp-position cost, velocity cost in `state`
and torque cost in `input`. Both native paths use the same quadratic
normalization, `0.5 * w * residual²`: **no factor-of-two conversion is needed**.

| Existing setting | New quadratic menu data |
| --- | --- |
| `q_cost` | Three `frame_pos` weights at knots 0 through N−2 |
| `N_cost` | Three `frame_pos` weights at knot N−1 |
| `qd_cost` | Last seven `state.weight` entries, with zero desired velocity |
| `u_cost` | Seven `input.weight` entries, with zero torque target |
| Posture weight and native `q_nom` | First seven `state.weight` / `state.target` entries, with GPU conversion inside the wrapper |
| `(N,3)` knot weights `[ee, qd, u]` | Separate frame-position, state-velocity and input schedules |

For the present scalar reaching defaults this gives frame-position weights
4 running / 8 terminal, state weights `[0 × 7, .05 × 7]`, input weights
`1e-4 × 7`, zero state/input targets, and task-generated frame-position targets.
Preserve actual terminal velocity and posture terms; they are present in the
current native path despite older “running posture” descriptions. Verify the
mapping against both objective readout and assembled derivatives before
changing defaults.

This mapping needs a bounded equivalence check before changing defaults.
Legacy per-knot terminal velocity indexing differs between native KKT assembly
and merit evaluation; the menu uses its explicit terminal row. Record the
chosen new terminal semantics and any discrepancy without turning this
migration into a solver-defect investigation. Scalar defaults do not exercise
that particular schedule-indexing difference.

The native `*_lim_cost` barriers remain effective under a menu and use the
plant's limit tables. They are separate from menu barriers and row mechanisms.
Keep their policy explicit and prevent accidental duplicate penalties. The
current reaching defaults have these legacy weights zero. If retaining them
as construction parameters, record them alongside the menu. GATO's legacy
`set_cost_weights` refuses calls while a menu is active, including limit-only
weight changes: replace the old update path. Reconstruct at a settings boundary,
or provide a narrowly defined setter/clear-update-reapply operation upstream;
do not keep invoking the old setter on an active menu.

### Bind each request, including warm-up

With a menu active, GATO still accepts the old `solve(..., reference)` argument
but ignores it for the objective. Before **every** preview, normal solve,
warm-up and inspection solve, bind that request's task window into
`frame_pos.target` and apply the menu. Do the same for any requested orientation,
velocity, posture or gravity-reference schedules. Changing only the old
reference argument would leave the new objective stale.

Define one target-ownership rule: recommended default is that the selected task
owns its position horizon, while explicit manual/scheduled targets require a
visible change of source. If position tracking is disabled, do not let task
binding silently turn it back on. Keep task arrival criteria independent of
cost weights. A posture/weight update persists until replaced, so record its
effective value and the exact solve at which it takes effect.

Replace `cost_weights`, `knot_weights` and `posture` updates with menu updates;
retain `external_force` as dynamics data. At unchanged shapes the native API
can reuse allocations, but uploads still have a cost. Avoid resetting the menu
on every physics tick; only apply the data needed for each solver request.

Use native joint coordinates in public cost data. `tiago_mpc` owns the existing
joint-6 GPU conversion for state/input targets, bounds and `q_ref`; bounds need
side reordering after a sign flip. For a native linear feature whose output
coordinates stay native, use `A_gpu = A_native D`, where D maps GPU variable
coordinates to native coordinates; its output target, offset and bounds keep
their declared feature convention.

Cost frames are baked, not chosen per request. Frame 0 must remain the grasp
frame. Cartesian targets use the reduced model's root (torso) coordinates;
the visualizer already converts world position references to that root. Convert
world orientation targets with `R_root_world R_world_desired`. Frame velocity
uses `[linear_xyz; angular_xyz]` at the cost-frame origin with root-aligned
axes (`LOCAL_WORLD_ALIGNED`); rotate both components from visualizer world
axes. This twist convention differs from the external spatial-force layout
below. Gravity targets must use the same predictor model/coordinates as the
solve. `q_ref` is shared across the batch, shaped `(7,)` or `(N,7)`; it is not
a per-batch reference. Permit it only with `input.target="gravity"`: current
native application overwrites the input target whenever `q_ref` is present,
even if an explicit input target was supplied. Reapplying it launches a
gravity-target kernel and synchronizes, so avoid recomputing an unchanged
static gravity target merely to update the position window.

## 2. Expose controller and limit policies

Add an explicit `limits` choice to the native parameters. On a fresh solver,
pass `"off"` to install no row mechanism: `None` requests the controller's
default and can install ADMM. On an already configured solver, `"off"` leaves
existing rows alone; mode changes need fresh construction or an explicit
`disable_row_groups()` operation. `admm.iters=0` is not the off switch.

| Mode | Meaning | Configuration needed |
| --- | --- | --- |
| `off` | Install no limit row groups | No row-bound setters; empty captured rows are valid |
| `telemetry` | Install rows and measure violations without enforcement | Planning bounds/masks, with enforcement clearly reported as absent |
| `barrier` | Penalize violations through the native row-barrier mechanism | `mu`, `delta` |
| `al` | Augmented-Lagrangian row handling | `rho`, optional `rho_q`, `rho_qd`, `rho_u`; retain actual dual/update semantics |
| `admm` | ADMM row handling | `rho`, `iters`, optional group rho values, `eps_abs`, `eps_rel`, `check_every`, and inner-solver policy |

Use mechanism-specific settings rather than forwarding `AdmmLimits` into every
mode. Install/modify the position, velocity and torque planning boxes only when
those groups exist. Preserve the native position-margin and velocity/effort
fraction semantics. Capture actual installed bounds, activity masks and mode;
inspection and standard plots must accept zero groups and distinguish
telemetry from enforcement. Generalize the current hardcoded three-group
readers only as far as these supported topologies require.

Turning row enforcement off does not remove legacy/menu soft penalties,
simulate unlimited actuators or disable plant clipping/breach handling. Those
remain independent visible settings. Keep plant effort clipping and breach
defaults unchanged. Avoid inadvertently enabling the controller's own command
clip in addition to the visualizer's existing execution-side clip.

Expose primary `linsys` policies `pcg`, `bdsv`, `bdsv_first`, `auto`, with
applicable thresholds and resolved defaults. Keep `admm_linsys` (`pcg`,
`bdsv_factor`, `auto`) separate. The current native routing is:

| Active path | Effective linear-solver route |
| --- | --- |
| Off / telemetry / barrier, EH off | Requested primary path; `auto` resolves the policy per step |
| AL | BDSV, overriding primary policy; native trust-region rho adaptation is also suppressed |
| Non-ADMM with dynamics EH enabled | BDSV, overriding primary policy |
| ADMM, including dynamics EH enabled | ADMM inner PCG or BDSV-factor; primary policy is bypassed |

Report requested policy and effective route separately. `stats.linsys` alone
is insufficient because it can retain the requested primary mode. EH does
not force the ADMM inner solver to direct; qualify that combination separately.
PCG and ADMM controls should show when they are inactive rather than imply
they affect every solve. Preserve available backend counts/timings.

## 3. Treat build capabilities as part of configuration

`tiago_mpc.find_binary`, `compile_binary` and `load_controller` must agree on
normal versus `eh` variants. Currently the wrapper hardcodes the normal module
name and lookup. Thread the variant through registration/build lookup, filename
validation, module loading and `BSQP(..., variant=...)` as appropriate. An
EH-built module's runtime switches remain separate from the fact it was built
with EH support.

Probe the loaded module's actual capability flags, including cost-menu support,
EH availability and baked cost-frame identities. Source compatibility, a cached
filename and a successful Python import are different evidence. Do not infer
menu support solely from the package version or offer runtime switches which
the selected binary cannot implement.

Extend Source / Build from the current N × friction-on/off lookup to the exact
requested configuration: N, normal/EH variant, predictor coefficients/tanh
width, required baked cost frames and other generated model features. Keep
generation/cache identities owned by `tiago_mpc` and GATO; do not invent a
visualizer binary naming scheme. Ordinary target/weight/activation changes are
runtime data and should not trigger compilation. A different baked frame or
predictor dynamics configuration may need a different binary.

The current GATO `eh`, predictor `rk4` and contact-force `fc` variants are
separate build variants, not independent freely combinable flags. Supporting
their combinations would require upstream build/native work. This does not
prevent using an RK4 **simulation plant** with the existing EH predictor.

Retain explicit builds, read-only availability checks and clear “not compiled”
states. Do not prebuild a Cartesian product of all settings. Build the requested
combinations and probe/refresh them for the selected profile. Larger horizons
need device resource and finite-solve checks before claiming support; the
presence of a `.so` is insufficient. Record build identities so recordings and
inspection cannot silently substitute another variant.

### Exact cost curvature is a separate upstream feature

Dynamics curvature (`exact_hessian`) and residual-weighted cost curvature
(`cost_curvature`) are distinct. The installed menu uses its Gauss-Newton
cost path. GATO 0.1.5's exact-cost toggle covers the legacy position objective
and explicitly rejects an active menu; an EH build alone does not fix that.

For affine state/input/linear features, the existing activation Hessian is
already exact away from activation boundaries. The missing residual-weighted
curvature concerns nonlinear frame-position, orientation and velocity terms.
To support the combination, GATO/GRiD must specify and implement those
second-order contributions for the supported activations, then connect them
to stage-block projection and the backend routing above, including ADMM.
Define behavior at piecewise activation boundaries and for mixed terms.
Start with the migrated reaching menu if staging the work, but expose only
the combinations actually implemented. Do not label a partially covered menu
as fully exact. Qualify cost curvature independently of dynamics curvature,
then their combination.

## 4. Complete the dynamics controls

Preserve the requested default: **SIMULATE**, semi-implicit Euler plant with
URDF friction and the constraint (`StickSlip`) law. Predictor friction stays
independent and loss-free by default.

Expose per-joint Coulomb Nm and viscous Nm·s/rad coefficients for plant and
predictor separately, with reset to the URDF values and retained provenance.
Validate seven finite nonnegative values and positive tanh width. Use native
`Friction`/law serialization throughout. Plant edits need no solver build;
predictor coefficient/width edits select a distinct compiled plant. The current
native plant identity already includes predictor coefficients and width;
the visualizer's boolean availability map/build controls need to catch up.

| Model | Supported law/integrator combinations to expose |
| --- | --- |
| Simulated plant | Loss-free Euler/RK4; Tanh or Sign with Euler/RK4; StickSlip with Euler |
| MPC predictor | Loss-free or compiled Tanh friction; predictor integration remains its native solver implementation |

For RK4 + StickSlip, retain a precise incompatibility message or require a
visible law/integrator change. Remove the current blanket rule which disables
all friction on RK4. Predictor Sign/StickSlip would require new generated
dynamics/derivatives and a design for nonsmooth behavior; they are not unlocked
by exposing the existing `Friction` object.

Wiring more settings does not resolve the documented predictor-stiffness and
instability findings in [friction.md](friction.md). Preserve those failures and
test new combinations as identified simulation cases. Armature, alternative
discretizations and friction-model changes need separate scope decisions.

### External wrench updates

Expose predictor wrench updates with an explicit body/frame/point/order
contract. Native `set_f_ext_B` expects joint-local spatial forces about joint
origins, angular components before linear components, with documented EE or
body-major and shared/per-knot shapes. World-frame or grasp-point inputs need
the upstream conversion, including the moment shift; a six-vector alone is
ambiguous. Carry updates through `solver_worker` and retain the exact arrays
used by each solve.

This modifies prediction only. Applying an external disturbance to the
simulated plant requires a separate SimPlant/input contract and recording of
the applied disturbance. Do not display predictor force as a force already
acting on the plant.

## 5. Record enough to inspect the actual problem

Keep the current segment-header model for constant settings and native states.
Add cost definition/activation semantics, limit mode, requested and resolved
solver policies, binary/capability identity, frame identities and independent
plant/predictor dynamics. Keep changing target windows, cost updates and
external-wrench schedules with the solves that consumed them. Store substantial
arrays as binary buffers rather than duplicating horizon data in JSON records.

Extend the existing capture, Run again, plot and portable-export readers together.
`cost_menu_terms` reports eight menu slots but excludes native legacy limit
barriers and row-mechanism contributions; a sum of those slots is not always
the complete objective/merit. Cost plots must identify the included components
and leave unavailable historical components unavailable.

Existing motion recordings should remain viewable. Recordings without complete
menu/constraint/model inputs may have Run again unavailable with a specific
reason; never reconstruct their objective from today's defaults. Version the
changed problem/capture contract and document export compatibility. No bulk
conversion or historical-data rewriting is required.

### Three distinct inspection deliverables

1. **Fresh cold inspection with authentic iteration capture.** Reintroduce a
   native opt-in trajectory recorder in the selected GATO line. Define Seed,
   accepted/rejected iteration indices, stop reason and alignment with scalar
   statistics. Keep it off in ordinary episode solves; transfer snapshots once
   in binary form to the existing temporary inspection child. Capturing can
   change wall-budget outcomes, so describe that overhead. Repeated cold solves
   with increasing iteration caps are separate solves, not recorded iterates.
2. **Rerun from a recorded incoming trajectory.** Capture the actual incoming
   warm trajectory and the initialization policy, then restore that seed in a
   fresh solver. A trajectory-seeded rerun can differ from the original solve
   because private optimizer/controller state is missing. Label it accordingly.
3. **Exact checkpoint and Continue SQP.** Add an upstream export/import contract
   at a defined optimizer boundary. Audit all state needed to resume: primal
   trajectory, multipliers, constraint/ADMM state, penalty/regularization and
   adaptation state, iteration/stopping state, plus relevant controller history.
   Define checkpoint version/model/binary compatibility, device synchronization,
   remaining budget semantics and cancellation behavior. Restore into an
   isolated child and verify continuation against an uninterrupted solve.

Available partial getters (`get_row_duals`, `get_admm_state`,
`get_admm_rho_scale`) and `set_warm` do not establish a complete checkpoint.
Keeping the Live solver paused also does not make a historical Solve resumable.
Until the checkpoint contract exists, Continue remains explicitly unavailable.

## Delivery order and verification

| Step | Deliverable | Bounded verification |
| --- | --- | --- |
| 1 | Native cost-menu parameters, serialization, target binding and updates | CPU shape/type/JSON round-trips; native objective/gradient/KKT checks for migrated scalar defaults and a changing task window, including warm-up; document terminal schedules |
| 2 | Visualizer cost editor, solver RPC and captured-problem/plot changes | Settings version/stale-request checks; per-knot/posture changes reach the child; recorded effective cost can be reconstructed; old recordings still display |
| 3 | Limit modes and primary/ADMM solver policies | Off has zero rows and no bound-install failure; telemetry does not enforce; representative barrier/AL/ADMM cases; correct effective backend and native joint-6 bounds; clipping stays independent |
| 4 | Variant-aware builds/probes, EH dynamics and horizon availability | Cache identities distinguish variants; incompatible/missing binaries fail before use; representative resource/finite solves; EH on/off and policy interaction checks |
| 5 | Custom friction, supported RK4 combinations and predictor wrench updates | Settings/record round-trips, native dynamics/frame conversion checks, identified short simulation cases; no implicit builds and no stale-variant substitution |
| 6 | Native SQP trajectory capture and seeded inspection | Snapshots match their actual iterations, early stops/rejects preserve indices; Live state survives isolated inspection/Stop; capture overhead measured separately |
| 7 | Menu-compatible exact cost curvature | Derivative/assembly checks for every advertised term/activation, projection/backend interaction and representative task behavior; unsupported mixtures remain explicit |
| 8 | Versioned checkpoint/resume | Uninterrupted versus checkpoint-restored continuation with sensible tolerances, including ADMM and warm controller state; mismatched checkpoints rejected |

Steps 3–5 can follow the agreed native configuration while cost UI work proceeds;
step 7 is not a prerequisite for a useful Gauss-Newton cost-menu visualizer.
Step 8 depends on a genuine upstream state contract, rather than more UI work.
No full experiment campaign is required to establish these plumbing features.

For future GATO/GRiD contributions, run the upstream project's established
benchmarks on unchanged baseline and completed change, with exact source/build/
hardware/configuration, repeats and raw logs. Keep GPU work sequential and
record clock state during short measured runs. Separate functional checks,
host solve-wall timing, native timing and capture/recording overhead. For wrapper
integration, use the existing focused CPU/browser tests and a short native
conformance/task check appropriate to the changed behavior. Do not claim a
performance comparison from a functional smoke test.

Use practical trajectory/objective agreement with sensible tolerances; the
current KKT residual is not an acceptance gate. A zero-PCG outer shortcut is
the existing practical stopping heuristic, not a formal certificate. Simulation
task success, physical-limit compliance and physical-robot qualification remain
separate. Preserve failed checks and original cohorts in the owning checkout's
ignored `_expr_data/`; do not write into the frozen thesis archive.

## Decisions to settle when implementing

The recommended first scope is the migrated reaching/tracking menu, explicit
limit modes, primary solver policies, supported dynamics controls and reliable
problem recording. Implement the other menu slots through the same contract,
without pretending every curvature/build combination is already available.

Before implementation, fix the public native parameter shape, task-versus-manual
target ownership, terminal weighting semantics, policy for the surviving legacy
limit penalties, and frame identities. Prefer explicit resolved defaults and
capability/reason metadata from the selected native implementation so the UI
shows why an option is unavailable. A frozen checkbox with no explanation should
not stand in for a missing feature.

Implement upstream changes in clearly identified `tiago_mpc`/GATO trial
worktrees and follow the repository's review rules before merging them.

## Source trail

The baseline above was checked against these local definitions:

| Source | Relevant evidence |
| --- | --- |
| `tiago_mpc/mpc.py`: `MpcParams`, `set_bounds`, `_register`, `find_binary`, `compile_binary`, `load_controller`, `UPDATES`, `Mpc.warmup`, `Mpc._solve` | Hardcoded controller modes; default binary lookup; predictor identity; legacy cost migration TODOs and request updates |
| `tiago_mpc/record.py`: `CLASSES`, `to_dict`, `from_dict` | Native tagged configuration and current reconstruction registry |
| `tiago_mpc/dynamics.py`, `tiago_mpc/sim.py`: `Friction`, `SimPlant` | Coefficients/laws and actual integrator compatibility |
| Installed GATO `cost_menu.py`: `CostMenu`, `Term`, `LinearTerm`, field/shape validators | Named slots, activations, bounds, targets, upload behavior and terminal input convention |
| Installed GATO `interface.py`: `set_cost_menu`, `cost_menu_terms`, `set_exact_hessian`, `set_cost_curvature`, `solve`, `set_f_ext_B` | Runtime menu, EH requirements, curvature incompatibility, absent capture argument and wrench layout |
| Installed GATO `controller.py`: `MPCController`, `_install_limits`, `step` | Limit modes, default ADMM behavior and separate linear-solver policies |
| Installed GATO native headers: `plant.cuh`, `setup_kkt.cuh`, `merit.cuh`, `bsqp.cuh` | Menu Gauss-Newton path, terminal-weight indexing and legacy-setter guard |
| Visualizer `live_mpc.py`, `solver_worker.py`, `inspection_problem.py`, `source_runtime.py`, `scripts/source_probe.py`, `src/live.js` | Restricted choices, missing updates, three-group capture assumption and current build/UI restrictions |

For current implemented contracts see [architecture](architecture.md),
[friction](friction.md), [solver profiles](solver-profiles.md),
[inspection](inspection.md) and [the refactor handoff](handoff-tiago-mpc-api-20261026.md).
