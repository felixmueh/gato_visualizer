# Plot API v1 implementation contract

Implemented contract shared by [plotting.md](plotting.md),
[inspection.md](inspection.md) and [the author workflow](plot-authoring.md).

## Plot specifications

Python emits JSON-compatible objects with `version: 1`, a `title`, and a `kind`
of `lines`, `bars`, `table`, `spans`, or `unavailable`. JavaScript only renders
the specification and provides presentation interactions.

```json
{
  "version": 1,
  "kind": "lines",
  "title": "Joint position",
  "x": {"identity": "episode_time", "label": "Episode time", "unit": "s", "clock": "live:4"},
  "y": {"label": "Position", "unit": "rad"},
  "series": [{"label": "Joint 1", "x": [0, 0.1], "y": [0.2, 0.3], "style": "line"}],
  "guides": [{"axis": "y", "value": 1.5, "label": "Upper bound"}],
  "notes": []
}
```

- `x.identity`: `episode_time`, `session_time`, `sqp_iteration`, `prediction_time`, `wall_time`,
  `numeric`, or `category`. `prediction_time` is a prediction-horizon offset.
- Series have `label`, matching `x`/`y` arrays, optional `color`, and `style`
  `line`, `step`, or `bar`. Numeric missing values use null, never NaN/Infinity.
  A `color` may be a CSS token with fallback, `var(--limit-torque, #b398f3)`.
  Optional `hover` holds one text (or null) per sample; the readout shows it
  instead of `label: value`, and display reduction keeps it aligned. The
  readout names the series whose curve is vertically closest to the pointer, in
  its colour, and a dot marks that sample; the tooltip lists every series. A
  `step` series holds a sample until the next one, and unrevealed samples are
  not read.
- Guides may set `style: "hard"` (solid, in the limit-beyond colour) instead
  of the default dashed line. `bands: [{axis: "y", start, end, tone, label?}]`
  shade a y interval across the plot beneath the data; `end: null` reaches the
  top. Tones are `near` (tinted) and `beyond` (hatched), using the CSS tokens
  `--limit-near` and `--limit-beyond` with fallbacks.
- `y.span: [low, high]` is the default automatic y range: data beyond it
  extend that side, data inside never shrink it. Viewer y limits and outlier
  clipping still apply.
- Bar series may provide Python-computed `bin_edges`: finite, strictly
  increasing boundaries with one more entry than `y`, so histogram widths are
  rendered from the actual bins rather than guessed from their centres.
- Table `rows`: `{label, value, unit, note}`; value may be numeric, text, or null.
  A `note` qualifies how its value reads (for example, computed over partial
  data): the app marks the row with * and shows the note on hover.
- Span `spans`: `{lane, start, end, label, color?}` with measured axis identity.
- Unavailable results carry `message` explaining the missing data/capability.
- `notes` are optional strings. Omit fields irrelevant to the chosen kind.
- Only episode-time specifications matching the active episode clock dock to
  the episode timeline. SQP indices and horizon offsets are not episode time.
- Python performs derived metrics, aggregation, histogram binning and any
  display reduction. Reduction preserves extrema/gaps; aggregates use full data.
  The host records it as `display_reduction: [{series, original, displayed}]`
  (not a note), which the app shows on hover. Plotters do not emit this field.
- The renderer reports a hovered bar's own bin edges, so histogram specs need
  no edge list in their notes.

The import-free `src/plot-renderer.js` exports
`renderPlot(container, spec, options)`. The author CLI embeds this same renderer
in offline HTML previews rather than maintaining a second plotting renderer.
Presentation options include `height` (SVG pixels), `notes: false` (the host
shows notes elsewhere), `legendTarget` (element receiving the unit/legend row),
and `yLimits: {min, max, clipOutliers}` (null sides are automatic; clipping fits
automatic sides to the 1st–99th percentile of visible samples). Standalone
previews keep notes inline. The renderer returns a handle with `update`,
`setView`, and `destroy`; options and handle behavior are exercised in
[plot-renderer.test.js](../src/plot-renderer.test.js).

## Plot inputs and definitions

The Episode catalog includes **MPC update frequency** (`episode.mpc_frequency`).
It plots the reciprocal simulation-time spacing of consecutive recorded MPC
requests, with a Requested TO guide for fixed-rate runs. As-fast-as-possible TO
has no requested-rate guide. The full request interval determines its rate even
when the analysis window clips that interval. Preview solves and duplicate
timestamps are excluded; missing request times are not reconstructed from
compensated plan origins or solver durations. Live status separately reports
achieved updates per wall-clock second.

`@plot_solve` and `@plot_episode` register ordinary callable Python functions.
Definitions carry stable `id`, `title`, optional description, input schemas, and
required/optional data as availability hints. They receive broad read-only
Solve/Episode views with `.raw` and common accessors; requirements do not limit
what retained fields can be read. `.solver` is absent/None in web/replay views.

Input schemas are keyed by parameter name and use `type` values `joint`,
`boolean`, `number`, or `choice`, plus `default`, `label`, optional `unit`,
`description`, `min`, `max`, and `choices`. Joint values are stable joint names.
Choices may be `{value, label}` objects (from `Choice(..., labels=...)`). A
choice's `disabled_when: {option: {other_input: value}}` disables that option
in the settings dialog while the other input has that value; evaluation
rejects the combination.
The SDK exports `Joint`, `Boolean`, `Number`, `Choice`, `EpisodeView`,
`SolveView` and `InspectionContext`; see [plot-authoring.md](plot-authoring.md).

## Source, selection and range requests

```json
{
  "source": {"kind": "live", "generation": 4},
  "context": "solve",
  "selection": {"solve_seq": 12, "iteration": null},
  "range": {"mode": "entire", "cursor_s": 1.2, "start_s": 0, "end_s": 2},
  "plots": [{"instance_id": "card-1", "plot_id": "builtin.joint_position", "inputs": {}}],
  "pixels": 800,
  "limit_settings": {"limit_near_percent": 90, "limit_at_position_rad": 0.003,
                     "limit_at_velocity_rad_s": 0.01, "limit_at_torque_percent": 0.2}
}
```

- `limit_settings` is optional: the browser's current [joint limit
  states](presentation.md#joint-limit-states) thresholds. Omitted fields take
  the defaults; values outside their ranges are rejected. The plot service
  validates them, includes them in the cache key, and places them in the
  view's `raw['limit_settings']`, which plotters read through
  `gato_visualizer.plotting.limit_use.limit_settings(raw)`. They travel with
  the request rather than the backend config so a change applies at once,
  before the debounced settings save.

- Source is Live generation, `{kind: "replay", id, trajectory_index}`, or
  `{kind: "inspection", id}` for a completed standalone Run again result.
  Inspection sources have no Episode; use them only for the Solve inspector.
- Single-source `context` is `episode` or `solve`. Comparison requests use the
  collection contract described under [Comparison plots](#comparison-plots).
- Null/omitted `solve_seq` follows the episode cursor's recorded association.
  Explicit identities may be strings or integers; previews use `preview:<seq>`
  to distinguish them from controller solves. Keep identities opaque in the UI.
- Null/omitted `iteration` selects the final result; integer indices select
  only actual recorded SQP data. Seed index 0 requires a recorded seed.
- Episode range modes: `entire`, `window` (optional `start_s`/`end_s`; an
  omitted bound is unbounded, so an open end follows growing history),
  `through_cursor`, and `visible` (both bounds required), with cursor/window
  coordinates in the active episode's existing UI clock. The browser sends
  `entire` or `window` from the timeline's aggregate window.
- Live clock values remain task/simulation times, including nonzero segment
  starts. Replay values use elapsed times matching its existing playback clock;
  retain original time origin/basis in context metadata and raw records.
- Each card has an independent instance ID/configuration. Sidebar and timeline
  placements refer to that same instance, not duplicate computations.

## HTTP jobs

- `GET /api/plots/catalog`: cached definition catalog, no expensive evaluation.
- `POST /api/plots/catalog`: request above without plots; async source-aware
  availability/inspection metadata through the same job mechanism.
- `POST /api/plots/evaluate`: evaluate the requested batch of card instances.
- Both POST actions return HTTP 202 `{job_id, state}` immediately.
- `GET /api/plots/jobs/<id>` returns pending/running/complete/superseded/failed.

Completed responses include `results: [{instance_id, spec, error?}]`, `catalog`,
`registry_revision`, and `context` describing `joint_names`, episode `clock` and
`bounds`, and `selected_solve` when available. Solve metadata includes `seq`,
`sim_time_s`, `origin`, `iterations: [{index, status, has_prediction}]`, final
`has_prediction`, `can_continue`, and explanatory capability reasons. Do not
create a fake per-iteration prediction or advertise exact resumption.

For binary inspection results, `selected_prediction` contains only the requested
snapshot and `selected_iteration` echoes its index (null means final). Entries
in `iterations` remain scalar summaries, including index 0 for Seed. The full
raw trace stays in a lazy read-only `SolveView.iteration_trace` handle in the
CPU process. Context `provenance` records initialization, requested cap/budget,
actual count/stop reason, original solve/source and actual implementation/model.
A request with `selection.iteration_paths: k` additionally returns a top-level
`iteration_paths` chunk of end-effector paths for the 3D view (see
[Fresh inspection service](inspection.md#fresh-inspection-service-and-binary-data-flow)).
See [the inspection HTTP contract](inspection.md#fresh-inspection-http-contract).

Preview solves have a separate append-only inspection store, written after
presentation and identified by Live generation. They remain available to a
pinned inspector after newer previews arrive, without becoming executed plans
or changing the authoritative episode history.

One bounded CPU plotting worker handles computation apart from the numerical
worker and HTTP threads. Coalesce obsolete pending jobs and discard stale UI
completions. Cache repeated requests/data by source, committed revision, scope,
selection and inputs. Live uses committed file/cursor descriptors and an
incremental reader, not browser uploads or full file rescans per card/frame.
Keep errors local to their plot/module so other plots and Replay stay usable.

## Plotter settings

- Bundled `<visualizer>/plotters/` always loads.
- External directory defaults to `<selected tiago_mpc>/_visualizer`.
- `GET /api/plots/settings` returns `directory`, nullable `override`,
  `default_directory`, `bundled_directory`, `registry_revision`, and `errors`.
- `POST /api/plots/settings` accepts `{directory: null | path}`; save top-level
  `plotters_directory` in the visualizer config while retaining other fields.
- `POST /api/plots/reload` reloads Python plotters without restarting MPC.
- Reload/settings mutations report the updated registry state; missing external
  directories leave bundled plots available.
- Frontend reuses the Source/Build floating window for the directory field and
  explicit reload action. Applying a solver source remains a separate action.

## Author verification

The SDK check CLI uses the same definitions, views, validator and rendering
specifications as the app. It runs on deterministic small fixtures without a
GPU/server, reports structural and numerical test failures with nonzero exit,
and can save JSON and standalone HTML using the shared renderer. Standard
plotters include meaningful expected-value assertions as author examples.

## Comparison plots

`@plot_comparison` is additive to Episode/Solve and uses the same registry,
typed inputs, PlotSpec renderer, asynchronous CPU jobs and plot directories.
It receives an immutable `ComparisonView` containing ordered `ComparisonRun`
objects: `key`, `label`, hex `color`, `source`, `offset_s`, `episode` (the
existing broad `EpisodeView`) and optional `error`. No view attaches a live
solver. Native episode clocks remain unchanged; `run.channel(path)` returns
recorded samples on session seconds (`episode time + offset_s`).

`ComparisonView.context` holds the host range/cursor and session clock.
`bounds` is the union within that window; `common_bounds` the intersection of
recorded spans (null without overlap); `run_bounds(run)` clips one span.
`available_runs` excludes unavailable/empty episodes. The `.episode` retains
full captured data so a metric can use valid bracketing samples at a window
boundary; plot authors apply the range explicitly. `requires=('runs',)` means
at least two available episodes; other requirements need two runs with that data.

The typed `Channel()` input becomes a normal choice populated from recorded
numeric scalar/vector leaves in timestamped `states`, `torque_samples`,
`controls`, `intervals` and `plans`. Examples: `states.q.0`,
`states.sensor.temperature_c`, `torque_samples.torque_nm.2`,
`intervals.solve_wall_s`, `plans.stats.wall_s`. Booleans, strings, prediction
matrices and arbitrary solver objects are excluded. `channels` contains
`{value,label,unit,runs}`; known units also appear in choice labels. New numeric
record fields need no dedicated plot. Absent per-run values remain null.

The existing catalog/evaluate endpoints accept this additional envelope:

```json
{
  "context":"comparison",
  "sources":[
    {"key":"track-1","label":"Default","color":"#b48cff","offset_s":0,
     "source":{"kind":"replay","id":"study/default","revision":"retained-revision"}},
    {"key":"track-2","label":"PD","color":"#6fa8ff","offset_s":0,
     "source":{"kind":"live","generation":4}}
  ],
  "alignment":{"mode":"session_time"},
  "range":{"mode":"window","start_s":0,"end_s":24},
  "client_id":"comparison-sidebar",
  "plots":[{"instance_id":"card-1","plot_id":"comparison.channel","inputs":{"channel":"states.q.0"}}]
}
```

Each wrapper has exactly these five fields; keys are unique, offsets finite,
colours `#rrggbb`, and there are at most 16 sources. Zero/one sources support
retained-card empty states. Selectors are validated Replay catalog IDs or a
committed Live generation; inspections/prediction horizons are not episodes.
`alignment` is optional and only accepts `session_time`; task phase is not
inferred from run duration. The range is in session seconds. No browser array
or path uploads are accepted. Every submission snapshots the actual committed
Live prefix; a replaced generation supersedes its comparison jobs.

The existing jobs/results/catalog envelope remains. Comparison `context`
contains `clock: "session:<client_id>"`, `bounds`, `common_bounds`, integer
`usable_runs`, `joint_names`, `channels`, and `runs`. Each run reports full
`bounds`, `analysis_bounds`, `episode_available`, `coverage_s`, `error`, original
`time_origin_s`/`time_basis`, frame and retained provenance/outcome when present.
No outcome is inferred. Cache identity includes source revisions/committed
prefixes, offsets, labels/colours, range and inputs. The CPU replay cache is LRU
bounded to 16 entries and approximately 256 MiB of retained Python objects;
one larger recording can be evaluated but is not retained in that cache.

Bundled definitions:

- `comparison.tracking_error`: own-reference error overlays in mm.
- `comparison.tracking_summary`: RMS/peak error bars over the common interval.
  RMS integrates the square of piecewise-linear scalar error over valid time,
  rather than weighting by sample count.
- `comparison.smoothness`: command total variation per covered duration
  (Euclidean norm of consecutive recorded torque jumps, Nm/s), acceleration RMS
  from finite differences of recorded velocity (rad/s²), or speed RMS
  (piecewise-linear recorded velocity, rad/s). Velocity is never inferred from q.
- `comparison.channel`: the selected recorded channel on its own sample clock
  plus offset; controls/torques use steps, intervals end with null gaps.
- `comparison.control_effort`: cumulative ∫Σⱼτ_applied,j² dt curves (default
  `view='cumulative'`) or per-run integral bars (`view='total'`), in **Nm²·s**.
  Uses only `torque_samples`/`controls` with recorded `torque_nm`, over the
  common selected episode interval. Applied commands use zero-order hold,
  including the last command only up to the episode's final recorded state.
  Missing/nonfinite/incomplete vectors interrupt support until another valid
  applied sample arrives. The curve has gaps and resumes its **observed**
  cumulative integral; partial totals report valid duration, not zero-filled
  effort. A preceding recorded command can support the start of a clipped
  window. There is no predicted/requested/state-torque substitution. This is
  an effort cost proxy, not mechanical work or energy.

Time overlays use `x.identity='session_time'` with an explicit session clock.
Metric hover details retain valid duration and full recorded span: a shared
prefix does not qualify an early-stopped task as successful. Missing telemetry
remains unavailable per run while other runs can render. Sampling/filtering and
recorded command-versus-actuator meanings still matter. No outside-span endpoint
hold is added to plots or metrics. Single-source requests are unchanged.

Comparison replay reads normalize the complete recorded execution and all saved
plans' timed scalar statistics. They do not materialize prediction-horizon
geometry or perform FK for every saved prediction: those remain on the ordinary
Episode/Solve inspection path, and the original NPZ data is untouched. Channel
paths are discovered once per immutable replay; Live discovery adds only newly
committed records. Comparison contexts reuse immutable source records rather
than freezing/copying the full recording for each selection or channel change.
Cache-size accounting uses a conservative numeric-vector fast path; the same
16-entry/256-MiB bounds and 30-second CPU job timeout remain in force.
