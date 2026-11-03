# Presentation settings

`GET /api/presentation/settings` returns the saved preferences. `POST` replaces all fields and returns the same object:

```json
{"report_hz":20,"buffer_ms":200,"interpolate":false,"limit_tint":true,
 "ghost_start_opacity_percent":55,"ghost_end_opacity_percent":25,
 "limit_near_percent":90,"limit_at_position_rad":0.003,
 "limit_at_velocity_rad_s":0.01,"limit_at_torque_percent":0.2}
```

These are also the defaults when the local `visualizer.json` has no `presentation` key. The endpoint remains available when Live MPC is unavailable. POST requires same-origin JSON; invalid values return HTTP 400. `report_hz` must be finite within 1–120, `buffer_ms` finite within 0–10000, `interpolate` a boolean, `limit_tint` a boolean, both ghost opacity percentages within 0–100, `limit_near_percent` within 1–100, `limit_at_position_rad` within 0–0.1, `limit_at_velocity_rad_s` within 0–1 and `limit_at_torque_percent` within 0–10. A saved `presentation` key without any of these fields takes their defaults. Legacy `ghost_opacity_percent` migrates to start opacity and an end opacity scaled by 25/55; explicit new endpoints take precedence. Source, build, plotting and replay preferences are preserved when saving this key.

Timing fields accept explicit units, keeping canonical API values: reporting can
be `20 Hz` or `50 ms`, buffer can be `200 ms` or `0.2 s`, and ghost spacing can
be `0.5 s` or `2 Hz`. Signed timeline offsets accept time units such as
`-350 ms`; offsets have no frequency interpretation. Equivalent server echoes
preserve the typed spelling. Physical angular velocities and friction widths
remain in their own units.

**Settings dialog (UI tab):** no Save button. Checkboxes apply on change. Numeric fields apply on a committed change (change, blur, Enter) or after 700 ms without typing, never per keystroke. A value outside its range is marked on the field with the reason as tooltip; it is neither applied nor saved and the last valid value stays in effect. Valid changes are saved through the POST above after a 400 ms debounce, so a burst (including `report_hz`, whose backend update happens with the POST) sends only the last value, with at most one request in flight. A failed save marks the section heading ("! not saved", reason in the tooltip) while the setting stays applied; the next change retries.

`report_hz` controls the numerical worker's wall-clock reporting cadence, independently of TO, control and simulation frequencies. Reports retain every recorded plan, state, control sample and per-interval deadline measurement (states at the control events, see [recording](execution-api.md#recording)). A report is split into IPC packets of at most 256 records; splitting does not trigger an earlier report. History/latest notifications are published after the final packet. Progress statuses follow the configured cadence. Pause, cancel, inspection pause, settings/profile transitions, completion and errors flush pending records immediately. No reporting wait is added to numerical execution, and changing this preference does not reset the controller, history generation, settings version or warm start.

The report window bounds accumulation by elapsed wall time (at most one second at the minimum reporting frequency, observed at completed numerical boundaries). Existing finite-job state limits and Live pacing remain in force; no extra recording queue or spool is introduced. A slow numerical call can delay a report beyond its target deadline.

`buffer_ms` is a browser presentation target in **simulation-time milliseconds**, not a numerical integration delay or a wall-clock reporting interval. `interpolate` selects display interpolation; the default is sample hold. Both are consumed by the frontend and never change recorded values or plant/control calculations. Available buffered motion comes from received history bounds, not a progress status's computational `history_end_s`, which may lead a pending report.

`POST /api/presentation/settings/patch` accepts a partial object of these fields
and returns the complete saved preferences. It merges and validates atomically;
an invalid or unknown field changes nothing. Browsers save only edited fields
and poll the GET endpoint every second, in Live and Replay, so agent changes
update open controls and rendering. Pending local edits are preserved by field;
an old read cannot undo an in-flight save. See [agent controls](agent-api.md).

## Joint limit states

Limit use is always measured against the physical URDF limits (`joint_limits` of the scene, a recording or a Live segment header), never the MPC's tighter bounds, in Replay and Live alike. One definition serves the 3D tint, the Joints gauges and the Joint limit use plot: `gato_visualizer/plotting/limit_use.py`, mirrored for the browser by `src/limit-use.js`; `tests/fixtures/limit_use_cases.json` checks that both agree.

- **Utilisation:** position |q − centre| / half range; velocity |qd| / limit; torque |τ| / effort.
- **Distance to the bound,** in physical units, to the bound on the value's side: positive inside, negative beyond.
- **States:** *near* when utilisation × 100 ≥ `limit_near_percent` (default 90); *at* when |distance| ≤ the quantity's at-tolerance, on either side: `limit_at_position_rad` (0.003), `limit_at_velocity_rad_s` (0.01), `limit_at_torque_percent` of the effort limit (0.2); *beyond* when distance < −tolerance; otherwise *inside*. At and beyond take precedence over near.

The **UI** tab edits the four thresholds like the other numeric fields; a change applies at once to the tint, the gauges and the plots. Plot requests carry the browser's current values as `limit_settings` (see [the plot API](plot-api.md#source-selection-and-range-requests)); plotters read them through `limit_settings(raw)`.

`limit_tint` (default on) colours each robot link by its joint's worst state among the quantities the displayed sample has: near amber, at solid red, beyond red with a light edge outline. Hovering a tinted link lists each quantity that is not inside, worst first, for example `arm_right_4_joint position · at · 0.002 rad from lower bound`. It is browser-side display only.

Colours are CSS custom properties on `:root` in `src/style.css`: one per quantity (`--limit-position`, `--limit-velocity`, `--limit-torque`), shared by the gauges and the limit plot (the Numbers view uses only the state colours), and one per state (`--limit-near`, `--limit-at`, `--limit-beyond`, `--limit-beyond-edge`), shared with the tint.

The MPC's bounds remain visible where they are labelled as such: the scene and the Live segment header carry them as `mpc_bounds` when known (see [the Live API](live-api.md)); the gauge hover tooltips (shared by the Gauges and Numbers views of the Joints tab, shown at the pointer without the native delay) name them, and the recorded and predicted joint plots draw them dashed beside the URDF limits.

Live history HTTP pages accept `limit` from 1 to 2048 records; the API default remains 256. The browser requests 1024 to reduce serial network round trips. This read-only page limit is separate from the 256-record numerical IPC packet limit. Pages preserve every recorded value and cursor; the larger allowance does not establish a throughput guarantee.

## Plot growth during Live playback — Felix, 2026-10-22

Episode-time plots grow with the playback cursor rather than with fetched data. While Live playback runs at the growing edge (following the tip, buffering, or with history still arriving), each plot reveals its data only up to the playback cursor. Every frame, the browser moves each plot's x-window with one SVG transform and ends its clip at the cursor. Docked plots follow the timeline window; a sidebar plot whose aggregate window has an open end follows the cursor rather than the end of the last fetched data. Paused, scrubbed and Replay views show all available data.

This is presentation only. Plot data still come from Python jobs at the existing cadence: at most 5 Hz, with 80 ms job polling and full SVG rebuilds at most every 200 ms. The reveal never draws beyond the fetched samples and never interpolates new ones. When the data arrive within the playback buffer (`buffer_ms`), the plots are in step with the 3D view. When the data age exceeds it, as with long histories at the 200 ms default, a plot's line ends a little behind the cursor and keeps growing smoothly as data arrive, instead of jumping in 200 ms steps. A higher plot refresh rate for true real-time plots is deferred.

## Onion skin

The nested-arcs button beside the transport bar’s expand chevron, or **O**
while not typing, cycles onion skin: off, Live only, and (with comparison
tracks) all tracks in their colours. It starts off and
remembers the choice in browser storage. The button’s tooltip shows its mode,
current count and spacing.

Hover or focus the button to open its settings above the transport: **Fixed
spacing** starts enabled, **Spacing (s)** defaults to 0.5 seconds and
**Maximum arms** to 16 (integer 1–64). The
maximum counts temporal ghost arms across all displayed tracks; each track's
ordinary current arm/dot remains independent. Keyframes start at the aggregate
range's left edge and advance by exactly the requested spacing, stopping at
the maximum or the range's end. The cap retains the prefix; spacing never
widens and the final endpoint is included only if it falls on the grid. With
no aggregate bounds, use the whole session. For range
2–8 s, spacing 1 s and maximum 4, the keyframes are 2, 3, 4, 5 s. All-track
mode translates this same session grid through each track's offset and skips
times outside that track's recording. Turn **Fixed spacing** off to distribute
the maximum evenly over the full aggregate range, including both endpoints
(a maximum of one uses the start). In all-track mode the total cap is divided
between tracks, and each track's allocated count spans that range. Unsupported
times are omitted rather than stretching a shorter recording to fill it.
Changing the aggregate window updates
the ghosts; timeline zoom leaves them unchanged. These preferences are saved
in the browser. Arrow Up enters a panel from its button; Escape closes
it. The same hover interaction above Precalculate edits its duration.

Ghost arms show the recorded right arm and gripper only. Each keyframe snaps
to the sample at or before it; duplicate snapped samples draw once. Grey
denotes Live recorded motion, cyan a saved prediction trajectory, and comparison
arms use their track colours and recorded base/gripper positions.
Ghosts never interpolate, even when the solid robot’s playback does.

**Settings → UI** exposes **Ghost start opacity (%)** and **Ghost end opacity
(%)**, defaulting to 55% and 25%. Temporal ghosts interpolate linearly between
these values using their aligned timestamp within the aggregate range. The
fade stays fixed while scrubbing, and either endpoint may be stronger. Current
comparison arms use the start opacity. Temporal ghosts also darken subtly
through the aggregate range: their hue and saturation stay fixed while
lightness falls to 85% of the track colour's starting lightness. This cue is
independent of opacity and cursor position; ticks, labels and current comparison
arms retain their original track colour. Ghosts within 5 ms of the solid arm's
cursor are hidden to avoid overlap; hiding Live's solid arm also reveals its
coincident ghost. Compact and expanded timelines mark the same snapped
samples. Hover a ghost or tick for its recorded time; click to seek. Orbit
drags of 4 px or more do not seek. Track ticks use session time for positioning
and show the original recorded timestamp on hover.
Live reveals only samples up to the cursor during growing playback, just like
plots; paused history shows all retained states. A new generation clears the
keyframes. Ghost transforms rebase when the recording’s fixed joints change.

The temporal pool obeys the chosen maximum and shares the solid robot’s geometry while
owning its materials. Ghosts use a depth pre-pass and appear in the main,
Top and Right views. Current comparison and temporal pools share a scene-wide
far-to-near order, keeping each ghost's depth and colour passes adjacent for
every camera. This prevents one pool's depth pass from hiding another pool's
unfinished colour pass. The 2026-10-23 laptop spike (Firefox 158, reported AMD
Radeon R9 200 Series) measured 16.67 ms mean frame interval with eight ghosts
and Views visible, below the handoff’s 20 ms threshold; the auxiliary-view
increment was below 5 ms. These are browser frame intervals from one run,
including display pacing, rather than isolated GPU render times.

The optional `?onion-spike` dialog measures 8/16/24 arms with plain transparency
and a depth pre-pass, with Views hidden/visible for 5 seconds each while orbiting.
It provides a JSON report and four screenshot downloads. Its result is stored
under `motion-studio-onion-spike-result` for inspection; it does not override
the application’s qualified rendering defaults. Raw laptop measurements and the
implementation report stay in this worktree’s ignored `_expr_data/onion-skin/`.


## Session and tracks

The application opens directly into one browser-owned session, initially
the main track **Live** only unless a replay link was supplied. The bottom-bar
**Replay** toggle selects Replay mode within this same workspace. Each immutable replay
track samples at `session time − offset`, interpolating recorded samples and
holding the nearest endpoint outside its span. Main-track playback retains the
Live sample-hold/interpolation preference. In Live, the session span is the union
of the main track and visible comparison tracks and presentation reads Live.
In Replay mode, the span includes only visible replay tracks and Joints,
Episode and follow-cursor Solve read the first visible replay. There is no
arbitrary track focus selector. Pinned solves retain their own source.

Replay mode cancels any active Live calculation, including Manual/Automatic
precalculation, and blocks new simulation, preview and Live settings submissions.
Live settings stay visible but inert; target and start-pose editing are unavailable.
Live's lane, solid right arm, paths and temporal ghosts are hidden. The Live
track and its history, settings and arm-display choice are preserved.
Play, Pause, scrub and speed operate locally over the replay-only span; Reset
rewinds to its start. No end-of-playback preference extends Live in this mode.
A subtle amber outline surrounds the viewport and a top-centre
**Replay mode · Return to Live** button restores Live. This button and the
bottom-bar toggle return to the retained Live session, paused, with all replay
tracks, offsets and display choices intact. Hiding or removing all replays
leaves Replay mode selected with an empty playback span.

**Add track** in the expanded heading opens a searchable floating catalog,
with RAM freezes under Temporary, library recordings and uploads. Hover or
focus a recording for a preview of its actual end-effector path and recorded
duration; previews never calculate motion. File/folder upload actions use the
same recording library. Opening a catalog entry through Add track enters Replay
mode. A `?replay=<library path>` link also enters Replay mode and adds its
recording without replacing the main run; initial linked startup does not
subscribe to Live events or request an automatic preview.
Repeated `replay` parameters open multiple tracks in the same Replay-mode
session, with offset zero and editable names from their recording labels.
Each available recording loads once; late catalog arrivals join the retained
tracks. The first visible replay continues to supply the inspectors.
Replays align their start with the main track's
start (session zero when it is empty); freezes start at offset zero. Lanes show
an effective offset, including zero, plus eye, Arm/Dot and removal controls.
Live's enabled **Arm** toggle hides/restores only its solid right arm. The
ghost pool, paths, clock, calculation and inspections stay independent of it.
Hiding uses render/picking layers, so new ghost clones still appear while the
main arm is hidden. The rest of the robot remains visible in all views.
Replay names are editable and start at A, B, C; source names stay in tooltips.
The compact name field leaves more room for the time axis. The boxed remove
button sits in the rightmost action column, directly below Live's second
Freeze button beside its arm display control. A compact ruler sits directly above
the track rows. Aggregate barriers and outside shading span every track rail.
Dragging shifts a track without modifying recorded data; snapping within 6 px
uses zero, the cursor and track endpoints. Alt-drag disables snapping;
double-click resets the default offset. A lane's hover tooltip shows track
time, all settings differences and provenance badges; its label shows the first
two differences. Names distinguish tracks when the five-colour palette repeats.
The main lane carries Live timing intervals and breach marks. A count on the
collapsed timeline chevron keeps loaded tracks discoverable.

Comparison ghosts use the shared arm renderer in an independent uncapped
pre-pass pool, with one right arm per visible Arm track and its own recorded
fixed-joint base. Dot tracks show an end-effector marker. Opacity follows the
UI setting and dims outside the recorded span. Paths are solid in the track colour, thinner and dimmer
than Live's white trace. A different reference is dashed in the same colour.
Ghosts/dots appear in the main, Top and Right views; limit tint belongs only
to the solid robot. Frame, wall-clock and model-hash mismatches are marked
once on the lane. Run completeness remains recorded in provenance.

Play, Pause and scrub drive one session clock even without comparison tracks.
Speed ranges from 0.25× to 4× except while following a growing Live tip, when
the selector is disabled at 1×. With Stop checked the cursor can pass Live's
end and play to the session end, with Live's endpoint dimmed; with Continue,
Live waits for or extends computation at its tip and the tracks wait together.
Offsets and playback rate never change calculation, recording or frequencies.
The aggregate window is stored in session time; it and an unfitted zoom window
survive Live generation changes. When Live is unavailable, the application
still opens this session: its empty main lane and loaded comparison tracks
support local playback; calculation controls remain disabled.

Freeze for comparison stays in Live and is available with at least two states, no active job and
no dirty/pending settings. It exports the current run via `save_replay`, adds
it at offset zero and seeks the episode cursor to the run start. Breach-stopped
and cancelled runs are allowed. Freezes live only in
the server's RAM-backed runtime directory, survive page reloads, and are pruned
to eight oldest-first; server shutdown deletes them. The browser's track list,
offsets, mode and display choices are not persisted or written to config.
General focus switching, Keep and a past-run browser are later phases.
The contextual **Comparison** tab is available with at least two loaded
recorded runs. It has a separate extensible Python plot catalog, seeded with
tracking error, tracking summary and smoothness. Its **+** catalog includes a
generic recorded numeric channel plot and **Squared control effort**, with
cumulative integral and total-by-run views of ∫Σⱼτ_applied,j² dt in Nm²·s.
Duplicate a card to compare several signals or views. Effort uses recorded
applied torque and is a cost proxy, not mechanical work or energy.
Plots follow run names/colours/offsets and the shared session aggregate window,
preserving actual sample support and missing values. Catalog, preview and plot
calculations wait while Live is calculating, then refresh after it pauses or
finishes. Playback of retained data does not defer plots. An already submitted
CPU job can finish, but its stale response is ignored. See
[comparison plotting](plot-api.md#comparison-plots).

## Orientation goal glyphs

A reach with an [orientation goal](live-api.md#orientation-goal) draws two
gripper glyphs in the Live view: the goal at the target point in gold, and the
displayed arm's grasp frame in white. Each glyph has a 7 cm stem along the grasp
frame's approach axis, ending at the grasp point; a crossbar of ±4.5 cm along
the fingers' opening direction; and a knob at the bar's +y end, which shows a
half turn about the approach axis that the symmetric bar alone would hide. The
axes come from the full URDF: the grasp frame (`arm_right_grasp_joint`) sits
139 mm along `arm_right_tool_link`'s z without rotation, so the gripper
approaches along +z, and the finger joints move the fingertip pads along that
link's y (±51 mm open, ±16 mm closed). Glyphs draw through the arm.

The goal glyph follows the draft while the goal is edited. The grasp glyph is
read from the displayed robot model, so it follows every shown pose: recorded,
interpolated or a start pose being edited. The Live panel shows the displayed
state's **Orientation error** (degrees) next to Target distance while the
settings or the displayed run have a goal.

Task setup's **Orientation goal** checkbox switches the goal. Switching it on
starts from the goal last switched off on this page, otherwise from the grasp
frame's displayed orientation; it never moves the arm. With the goal on, **R**
selects the task gizmo's rotation about the goal's own axes, so the rings line
up with the gold glyph; **T** and **G** translate as before. The two orientation
weights under Costs are disabled while the goal is off.

A replay track whose recording has an orientation reference draws the same pair
in the track colour: the goal dashed, held from the latest reference sample, and
the recorded grasp frame solid, interpolated along the shortest rotation between
recorded states.

## IK preview and unreachable goals

The **IK preview** button sits beside the onion-skin button. It cycles **setup
only** (default), off and on, and remembers the choice in browser storage (in a
try/catch, like the onion skin). Its ghost arm, in the goal's gold at 30 %
opacity and never pickable, shows an inverse-kinematics pose that reaches the
displayed Live reach goal: position, plus the orientation goal when that is on;
without it, position only with the posture term toward the start pose. It is a
kinematic pose, not the MPC's predicted final pose, as the button's tooltip says.
**Setup only** shows it while Live is set up: not playing, with the displayed
state at the run start (t = 0, as for start-pose editing). It is not shown in
Replay mode, whose recordings have their own references, nor for a figure eight.

The same check colours the goal. A reach goal is reachable when some seed brings
the grasp frame within 2 mm and, with an orientation goal, 1° (the grasp
handle's thresholds), with every joint inside the MPC planning box (URDF range
less `joint_margin_rad`), the bounds the MPC itself plans within. Otherwise the
goal marker, its glyph and the gizmo anchor turn red (`0xff4b4b`), whatever the
preview setting, and Task setup reads "No exact IK solution: … mm, …° short",
the nearest pose found. Collisions are not checked.

Each seed runs `solveGraspIk` until it reaches the goal, converges, stalls or
improves the weighted error by less than 0.1 mm per call (at most 40 calls); a
seed ending within 2 cm is polished without the posture term at 5 mm damping.
Seeds: the last solution, the start pose, the displayed pose, the middle of the
bounds and two fixed spreads; the first seed that reaches the goal ends the
check. Unreachable therefore means no seed reached it, not a proof. While the goal, the
orientation goal or the start pose changes (gizmo or start-pose drags), a quick
check of the last solution and the start pose runs at most every 120 ms; 250 ms
after the last change the full check follows. `window.__motionStudio.ikPreview` and `.goalColor` expose the state.

## Viewport start-pose editing

Viewport editing needs no lock. The Joints tab's remembered lock, initially
locked, protects only its gauges and number fields; changing it does not cancel
a viewport selection or drag. Editing remains available only in Live, paused
at the run start, with the solid Live arm visible and its source connected.
The solid arm then shows
the start pose rather than a separate recorded pose; the white recorded Live
marker is hidden. Dragging previews the same seven native positions as the
Joints tab and hides the outdated prediction. Release applies the setting once;
Escape cancels the draft. Empty clicks deselect. Ordinary drags still orbit.

Click an arm link for its joint ring: rotation about that joint's local axis,
clamped to raw URDF limits. Joint 6 keeps its native negative axis. Click the
gripper or wireframe grasp sphere for the grasp handle, a pose: translation in
world axes (**T** or **G**, the default), which holds the handle's orientation,
or rotation rings in the handle's own axes (**R**), which hold its position. A
new selection starts with translation. While the grasp handle is selected these
keys belong to it, not to the task gizmo. Gizmo presses never move the camera:
`src/orbit-lock.js` disables orbiting before OrbitControls sees a press on a task
or editor handle, counts the tools' holds, and lets orbiting resume only after
that button is released, even when the drag ends early (for example when Live
turns busy and the handles become unavailable). Holding **Shift** during a translate
drag frees the orientation (position-only IK with the posture term, as before
the handle had an orientation): pressing or releasing it switches at once from
the current pose; while free the handle follows the orientation the arm reaches,
and after Shift it holds that orientation. Shift does nothing in a rotate drag.
A hint line at the bottom of the viewport names the selected handle's keys. Task, ring and grasp selections
exclude each other. A gizmo consumes its pointer interaction;
otherwise the nearest solid/ghost surface decides between selection and seeking.
Recorded comparison arms are never editable. Top/Right views show the same
handles; interaction remains in the main viewport.

The grasp sphere and dashed tether use text white (`0xe7edf5`); the sphere is
2 cm in radius, distinct from the recorded marker and gold task anchor. Both
controls have size 0.6. The selected handle carries a
[gripper glyph](#orientation-goal-glyphs) of the requested pose in the same tone;
the white Live grasp glyph is hidden meanwhile. A gap of at least 2 mm shows the
tether to the achieved point, and a gap of 2 mm or 1° shows the achieved pose as a
dashed glyph. An orientation gap of 1° or more also shows its angle, in degrees,
next to the handle. Releasing snaps the handle to the achieved pose, position and
orientation, the nearest reachable pose found from the warm start, without
claiming a global optimum. Amber outlines flag joints
outside the MPC planning box independently of the optional raw-limit tint.

Damped least squares on the handle's full pose runs once per animation frame:
a six-dimensional error, the position gap in metres and then the rotation vector
to the handle's orientation (world frame) in radians times 0.1 m, so 1 rad weighs
as much as 10 cm and 1° as 1.7 mm. Up to 16 iterations, 0.04 m damping, a 0.05 m
clamp on that error, 0.05 rad maximum joint step, 0.1 null-space posture gain, and
convergence below 1e-4 m of weighted error (0.1 mm and 1 mrad). The previous
solution seeds each frame; posture stays near the drag-start pose. Deterministic
backtracking and a task-only fallback prevent the damped posture term from
increasing the weighted error or blocking final convergence; a frame that cannot
reduce it stops as stalled. Each joint uses planning bounds when it began inside
them, raw bounds otherwise. Out of reach, the weighting decides the compromise
between position and orientation. There is no collision constraint.

Browser FK uses the full display URDF and the simulator's schema grasp origin.
A recorded-state comparison checks the world grasp position within 0.1 mm and
the frame identity. Missing/inconsistent data disables the grasp handle and
shows an IK badge with the reason in its tooltip; joint rings remain usable.
`window.__motionStudio.jointEdit` exposes the guard distance, draft, selection,
grasp tool, achieved/requested position and orientation, both gaps and projected
handles and rings for browser checks.
