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

- `x.identity`: `episode_time`, `sqp_iteration`, `prediction_time`, `wall_time`,
  `numeric`, or `category`. `prediction_time` is a prediction-horizon offset.
- Series have `label`, matching `x`/`y` arrays, optional `color`, and `style`
  `line`, `step`, or `bar`. Numeric missing values use null, never NaN/Infinity.
- Bar series may provide Python-computed `bin_edges`: finite, strictly
  increasing boundaries with one more entry than `y`, so histogram widths are
  rendered from the actual bins rather than guessed from their centres.
- Table `rows`: `{label, value, unit, note}`; value may be numeric, text, or null.
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

`@plot_solve` and `@plot_episode` register ordinary callable Python functions.
Definitions carry stable `id`, `title`, optional description, input schemas, and
required/optional data as availability hints. They receive broad read-only
Solve/Episode views with `.raw` and common accessors; requirements do not limit
what retained fields can be read. `.solver` is absent/None in web/replay views.

Input schemas are keyed by parameter name and use `type` values `joint`,
`boolean`, `number`, or `choice`, plus `default`, `label`, optional `unit`,
`description`, `min`, `max`, and `choices`. Joint values are stable joint names.
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
  "pixels": 800
}
```

- Source is Live generation, `{kind: "replay", id, trajectory_index}`, or
  `{kind: "inspection", id}` for a completed standalone Run again result.
  Inspection sources have no Episode; use them only for the Solve inspector.
- `context` is `episode` or `solve`.
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
