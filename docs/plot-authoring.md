# Writing and checking a Python plot

The lightweight `gato_visualizer.plotting` package uses the Python standard
library. It imports no GATO, CUDA, robot model or scientific plotting library.
Run it from this checkout, or add this checkout to your editor's Python path.
Use your ordinary development interpreter for offline checks; do not install
packages into the selected MPC interpreter.

Copy [the typed starter](../examples/plotters/joint_offset.py) into the selected
MPC checkout's `_visualizer/` directory. The visualizer always loads its own
`plotters/` too. Settings can override the project directory. Explicit reload
reimports definitions; a broken file or duplicate ID is reported without hiding
other files. IDs must be unique across both directories. Plot files are trusted
local Python code and can import their own dependencies; they are not sandboxed.

Use `@plot_episode` or `@plot_solve`, with a stable `id`, `title`, optional
`description`, and `inputs`. The decorator returns the original function.
`Joint`, `Boolean`, `Number`, and `Choice` describe configurable inputs; the
function's ordinary defaults should match the metadata defaults so direct calls
behave the same way as host evaluation. Joint controls carry stable native names
such as `arm_right_1_joint`; `joint_index(name, data.joint_names)` resolves them.
Number bounds are `minimum`/`maximum` constructor arguments and serialize as
`min`/`max`. `requires` and `optional` are dotted retained-data availability hints,
not field access restrictions. A required-data absence marks a catalog item
unavailable; direct function access remains broad.

A function receives `EpisodeView` or `SolveView` and returns a `PlotSpec` dict.
Use `lines`, `series`, `table`, and `unavailable`, or build the documented
[version 1 specification](plot-api.md). Series gaps are `None`, never NaN or
Infinity. Bars may carry explicit `bin_edges` with one more value than y samples,
finite and strictly increasing. Do all numerical derivation, histogram binning
and aggregation in Python. Specs contain data and plain text, without arbitrary
HTML, JavaScript or callbacks. The renderer handles presentation and cursors.

`EpisodeView.states`, `.plans`, `.intervals`, `.time_s`, `.q`, and `.qd` follow
the host-selected analysis range. Interval measurements that intersect the range
remain complete measurements; duration coverage clips to the selected bounds.
`.bounds` uses episode time, including nonzero segment starts. `.raw` retains the
whole captured episode and additional experiment fields. Normalized records use
`states`, `plans`, `intervals`, `torque_samples`, and optional `joint_limits`.
`joint_limits` are the recorded limits (Live: URDF; Live histories before
2026-10-22: the MPC's bounds); the physical scene/URDF limits are
`scene_joint_limits`, and the MPC bounds, when known, `mpc_bounds`.
`gato_visualizer.plotting.limit_use` computes limit use against the physical
limits (`episode.joint_limit_use` is its example); `limit_settings(raw)` gives
the app's current near/at thresholds.
States use `sim_time_s`, native `q`, `qd`/`qd_rad_s`, and optional `ee_xyz`,
`target_xyz`, and `torque_nm`. Velocity and torque are never synthesized from q.

`SolveView.prediction`, `.horizon_time_s`, `.q`, `.qd`, and `.torque_nm` describe
the selected iteration's recorded prediction. `.stats`, `.diagnostics`,
`.iterations`, and `.raw` expose retained diagnostics and extra fields. Final is
selected by `context.sqp_iteration=None`; seed uses `0` (or `"seed"`), and actual
SQP iterations use their recorded indices. If the selected iteration has no
snapshot, `.prediction` is `None`: final data is never substituted.

`InspectionContext` carries `episode_cursor_s`, `analysis_range` (`entire`,
`window`, `through_cursor`, `visible`), `visible_window` (for `window`, either
bound may be `None` = unbounded), `selected_solve_id`,
`sqp_iteration`, and `clock`. These are host selection, separate from plot user
inputs. Registry evaluation attaches the host clock to episode-time axes so the
UI can check timeline compatibility. Prediction horizon offsets and SQP indices
are distinct axes and cannot dock as episode time.

`.solver` defaults to `None` in both views, including ordinary web and Replay
contexts. A local prototype may explicitly attach its actual runtime solver.
This handle is mutable, does not freeze native/CUDA state, and is not a saved
optimizer checkpoint. It must not be mistaken for a historical selected Solve.
Per-SQP trajectories and exact continuation remain unavailable when upstream did
not record/expose them.

## Offline checks

These commands do not start a server or MPC. They evaluate the same functions
used by the application, validate the spec, and save JSON plus a standalone HTML
preview embedding the application's exact `src/plot-renderer.js`.

```bash
python -m gato_visualizer.plotting.check --fixture episode \
  --plot episode.timing --expect 'series.0.y.0=20'
python -m gato_visualizer.plotting.check examples/plotters/joint_offset.py \
  --fixture episode --plot example.joint_offset \
  --inputs '{"joint":"arm_right_1_joint","scale":2}' \
  --expect 'series.0.y.2=0.4'
python -m gato_visualizer.plotting.check --fixture solve --plot solve.prediction_joint \
  --inputs '{"quantity":"torque_nm"}' --expect 'series.0.y=[2,4,null]'
python -m gato_visualizer.plotting.check --fixture solve --iteration 1 \
  --plot solve.prediction_joint --expect 'kind="unavailable"'
python -m unittest discover -s tests -p test_plotting.py -v
```

Outputs default to ignored `_expr_data/plot-check/`. Use `--output` for another
artifact directory, `--no-preview` for JSON only, and `--renderer` to explicitly
select the same application renderer from another checkout. No network is
required to open the HTML preview. The CLI exits nonzero for import, evaluation,
structural validation or explicit expectation failures. A `--expect` assertion
uses a dotted dict/list path and a JSON value; numbers allow small floating point
roundoff. `--fixture episode-missing` and `solve-missing` remove optional
telemetry to exercise unavailable states.

The fixtures start at episode time 10 s: joint 1 positions are 0, .1, .2, .3 rad;
tracking errors are 300, 200, 100, 0 mm; wall times are 20, 60, 10 ms. Their median
is 20 ms and interpolated p95 is 56 ms. The final prediction uses horizon offsets
0, .1, .2 s, joint 1 torque 2, 4 Nm on nonterminal controls, and recorded SQP merit
7, 3 at indices 1, 2. Iterations have no trajectory snapshots deliberately.

Structural validation does not establish numerical correctness. Follow the
standard plot checks in [test_plotting.py](../tests/test_plotting.py): call the
same definition with known inputs, then assert meaningful independently known
values, units, range behavior and missing-data behavior. Open the shared HTML
preview to inspect labels, clipping and layout when changing presentation.

Fresh Run again results can supply `SolveView.iteration_trace`, also available
at `raw['iteration_trace']`. It is an optional read-only binary trace handle,
not a JSON list or a solver checkpoint. `prediction(index)` decodes one native
q/v/u snapshot; `xu` exposes the read-only raw GPU-coordinate NumPy array for
explicit local numerical prototypes, with shape `(K+1, 1, 21*N-7)`. Prefer the
ordinary selected-iteration accessors for plots. The host keeps this handle
local to the CPU plot process and never materializes it through `freeze()` or
HTTP. Its metadata records the original solve and actual inspection source.
