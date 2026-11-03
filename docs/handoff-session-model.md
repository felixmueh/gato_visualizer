# Handoff: session model, first deliverable (tracks next to Live, freeze for comparison)

For the coding agent implementing it. Written 2026-10-23 against visualizer
main `c7c5cce`, with Felix's decisions of the same day. Background, alternatives
and the reasoning behind the decisions (read only if a decision below is
unclear; it predates `c7c5cce`, so its remarks on history files and hard links
are superseded by this handoff):
[the motion-comparison brainstorm](/home/felix/_Uni/MasterThesis/agent-reading/visualizer-motion-comparison/brainstorm.md).
The onion-skin feature ([its handoff](handoff-onion-skin.md), branch
`ux/onion-skin`) builds `src/ghost-arm.js`; this work reuses that module.

## Goal

Felix wants to compare several motions: Live runs with different parameters,
and Live against saved experiment replays. The visualizer gets one **session**
holding the Live run as the **main track** plus any number of loaded
**tracks**, all placed on one **session time** axis, played together, each
drawn as a colour-coded ghost arm (or an end-effector dot) with its tool path.
This handoff defines the whole model, then scopes the first deliverable that
establishes it in code. Later phases (focus switching, removing Replay mode,
keeping freezes on disk, comparison plots) must fit without rework.

**Design principle (Felix, 2026-10-23): session time always exists**, not only
when several tracks are loaded; with one track it is simply that track's time.
The same holds for the transport, the timeline and focus: **one code path
whether one or many tracks are loaded**, no special case for "multiple". In
Live mode, Live alone is a session with one track.

## The session model (complete; later phases build on it)

### Terms

Existing terms (`UBIQUITOUS_LANGUAGE.md`) keep their meaning: MPC episode,
Solve, Prediction, Episode cursor, Pinned solve, Continuation, Simulation time,
Aggregate window, Segment header, Control events. New terms (proposed; add
them to `UBIQUITOUS_LANGUAGE.md` in a new "Session and tracks" table, marked
"Felix, 2026-10-23"):

- **Session:** the set of tracks shown together, with one session time, one
  transport, one focus.
- **Track:** one recorded MPC episode placed in the session: its own recorded
  clock (its **track time**) plus an **offset**, colour, visibility and
  display mode. A track never changes its recorded data. Avoid: clip, layer
  (use "lane" only for its timeline row).
- **Main track:** the Live run (current generation). Always present in Live
  mode, offset fixed at 0, the only editable and growing track. Empty when
  Live is idle or unavailable.
- **Session time:** the shared playback axis. It equals the main track's
  simulation time; for any track, track time = session time − offset. Avoid:
  global time, wall time.
- **Offset:** a track's placement on session time, in seconds. Presentation
  only; never written into the recording.
- **Focused track:** the track whose data the solid robot, Joints, limit tint,
  prediction line, Episode and Solve show. Avoid: selected track, active track
  ("selected" belongs to the selected solve).
- **Lane:** a track's row under the expanded timeline's ruler.
- **Freeze:** a temporary replay `.npz` exported from the current Live run, in
  RAM, loaded as a track. **Keep** (later phase) writes a freeze to disk.
  Avoid: snapshot, temporary replay (in UI text).
- **Ghost arm** (from onion skin): a translucent right arm at a recorded state
  other than the solid robot's. A track's ghost arm uses the track colour.
- **End-effector dot:** the alternative per-track display: a marker in the
  track colour at the track's end-effector position.

### State

All session state lives in the browser; the backend only serves recordings.

- **Session** (`src/session.js`, pure, no three.js or DOM):
  `{ tracks: [Track], focusedId, aggregate: {start, end} in session time,
  playback rate }`. The main track is `tracks[0]` with `id: 'live'`.
- **Track:** `{ id, kind: 'live' | 'replay', source, label, color, offset_s,
  defaultOffset: 'zero' | 'align-start', visible, display: 'arm' | 'dot',
  span: [start, end] in track time, timeBasis, endEffectorFrame, settings }`.
  `source` is the plot-API source (`{kind: 'live', generation}` or
  `{kind: 'replay', id, revision}`); a freeze is a replay whose catalog item
  has `source: 'freeze'`, so it needs no third kind. `settings` is the
  segment header's `context.settings` (Live) or `provenance.live.settings`
  (freeze; absent for experiment replays) and feeds the label.
- **Derived:** session span = union of visible tracks' `[start + offset,
  end + offset]` (and the main track's span); track time of the cursor;
  whether the cursor is outside a track's span.

### What follows focus (later phase; the code must route through focus now)

Follows focus: the solid robot and its limit tint, Joints, the prediction line,
Episode plots and aggregates, Solve follow-cursor, the scene's reference and
target, the timing bands on the ruler, `Fit trajectory`. Does not follow
focus: the left sidebar settings and the target gizmo (always edit Live),
a pinned Solve (already keeps its own source, `pinnedSource` in
`src/plot-inspection.js`). In the first deliverable the focused track is
always the main track, but every one of these reads goes through
`session.focused` (see "Code to touch").

### How Replay mode maps onto it (later phase)

Today's Replay mode becomes "main track idle, one replay track focused". The
recording selector becomes "Add track"; `?replay=<name>` loads that replay as
the focused track. Replay mode disappears once focus works and the start path
without Live (no compiled N, no GPU) still shows replays. In the first
deliverable Replay mode stays as it is (see Scope).

## Decisions to implement (Felix, 2026-10-23)

1. Live is always the main track, offset 0. Every other track aligns to it.
2. The solid arm follows focus, together with Joints, limit tint, prediction,
   Episode and Solve; settings and the target gizmo always edit Live (focus
   switching is a later phase).
3. Replay mode disappears later, after focus works and the start path without
   Live is kept.
4. **Freeze = export the current Live run to a replay `.npz` directly**, so
   library replays and freezes share one code path as tracks. The file is in
   RAM (the runtime directory), never written to disk unless the user keeps
   it (later phase).
5. Up to **8 temporary freezes** in RAM; beyond that the oldest unkept one is
   dropped. A kept freeze is written to disk into the library (later phase).
6. **Freezing rewinds the episode cursor to the run's start**, so the next
   settings edit calculates from the same state and time (Automatic mode
   calculates from the displayed state: `change()` freezes
   `displayedAnchor()` in `src/live.js`).
7. Default offsets: **0 for freezes** (same simulation clock), **aligned
   starts for library replays** (first sample at the main track's start, or at
   session 0 when the main track is empty).
8. **The aggregate window lives in session time** and persists across
   generation changes; session time always exists (see the principle above).
9. **One transport.** Speed control everywhere except while following a
   growing Live tip (forced 1×). Stop/Continue keeps its Live meaning
   (unchecked: continue the simulation at the end). Looping only without Live
   (Replay mode, unchanged for now).
10. A track past its end (or before its start) **holds its last (first) pose,
    dimmed**, and its lane shows where its span ends.
11. **One ghost arm per loaded track, no fixed cap.** Each track has its own
    display setting: **ghost arm or end-effector dot** (toggle on the lane).
12. A browser of past Live runs ("branches") is much later, not v1.
13. The segment header carries the full settings (done in `c7c5cce`).

## Defaults I had to choose (Felix may override)

- **Scope boundary:** tracks exist in Live mode only. Switching to Replay mode
  hides them (state retained, shown again on return). Replay mode is moved
  onto the session in its later phase, not now.
- **Main-track playback past its end:** the session clock runs over the
  session span. With Continue (Stop unchecked) the existing Live behaviour
  wins: at the main track's tip playback waits for or extends the calculation,
  and the other tracks wait too. With Stop checked, playback continues to the
  session end while the main track holds its last state, dimmed like any
  track past its end.
- **Ghost interpolation:** non-main tracks interpolate between samples, as
  Replay does today (`sampleTrajectory` in `src/playback.js`); the main track
  keeps Live's sample hold / interpolation preference.
- **Track palette** (avoid cyan prediction, white executed trace, orange
  reference, pin red, red/yellow timing, amber/red limit tint and the onion
  greys): violet `0xb48cff`, blue `0x6fa8ff`, green `0x6fdc8c`, pink
  `0xff7eb6`, tan `0xc8a27a`, assigned in order and reused after five with
  the lane letter as the distinguishing mark. Check contrast in the main,
  Top and Right views; adjust by eye, keep them as named constants.
- **Unfocused tracks' paths:** solid line in the track colour, thinner and at
  lower opacity than the main track's white trace. No predictions for
  unfocused tracks in v1. A track's reference is drawn only if it differs
  from the main track's, dashed in the track colour.
- **Dimming:** ghost opacity 0.35 inside its span, 0.15 outside; dot likewise.
  Named constants.
- **Labels:** a letter (B, C, …; A is the main track) plus the catalog name for
  replays or the freeze time (`B · 14:32:05`). The lane and tooltip list the
  settings that differ from the main track's current segment header (first
  two on the lane, all in the tooltip), recomputed when the main track's
  segment changes. Experiment replays without `provenance.live.settings` show
  their `provenance.params` differences when present, otherwise none.
- **Freeze availability:** enabled when the main track has at least two states
  and no job is active, and the settings are not being edited (not dirty or
  pending). A breach-stopped or cancelled run can be frozen; its provenance
  records `complete: false` and the lane tooltip says "incomplete run".
- **Freeze lifetime:** owned by the server run, like Run again results: kept in
  `<runtime>/freezes/p<pid>/`, surviving page reloads, deleted at shutdown and
  as leftovers of ended servers at start. Removing a track from the session
  does not delete its freeze; the catalog keeps it until pruned.
- **Freeze size limits:** the replay format's limits apply (200 000 samples,
  10 000 predictions, 64 MiB compressed; `replay_format.py`). A run beyond
  them is refused with a message naming the limit; never drop data silently.
- **Snapping** while dragging a lane: to session 0, the cursor, the main
  track's start and end, other tracks' starts and ends, within 6 px (the
  timeline's `snapSeconds` rule). Alt-drag disables snapping. Double-click
  resets to the default offset. The lane header shows the offset as an
  editable value (`+0.350 s`).
- **Track removal** from the lane (×), no confirmation (nothing is deleted).
- **Persistence:** the track list, offsets and display modes are not persisted
  across page reloads in v1 (freezes remain in the catalog to re-add).

## Scope of the first deliverable

**(a) Library replays as tracks next to Live.**

- "Add track" (button in the expanded timeline heading; a menu listing ready
  catalog items, freezes first under "Temporary") adds a replay as a track
  with aligned starts, the next palette colour, display "arm", visible.
- Each visible track shows a ghost arm (or a dot) in its colour, sampled at
  `session time − offset`, and its tool path. Outside its span it holds the
  first/last pose, dimmed.
- Lanes under the expanded timeline's ruler, one per track including the main
  track (whose lane carries today's timing bands and breach marks): colour
  chip, label, offset value, eye (visible), arm/dot toggle, × (remove). The
  clip spans the track's shifted time; drag it to change the offset.
- The ruler, zoom and Fit cover the session span. The playhead is session
  time; the readout shows session time, and the hovered lane's tooltip shows
  that track's time.
- Play/Pause/scrub of the Live transport drive session time; tracks play along.
  A speed selector in the Live transport (0.25–4×, as Replay's) is disabled
  and shows 1× while following a growing Live tip.
- The aggregate window is stored in session time and no longer resets when the
  Live generation changes (zoom likewise keeps its window unless fitted).
- A small count badge on the timeline expand chevron when tracks are loaded,
  so tracks remain discoverable while the timeline is collapsed.

**(b) Freeze for comparison.**

- A button in the Live transport next to Precalculate ("Freeze for
  comparison", icon), enabled per the defaults above. It asks the backend to
  export the current generation to an in-RAM `.npz`, adds the result as a
  track at offset 0, then seeks the episode cursor to the run's start.
- The freeze appears in the replay catalog (source `freeze`), so it can also
  be opened in Replay mode and re-added after removal.

**Not in scope (do not build):** focus switching to non-main tracks; removing
Replay mode; Keep (writing a freeze to disk); comparison plots; predictions of
unfocused tracks; onion skin for tracks; breach stops for non-main tracks;
persisting the session; URL encoding of tracks; a browser of past Live runs.

## Freeze: what the export contains and drops

Export with `tiago_mpc`'s own `experiments/replay.py` `save_replay` (AGENTS.md:
one exporter, on the producer side; import it from the selected checkout,
which `live_mpc.import_tiago` already puts on `sys.path`; do not write a
second NPZ writer and do not change `tiago_mpc`). Read the current
generation's JSONL as `HistoryStore` pages do (open the file under the store
lock, read the committed prefix outside it; `execution_bridge.py`).

Include (cheap, all supported by `save_replay`):

- `time_s`, `q`, `qd_rad_s` from state records; `torque_nm` (applied, after
  clipping) at the state times; `time_basis="simulation"`.
- `end_effector_frame` and `joint_limits` from the segment header;
  `fixed_joints` from the Live scene, so the freeze shows the same torso pose.
- The reference: the states' `target_xyz` with `reference_time_s` = state
  times. `save_replay` accepts only `base_footprint` or `torso_lift_link`
  frames; **verify** which frame the Live world coordinates are in
  (`server.py` derives the full robot's root link) before choosing.
- Every controller plan (`type: "plan"` in the history; previews live in a
  separate store and are excluded): `origin_time_s` = plan `sim_time_s`,
  knot `time_s`, `q`, `qd_rad_s`, `torque_nm`/`torque_time_s` (predicted), and
  `stats` (finite JSON scalars only).
- `provenance = {params: problem_configuration, live: {settings, source,
  simulator_identity, solver_profile, model_identity, arrival rule
  (position_tol_m, speed_l1_tol_rad_s), generation, complete, frozen_at,
  breaches}}`, all taken from the segment header and the breach records.
- `label`: the freeze label (`Freeze B · 14:32:05`).

Dropped, accepted for v1 (record this in `docs/replay-format.md`): timing
intervals (no timing bands or timing plots for a freeze), command records
(`plan_seq`, `planned_torque_nm`, plan exhaustion; only the applied torque
series remains), per-state `distance_m`/`arrived` (recomputable later from
`target_xyz` and the arrival rule in provenance), breach stops in playback
(breaches are only in provenance), and Run again inputs
(`constraint_bounds_native`, `reference_native`, `initial_state`; Run again
reports unavailable for a freeze, as for any replay without them).

## Code to touch and patterns to follow

### Base and reuse

- `ux/onion-skin` (14 commits, not on main at `c7c5cce`) adds
  `src/ghost-arm.js` (`createGhostArms({robot, scene, max, method, layer})` →
  `set(poses)`, `setBase()`, `update(camera)`, `pick(raycaster)`, `dispose()`,
  `snapshot`), the `beforeRender` hook in `src/auxiliary-views.js`, and the
  depth pre-pass method chosen by its laptop spike. Reuse it; never copy it.
  Use a **separate pool** for tracks (`method: 'prepass'`), one pose per
  visible arm-mode track with `pose.color`, `pose.opacity`.
- Needed changes to `ghost-arm.js` (small, keep onion skin's behaviour):
  - The pool rejects `max > 24`. Allow an uncapped pool for tracks (decision
    11), e.g. `max: Infinity` accepted; onion skin keeps 24.
  - **Per-pose base.** `setBase()` uses one base matrix (the solid arm's
    parent) for the whole pool. A replay with different `fixed_joints` (for
    example torso height) needs its own base. Add an optional `pose.base`
    (`Matrix4`, world transform of `arm_right_1_joint`'s parent) and have the
    backend's motion payload supply it (below). If that is not straightforward,
    refuse such tracks with a lane badge whose tooltip names the differing
    joints, and report it.
  - Call the track pool's `update(camera)` wherever onion skin's sort runs
    (main render, `beforeRender` of the auxiliary views).

### Backend

- **`replay_library.py`:** a third catalog root `freeze` =
  `runtime_directory("freezes", owner_tag())` (`runtime_files.py`), scanned
  like ingest and uploads, ids `freeze-<hash>`, items `source: "freeze"`,
  listed before the others. Delete leftover `freezes/p<pid>` directories of
  ended servers at start (`ended_owner`), the own directory at shutdown, and
  the oldest freeze beyond 8 after each new one.
- **Do not route track loading through `ReplayLibrary.scene()`.** It sets
  `current`, and its listeners delete Run again results of other recordings
  (`c7c5cce`, `ba2f8f1`). Loading a track must not count as switching the
  current replay.
- **Light motion payload:** `GET /api/replays/motion?id=<catalog id>` →
  `{id, revision, label, time_basis, end_effector_frame, fixed_joints,
  joint_limits, model_warning, time_s, q, ee_xyz, reference_time_s,
  reference_xyz, arm_base (4×4 row-major), plan_count, provenance}` for the
  recorded trajectory only. Factor it out of `server.py` `replay_scene`, which
  also computes FK for every saved plan (2400 for a figure eight) and is too
  heavy for tracks. Cache per `(id, revision)` (small LRU). Validate like
  `/api/replays/scene` (exact query keys, catalog id only, never a path).
- **Freeze:** `POST /api/live/freeze {generation}` (same-origin JSON check as
  `/api/live/command`) → `{accepted, item}`; HTTP 409 when the generation is
  not current ("History changed") or a job is active. Put the conversion
  (history records → `save_replay` arguments) in a new pure module, e.g.
  `live_freeze.py`, testable on JSONL fixtures without a GPU; wire it in
  `server.py` / `execution_bridge.py` (`ProcessLiveService.history_store`).
  `save_replay` writes atomically into the freeze directory; then rescan the
  catalog and return the new item.
- Plot sources need nothing new: a freeze is `{kind: "replay", id}`.

### Frontend

- **`src/session.js` (new, pure):** the session state above; `addTrack`,
  `removeTrack`, `setOffset`, `defaultOffset`, `sessionSpan`, `trackTime`,
  `outsideSpan`, `snapOffset(candidates, px)`, `settingsDiff(main, other)`,
  palette assignment, `focused` (always the main track for now). Unit-test it
  like `src/live-history.test.js`.
- **Session clock:** today `src/live.js` owns `createHistoryClock`
  (`src/live-execution.js`) and clamps it to the Live history's bounds. Make
  the clock a session clock: bounds = session span, a playback rate, and the
  existing follow/buffer/growing behaviour applying at the main track's tip.
  Keep the Live-specific decisions (breach stop, extension at the end, Waiting,
  compute-limited) in `live.js`, as hooks the session clock calls, rather than
  moving them into the session. Generalise `createHistoryClock` (rate, wider
  bounds) instead of writing a second clock; its tests in
  `src/live-execution.test.js` must keep passing.
- **`src/track-scene.js` (new):** per track the ghost pose (from the shared
  track pool) or a dot (`makeMarker` pattern in `src/main.js`), and its path
  (`createPathLine` in `src/path-lines.js`, ≤ 5000 points like
  `displayPath`). Sampling via `sampleTrajectory` (`src/playback.js`). Group the
  objects under one `THREE.Group` so `visibleSceneBounds` and Fit can include
  them later.
- **`src/expanded-timeline.js`:** lanes below `#timeline-inspector`, clip drag
  with pointer capture (follow the existing `drag` handling), snapping, Alt to
  disable, double-click reset, the offset field, eye / arm-dot / × controls.
  `update(next)` gets the session (span, tracks, cursor in session time) with
  a stable session identity: identity changes no longer reset the aggregate
  window or zoom. Keep painting cached by `paintKey`.
- **`src/main.js`:** create the session after `setupLive`; in `animate`,
  sample tracks at session time and update the track scene; replace the Live
  branches that will follow focus (`getSource`, `getView`,
  `updateExpandedTimeline`, `onSeek`, `renderInspectedPrediction`,
  `fitTaskPoints`, joint telemetry) with reads through `session.focused`
  (which is the main track for now, so behaviour is unchanged). Add the
  track-related fields to `window.__motionStudio` (`session`: tracks, offsets,
  span, cursor, sampled track times, ghost/dot counts).
- **`src/live.js`:** the freeze button and its enablement; after a successful
  freeze, seek to `history.bounds[0]` (the segment start) through the existing
  seek path so `displayedAnchor()` is the start state; expose the current
  segment header (`segmentOf` already exists) for the label diff.
- **`src/workbench-shell.js`:** the freeze button and the speed selector in
  `#live-controls`, the Add-track button and the lanes container in the
  expanded timeline shell, an icon in the `icons` table in `src/main.js`.
- **Docs:** `docs/presentation.md` (session, tracks, lanes, defaults),
  `docs/replay-format.md` (freeze root, motion endpoint, what a freeze
  contains and drops), `docs/live-api.md` (freeze command),
  `docs/execution-api.md` "Runtime files" (`freezes/`), `docs/architecture.md`
  code map, `README.md` Workspace, `UBIQUITOUS_LANGUAGE.md` (terms above), and
  a dated "Session model — Felix, 2026-10-23" paragraph in `AGENTS.md`
  summarising the decisions, including that Live history playback may now run
  at other speeds except while following the growing tip (this changes the
  current "History playback follows recorded simulation timestamps at 1x").

## AGENTS.md rules that apply

- **What the display claims:** an offset track is not at its recorded time;
  show the offset at the lane (the value itself) and the track time in the
  lane tooltip, once. Mark mismatches once, with a lane badge whose tooltip
  gives the reason: a different end-effector frame (old replays default to the
  flange, Live uses the grasp frame, so tool paths are not comparable), a
  `wall` time basis against simulation time, a model hash warning, an
  incomplete run. A ghost is recorded motion; a replay's saved predictions are
  not tracks.
- **UI design: let the design carry the information:** colour chips, the
  offset value, dimming and lane ends carry state; no permanent explanatory
  text; secondary details in tooltips; match the dark blue palette.
- **Defaults are never hidden:** the offset field shows the value in effect
  (also 0); the speed selector shows 1× when forced; the display toggle shows
  arm or dot.
- **Avoid excessive disk writes:** freezes stay in the runtime directory; no
  track state is written to disk; no config rewrite for track changes.
- **Visualizer timing ownership:** session time is the main track's
  simulation time; offsets and speed are presentation only; nothing here
  changes calculation, rates or recorded data.
- **Relationship to tiago_mpc:** import `save_replay` unchanged; no edits in
  `tiago_mpc`.
- **GPU:** nothing here needs the GPU except producing Live runs for the manual
  checks; never run them while an experiment holds the GPU locks.

## Later phases (not in scope; listed so the model fits them)

1. **Focus** (needs this deliverable): clicking a lane, chip or ghost focuses
   a track; the solid robot, Joints, limit tint, prediction (plans fetched one
   at a time for the focused replay), Episode and Solve follow; the aggregate
   window converts session time to the focused track's time; docked plots
   shift by its offset. Backend: a `SourceReader` cache of a few sources
   instead of one per kind (`plot_sources.py`), and the "current replay"
   notion of `ReplayLibrary` redefined as "focused track" so Run again
   retention stays correct.
2. **Replay mode removed** (needs focus): the library becomes Add track; one
   transport; looping only with an idle main track; `?replay=` loads a
   focused track; the start path without Live kept.
3. **Keep** (needs this deliverable): write a freeze to disk as an upload
   (`ReplayLibrary.upload` path, `_expr_data/uploads/live/…`), listed as a
   normal recording; optionally export to the shared ingest directory.
   Revisit what a freeze drops (timing intervals, commands, breaches) if the
   loss matters for kept runs.
4. **Comparison plots** (needs focus and the multi-source cache): one-signal
   episode-time plots overlaid across visible tracks with offsets and track
   colours; tables with a column per track; later dedicated multi-source
   plotters with explicit resampling.
5. **Load a track's settings into Live**, read-only settings view with the
   differences for a focused freeze (needs focus).
6. **Browser of past Live runs** (much later, decision 12); `HistoryStore.kept`
   is the existing hook.

## Tests and checks

- **Unit tests** (`node --test`, `src/*.test.js`): session state (add/remove,
  palette order and reuse, default offsets for both kinds, session span with
  hidden tracks, track time conversion, outside-span detection, snapping with
  and without Alt, settings diff on two segment headers), session clock (rate,
  bounds beyond the main track's end, forced 1× while following a growing tip,
  existing follow/buffer behaviour unchanged), lane geometry and hit testing
  in `expanded-timeline.test.js`, aggregate window and zoom kept across a
  generation change.
- **Python tests** (`python_bin="$(python3 scripts/launch_python.py)"`, then
  `"$python_bin" -m unittest discover -s tests -v`): freeze conversion on a
  JSONL fixture with a segment header (fields, frames, plan origins, preview
  plans excluded, provenance, limits refused with a clear error, complete flag),
  freeze directory ownership, pruning beyond 8 and leftover cleanup, catalog
  listing of the freeze root, the motion endpoint (shape, caching, rejected
  queries, no change of `ReplayLibrary.current`), the freeze endpoint (409 on
  stale generation and active job). Round-trip: a frozen file loads with
  `replay_format.load_replay` and through `/api/replays/scene`.
- `npm test` and `npm run build` pass.
- **Manual browser checklist** (your own server on a free port, e.g.
  `./scripts/start.sh --host 0.0.0.0 --port 8091` from your worktree, with
  its own `TIAGO_VISUALIZER_RUNTIME_DIR` if Felix's server runs at the same
  time):
  1. Live idle: expanded timeline shows the main lane only; nothing else
     changed (one code path).
  2. Add two library replays: ghost arms in two colours, paths, lanes with
     aligned starts; arm/dot toggle; eye hides; × removes.
  3. Drag a lane: offset value updates, snapping to 0/cursor/clip edges,
     Alt-drag free, double-click resets; the ghost moves in time accordingly.
  4. Play/scrub: all tracks move together; past a track's end it holds,
     dimmed, and its lane shows the end; speed 0.5× and 2× work while not
     following a tip; forced 1× while following.
  5. A replay with the flange frame or a wall time basis shows its badge.
  6. Precalculate a reach (GPU; only if free), Freeze: a new track at offset 0
     in the next colour, cursor back at the start; change a setting
     (Automatic): the new run starts from the same state and time; the lane
     label lists the changed setting.
  7. Freeze nine times: the catalog keeps 8 freezes; the oldest is gone.
     Reload the page: freezes still listed. Restart the server: they are gone.
  8. Aggregate window and zoom survive a settings change (new generation).
  9. Top/Right views show the ghosts and dots; limit tint only on the solid
     robot; onion skin still works and does not mix with track ghosts.
  10. Replay mode: tracks hidden; back to Live: tracks shown again.

## Working rules

- **Own worktree and branch** from visualizer main, e.g.
  `git worktree add ../tiago_mpc_visualizer-session -b ux/session-model main`.
- **Base:** check `git log --oneline main` first. The history-format and
  runtime-files changes are on main (`e8a0442` … `c7c5cce`). If `ux/onion-skin`
  is merged, branch from main. If it is not, branch from `ux/onion-skin` and
  say so in your report (it will need a rebase after the merge); do not copy
  `ghost-arm.js`. Keep your changes to `ghost-arm.js` in their own commits so
  they can be reviewed against onion skin.
- **Never touch the main checkout** `impl/tiago_mpc_visualizer` (Felix's viewer
  runs from it on port 8090): no edits, builds, `npm` runs or servers there.
  Run `npm ci` in your worktree if `node_modules` is missing.
- **Small commits** with clear messages (session state, clock, ghost-arm
  changes, motion endpoint, lanes, track scene, freeze backend, freeze button,
  docs). Do not merge into main; Felix decides.
- Keep the scope. Note improvements outside it in the report instead of
  building them.

## What to report back

- Branch, worktree path, base (main or `ux/onion-skin`) and commit list.
- What was implemented, and any deviation from the decisions or defaults
  above with the reason (especially the session clock, the per-pose ghost base
  and the freeze reference frame).
- The freeze's measured export time and file size for a 10 s reach and a 10 s
  figure eight at the defaults, and the largest run that fits the format.
- Test results (`npm test`, `npm run build`, Python suite) and which manual
  checks you did; say explicitly which you could not do (for example the
  Live and freeze checks without a free GPU).
- Open issues, visual problems, and anything that would make a later phase
  (focus, Replay removal, Keep, comparison plots) harder than planned.
