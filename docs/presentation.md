# Presentation settings

`GET /api/presentation/settings` returns the saved preferences. `POST` replaces all four fields and returns the same object:

```json
{"report_hz":20,"buffer_ms":200,"interpolate":false,"limit_tint":true}
```

These are also the defaults when the local `visualizer.json` has no `presentation` key. The endpoint remains available when Live MPC is unavailable. POST requires same-origin JSON; invalid values return HTTP 400. `report_hz` must be finite within 1–120, `buffer_ms` finite within 0–10000, `interpolate` a boolean, and `limit_tint` a boolean. A saved `presentation` key without `limit_tint` takes the default. Source, build, plotting and replay preferences are preserved when saving this key.

`report_hz` controls the numerical worker's wall-clock reporting cadence, independently of TO, control and simulation frequencies. Reports retain every plan, state, control sample and per-interval deadline measurement. A report is split into IPC packets of at most 256 records; splitting does not trigger an earlier report. History/latest notifications are published after the final packet. Progress statuses follow the configured cadence. Pause, cancel, inspection pause, settings/profile transitions, completion and errors flush pending records immediately. No reporting wait is added to numerical execution, and changing this preference does not reset the controller, history generation, settings version or warm start.

The report window bounds accumulation by elapsed wall time (at most one second at the minimum reporting frequency, observed at completed numerical boundaries). Existing finite-job state limits and Live pacing remain in force; no extra recording queue or spool is introduced. A slow numerical call can delay a report beyond its target deadline.

`buffer_ms` is a browser presentation target in **simulation-time milliseconds**, not a numerical integration delay or a wall-clock reporting interval. `interpolate` selects display interpolation; the default is sample hold. Both are consumed by the frontend and never change recorded values or plant/control calculations. Available buffered motion comes from received history bounds, not a progress status's computational `history_end_s`, which may lead a pending report.

`limit_tint` (default on) tints each robot link by its joint's worst limit use among position (distance from the range centre over the half range), velocity and torque, using only quantities the displayed sample has and the limits resolved for the recording or Live state. Tint starts at 80 % use (`LIMIT_TINT_THRESHOLD` in `src/limit-tint.js`) and is fully red at 100 %; hovering a tinted link names the limit. It is browser-side display only.

Live history HTTP pages accept `limit` from 1 to 2048 records; the API default remains 256. The browser requests 1024 to reduce serial network round trips. This read-only page limit is separate from the 256-record numerical IPC packet limit. Pages preserve every recorded value and cursor; the larger allowance does not establish a throughput guarantee.

## Plot growth during Live playback — Felix, 2026-10-22

Episode-time plots grow with the playback cursor rather than with fetched data. While Live playback runs at the growing edge (following the tip, buffering, or with history still arriving), each plot reveals its data only up to the playback cursor. Every frame, the browser moves each plot's x-window with one SVG transform and ends its clip at the cursor. Docked plots follow the timeline window; a sidebar plot whose aggregate window has an open end follows the cursor rather than the end of the last fetched data. Paused, scrubbed and Replay views show all available data.

This is presentation only. Plot data still come from Python jobs at the existing cadence: at most 5 Hz, with 80 ms job polling and full SVG rebuilds at most every 200 ms. The reveal never draws beyond the fetched samples and never interpolates new ones. When the data arrive within the playback buffer (`buffer_ms`), the plots are in step with the 3D view. When the data age exceeds it, as with long histories at the 200 ms default, a plot's line ends a little behind the cursor and keeps growing smoothly as data arrive, instead of jumping in 200 ms steps. A higher plot refresh rate for true real-time plots is deferred.
