# TIAGo MPC visualizer

A local browser application for live reaching/tracking MPC and saved trajectory replay.
Orbit, pan and zoom around the full canonical TIAGo; change solver settings,
inspect its predicted tool path, then play the simulated closed-loop motion.

## Run

**Temporary default (2026-10-22):** `tiago_mpc` main is being restructured. Until the
visualizer follows it, the default source is `../tiago_mpc_vis_baseline`, a frozen
`tiago_mpc` worktree on branch `vis-baseline` (main at `72ca2b0`). Select another
checkout with `--mpc-root`, `TIAGO_MPC_ROOT` or Settings › Backend.

Use a prepared sibling `../tiago_mpc_vis_baseline` checkout with canonical models, fetched
LFS meshes and GATO dependencies. A saved legacy reaching recording is optional;
without one, the viewer opens at the starting pose, ready for replay uploads.
The launcher uses `../tiago_mpc_vis_baseline/venv-host` on the desktop. `TIAGO_PYTHON` can
select another prepared interpreter; inside the existing container the launcher
falls back to the checkout's `.venv`. It does not install Python packages there.

The viewer reuses compatible GATO binaries in the selected checkout’s
`.cache/gato`. Prepare missing horizon modules explicitly during setup or use
the gear button (**Settings › Backend**):

```bash
cd /workspace/tiago_mpc_visualizer
./scripts/start.sh --prebuild
./scripts/start.sh --host 0.0.0.0 --port 8090
```

Open **http://192.168.178.82:8090** from the laptop on the local network (or use
your desktop's current address). Port 8080 is used by the older container viewer.
Omit `--host 0.0.0.0` to listen only on the desktop itself. No cloud service,
laptop Python environment, or internet connection is needed after setup.

**Direct replay links:** `http://192.168.178.82:8090/?replay=reaching/study/run_017`
opens Replay with that library path (shown in the library without `.npz`;
uploads use an `uploads/` prefix) selected and loaded. Selecting a recording
keeps the address bar on its link, so the current URL is always shareable;
**Copy link** beside the path copies it. The default recording and Live carry
no parameter. A missing or unreadable path shows the library's usual message
and error list, and the link opens the recording once it appears (for example
when its export finishes). Links match library entries only, never file paths.

The launcher installs locked frontend dependencies if absent, builds the
frontend, and serves the application, robot assets and API from one process.
Numerical solving respects the experiment locks and reports GPU busy while
another experiment owns them. Explicit compilation is CPU work: it keeps Live
running, takes no GPU experiment lock, and uses half the available CPU cores
while respecting CPU affinity/quota. Replay and camera controls remain available.

Use another MPC checkout, interpreter, or replay recording with:

```bash
TIAGO_MPC_ROOT=/workspace/tiago_mpc-other ./scripts/start.sh --port 8090
TIAGO_PYTHON=/path/to/python ./scripts/start.sh --port 8090
./scripts/start.sh --port 8090 --run-dir /absolute/path/to/recording
```

The gear button opens a movable **Settings** window with two tabs, remembered per
browser. **Backend** holds what affects computation or backend processes: the
simulator source, solver profiles, binary builds and the Python plotting
directory. **UI** holds presentation preferences (reporting, playback buffer,
interpolation, joint-limit tint); new presentation settings appear there.
They have no Save button: each change applies at once and is saved automatically.
Invalid numbers are marked (the tooltip gives the reason) and neither applied nor saved.

In **Backend**, enter a `tiago_mpc` checkout or worktree path; Check source shows
its branch, commit/dirty state and compatible knot counts. The Python interpreter
and binary cache fields hold path templates. The literal token `<checkout>`
stands for the selected checkout and is substituted when the path is used, so a
saved template such as `<checkout>/.venv/bin/python` stays valid when the checkout
changes (`~` is expanded too; absolute paths without the token keep working;
any other `<…>` token is an error). The defaults are
`<checkout>/venv-host/bin/python` when that interpreter exists, else
`<checkout>/.venv/bin/python`, and `<checkout>/.cache/gato`. The resolved
absolute path is the field's tooltip; a template that cannot be resolved is marked
invalid, with the reason as tooltip. An edited template is a highlighted override
with a reset arrow that restores the default. A value equal to the default is sent
as "follow the checkout" and not saved; overrides are saved as typed, templates
included. `POST /api/source/defaults` with `{"mpc_root": …}` (optionally
`python`/`cache` templates) returns the default templates, their resolution and
the resolution of the entered templates. Existing configs with absolute paths are
not rewritten. The previous visualizer cache can be
reused by entering `/workspace/tiago_mpc_visualizer/.cache/gato` as the cache
override; it is never copied into the selected project cache. Compatibility checks include the current
URDF/grasp frame, generated/native GATO sources, toolchain, Python ABI, GPU
architecture, and extension load/embedded identity. Discovery includes built N
values beyond 16/32/64/128 and does not rely on manifest.N alone.

**Build selected N** accepts additional integer counts, reuses current binaries,
and compiles missing/stale ones with progress and retained logs. The explicit
rebuild checkbox preserves prior binary bytes under `_expr_data/source-builds/`.
Changing normal Live settings or selecting N never compiles. **Apply and restart
backend** saves the selected paths, closes the numerical worker, restarts in the
selected interpreter, and reloads all source-bound models/renderers/replay
bindings. This starts a fresh Live session while retaining compatible controls,
saved replays and disk history. Restart may wait for an active solve or timing
window to release the GPU safely.

Startup source precedence is `--mpc-root` > `TIAGO_MPC_ROOT` > saved selection >
`../tiago_mpc_vis_baseline`; `TIAGO_PYTHON` and `GATO_CACHE_DIR` override their saved paths.
Selecting another source with CLI/environment chooses that project's default
environment/cache unless explicitly overridden. Apply replaces those launch-time
overrides for its restart. No packages are installed in the selected environment.

Server configuration lives in [`visualizer.json`](visualizer.json). Its
`ingest_directory` defaults to the shared `../_expr_data/ingest`; directory
paths resolve relative to the config file. Select another file with
`./scripts/start.sh --config /path/to/visualizer.json`. Startup prints the
resolved ingest directory. This is `impl/_expr_data/ingest` on the host and
`/workspace/_expr_data/ingest` in the container. This config does not change the MPC settings.
The Replay library discovers portable `.npz` files recursively there and accepts
file/folder uploads from the laptop into `_expr_data/uploads`. Select a recording
to load it; file changes update the library without replacing current playback.
The producer-side exporter is `tiago_mpc/experiments/tools.py`;
see the [format and export cookbook](docs/replay-format.md).

## Workspace

The viewport fills the window above a single compact playback bar. Use its top
left and top right buttons to hide or restore either sidebar. The right sidebar
has **Views** (synchronized Top and Right cameras), **Episode** (recorded motion
and scoped aggregate statistics), **Solve** (a selected optimizer invocation
and its recorded SQP iterations), and **Joints** (native
position, velocity and actuator torque). Auxiliary views show the same robot and
playback time and suspend rendering when their panel is hidden.

Drag the inner edge of either sidebar to resize it (220-560 px, always leaving
the viewport at least 360 px); double-click the edge to restore the default
width. Widths are remembered per browser. Below 960 px the sidebars are
overlays and keep their fixed width.

The playback bar contains Play/Pause, Reset, the timeline and **Stop**. Checked
Stop ends playback at the recording's end. With Manual/Automatic Live calculation,
unchecking it continues simulation from the tip; in Replay, unchecking it loops
the recording. On Play runs continuously until paused. Live also
provides the calculation mode, a precalculation icon and a duration in seconds.
Task position inputs remain available below the controller settings; direct
viewport manipulation avoids scrolling to them during normal use.

Changed Live settings show a circular-arrow button on their left. Click it to
restore the original default supplied by the MPC configuration or active task.
The horizon reset restores the default knot interval at the currently selected
N. Resetting a setting follows the same preview/Automatic calculation behavior
as editing it; task pose also has a reset for position and rotation.

Use the chevron at the right of the bottom bar to expand the timestamp ruler
above the controls. Scroll to zoom around the pointer; Alt-drag or middle-drag
to pan; click or drag to scrub; Shift-drag to select the aggregate window. Arrow keys seek, Shift+arrows seek by 1 ms,
+/− zoom, and Fit (or 0) shows the full recording; the ruler's **?** lists these
gestures on hover. Colored intervals retain the
same MPC/simulation over-budget meanings as the compact timeline.

Use **+** in Episode or Solve to open the searchable plot catalog; each entry
previews the plot with default inputs on the active source. Add several
plots without closing it, configure each instance independently, duplicate them,
and drag their titles to reorder. **Show on timeline**, or dragging a compatible
Episode plot to the expanded timeline (outlined as a drop zone while dragging), docks it above the ruler. Drag it out to
remove that placement. Docked graphs share the episode window and scrub cursor;
their title, unit and legend share one row, and y labels sit inside the plot.
Aggregates and prediction-horizon/SQP plots stay in the sidebar. Hover a plot
title for its description and notes. Drag a plot's bottom edge to resize it
(sidebar and timeline heights are separate), and drag the strip's top edge to
change how much height the timeline rows may take. ⚙ also sets each plot's
y-axis bottom/top (a value or automatic) and can clip outliers from automatic
sides. Hover a histogram bar for its bin edges.

Episode plots and aggregates use the **aggregate window**, chosen on the
expanded timeline: Shift-drag selects one, and its bracket handles adjust either
bound. Dragging a bound onto its data edge (or double-clicking it) leaves that
side unbounded; an unbounded end keeps following new Live data. The reset arrow,
Esc on the timeline, or × on the Episode header's window chip clears it to the
entire episode. The window is independent of zoom and the playback cursor and
resets with the recording or Live generation, like zoom. Sidebar episode-time
plots fit the window; docked plots retain the timeline zoom window and cursor. Drag in a plot to scrub; Y scales hold headroom and expand smoothly as
new values arrive. The Solve inspector follows the recorded
plan association. **Pin solve** retains its identity and SQP selection with a
muted red indicator. Its separate SQP strip selects recorded iterations without
moving the episode clock. **Run again** offers a finite SQP cap and optional
wall budget, creates a separate pinned result with genuine iteration snapshots,
and preserves the original episode. Initialization is explicitly cold; **Stop**
terminates only that inspection worker. Older data without captured inputs
disables it; its tooltip gives the reason. Short badges mark what changes how a
plan reads (**final only**, **no path**, **cold start**, an unusual cursor
association); hover one for its reason. Aggregate rows marked * carry a note on
hover. See [Solve inspection](docs/inspection.md).

Bundled Python plotters cover timing/budgets, iteration counts, tracking error,
joint motion and bounds, timing histograms, episode aggregates, prediction joint
profiles and recorded iteration diagnostics. Missing values remain unavailable.
Custom `@plot_episode` and `@plot_solve` functions load from
`<selected tiago_mpc>/_visualizer` by default. Change the directory and reload
plotters in Settings › Backend without restarting MPC. See the
[plot authoring guide](docs/plot-authoring.md) for typed views, the starter and
offline numerical checks with shared-renderer HTML previews.

## Solver profiles

Settings › Backend also saves named solver checkout/interpreter/cache
profiles (same `<checkout>` templates, defaults and reset arrows). Select one in Live to switch solver implementations without reloading
the browser or replacing the simulator. Switching pauses at the displayed native
state and starts a new history segment. Profiles must have compatible model
coordinates and prebuilt binaries for the chosen knot count. See
[solver profiles](docs/solver-profiles.md) for provenance and failure behavior.

## Live MPC

Independent Simulator and Predictor friction controls use the selected source’s actual joint coefficients. Both default to **on** in the new UI, with predictor smoothing of **0.03 rad/s**; these defaults do not imply numerical or physical qualification. See [friction modes, provenance and prepared binaries](docs/friction.md).

Select Live, adjust the target offset and settings, and inspect the prediction.
The prediction computes one optimized horizon from the displayed state. It
does not advance the simulated plant. **Reset state** returns to the comfortable
starting pose, clears recorded motion, and restarts the episode's plan count.
Live settings stay intact when switching to Replay and back; replay metadata
never replaces the Live configuration. The first Live connection after loading
the application starts a fresh episode at the comfortable pose and time zero.

The **Calculation** menu selects how full closed-loop motion is generated:

- **On Play:** continuously calculate new motion until Pause, paced at at most 1×.
  The duration and Stop toggle do not end this continuous simulation.
- **Manual:** press **Precalculate** to prepare the requested duration.
- **Automatic:** settings edits replace obsolete work and calculate the requested
  duration from the displayed state captured when the edit began.

Every calculation repeats optimization, control application and physics
integration. Manual/Automatic calculation and the explicit Precalculate button
use the chosen **Calculation duration**. New settings replace obsolete calculation work after the current numerical
operation; a native solve cannot be interrupted.
Playback and calculation are independent. Play with no recorded motion starts
calculation. For Manual/Automatic recordings, **Stop**, checked by default, decides whether
playing through existing history stops at its end or extends it when unchecked. Changing this
toggle preserves the recording. Scrubbing changes only the displayed time.
Pressing Play at a completed Manual/Automatic recording's end with Stop checked
replays it from the beginning. On Play resumes simulation from the latest state
without rewinding history. At a growing recording's end, playback waits for new samples.

Set **Simulation Hz ≥ Control Hz ≥ TO / replanning Hz**. Simulation Hz controls
RK4 integration, Control Hz samples the active plan's torque, and TO Hz requests
new plans. The prediction knot interval is separate. The existing upstream
warm-start behavior is preserved and has no UI setting. Large SQP/PCG budgets
are available within backend limits; they may make calculation slower than 1×.
The N, interval and horizon inputs sit together: horizon is `(N − 1) × interval`.
Editing either time input updates the other using the selected prebuilt N.

Choose Reach or Figure eight in the task selector. Reach defaults to world-axis
offsets X = 0.15 m, Y = 0.2 m, Z = 0.2 m from the imported default reaching
target; the reset controls restore these offsets. Each task retains its own
position when switching; Figure eight also retains its rotation and dimensions.
Figure eight defaults to a
horizontal world-XY path, starting at the comfortable-pose tool position. Its
default full spans are 24 × 16 cm with a 24 s period; dimensions, period and
world offsets are editable. Click the gold task anchor or press **T** to translate
it; for Figure eight, **R** selects rotation and **S** selects width/height
scaling. Drag the corresponding gizmo handles; **Escape** hides them. Rotation
uses the fixed path start as its pivot and changes the controller reference too.
**G** remains an alias for translation. The gold desired path updates immediately
while dragging, independently of the solver. Obsolete predictions are hidden
until a replacement arrives; recorded history keeps its recorded reference.
Shortcuts are inactive while typing. The paused prediction uses that simulation
time's reference phase; Reset returns the phase to zero.

The Live timeline uses authoritative saved physics timestamps. Scrub to inspect
recorded position, velocity, actuator torque and matching predictions. History
plays smoothly at 1× simulation time, independently of how slowly it was
calculated. At a growing history's unavailable end, playback holds until more
motion is ready. It never extrapolates or jumps to the newest sample. The full
accepted recording is retained; only the displayed path is reduced to at most
5000 points, with cached geometry so rendering stays responsive.

Timeline intervals are **red** when MPC exceeds its nominal TO budget, otherwise
**yellow** when physics or combined execution exceeds the simulated interval.
Red takes priority even when physics is slower. Hover for separate MPC, physics,
total and budget times. The Play button turns red only while waiting at a
computation-limited end, not while replaying previously slow intervals.
**Calculation RTF** reports generated simulation time per calculation wall time (including deliberate pacing);
it does not alter recorded playback speed. Nominal simulated rates and achieved
rates per calculation-wall second are labeled separately.

The settings include horizon N and knot interval, costs, SQP/PCG budgets and
tolerance, ADMM choices, and bound margins/fractions. Only modules prepared for
the current MPC/toolchain are offered; changing a setting never compiles one.
Use Settings › Backend to inspect changed `tiago_mpc` code, build missing
modules explicitly and Apply the selected source/binaries. See the
[execution API](docs/execution-api.md) and [prediction fields](docs/live-api.md).

Predicted tool path, task reference, and recorded simulated motion have separate
labels. The display shows solver work, constraint violation and solve time for
each plan. A finite plan does not establish convergence. A persistent simulation
coordinator and a separate persistent solver child keep native calls independent
of HTTP and rendering. See [process ownership](docs/architecture.md).

This MVP is a simulation diagnostic. It does not command a physical robot,
check collisions, or provide experiment/timing evidence. Plotting exposes only
diagnostics actually retained by the selected solver or recording.

## Replay

Select recorded MPC motion or a saved optimizer prediction, then play, pause,
scrub, restart or change speed. Recorded motion uses sample timestamps and
interpolation. A saved prediction animates its knot states; it is distinct from
executed simulated motion. Native recorded joints are displayed directly;
saved GPU predictions use their recorded coordinate signs, including joint 6.
The full robot supplies context, with the left arm in a bent resting display
pose (`[0.39, -1.73, 0.38, -2.35, 0, -1.21, -0.04]` native radians) and the torso
at zero by default. Portable recordings can supply their own fixed context.

The orientation cube at the top right snaps to Front, Back, Left, Right, Top
and Bottom while preserving the current pan target and zoom distance.
Top places the robot's forward direction toward screen right. Cube corners
select the eight equal-angle diagonal views.

**Fit robot** frames the full robot in its current pose. **Fit trajectory**
frames the selected Replay motion and reference. In Live, it frames a completed precalculated closed-loop path when available;
otherwise it uses the full tracking reference, or the task start and reaching target. Both
commands retain the viewing direction and adjust the center and distance with
margin for the viewport's current shape. Trajectory fitting uses a 40% margin
(previously 15%); robot fitting retains 15%. They do not run the solver.

The right-arm table shows native position (rad), velocity (rad/s), and actuator
torque (Nm). Missing telemetry displays “—”. Position values turn yellow within
10% of either position bound; velocity/torque turn yellow at 90% of their
magnitude limit. Values at or beyond a limit turn red. Hover for the limit source
and bounds: recordings can carry their historical limits, otherwise the current
display URDF supplies them; Live uses the configured MPC bounds. Recorded torque
holds between its saved command timestamps; a prediction's final knot has no
torque. Live torque reports the last command actually applied to the plant.

The canonical full URDF supplies the torso-to-root transform for every tool
path and reference. Models and existing recordings stay in `tiago_mpc` and are
read-only; the viewer imports its controller/configuration/plant code unchanged.
All new logs, configuration snapshots and validation artifacts live under this
checkout's ignored `_expr_data/`; compiled modules stay in the selected GATO
cache (the selected MPC checkout’s `.cache/gato` by default).

## Development

Start with [AGENTS.md](AGENTS.md), the [domain glossary](UBIQUITOUS_LANGUAGE.md),
and the [architecture and code map](docs/architecture.md). The guide links
accepted architecture decisions, topic contracts and focused checks.

```bash
npm ci
npm test
npm run build
python_bin="$(python3 scripts/launch_python.py)"
"$python_bin" -m unittest discover -s tests -v
"$python_bin" server.py --port 8090
```

The resolver above uses the same prepared interpreter as startup; it installs
no Python packages. Tests use a prepared sibling `../tiago_mpc_vis_baseline` for model/replay
fixtures. Run the opt-in GPU conformance check only when the experiment locks
are free:

```bash
"$python_bin" scripts/check_conformance.py --mpc-root /absolute/path/to/tiago_mpc --steps 3
```

It checks the synchronous `MPCAdapter` compatibility path against unchanged
`reach_sim.py`, comparing three plans and their native plant timestamps, states
and controls bit for bit. It does not exercise every production multirate,
profile or inspection path. Pass the actual selected source explicitly; this
script does not read the saved source selection. Both raw outputs are retained below
`_expr_data/conformance/`. Solve timings are excluded from that comparison.
Mesh ownership and model provenance remain with the selected MPC checkout;
see its `models/README.md` and license files.
