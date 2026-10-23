# Presentation settings

`GET /api/presentation/settings` returns the saved preferences. `POST` replaces all fields and returns the same object:

```json
{"report_hz":20,"buffer_ms":200,"interpolate":false,"limit_tint":true,
 "ghost_start_opacity_percent":55,"ghost_end_opacity_percent":25,
 "limit_near_percent":90,"limit_at_position_rad":0.003,
 "limit_at_velocity_rad_s":0.01,"limit_at_torque_percent":0.2}
```

These are also the defaults when the local `visualizer.json` has no `presentation` key. The endpoint remains available when Live MPC is unavailable. POST requires same-origin JSON; invalid values return HTTP 400. `report_hz` must be finite within 1–120, `buffer_ms` finite within 0–10000, `interpolate` a boolean, `limit_tint` a boolean, both ghost opacity percentages within 0–100, `limit_near_percent` within 1–100, `limit_at_position_rad` within 0–0.1, `limit_at_velocity_rad_s` within 0–1 and `limit_at_torque_percent` within 0–10. A saved `presentation` key without any of these fields takes their defaults. Legacy `ghost_opacity_percent` migrates to start opacity and an end opacity scaled by 25/55; explicit new endpoints take precedence. Source, build, plotting and replay preferences are preserved when saving this key.

**Settings dialog (UI tab):** no Save button. Checkboxes apply on change. Numeric fields apply on a committed change (change, blur, Enter) or after 700 ms without typing, never per keystroke. A value outside its range is marked on the field with the reason as tooltip; it is neither applied nor saved and the last valid value stays in effect. Valid changes are saved through the POST above after a 400 ms debounce, so a burst (including `report_hz`, whose backend update happens with the POST) sends only the last value, with at most one request in flight. A failed save marks the section heading ("! not saved", reason in the tooltip) while the setting stays applied; the next change retries.

`report_hz` controls the numerical worker's wall-clock reporting cadence, independently of TO, control and simulation frequencies. Reports retain every recorded plan, state, control sample and per-interval deadline measurement (states at the control events, see [recording](execution-api.md#recording)). A report is split into IPC packets of at most 256 records; splitting does not trigger an earlier report. History/latest notifications are published after the final packet. Progress statuses follow the configured cadence. Pause, cancel, inspection pause, settings/profile transitions, completion and errors flush pending records immediately. No reporting wait is added to numerical execution, and changing this preference does not reset the controller, history generation, settings version or warm start.

The report window bounds accumulation by elapsed wall time (at most one second at the minimum reporting frequency, observed at completed numerical boundaries). Existing finite-job state limits and Live pacing remain in force; no extra recording queue or spool is introduced. A slow numerical call can delay a report beyond its target deadline.

`buffer_ms` is a browser presentation target in **simulation-time milliseconds**, not a numerical integration delay or a wall-clock reporting interval. `interpolate` selects display interpolation; the default is sample hold. Both are consumed by the frontend and never change recorded values or plant/control calculations. Available buffered motion comes from received history bounds, not a progress status's computational `history_end_s`, which may lead a pending report.

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
comparison arms use the start opacity. Ghosts within 5 ms of the solid arm's
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
Top and Right views. The 2026-10-23 laptop spike (Firefox 158, reported AMD
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

The application opens directly into one browser-owned Live session, initially
the main track **Live** only. There is no Replay/Live mode switch. The
session time equals Live's recorded simulation time. Each immutable replay
track samples at `session time − offset`, interpolating recorded samples and
holding the nearest endpoint outside its span. Main-track playback retains the
Live sample-hold/interpolation preference. The session span is the union of
the main track and visible comparison tracks. Focus is main-only in this phase;
settings and the target gizmo always edit Live, while pinned solves retain
their own source.

**Add track** in the expanded heading opens a searchable floating catalog,
with RAM freezes under Temporary, library recordings and uploads. Hover or
focus a recording for a preview of its actual end-effector path and recorded
duration; previews never calculate motion. File/folder upload actions use the
same recording library. A `?replay=<library path>` link adds its recording as
a track without switching focus or replacing the main run.
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
Freeze button beside its arm display control. A compact ruler sits directly above the Live
row. Aggregate barriers and outside shading span every track rail.
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

Freeze for comparison is available with at least two states, no active job and
no dirty/pending settings. It exports the current run via `save_replay`, adds
it at offset zero and seeks the episode cursor to the run start. Breach-stopped
and cancelled runs are allowed. Freezes live only in
the server's RAM-backed runtime directory, survive page reloads, and are pruned
to eight oldest-first; server shutdown deletes them. The browser's track list,
offsets and display choices are not persisted or written to config. Focus
switching, Keep, comparison plots and a past-run browser are later phases.
