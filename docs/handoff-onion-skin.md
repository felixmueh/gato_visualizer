# Handoff: onion skin, first version

For the coding agent implementing it. Written 2026-10-23 against visualizer
main `8a84365`. Background and alternatives (read only if a decision below is
unclear):
[the onion-skin brainstorm](/home/felix/_Uni/MasterThesis/agent-reading/visualizer-onion-skin/brainstorm.md).
A later feature (comparing several motions as tracks, with translucent arms of
other tracks) will reuse the ghost-arm module you build here; its brainstorm is
[visualizer-motion-comparison](/home/felix/_Uni/MasterThesis/agent-reading/visualizer-motion-comparison/brainstorm.md).

## Goal and user-visible behaviour

Onion skin shows several poses of the displayed motion at once, so differences
along the whole motion are visible without playing it.

- A toggle button in **both** transport bars (Replay `#replay-controls` and
  Live `#live-controls`), next to the expand chevron, key **O** (ignored while
  typing, like Space). Off by default.
- When on: about **8 translucent grey right arms** (ghost arms) at keyframes on
  **round time steps** over the whole motion, plus one at the **final state**.
  The solid robot stays as it is (pose, limit tint, everything).
- **Opacity rises toward the episode cursor** (far: faint, near: stronger) and
  updates while playing or scrubbing. A ghost within a few ms of the cursor is
  hidden (it would z-fight with the solid arm).
- **Ticks** at the keyframe times on the transport track, in the ghost tone,
  and on the expanded timeline when it is open.
- **Hover** a ghost (or its tick) → tooltip with its time, e.g. `1.500 s`.
- **Click** a ghost (click without drag, so orbiting still works) or its tick
  → the episode cursor seeks to that keyframe.
- **Live:** ghosts exist only where history exists; while playback runs at the
  growing edge (following the tip, buffering, or history still arriving)
  only keyframes up to the playback cursor are shown, like the plots
  (`liveReveal` in `src/main.js`). A new history generation clears them.
- The ghosts also appear in the Top/Right views (same scene), unless the spike
  shows that is too slow (see below).

## Scope

1. **Measurement spike** (half a day, may be throwaway code on the branch).
2. **First version** as described above, built on a reusable
   `src/ghost-arm.js`.

**Non-goals (do not build):** onion skin of a plan/prediction's knots;
event keyframes (breaches, arrival, overruns, clipping); spacing modes other
than round time steps, count/step controls, range options (visible window,
around cursor); hand-placed keyframes; comparison tracks or track colours;
persisting the toggle anywhere other than `localStorage`; limit tint on ghosts;
floating text labels in the scene.

## Decisions to implement (defaults; Felix may override)

1. **Right arm only.** Ghosts show the subtree from `arm_right_1_joint` down,
   including the gripper. The rest of the robot is static within a motion.
2. **Keyframe times:** the step is the smallest of 1, 2, 5 × 10ᵏ s that gives
   at most 8 keyframes over the motion's time range (same idea as
   `timelineTicks` in `src/expanded-timeline.js`). Keyframes are the multiples
   of the step inside the range (absolute times, not offsets from the start),
   plus the final recorded state. Drop a grid keyframe closer than ¼ step to
   the final one.
3. **Live growth:** keep the step while the history grows until the count
   would exceed 16, then recompute (step doubles). Hysteresis prevents
   relayout on every history batch.
4. **Snap to recorded states.** A keyframe shows the recorded sample at or
   before its time (Replay: the sample index from `sampleTrajectory(...).index`
   or an equivalent binary search; Live: `history.at(time, {trace: false})`).
   Never interpolate. The tooltip shows the **snapped sample's time**, not the
   grid time.
5. **Encoding:** one neutral grey for past and future; opacity linear in
   |t − cursor| over the range, from about 0.12 (far) to 0.4 (nearest); hide
   within 5 ms of the cursor. Tune the numbers by eye, keep them as named
   constants.
6. **Executed motion only.** In Replay the ghosts follow the selected
   trajectory. If the selected trajectory is a saved prediction
   (`kind: "prediction"`), use the prediction cyan (`pathColor` `0x34d8d4` in
   `src/main.js`) instead of grey, because a prediction must not look like
   executed motion.
7. **Toggle state** in `localStorage` (wrapped in try/catch), like the Joints
   view toggle (`loadJointView`/`saveJointView` in `src/joint-telemetry.js`).
   Do not extend `/api/presentation/settings`, so no backend change.
8. **Limits:** pool of at most 24 ghosts (the first version needs ≤ 9).
9. **Transparency method:** chosen in the spike, rule below.

## Vocabulary and display rules

Read `AGENTS.md` ("What the display claims", "UI design: let the design carry
the information", "Defaults are never hidden") and `UBIQUITOUS_LANGUAGE.md`.

- **Terms** (in code, UI text, docs): **onion skin** (the feature), **keyframe**
  (a time at which a ghost arm is drawn), **ghost arm** (a translucent right arm
  at a state other than the solid robot's). Do **not** use "frame" (means a
  coordinate frame here) or "preview" (means a Live preview solve). Add the
  three terms to `UBIQUITOUS_LANGUAGE.md` under "Clocks and presentation" with
  the definitions above.
- **What the display claims:** a ghost is a recorded state (simulated plant
  state in Live, the recording's state in Replay); never show an interpolated
  or invented pose. Predictions use cyan, never grey.
- **UI design:** no permanent text. The button is an icon (add an `onion` icon
  to the `icons` table in `src/main.js`, e.g. three nested arcs) with a
  pressed state (`aria-pressed`). Secondary details go in tooltips.
- **Defaults are never hidden:** the button's tooltip states the values in
  effect, e.g. `Onion skin · 9 ghost arms · every 0.5 s` (and `· off` when off).

## Code to touch and patterns to follow

- **`src/ghost-arm.js` (new, reusable).** Proposed interface:
  `createGhostArms({ robot, scene, armRoot: 'arm_right_1_joint', max })` →
  `{ set(poses), setBase(), pick(raycaster) , dispose(), snapshot }`, where a
  pose is `{ id, q, jointNames, time, opacity, color }` and `pick` returns the
  pose's `{ id, time }` or null. It owns cloning, materials, render order,
  sorting and disposal; it knows nothing about keyframes. Keep keyframe
  selection in a separate pure module (e.g. `src/onion-skin.js` exporting
  `onionKeyframes(times, { maxCount, previousStep })` and the opacity
  function) so it is unit-testable without WebGL.
- **Robot loading and cloning** (`loadRobot`, `start` in `src/main.js`): the
  robot is one `URDFLoader` hierarchy of STL meshes (`parseVisual` only),
  complete when `loadRobot` resolves. `robot.traverse` then clones every mesh
  material (for the limit tint), and `createLimitTint` may later add
  `LineSegments` children named `limit-beyond-outline`. Create the ghost pool
  right after the robot is added, **filter out** any `limit-beyond-outline`
  children, and give ghosts their own materials. three.js `clone()` shares
  geometry by reference: never clone or dispose geometry for ghosts.
  - Clone the arm subtree (`robot.joints.arm_right_1_joint.clone()`) under a
    `THREE.Group` whose matrix is the solid arm's parent `matrixWorld`. Map
    cloned joints by `urdfName` and set them with `joint.setJointValue(value)`.
    The gripper's mimic joints are not driven, which is fine because the
    fingers are fixed display joints.
  - **`setBase()`** must be called after every `applyFixedJoints` (recording
    change, mode change), or the ghosts keep the old torso pose.
- **Materials:** one material per ghost shared by its meshes, `FrontSide`
  (the solid robot uses `DoubleSide`, which shows inner faces through
  transparency), `transparent: true`. Scene fog and tone mapping apply.
- **Draw order:** paths draw on top already (`depthTest: false`, render order
  3–4 in `src/path-lines.js`; markers 5, target gizmo 6); keep ghosts below
  that. three.js 0.180 applies a `Group`'s `renderOrder` to its descendants
  (`projectObject` in `WebGLRenderer.js`); `URDFJoint` is not a `Group`, hence
  the wrapping group per ghost.
- **Render loop:** `animate` in `src/main.js` renders the scene, then
  `updateExpandedTimeline`, plots and `auxiliaryViews.render`. Update ghost
  opacities (and the far-to-near sort, if used) once per frame there; recompute
  keyframes only when the motion changes (Replay: `selectTrajectory`; Live:
  history revision or generation, see below), not every frame.
- **Replay data:** `trajectory.time_s`, `trajectory.q` (T × 7, order
  `data.joint_names`), `trajectory.kind`; cursor time is
  `elapsed + trajectory.time_s[0]`; seeking = set `$('timeline').value` and
  dispatch `input` (as `expandedTimeline`'s `onSeek` does).
- **Live data:** `src/live.js` hides its `history` (`createLiveHistory`) behind
  the object returned by `setupLive`. Add one small read-only accessor there,
  e.g. `historyStates(times)` → `[{ time, q }]` via `history.at(time, { trace:
  false })`, plus `historyRevision` and `generation` getters (a
  `historyRevision` counter already exists). Use `live.history`
  (`presentationBounds`, `selectedTime`, `playing`, `following`, `buffering`,
  `growing`) for the range, cursor and reveal rule. Seek through the existing
  `#live-history` input (`input` event), as `onSeek` does.
- **Transport track ticks:** Live already overlays `#live-history-intervals`
  on its track (`paintIntervals` in `src/live.js`, CSS in `src/style.css`
  around `#live-history-intervals`, breach ticks `.breach`). Add a separate
  overlay element for keyframe ticks in each transport track (the Replay
  track `.transport-track` has none yet), positioned in the track's own
  range: Live uses `presentationBounds`, not the recorded bounds. Repaint
  only on keyframe changes. Ticks need `pointer-events` for hover/click
  without breaking the range input underneath.
- **Expanded timeline ticks:** `paint()` in `src/expanded-timeline.js` draws
  on a canvas and caches by `paintKey`; pass the keyframes in `update(next)`
  and include a keyframe revision in `paintKey`. Draw short ticks in the
  ghost tone below the time labels.
- **Hover and click in the scene:** follow `createLimitTint` in
  `src/limit-tint.js` (pointer handler throttled with
  `requestAnimationFrame`, `Raycaster` from the camera). Raycast only the ghost
  groups, with bounding-sphere early-out; use the existing tooltip style
  (`#limit-tint-tooltip` CSS) for a ghost tooltip element. Distinguish a click
  from an orbit drag (pointer moved < 4 px between down and up).
- **Top/Right views:** `src/auxiliary-views.js` renders the same `scene`
  through two orthographic cameras at ≤ 30 fps while the Views tab is
  visible, so ghosts are drawn there too. If the spike says to exclude them,
  put ghosts on a separate `layers` channel that only the main camera enables.
- **Smoke-check handle:** add `onionSkin` to `window.__motionStudio` in
  `start()` (enabled, step, keyframe times, snapped times, opacities, ghost
  count), like `timeline` and `pathInfo`.
- **Docs:** a short "Onion skin" section in `docs/presentation.md` (behaviour,
  defaults, `localStorage` key); add `src/ghost-arm.js` and `src/onion-skin.js`
  to the code map in `docs/architecture.md`.

## Spike: measurement and decision rule

Before the real implementation, on Felix's laptop browser (he views the
visualizer from his laptop, served by the desktop):

- Measured robot size (my count from the URDF): the right-arm subtree is 14
  visual meshes, about 78 000 triangles; the whole robot 48 meshes, about
  255 000.
- Load a Replay recording, place **8, 16 and 24** ghosts, for each of
  **(a) plain transparency** (`depthWrite: false`) and **(b) depth pre-pass**
  (each ghost drawn twice: a depth-only copy with `colorWrite: false`, then the
  colour copy with `depthFunc: EqualDepth`; per-ghost group render order,
  groups sorted far to near by camera distance each frame).
- Record per case: `renderer.info.render.calls` and `.triangles`, mean frame
  time over ~5 s of orbiting (e.g. `performance.now()` deltas in `animate`),
  with the Views tab **visible and hidden**. Take one screenshot per method at
  8 ghosts from the default camera and one close-up of overlapping arms.
- **Decision rule:**
  - Use **(b) pre-pass** if, at 8 ghosts with the Views tab visible, the mean
    frame time stays ≤ 20 ms (≈ 50 fps) on the laptop. Otherwise use (a)
    with an unlit flat colour at about 0.35 opacity and `depthWrite: true`,
    groups sorted far to near.
  - Exclude ghosts from the Top/Right views (layers) if the Views tab visible
    costs more than 5 ms per frame extra at 8 ghosts.
  - If even (a) misses 20 ms at 8 ghosts, stop and report before building
    further.
- Put the numbers, the chosen method and the screenshots' paths (under the
  worktree's ignored `_expr_data/`) in your report.

## Tests and checks

- **Unit tests** (`node --test`, files `src/*.test.js`, style of
  `src/live-history.test.js`): keyframe selection (step choice, absolute
  multiples, final state added, near-final grid point dropped, hysteresis on
  growth, ranges not starting at 0, single-sample and zero-length motions),
  snapping (returns the sample at or before, reports its time), opacity
  function (monotone, hidden near the cursor), Live reveal (no keyframes after
  the cursor when growing). Pure functions only; no WebGL in tests.
- `npm test` and `npm run build` must pass. The backend should not change; if
  it does, run `"$python_bin" -m unittest discover -s tests -v` with
  `python_bin="$(python3 scripts/launch_python.py)"`.
- **Manual browser checks** (your own server on a free port, e.g.
  `./scripts/start.sh --host 0.0.0.0 --port 8091` from your worktree):
  1. Replay: load a recording; toggle with the button and with O; 9-ish arms,
     ticks on the track, tooltip on the button shows the values.
  2. Opacity follows scrubbing and playback; no flicker at the cursor.
  3. Hover a ghost and a tick → time; click → cursor jumps there; orbit drag
     does not seek.
  4. Select a saved prediction trajectory → ghosts in cyan.
  5. Switch recordings (including one with a different torso height if
     available) and Replay ↔ Live → ghosts rebase and rebuild.
  6. Live (needs the solver/GPU; only if the GPU is free, see AGENTS.md "Host
     environment and GPU"): precalculate a few seconds, play from the start →
     ghosts appear only up to the cursor; after completion, scrubbing shows all;
     Reset clears them; a breach-stopped run still works.
  7. Top/Right views show (or, per the spike, omit) ghosts; limit tint still
     colours only the solid robot and its hover still works.
  8. Expanded timeline open: ticks drawn, zoom/pan keep them aligned.
  9. Toggle state survives a reload; a private window (no storage) still works.

## Working rules

- **Own worktree and branch** from visualizer main, e.g.
  `git worktree add ../tiago_mpc_visualizer-onion-skin -b ux/onion-skin main`.
- **Base:** check `git log --oneline main` first. The branch
  `live/history-format` (worktree `../tiago_mpc_visualizer-history`) is in
  progress and touches the Live history. If it is merged by the time you
  start, branch from the new main. If it is not merged and your work needs
  `src/live.js`/`src/live-history.js` beyond the small accessor above, keep the
  accessor minimal and note the expected conflict in your report rather than
  waiting.
- **Never touch the main checkout** `impl/tiago_mpc_visualizer` (Felix's viewer
  runs from it on port 8090): no edits, builds, `npm` runs or servers there.
- Run `npm ci` in your worktree if `node_modules` is missing.
- **Small commits** with clear messages (spike, ghost-arm module, keyframes,
  UI, docs). Do not merge into main; Felix decides.
- No GPU is needed except for the Live check (step 6). Do not run GPU work
  while an experiment holds the GPU locks.
- Keep the scope above. Note any improvement outside it in the report instead
  of building it.

## What to report back

- Branch, worktree path and commit list.
- Spike numbers (table of calls, triangles, frame time per method and count,
  Views tab on/off), chosen transparency method, whether ghosts are in the
  Top/Right views, screenshot paths.
- What was implemented, with any deviation from the decisions above and why.
- Test results (`npm test`, `npm run build`, Python tests if run) and which
  manual checks you did; say explicitly which you could not do (e.g. Live
  without a free GPU).
- Open issues, visual problems, and any conflict expected with
  `live/history-format`.
