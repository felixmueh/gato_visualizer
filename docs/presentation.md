# Presentation settings

`GET /api/presentation/settings` returns the saved preferences. `POST` replaces all eight fields and returns the same object:

```json
{"report_hz":20,"buffer_ms":200,"interpolate":false,"limit_tint":true,
 "limit_near_percent":90,"limit_at_position_rad":0.003,
 "limit_at_velocity_rad_s":0.01,"limit_at_torque_percent":0.2}
```

These are also the defaults when the local `visualizer.json` has no `presentation` key. The endpoint remains available when Live MPC is unavailable. POST requires same-origin JSON; invalid values return HTTP 400. `report_hz` must be finite within 1–120, `buffer_ms` finite within 0–10000, `interpolate` a boolean, `limit_tint` a boolean, `limit_near_percent` within 1–100, `limit_at_position_rad` within 0–0.1, `limit_at_velocity_rad_s` within 0–1 and `limit_at_torque_percent` within 0–10. A saved `presentation` key without any of these fields takes their defaults. Source, build, plotting and replay preferences are preserved when saving this key.

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
