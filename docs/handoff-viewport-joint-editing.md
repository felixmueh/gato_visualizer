# Handoff: edit the start pose in the viewport (joint ring and grasp handle)

**Latest decision, Felix, 2026-10-24:** viewport editing requires no lock.
The lock protects only the sidebar gauges and joint numbers. There is no
viewport padlock, and changing the sidebar lock does not cancel a viewport
selection or drag. This supersedes every viewport-lock requirement in the
original brief below. Felix explicitly requested fixing this and merging to
main, overriding the earlier no-commit/no-merge restriction for this feature.

**Implementation, 2026-10-24:** the feature was developed in
`/workspace/tiago_mpc_visualizer-joint-edit` on `ux/viewport-joint-editing`.
The base is `91ab3fe` plus a read-only copy of the main checkout's pending
source changes, retained under `_expr_data/implementation-base/`. The isolated
feature patch is `_expr_data/viewport-feature.patch`; inherited changes are
excluded from it. The feature is merged to main; unrelated pending main changes
are retained separately as uncommitted work.

The implemented eligibility follows the merged start-pose controls: Live,
connected, paused **at t = 0**, with the solid Live arm visible. The sidebar
lock does not govern viewport editing. The IK defaults below are retained, with
deterministic backtracking and a task-only fallback when damped posture would
increase the gap or stall above tolerance. A real-browser check also exposed
an inherited configured-backend settings alias: the editable draft now copies
the accepted snapshot, so start-pose releases submit their patch. The focused
regression failed before this fix and passes after it.

Verification and browser evidence are recorded in
`_expr_data/viewport-implementation-report.md`. The remaining content below is
the original design and implementation brief.

For the coding agent implementing it. Written 2026-10-23 against visualizer
main `c7c5cce` and `tiago_mpc` main `154871e`, with Felix's request of the same
day. This feature builds on the **editable start pose** that another agent is
adding on branch `ux/editable-start-pose` (worktree
`../tiago_mpc_visualizer-startpose`). When this handoff was written that branch
had no commits beyond `c7c5cce`, only uncommitted backend changes (the
`plant.start_pose_rad` setting) and no frontend yet. Every statement below about
its API is therefore an expectation: **read its merged code first** and follow
it where it differs (see "Start-pose API to re-check").

## Goal and user-visible behaviour

Felix wants to set the arm's start pose by moving the arm in the 3D view instead
of typing seven joint angles. Two ways, both editing the same start pose.

- **Lock.** The start pose is editable only while the start-pose lock is open:
  the toggle left of the Gauges/Numbers selector in the Joints tab, **locked by
  default** (start-pose branch). The viewport uses **the same lock state**.
  Locked: no picking, no joint gizmos, nothing in the viewport changes
  behaviour. Unlocked (Live mode only): both edit modes are available.
- **Joint ring.** Click an arm link (click without drag) → that link's joint is
  selected: a rotate gizmo appears at the joint origin showing **only that
  joint's axis ring**. Dragging the ring sets the joint angle, clamped to the
  joint's raw URDF limits; the arm follows live. Release commits.
- **Grasp handle (inverse kinematics).** While unlocked, a small handle marks
  the grasp point (between the gripper fingers). Click it or a gripper link →
  a **translate-only** gizmo (no rotate, no scale) appears there. Dragging it
  solves inverse kinematics for the seven arm joints every frame; the arm
  follows. Out of reach, the solution lands on the nearest reachable point it
  finds, and a **tether** line from the handle to the achieved grasp point shows
  the gap. On release the handle **snaps to the achieved point** and the pose
  commits, so the display never claims an unreachable pose.
- **Commit** = write the seven angles into the start-pose setting through the
  start-pose branch's own path. That starts a new run at t = 0 from the new
  pose (velocities zero); Reset returns to it. Values are clamped to the raw
  joint limits; a pose outside the MPC planning box is flagged, not blocked.
- **Deselect:** Escape, a click on empty space, or locking. Escape during a
  drag cancels it: the arm returns to the drag-start pose and nothing commits.

## Decisions to implement (Felix, 2026-10-23)

1. Both modes edit the **start pose** setting of `ux/editable-start-pose`
   (seven native joint positions, velocities zero, default `tiago_mpc`'s
   `Q_START`), never a separate pose. An edit starts a new run at t = 0.
2. The viewport uses **the same lock** as the Joints tab, locked by default.
3. Joint ring: one ring about the selected joint's axis at its origin; the
   angle is clamped to the joint's raw limits; the arm follows live; release
   commits.
4. Grasp handle: translate only, at the grasp point; IK for the seven arm
   joints every frame; tether when out of reach; snap on release.
5. Clamped to raw limits; outside the planning box is flagged, not blocked.
6. Out of scope: self-collision, orientation targets, editing during playback.

## Defaults I had to choose (Felix may override)

- **No extra mode switch or modifier.** The lock is the mode switch. Unlocked:
  a click without drag (pointer moved < 4 px between down and up, the onion-skin
  rule) on an arm link selects its joint ring; on a gripper link or the grasp
  handle it selects the grasp handle. A drag anywhere still orbits the camera,
  so orbiting needs no modifier. The limit-tint hover tooltip stays (it is hover
  only) but is hidden while a gizmo is dragged. Rejected: an Alt-click modifier
  (hidden, and redundant with the lock) and a separate ring/IK toggle (the
  clicked part already says which mode is meant).
- **Pick priority** for one click: an active gizmo handle (TransformControls
  axis under the pointer), then the gold task anchor (`src/target-gizmo.js`
  already captures it), then the grasp handle, then the nearest solid-robot hit
  (arm link → ring, gripper → grasp handle). Ghost arms (`ux/onion-skin`,
  `ux/session-model`) are not editable: if onion skin's click-to-seek is on
  main, one click must not both seek and select; the nearest hit decides.
- **One selection at a time** across the task gizmo, the joint ring and the
  grasp handle: selecting one deselects the others (in both directions,
  including the task gizmo's T/G/R/S shortcuts).
- **A lock mirror in the viewport.** One icon button in `.camera-controls`
  (open/closed padlock, `aria-pressed`) bound to the same lock state, because the
  Joints tab is often not the visible right-sidebar tab and the lock changes
  what the arm shows. Tooltip states the state in effect: `Start pose locked`
  / `Start pose editable · click a link or the grasp point`.
- **What the arm shows while unlocked: the start pose.** One pose for the
  Joints tab and the 3D arm: if the merged branch shows the start pose in the
  Joints tab while unlocked, the solid arm, its limit tint and the grasp handle
  show it too (the editor owns the arm's pose); locking returns the arm to the
  episode cursor's recorded state. If the merged branch keeps the Joints tab on
  the recorded state while unlocked, stop and report before building this part.
  While the editor owns the pose, hide the white Live end-effector marker
  (`liveMarker`, it marks the recorded state) and, during a drag, the Live
  prediction line (it was computed from another state).
- **Commit on release only**, never during a drag (each commit starts a run).
  No commit when no joint moved by more than 1e-6 rad. Angles are rounded to
  1e-6 rad, then clamped (so rounding cannot leave the limits).
- **Joint ring clamps to the raw limits** (Felix's rule). **The IK clamps each
  joint to the planning box if that joint was inside it at drag start,
  otherwise to its raw limits**, so the IK never pushes a joint into the
  flagged band by itself. A joint already outside the box stays editable.
- **Planning-box flag in the viewport:** the encoding the merged branch uses in
  the Joints tab, applied to that joint's link (the element it concerns), with
  joint, value and box in the limit-tint tooltip. If the branch defines no
  colour: an amber (`--limit-near`) edge outline built like
  `limit-beyond-outline`.
- **Grasp handle and tether colour:** the workbench text tone `0xe7edf5`,
  unlit, `depthTest: false`, render order 6 like the task gizmo. Handle: a
  wireframe sphere of radius 0.02 m when not selected (distinct from the solid
  white Live marker of radius 0.011 m and the gold task anchor). Tether: a
  dashed line (`createPathLine` with `dashed`), shown when the gap is ≥ 2 mm.
- **Gizmo settings:** ring: `TransformControls` mode `rotate`, space `local`,
  `showX = showY = false`, `showZ = true`, size 0.6. Grasp handle: mode
  `translate`, space `world` (as the task gizmo), all axes and planes, size 0.6.
  Selected link: a slight emissive lift (`emissive` `0x1d3a55`; urdf-loader
  meshes are `MeshPhongMaterial`, materials are already cloned per mesh). Over
  a pickable link or the handle while unlocked: CSS `cursor: pointer`.
- **Gizmos in the Top/Right views:** the same scene is rendered there, so they
  appear as the task gizmo already does. No layer change.
- **IK numbers** (see "Inverse kinematics"): damping 0.04 m, 16 iterations per
  frame, task-error clamp 0.05 m, joint step ≤ 0.05 rad per iteration,
  null-space posture gain 0.1, convergence 0.1 mm. Named constants, overridable
  through an options object.
- **The grasp frame comes from the backend**, never a constant in the browser
  (the existing `tests/test_end_effector.py` uses a nontrivial test TCP for the
  same reason). A runtime guard compares browser FK with the recorded
  `ee_xyz` (0.1 mm).
- **Test tolerance** 1e-6 m (positions) and 1e-6 (Jacobian entries). A spike
  for this handoff got 4e-10 m at `Q_START`.
- **Node DOM for the test:** `linkedom` as a devDependency (spike result
  below). No runtime dependency is added.
- **Base:** wait for the start-pose merge (working rules). Felix may allow the
  pure kinematics part (phase 1) to start earlier.

## Vocabulary and display rules

Read `AGENTS.md` ("What the display claims", "UI design: let the design carry
the information", "Defaults are never hidden") and `UBIQUITOUS_LANGUAGE.md`.

**Terms** (code, UI text, docs). Proposed; add the ones the start-pose branch has
not added to `UBIQUITOUS_LANGUAGE.md`, in a new "Start pose editing" table marked
"Felix, 2026-10-23" (use the start-pose branch's wording where it already defines
a term):

| Term | Definition | Avoid |
|---|---|---|
| **Start pose** | The seven native right-arm joint positions the simulated arm starts from at t = 0, velocities zero; a Live setting, default `tiago_mpc`'s `Q_START`; Reset returns to it. | Starting pose (the Replay library's default scene), initial state (includes velocities), home pose |
| **Start-pose lock** | The toggle that makes the start pose editable, in the Joints tab and mirrored in the viewport; locked by default. | Edit mode |
| **Joint ring** | The rotate handle about one arm joint's axis at its origin; it edits that joint's start-pose angle. | Rotation gizmo, joint handle |
| **Grasp point** | The position of `tiago_mpc`'s grasp frame (`GRASP_FRAME`, `arm_right_grasp_joint`): the nominal grasp centre between the fingertip pads, Live's end effector. A geometric convention, not a calibrated TCP. | TCP, tool point, flange (that is `arm_right_tool_joint`) |
| **Grasp handle** | The translate handle at the grasp point that drives the inverse kinematics. | Target, task anchor (the gold task target) |
| **Achieved grasp point** | The grasp point of the inverse-kinematics solution currently shown. | Target |
| **Tether** | The line from the grasp handle to the achieved grasp point while the handle is out of reach. | Error line, residual |
| **Planning box** | The MPC's joint position bounds: the raw URDF limits shrunk by `MpcParams.joint_margin_rad` (0.1 rad); `mpc_bounds` in the segment header. | Soft limits, safety limits (the URDF's `safety_controller`) |

Flag in the glossary's ambiguities: "starting pose" (Replay default scene,
README) versus "start pose" (the Live setting).

**What the display claims:**

- The arm shows the **achieved** pose, never the requested one: the handle shows
  the request, the tether the gap, and on release the handle snaps to the
  achieved point. The tether is the only out-of-reach cue (no text).
- While the editor owns the pose, the arm shows a **setting** (the start pose),
  not a recorded state. The open lock (viewport mirror) and the visible grasp
  handle mark this; the Live marker of the recorded state is hidden. After a
  commit the new run's t = 0 state is the start pose, so display and record
  agree again.
- An IK pose is a kinematic pose only. It says nothing about self-collision or
  whether the MPC can move from there; the planning box is flagged; no caveat
  text beyond that.
- **Defaults are never hidden:** the lock shows its state; the start pose's
  value and reset arrows stay where the start-pose branch puts them.

## Inverse kinematics

Position only, for the seven arm joints, in the browser, on the browser's own
model (`robot` from urdf-loader), so the arm and the IK cannot disagree.

**Forward kinematics** (pure function on a chain extracted once from `robot`):

- Base `T₀` = world matrix of `arm_right_1_joint`'s parent link
  (`torso_lift_link`). Read it at every drag start: it changes with the fixed
  joints (`applyFixedJoints`, torso height).
- For each arm joint i: `T ← T · O_i` (origin: urdf-loader keeps it in
  `joint.origPosition`/`origQuaternion` after the first `setJointValue`, before
  that in `position`/`quaternion`); `p_i` = translation of `T`;
  **`z_i = R(T) · a_i`** with `a_i = joint.axis`; then `T ← T · Rot(a_i, q_i)`.
  **`a_i` is ±z, not always +z:** `arm_right_6_joint` has `axis 0 0 -1` in the
  full URDF. Using the joint's own axis keeps the sign right; never assume +z.
  Assert that each arm joint's child link is the next joint's parent with an
  identity link transform (true for urdf-loader), and that each axis is ±z
  (the same check as `tiago_mpc`'s `runtime_urdf`).
- Grasp: `T ← T · (fixed joints from arm_right_7_link to the grasp frame's
  parent link, here arm_right_tool_joint, xyz 0 0 0.017) · G`, with `G` the
  grasp frame's origin served by the backend (today `arm_right_tool_link` +
  xyz 0 0 0.139288457525, rpy 0 0 0 in `tiago.arm_urdf()`). `p` = translation.
- **Jacobian** (position rows, world frame): `J_i = z_i × (p − p_i)`.
- Note: the grasp point lies on joint 7's axis (tool and grasp offsets are along
  link 7's z), so `J_7 ≈ 0`: joint 7 never moves the grasp point, the IK leaves
  it to the posture term, and its ring only turns the gripper. Effectively six
  joints serve a 3D point: three redundant degrees of freedom.

**Solver** (damped least squares with null-space posture; per frame):

```
inputs: q (warm start: previous frame's solution; at drag start the start pose),
        q0 (pose at drag start), target x* (handle position, world),
        bounds lo, hi (planning box or raw, per joint, fixed at drag start)
repeat up to ITERATIONS_PER_FRAME (16):
  p, J ← fk(q)
  e ← x* − p;  if |e| > E_MAX (0.05 m): e ← e · E_MAX / |e|
  if |x* − p| < TOL (1e-4 m): stop (converged)
  free ← joints not at a bound whose step would push further out
  J_f ← J with columns of non-free joints zeroed
  A ← J_f J_fᵀ + λ² I₃            (λ = DAMPING = 0.04 m; 3×3 solve)
  dq_task ← J_fᵀ A⁻¹ e
  N ← I − J_fᵀ A⁻¹ J_f            (damped null-space projector)
  dq ← dq_task + N · POSTURE_GAIN (0.1) · (q0 − q), zero for non-free joints
  if max|dq_i| > DQ_MAX (0.05 rad): dq ← dq · DQ_MAX / max|dq_i|
  q ← clamp(q + dq, lo, hi)
  if max|dq_i| < 1e-7: stop (stalled: out of reach or at bounds)
```

- **Out of reach:** with the clamped error the iteration descends the distance
  and stalls at a local minimum: the achieved grasp point is the nearest point
  the solver reaches from the warm start, not a proven global nearest point.
  Do not claim more (docs and tooltip: "nearest reachable point found").
- **No flipping:** warm start from the previous frame, the posture term toward
  the drag-start pose, the joint step limit and at most 16 × 0.05 rad = 0.8 rad
  per joint per frame. Solve once per animation frame (in `animate`, before
  rendering), only while the target changed or the last frame did not converge;
  `objectChange` only stores the target.
- **Budget:** each iteration is one 7-joint FK and a 3×3 solve; 16 iterations
  are far below 1 ms. Keep the iteration count fixed, not time-based, so tests
  are deterministic.
- Return `{ q, achieved, gap_m, iterations, converged, stalled }` per frame.
- Pure module, plain arrays (three.js math types are fine), no DOM, unit-tested.

## Required consistency test: browser FK against `tiago_mpc`

The browser's grasp point must equal `tiago_mpc.tiago.fk` (Pinocchio, reduced
arm) for random poses.

- **Spike (done for this handoff, `/tmp`, nothing committed):** urdf-loader
  0.12.7 parses the full URDF in Node 22 with `linkedom` 0.18.14 when
  `DOMParser`, `Document` and `Element` from linkedom are set on `globalThis`
  (`parseVisual = parseCollision = false`). At `Q_START` the grasp point
  relative to `torso_lift_link` was `[0.37316580041, -0.20996109264,
  -0.25740882760]`; `tiago.fk(Q_START)` gave `[0.3731658, -0.20996109,
  -0.25740883]`. `joint.axis` of joint 6 read `[0, 0, -1]`.
- **Generator** `scripts/grasp_fk_fixture.py` (run with the selected
  checkout's interpreter, `python3 scripts/launch_python.py`) writes
  `tests/fixtures/grasp_fk.json`:
  `{ tiago_mpc_commit, full_urdf_sha256, frame: GRASP_FRAME, root_frame:
  "torso_lift_link", grasp: {parent_link, xyz, rpy} (from tiago.arm_urdf()),
  seed, poses: [{ q, grasp_torso_m: tiago.fk(q), jacobian_torso: 3×7,
  grasp_world_m }] }`. Poses: `Q_START`, `Q_REACH`, 64 uniform random poses
  within `tiago.limits()` (fixed seed), and 14 poses with one joint at its
  lower or upper limit. `jacobian_torso`: Pinocchio
  `computeFrameJacobian(..., LOCAL_WORLD_ALIGNED)[:3]` of the grasp frame in
  the reduced model (checks the joint 6 sign). `grasp_world_m`: the backend's
  display-frame value, `server.RobotKinematics(FULL_URDF,
  end_effector_frame=GRASP_FRAME).ee_positions` with the default fixed joints.
- **JS test** `src/arm-kinematics.test.js` (`node --test`): loads the full URDF
  from `TIAGO_MPC_ROOT` or `../tiago_mpc` (the Python tests' rule in
  `tests/tiago_mpc_source.py`; fail clearly when missing, never skip), parses
  it with urdf-loader through linkedom, extracts the chain with the **same**
  function the browser uses, applies the fixture's grasp origin as the
  browser applies the backend's, and compares per pose: grasp relative to
  `torso_lift_link` and Jacobian (rotated into the torso frame) with
  `tiago.fk` and Pinocchio, and the world grasp point with `grasp_world_m`,
  all within 1e-6. A failure message names the pose, the error and, if the
  URDF's sha256 differs from the fixture's, says to regenerate the fixture.
  Also check the Jacobian against central finite differences of the JS FK.
- **Python staleness test** `tests/test_grasp_fk_fixture.py`: regenerates the
  fixture's values from the current `tiago_mpc` and compares within 1e-9, so a
  kinematics change in `tiago_mpc` fails loudly with "rerun
  scripts/grasp_fk_fixture.py".
- **Runtime guard:** when the grasp handle first becomes available in a Live
  segment, compute the browser grasp point for one recorded state and compare
  with its `ee_xyz` (Pinocchio, full URDF and grasp frame). Above 0.1 mm, or
  when the segment header's `end_effector_frame` is not the served grasp frame,
  disable the grasp handle (joint rings stay) and mark it with a badge whose
  tooltip gives the reason and the distance. Expose the value in the smoke
  handle.

## Start-pose API to re-check (from `ux/editable-start-pose`)

What the branch's uncommitted backend showed when this was written; verify all
of it on main after the merge and adapt:

- Setting `config.plant.start_pose_rad` (seven floats, native order
  `joint_names`); schema parameter `plant.start_pose_rad` with `kind:
  "joints"`, `group: "Start pose"`, `lower`/`upper` (raw URDF limits from
  `tiago.limits()`), default `tiago.Q_START` (`live_mpc.start_pose_spec`).
- The backend rejects values outside the raw limits (`validate_settings`), and a
  `set_settings` whose start pose changed starts a reset generation at t = 0
  (`execution_bridge.py`, `new_start`); the solver adapter seeds Reset from it.
- Expected in the frontend (not yet written then): the lock and its state, the
  Joints tab editing, the planning-box flag, reset arrows. Use the branch's
  functions; do not build a second path. If they are missing, add only the
  smallest accessors to the object `setupLive` returns, following
  `setTargetWorld`: e.g. `startPose` (current value or draft), `setStartPose(q)`
  (clamp, write the setting, `change()`), `startPoseLocked`, `onStartPoseLock(fn)`,
  and one `startPoseEditable` predicate (Live mode, connected, schema ready, not
  playing, no profile switch) shared by the Joints tab and the viewport.
- During a drag the Joints tab should show the draft values live without
  committing; use the branch's draft display if it has one, otherwise
  `updateJointTelemetry(q, zeros, null, limits, 'applied', planningBox)`.
- Not yours, but report it if still present: `server.load_scene` hard-codes
  `starting_right_rad` with joint 4 at −2.35, while `tiago.Q_START` has −2.33
  (the Replay "Starting pose" scene).

## Code to touch and patterns to follow

- **`src/arm-kinematics.js` (new, pure):** `armChain(robot, { jointNames,
  grasp })` (extraction and asserts above), `forwardKinematics(chain, base, q)`
  → `{ grasp, origins, axes }`, `positionJacobian(fk)`, `solveGraspIk(chain,
  base, { q, q0, target, lower, upper, ...options })`, `ikBounds(q0, raw,
  planningBox)`, the named constants. No DOM.
- **`src/joint-editor.js` (new):** follow `src/target-gizmo.js`
  (`setupTargetGizmo`): two `TransformControls` (ring, grasp handle), each
  attached to a **proxy** `Object3D` in the scene root (like its `anchor`),
  never to a URDF joint (that would bypass `setJointValue` and the limits).
  Ring proxy: at the joint's world origin with the joint's world orientation.
  In `objectChange` read `transform.rotationAngle` (unbounded, so joint 1's
  5.2 rad range works; TransformControls maps the drag linearly along the ring's
  tangent) and set `q = clamp(q_start + rotationAngle · a_i.z)`; then set the
  proxy's quaternion back to the clamped angle (TransformControls recomputes
  from its start each move, so this is safe). Disable orbit on
  `dragging-changed` as the task gizmo does. Picking: `Raycaster` from the
  camera, pointer handling as in `src/limit-tint.js`, click versus drag by the
  4 px rule; link → joint mapping from `limitTint.links` (each arm joint's child
  link meshes; it stops at nested joints), gripper meshes = the subtree under
  `arm_right_tool_joint`; skip `limit-beyond-outline` lines (their `raycast` is a
  no-op already). Before selecting on a click, check that no TransformControls
  axis is hovered (`transform.axis`) or dragging. Keyboard: Escape only (cancel
  drag or deselect); ignore while typing (`taskGizmoShortcut`'s rule). Export
  pure helpers (click threshold, ring angle → q, link classification) for
  `src/joint-editor.test.js` in the style of `src/target-gizmo.test.js`.
  Expose `update()`, `ownsPose`, `deselect()`, `dispose()` and `snapshot`.
- **`src/target-gizmo.js`:** add `deselect()` and an `onSelect` callback (also
  fired by its T/G/R/S shortcuts) for mutual exclusion; keep its behaviour.
- **Backend:** serve the grasp frame with the Live schema, e.g.
  `end_effector: { frame, parent_link, xyz, rpy }`, where the schema is built
  for the simulator source (next to the start-pose spec,
  `execution_worker.py` / `live_mpc.build_schema`). Factor the reduced-URDF
  lookup out of `server.RobotKinematics.__init__` (it already finds the fixed
  grasp joint, its parent link and origin) into one helper both use. Tests in
  `tests/test_live_mpc.py`. Document the field in `docs/live-api.md`.
- **`src/main.js`:** create the editor after `setupTargetGizmo` in `start()`;
  call `jointEditor.update()` in `animate` after `live?.frame()` and before
  `renderer.render`; in `showLiveState`, skip `setJointValue` and
  `updateJointTelemetry` and hide `liveMarker` while `jointEditor.ownsPose`; in
  `changeMode`, deselect and release the pose in Replay; add the lock mirror
  button (an `unlock`/`lock` pair in the `icons` table) and the cursor style;
  add `jointEdit` to `window.__motionStudio` (`available`, `locked`, `mode`
  none/ring/grasp, `joint`, `dragging`, `q_draft`, `target_world`,
  `achieved_world`, `gap_m`, `iterations`, `converged`, `fk_guard_m`,
  `handles_screen` like `targetGizmo.snapshot`).
- **`src/workbench-shell.js`:** the lock mirror in `.camera-controls`.
- **`package.json`:** `linkedom` in `devDependencies` (pin the version you
  test with); `npm test` stays `node --test src/*.test.js`.
- **Docs:** README (Live: editing the start pose in the viewport, the lock,
  Escape), `docs/presentation.md` (grasp handle, tether, colours, constants),
  `docs/live-api.md` (schema `end_effector`), `docs/architecture.md` code map
  (`arm-kinematics.js`, `joint-editor.js`, the fixture script),
  `UBIQUITOUS_LANGUAGE.md` (terms above), and a short dated "Viewport start-pose
  editing — Felix, 2026-10-23" paragraph in `AGENTS.md` with decisions 1–6.

## Out of scope (do not build)

- **Self-collision.** An IK pose may intersect the torso or the other arm.
  Later: a backend check with `tiago_mpc`'s safety collision model
  (`tiago_mpc/safety.py`: `build_tiago_collision_model`,
  `compute_collision_margin_violations`) that flags a start pose in collision,
  like the planning box.
- Orientation targets (6D IK, gripper orientation handles), task-space
  constraints, multi-joint selection, angle snapping, limit arcs on the ring.
- Editing during playback, in Replay, or on comparison tracks; editing start
  velocities; undo; named saved poses (`todo.org` "Random Ideas").
- Any change to `tiago_mpc`.

## Tests and checks

- **Unit tests** (`node --test`): the fixture comparison above; IK: a reachable
  target converges below 0.1 mm within a few frames; an out-of-reach target
  stalls with `gap_m` > 0, the error non-increasing over frames and joints
  within their bounds at every iteration; the planning-box/raw bound choice;
  posture: a zero-error target leaves q unchanged, and a reachable target ends
  closer to q0 than without the posture term; joint 7 untouched by position
  targets; determinism (same inputs, same output); non-finite targets rejected.
  Joint editor helpers: click threshold, ring angle with axis sign (joint 6),
  clamping, link classification (arm link → joint, gripper → grasp).
- **Python:** fixture staleness test, schema `end_effector`, the factored
  grasp-frame helper (`python_bin="$(python3 scripts/launch_python.py)"`, then
  `"$python_bin" -m unittest discover -s tests -v`).
- `npm test` and `npm run build` pass.
- **Manual browser checklist** (your own server on a free port, e.g.
  `./scripts/start.sh --host 0.0.0.0 --port 8093` from your worktree, with its
  own `TIAGO_VISUALIZER_RUNTIME_DIR`):
  1. Live, locked (default): clicks on links do nothing; drags orbit; limit-tint
     hover works; the task gizmo works as before.
  2. Unlock (Joints tab and the viewport mirror): both show the same state; the
     arm shows the start pose; the grasp handle appears at the grasp point.
  3. Click each arm link: only that joint's ring appears at its origin; drag:
     the arm follows, stops at the raw limit; the Joints tab shows the draft;
     joint 6 turns the right way (compare with the Numbers view).
  4. Release: one commit, a new run at t = 0 from the new pose (GPU, see below);
     Reset returns to it; the reset arrows restore `Q_START`.
  5. Grasp handle: drag within reach, the grasp point follows without jumps;
     drag far out: tether appears, arm stretched toward it, no flip; release:
     handle snaps, tether disappears.
  6. A pose outside the planning box is flagged on its link and in the Joints
     tab, and still commits.
  7. Escape during a drag reverts without commit; empty click deselects; lock
     during selection deselects and returns the arm to the cursor state.
  8. Task gizmo and joint editor deselect each other; T selects the task gizmo.
  9. Replay mode: no handle, no picking. Playing: gizmos hidden.
  10. Top/Right views show the gizmos like the task gizmo; nothing else
      changed there. `window.__motionStudio.jointEdit.fk_guard_m` < 1e-4.
  11. With onion skin on main: clicking a ghost seeks, clicking the solid arm
      selects, never both.

## Working rules

- **Base:** check `git log --oneline main` first. Start only when
  `ux/editable-start-pose` is merged into main; branch from that main. If it is
  not merged, stop and report back; do not branch from the unmerged branch.
- **Own worktree and branch**, e.g.
  `git worktree add ../tiago_mpc_visualizer-joint-edit -b ux/viewport-joint-editing main`.
  Run `npm ci` there (and `npm install -D linkedom@<version>`).
- **Never touch the main checkout** `impl/tiago_mpc_visualizer` (Felix's viewer
  runs from it on port 8090): no edits, builds, `npm` runs or servers there;
  never use port 8090. Other worktrees (`-startpose`, onion skin, session) are
  read-only for you.
- **Small commits** with clear messages (kinematics and fixture, backend grasp
  frame, IK, joint ring, grasp handle and tether, lock mirror, docs). Do not
  merge into main; Felix decides.
- **GPU:** nothing needs it except committing in Live (each commit starts a run
  and a reseed). Develop and check picking, rings, IK and the tether without
  committing; do the commit checks (4, 6) once at the end, only when no
  experiment holds the GPU locks (AGENTS.md "Host environment and GPU").
- Keep the scope. Note improvements outside it in the report instead of
  building them.

## What to report back

- Branch, worktree path, base commit (the start-pose merge) and commit list.
- What was implemented; every deviation from the decisions or defaults above
  and why (especially: what the arm shows while unlocked, the start-pose API
  you used, the IK constants after tuning).
- Fixture: number of poses, maximum position and Jacobian error, tiago_mpc
  commit; the runtime guard's value in Live.
- IK behaviour: frames to converge for a typical drag, worst gap and stall
  cases seen, any flips or local minima you could provoke.
- Test results (`npm test`, `npm run build`, Python suite) and which manual
  checks you did; say explicitly which you could not do (e.g. commits without a
  free GPU).
- Open issues, conflicts with onion skin or the session model, and the
  `load_scene` start pose note if still present.
