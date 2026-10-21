# TIAGo MPC visualizer

A local browser application for live reaching/tracking MPC and saved trajectory replay.
Orbit, pan and zoom around the full canonical TIAGo; change solver settings,
inspect its predicted tool path, then play the simulated closed-loop motion.

## Run

Use a prepared sibling `../tiago_mpc` checkout with canonical models, fetched
LFS meshes and GATO dependencies. A saved legacy reaching recording is optional;
without one, the viewer opens at the starting pose, ready for replay uploads.
The launcher uses `../tiago_mpc/venv-host` on the desktop. `TIAGO_PYTHON` can
select another prepared interpreter; inside the existing container the launcher
falls back to `../tiago_mpc/.venv`. It does not install Python packages there.

The viewer reuses compatible GATO binaries in the selected checkout’s
`.cache/gato`. Prepare missing horizon modules explicitly during setup or use
the **Source / Build settings** gear button:

```bash
cd /workspace/tiago_mpc_visualizer
./scripts/start.sh --prebuild
./scripts/start.sh --host 0.0.0.0 --port 8090
```

Open **http://192.168.178.82:8090** from the laptop on the local network (or use
your desktop's current address). Port 8080 is used by the older container viewer.
Omit `--host 0.0.0.0` to listen only on the desktop itself. No cloud service,
laptop Python environment, or internet connection is needed after setup.

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

The gear button opens a movable **Source / Build settings** window. Enter a
`tiago_mpc` checkout or worktree path; it shows the resolved source branch,
commit/dirty state, Python environment, cache and compatible knot counts. Python
and cache overrides are optional. The previous visualizer cache can be reused by
entering `/workspace/tiago_mpc_visualizer/.cache/gato` explicitly; it is never
copied into the selected project cache. Compatibility checks include the current
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
`../tiago_mpc`; `TIAGO_PYTHON` and `GATO_CACHE_DIR` override their saved paths.
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
to pan; click or drag to scrub. Arrow keys seek, Shift+arrows seek by 1 ms,
+/− zoom, and Fit (or 0) shows the full recording. Colored intervals retain the
same MPC/simulation over-budget meanings as the compact timeline.

Use **+** in Episode or Solve to open the searchable plot catalog. Add several
plots without closing it, configure each instance independently, duplicate them,
and drag their titles to reorder. **Show on timeline**, or dragging a compatible
Episode plot to the expanded timeline, docks it above the ruler. Drag it out to
remove that placement. Docked graphs share the episode window and scrub cursor.
Aggregates and prediction-horizon/SQP plots stay in the sidebar.

Episode analysis defaults to **Entire episode**; select **Through cursor** or
**Visible window** to change the scope. Sidebar plots fit that selected range:
Entire ignores timeline zoom, Through cursor ends at the cursor without its
marker, and Visible follows zoom. Docked plots retain the timeline window and
cursor. Drag in a plot to scrub; Y scales hold headroom and expand smoothly as
new values arrive. The Solve inspector follows the recorded
plan association. **Pin solve** retains its identity and SQP selection with a
muted red indicator. Its separate SQP strip selects recorded iterations without
moving the episode clock. **Run again** offers a finite SQP cap and optional
wall budget, creates a separate pinned result with genuine iteration snapshots,
and preserves the original episode. Initialization is explicitly cold; **Stop**
terminates only that inspection worker. Older data without captured inputs
explains why rerunning is unavailable. See [Solve inspection](docs/inspection.md).

Bundled Python plotters cover timing/budgets, iteration counts, tracking error,
joint motion and bounds, timing histograms, episode aggregates, prediction joint
profiles and recorded iteration diagnostics. Missing values remain unavailable.
Custom `@plot_episode` and `@plot_solve` functions load from
`<selected tiago_mpc>/_visualizer` by default. Change the directory and reload
plotters in Source / Build settings without restarting MPC. See the
[plot authoring guide](docs/plot-authoring.md) for typed views, the starter and
offline numerical checks with shared-renderer HTML previews.

## Solver profiles

Source / Build settings also save named solver checkout/interpreter/cache
profiles. Select one in Live to switch solver implementations without reloading
the browser or replacing the simulator. Switching pauses at the displayed native
state and starts a new history segment. Profiles must have compatible model
coordinates and prebuilt binaries for the chosen knot count. See
[solver profiles](docs/solver-profiles.md) for provenance and failure behavior.

## Live MPC

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
Use Source / Build settings to inspect changed `tiago_mpc` code, build missing
modules explicitly and Apply the selected source/binaries. See the
[execution API](docs/execution-api.md) and [prediction fields](docs/live-api.md).

Predicted tool path, task reference, and recorded simulated motion have separate
labels. The display shows solver work, constraint violation and solve time for
each plan. A finite plan does not establish convergence. A separate persistent
compute process keeps native solver calls independent of HTTP and rendering.

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

```bash
npm ci
npm test
npm run build
../tiago_mpc/.venv/bin/python -m unittest discover -s tests -v
../tiago_mpc/.venv/bin/python server.py --port 8090
```

Use `venv-host/bin/python` for desktop checks. Run the opt-in GPU conformance
check only when the experiment locks are free:

```bash
../tiago_mpc/.venv/bin/python scripts/check_conformance.py --steps 3
```

It compares three plans and their native plant timestamps, states and controls
bit for bit against unchanged `reach_sim.py`, retaining both raw outputs below
`_expr_data/conformance/`. Solve timings are excluded from that comparison.
Mesh ownership and model provenance remain with the selected MPC checkout;
see its `models/README.md` and license files.
