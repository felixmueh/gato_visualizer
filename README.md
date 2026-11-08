# TIAGo MPC visualizer

A local browser application for live reaching/tracking MPC and saved trajectory replay.
Orbit, pan and zoom around the full canonical TIAGo; change solver settings,
inspect its predicted tool path, then play the simulated closed-loop motion.

Agents can read and patch the current settings through
[`scripts/control.py`](scripts/control.py); open browsers reflect shared Live
and presentation changes. See the [agent API guide](docs/agent-api.md).

This experimental branch keeps settings integration in visualizer-owned
`adapters/` (the standard `adapters/tiago.py`, with an optional locally ignored
checkout override for local experiments). It follows `tiago_mpc` main without
compatibility for older interfaces. No tracked
visualizer hook is required in `tiago_mpc`. See [settings adapters](docs/source-settings.md).

Live can select uncompiled knot counts and predictor models. Missing combinations
are shaded and use one centered **Compile** action for the exact current draft;
cached models apply directly. Per-joint friction and armature coefficients stay
in the adapter's native presets, with toggles exposed in the form.

Runtime/task edits reuse model readiness; moving a goal never starts another
model lookup. Background model checks leave task handles editable. Timing
inputs accept `50 Hz`, `20 ms` or `0.02 s` with canonical numeric API values;
measured solve latency and as-fast-as-possible TO use separate checkboxes.
See [Live timing controls](docs/live-api.md#settings-object).

Loading several recorded runs enables **Comparison**, with tracking,
smoothness and arbitrary recorded-channel plots. Its separate extensible
Python catalog uses `@plot_comparison`; see
[the comparison API](docs/plot-api.md#comparison-plots).

## Run

Use the prepared sibling `../tiago_mpc-visualizer-base` worktree (branch
`visualizer/base`) after advancing it to include the shared-loop API. Live requires
separate native tick, solve-completed and diagnostic callbacks, cancellation,
execution safety and effort handling; the source probe rejects checkouts missing those capabilities. The selected
source needs canonical models, fetched LFS meshes and GATO dependencies
(select another checkout with `--mpc-root`,
`TIAGO_MPC_ROOT` or Settings › Backend). The viewer opens at the start pose,
in one Live workspace, ready to calculate or add recordings as tracks.
The launcher uses the selected checkout's uv environment: `.venv` on the desktop,
`.venv-container` inside Docker or Podman. It never falls back to the other
platform's environment. `TIAGO_PYTHON` can select another prepared interpreter;
the launcher does not install Python packages and unsets inherited `PYTHONPATH`.

The stable source stays at its selected commit while development continues in
`tiago_mpc` main. To accept a new chunk, first check that the base has no local
changes, then fast-forward it explicitly:

```bash
git -C ../tiago_mpc-visualizer-base status --short
git -C ../tiago_mpc-visualizer-base merge --ff-only main
```

Sync the base's own environment with `uv sync --locked` from that worktree
(in the container set `UV_PROJECT_ENVIRONMENT=.venv-container` and unset
`PYTHONPATH`), then use **Apply and restart backend** for that source. This also
reloads changed source code when the selected path stays the same. The launcher
never advances the base automatically. Each platform prepares its own environment.

The viewer uses the GATO modules that `tiago_mpc` compiled into its default
cache: the main checkout's `.cache/gato`, also when the selected checkout is a
worktree, for every interpreter, host and container alike. `tiago_mpc` decides
this path (`tiago_mpc.util.cache_root()`); the viewer leaves `GATO_CACHE_DIR`
unset unless a cache override is given. `tiago_mpc` compiles only on request; prepare the horizon modules during setup (`--prebuild` builds the
loss-free N = 16, 32, 64, 128) or with the gear button (**Settings › Backend**):

```bash
cd /workspace/tiago_mpc_visualizer
./scripts/start.sh --prebuild
./scripts/start.sh --host 0.0.0.0 --port 8090
```

Open **http://192.168.178.82:8090** from the laptop on the local network (or use
your desktop's current address). Port 8080 is used by the older container viewer.
Omit `--host 0.0.0.0` to listen only on the desktop itself. No cloud service,
laptop Python environment, or internet connection is needed after setup.

Raw recording ingestion runs in a separate CPU process before history FK/JSON
processing. The capture ring and ingestion queue each default to 256 MiB;
`TIAGO_VISUALIZER_RECORDING_BUFFER_MIB` and `TIAGO_VISUALIZER_INGEST_BUFFER_MIB`
set their startup budgets. These bound buffered data, not total application
memory. See [recording buffers and backpressure](docs/execution-api.md) for
capacity constraints and lossless simulation behavior.

Live playback downloads compact state/control records and prediction summaries.
Full predictions load independently into a bounded browser cache, so a slow
prediction download does not stop robot motion. Playing prediction geometry
updates on a 60 Hz display-time grid; scrubbing and animation export select the
exact recorded solve. The server retains all original records for inspection
and replay export. See [presentation](docs/presentation.md) for cache behavior.

**Direct replay links:** `http://192.168.178.82:8090/?replay=reaching/study/run_017`
adds that library recording as a track and opens **Replay mode** (the path
omits `.npz`; uploads use an `uploads/` prefix). It starts without subscribing
to Live events or requesting an automatic preview. The linked URL remains shareable.
A missing or unreadable path shows the library's usual message
and error list, and the link opens the recording once it appears (for example
when its export finishes). Links match library entries only, never file paths.
Repeat `replay` to open several recordings together, for example
`/?replay=study/stock&replay=study/feedback`. Each comparison track starts at
offset zero and uses its recording label as its editable lane name; the first
visible recording supplies the inspectors. Encode spaces as `%20` and literal
plus signs as `%2B`. Catalog updates add any newly available linked recordings
without replacing tracks already loaded. Single-recording links keep the usual
start alignment and A/B/C names.

The launcher installs locked frontend dependencies if absent, builds the
frontend, and serves the application, robot assets and API from one process.
Numerical solving respects the experiment locks and reports GPU busy while
another experiment owns them. Explicit compilation is CPU work: it keeps Live
running, takes no GPU experiment lock, and uses half the available CPU cores
while respecting CPU affinity/quota. Recorded playback and camera controls remain available.

Use another MPC checkout or interpreter with:

```bash
TIAGO_MPC_ROOT=/workspace/tiago_mpc-other ./scripts/start.sh --port 8090
TIAGO_PYTHON=/path/to/python ./scripts/start.sh --port 8090
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
any other `<…>` token is an error). The interpreter defaults to
`<checkout>/.venv/bin/python` on the host and `<checkout>/.venv-container/bin/python`
in Docker or Podman. Explicit interpreter overrides remain available.
The cache defaults to `tiago_mpc`'s own default,
which the field shows as its resolved path (tooltip "tiago_mpc's default"); a
cache override is any other template or path. The resolved
absolute path is the field's tooltip; a template that cannot be resolved is marked
invalid, with the reason as tooltip. An edited template is a highlighted override
with a reset arrow that restores the default. A value equal to the default is sent
as "follow the checkout" and not saved; overrides are saved as typed, templates
included. `POST /api/source/defaults` with `{"mpc_root": …}` (optionally
`python`/`cache` templates) returns the default interpreter template, the default
cache path (`cache`, with `cache_label`), their resolution and the resolution of
the entered templates. Existing configs with absolute paths are
not rewritten. Check source imports `tiago_mpc`'s MPC API in the selected
interpreter and asks its `find_binary` which modules exist for the offered
knot counts (8, 16, 24, 32, 48, 64, 96, 128), loss-free and with predictor
friction. `tiago_mpc` and GATO decide what a cached module must match; the
visualizer has no module discovery of its own.

**Build selected N** calls `tiago_mpc`'s `compile_binary` for each selected
count in a CPU-only subprocess, loss-free or, with **Predictor friction
modules**, with predictor friction. A count that is already compiled is left
as it is; **Rebuild compiled counts** compiles it again and replaces the old
module file (no backup). Progress streams into the dialog; the log and a
receipt stay under `_expr_data/source-builds/`. Changing normal Live settings
or selecting N never compiles. A Build into the running Live solver's own
checkout, interpreter and cache only adds modules: Live lists the new N as soon
as it finishes, without a restart (Felix, 2026-10-23). **Apply and restart
backend** is for another source, interpreter or cache, or changed source code;
it saves the selected paths, closes the numerical worker, restarts in the
selected interpreter, and reloads all source-bound models/renderers/replay
bindings. This starts a fresh Live session while retaining compatible controls,
saved replays; the Live history starts afresh. Restart may wait for an active solve or timing
window to release the GPU safely.

Startup source precedence is `--mpc-root` > `TIAGO_MPC_ROOT` > saved selection >
`../tiago_mpc-visualizer-base`; `TIAGO_PYTHON` and `GATO_CACHE_DIR` override their saved paths.
Selecting another source with CLI/environment chooses that project's default
environment and `tiago_mpc`'s default cache unless explicitly overridden. Apply replaces those launch-time
overrides for its restart. No packages are installed in the selected environment.

Server configuration lives in [`visualizer.json`](visualizer.json). Its
`ingest_directory` defaults to the shared `../_expr_data/ingest`; directory
paths resolve relative to the config file. Select another file with
`./scripts/start.sh --config /path/to/visualizer.json`. Startup prints the
resolved ingest directory. This is `impl/_expr_data/ingest` on the host and
`/workspace/_expr_data/ingest` in the container. This config does not change the MPC settings.
The recording library discovers portable `.npz` files recursively there and accepts
file/folder uploads from the laptop into `_expr_data/uploads`. Use **Add track**
to search recordings, preview their recorded tool paths and add them to the session.
File changes update the library without replacing loaded tracks.
The producer-side exporter is `tiago_mpc/experiments/replay.py` (`export_replay`, `save_replay`);
see the [format and export cookbook](docs/replay-format.md).

## Workspace

The application opens directly into one session workspace, with no mode tabs.
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

The playback bar contains Play/Pause, Reset, the timeline, **Replay** and **Stop**. In Live, checked
Stop ends recorded playback at the session end. With Live calculation,
unchecking it continues simulation from the tip. On Play runs continuously
from an empty run until paused. The transport also
provides the calculation mode, a precalculation icon with its duration in a
hover/focus panel above it,
**Freeze for comparison**, and a playback speed (forced to 1× while following
a growing Live tip).

The session retains a main track **Live**. Expand the timeline and use
**Add track** to compare saved recordings, or **Freeze for comparison** to
export the idle current run into RAM, add it at offset zero, and rewind to its
start. A subsequent settings edit starts from that displayed starting state.
Library tracks align their first sample with Live's start. Each lane shows its
colour, editable name (A, B, C by default) and offset; drag its span to move it in session time
(Alt disables snapping), or double-click to restore the default placement.
Live's **Arm** button hides or restores the solid right arm while leaving its
ghost images available. Other rows use Eye, Arm/Dot and × for track visibility,
representation and removal. Coloured
recorded ghosts/dots and paths play with Live, holding dimmed endpoint poses
outside their spans. Lane badges describe frame/time/model mismatches;
tooltips retain source provenance. The collapsed chevron counts comparison tracks.
Freezes appear under Temporary in Add track. Eight
are retained per server run; removing a track does not delete its freeze.
Page reload retains the freeze catalog but clears the browser's tracks;
server shutdown deletes its freezes. See [session defaults](docs/presentation.md#session-and-tracks).

Opening a recording through **Add track** or a direct link enters **Replay
mode**. It cancels Live calculation and hides Live's lane, arm, paths and ghost
images; Play, scrubbing and playback speed use only visible replay tracks.
Reset rewinds playback to their start. Live settings remain visible and
disabled. Joints, Episode and the unpinned Solve inspector read the first
visible replay; a pinned Solve retains its source. A subtle amber viewport
outline and the top-centre **Replay mode · Return to Live** button mark the
mode. Click that button or the bottom-bar **Replay** toggle to restore Live,
paused, alongside all retained recordings. **Freeze for comparison** stays in
Live. Removing the last recording leaves Replay mode selected until you return.

The ruler sits above the track rows; aggregate start/end barriers and shading extend
across all track rows. Live's row repeats the Freeze action. Hover the ghost
button to set spacing and the maximum number of arms; click it to cycle off,
Live only, or all tracks. **Settings → UI** sets start and end ghost opacity
(defaults 55% and 25%). The fade follows the aggregate range from beginning to
end and stays fixed while scrubbing. With **Fixed spacing** on, keyframes start
at the range's left edge and stop at the maximum count or range end. Turn it
off to distribute the maximum evenly over the range, including its endpoints.
Clearing the range uses the whole session; zoom leaves the ghosts unchanged.
The boxed × in each replay row
sits directly below Live's Freeze button.
Task position inputs remain available below the controller settings; direct
viewport manipulation avoids scrolling to them during normal use.

Changed Live settings show a circular-arrow button on their left. Click it to
restore the original default supplied by `MpcParams` or the active task.
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
title for its description and notes. Drag a sidebar plot's bottom edge to
resize it (sidebar and timeline heights are separate). On the timeline, the
divider between two docked plots belongs to the plot below it: drag up to
enlarge that plot, growing the strip into the viewport, or down to shrink it.
Drag the timeline panel's top edge to scale all docked plots together, up to a
small remaining viewport. Double-click a grip or edge to reset.
A smaller window shrinks docked plots to fit without forgetting their heights.
⚙ on sidebar and docked cards opens the same plot settings and also sets each plot's
y-axis bottom/top (a value or automatic) and can clip outliers from automatic
sides. Hover a histogram bar for its bin edges.

Episode plots and aggregates use the **aggregate window**, chosen on the
expanded timeline: Shift-drag selects one, and its bracket handles adjust either
bound. Dragging a bound onto its data edge (or double-clicking it) leaves that
side unbounded; an unbounded end keeps following new Live data. The reset arrow,
Esc on the timeline, or × on the Episode header's window chip clears it to the
entire episode. The window is independent of zoom and the playback cursor and
persists across Live generation changes, like zoom. Sidebar episode-time
plots fit the window; docked plots retain the timeline zoom window and cursor. Drag in a plot to scrub; Y scales hold headroom and expand smoothly as
new values arrive. The Solve inspector follows the recorded
plan association. **Pin solve** retains its identity and SQP selection with a
muted red indicator. Its separate SQP strip selects recorded iterations without
moving the episode clock. **Run again**, available with capture-capable solver
profiles (official `gato-mpc` 0.1.5 does not provide iteration capture), offers a finite SQP cap and optional
wall budget, creates a separate pinned result with genuine iteration snapshots,
and preserves the original episode. The result lasts as long as its Live run or
loaded replay stays current. Initialization is explicitly cold; **Stop**
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
coordinates and compiled modules for the chosen knot count. See
[solver profiles](docs/solver-profiles.md) for provenance and failure behavior.

## Live MPC

The **Friction** group sets the simulated plant and the predictor
independently. The simulated plant defaults to semi-implicit Euler with the
selected source's URDF friction and the constraint Coulomb law; the predictor
defaults to loss-free. Euler also simulates plant friction with a tanh, sign or constraint Coulomb law
(default constraint). Predictor friction and its separate `friction_law` select
a compiled variant. The standard control fixes tanh width at 0.03 rad/s; the
experimental friction adapter exposes its configured width and independent
armature toggles. See [friction](docs/friction.md).

**Limit handling** (Felix, 2026-10-23): **Clip effort** (on by default) clips
each command to ± the URDF effort limit before it reaches the simulated plant;
**Stop on breach** (Joint limits, Velocity, Torque, all on) pauses calculation
and playback where a simulated position, velocity or applied torque first
leaves its URDF limit, with a message naming joint, value and limit; Play
continues, and a value that stays beyond does not pause again. The history
track marks breaches; interval tooltips count clipped commands. These are
simulation settings: `tiago_mpc`'s robot path never clips. See
[limit handling](docs/execution-api.md#limit-handling).

Adjust the target offset and settings, and inspect the prediction.
The prediction computes one optimized horizon from the displayed state. It
does not advance the simulated plant. **Reset state** returns to the start
pose, clears recorded motion, and restarts the episode's plan count.
Adding recording tracks never replaces the Live configuration. The first viewer
of an unconfigured backend starts an episode at the start pose and time zero.
Later viewers read its current settings and history; opening a direct replay
link leaves Live idle until you return to it. Agent changes update open controls
through the [shared settings API](docs/agent-api.md).

**Start pose** (Felix, 2026-10-23): the seven joint positions the simulated arm
starts from at t = 0, velocities zero; the default is `tiago_mpc`'s `Q_START`
(the comfortable pose). It is a Live setting (`config.plant.start_pose_rad`),
edited in the **Joints** tab: unlock it with the lock left of
Gauges/Numbers, then, with the cursor at t = 0 (after Reset, or scrubbed to the
start), drag a position gauge or type a position in the Numbers view. The arm
follows the drag at once; releasing (or Enter) sets the start pose and starts a
new run at t = 0 from it, as Reset does. Values are clamped to the URDF position
limits. A joint outside the MPC planning box (URDF limits less the joint margin)
is shown amber: the run still starts there, and its first plans report a
position-row violation while they move the joint back inside. The task does not
move with the start pose: the reach target and the figure-eight start stay
where they are defined.

You can also edit the start pose directly in the **3D viewport**, independently
of the Joints tab's lock. While paused at the run start, click an arm link to
show its joint's rotation ring, then drag
the ring. Click the gripper or the small wireframe sphere between its fingers
for the grasp handle: a pose with a gripper glyph. Dragging it translates the
grasp point in world axes and keeps the gripper's orientation; **R** switches to
rotation rings about the handle's own axes, which keep the grasp point, and
**T** (or **G**) back to translation. Inverse kinematics for position and
orientation moves the arm; hold **Shift** while translating to let the
orientation follow freely (position only), which takes effect at once and
keeps the orientation reached when released. Release to set the start pose once. **Escape** during a drag restores the pose
without applying it; otherwise Escape or an empty click hides the handles.
Drag empty space to orbit as usual. Selecting the gold task anchor deselects
the arm handles, and vice versa.

An unreachable grasp request shows a dashed tether to the nearest reachable
point found and, dashed, the gripper glyph of the pose achieved; an orientation
the arm cannot reach also shows its remaining angle next to the handle.
Releasing snaps the handle to the achieved pose, orientation included. Joint rings use the raw URDF
limits. IK keeps joints inside the MPC planning box when they started inside;
joints already outside may use their raw limits. Amber link outlines flag a
start pose outside the planning box. This edits a kinematic pose and performs
no collision check. Holding Shift during grasp translation frees orientation. A small
**IK** badge appears if the displayed model cannot match the recorded grasp
frame; its tooltip explains why translation is unavailable. Joint rings remain
usable. Playback and recorded comparison arms are read-only.

**Obstacles (2026-11-02).** The source must have `tiago_mpc.collision`. Settings ›
Collision rows (standard adapter, `adapters/tiago.py`) switches the rows
(a compiled variant, off by default as `MpcParams.collision`), enforced or
reported only, the arm and body covers, the margin and lists the obstacles
(spheres, capsules, boxes and planes) in collapsed tables, with **+** to add one. Click an
obstacle in the viewport and drag its arrows; **R** rotates a box or plane,
a capsule's end spheres and a box's face squares drag ends and faces;
**S** scales radii and half-extents with the pointer
(**Shift** finer, click applies, **Escape** cancels), **Delete** removes,
**Ctrl+C**/**Ctrl+V** copy and paste at the pointer. Edits apply without a
compile, also while On Play plays. Export animation's **Show** choices include collision objects and
sphere covers.
The collision-spheres toggle shows the body's and the arm's sphere covers.
See [Live obstacles](docs/presentation.md#live-obstacles-and-collision-spheres).

The **Calculation** menu selects how full closed-loop motion is generated:

- **On Play:** Play from an empty run continuously calculates new motion until
  Pause, paced at at most 1×. Replaying an existing idle run respects Stop.
- **Manual:** press **Precalculate** to prepare the requested duration.
- **Automatic:** settings edits replace obsolete work and calculate the requested
  duration from the displayed state captured when the edit began.

Every calculation repeats optimization, control application and physics
integration. Manual/Automatic calculation and the explicit Precalculate button
use the chosen **Calculation duration**. New settings replace obsolete calculation work after the current numerical
operation; a native solve cannot be interrupted.
Playback and calculation are independent. Play with no recorded motion starts
calculation. For recorded Live playback, **Stop**, checked by default, decides whether
playing through existing history stops at its end or extends it when unchecked. Changing this
toggle preserves the recording. Scrubbing changes only the displayed time.
Pressing Play at a completed recording's end with Stop checked replays it from
the beginning. Unchecking Stop extends simulation from the latest state.
At a growing recording's end, playback waits for new samples.

Set **Simulation Hz ≥ Control Hz ≥ TO / replanning Hz** (defaults 1000, 500 and
100). Simulation Hz sets the plant's integration step, Control Hz samples the active plan's
torque, and TO Hz sets replanning slots. **TO Hz 0** requests back-to-back.
**Solve latency (s)** defaults to `measured`, the solver's host wall time; enter
nonnegative seconds to declare a latency instead. Requests start at control
ticks when no solve is pending, using `tiago_mpc`'s `Schedule`; missed slots are
skipped. The old plan continues until the first control tick at or after the
new plan becomes available. Its age still starts at the state used for the
solve, so latency may skip its first knots. The prediction knot interval is separate.
Live runs `tiago_mpc.loops.run_virtual_time` directly, passing the native
`VirtualTimeSettings` object through required `settings=`, with callbacks for
reporting and pause. Live passes a finite maximum duration and relaxes the native
experiment duration guard in its simulation process; cancellation ends the run.
That settings object holds
only command/update periods and solve latency. Compensation, safety and effort
handling are explicit invocation arguments. Live constructs
`ExecutionSafety(max_plan_age_s=...)` separately from its timing settings.
The source probe requires this API. **Plan age limit** is off by default; enabling it sets a
positive age deadline. A plan's finite horizon always applies. The native loop
applies effort handling after evaluating the selected command law; Live selects
`EffortClip` when **Clip effort** is enabled and `None` otherwise. Optional
latency compensation predicts using the same law and effort handling. Native
laws and effort handlers return `Command | Fault`; effort handlers receive the
law's `Command`, retaining requested and applied torque separately.
The history records every command, plan and timing interval and the state at
every command tick (every 2 ms at the defaults); the physics steps
between them are simulated, not recorded. The warm-start policy is
the `MpcParams` setting `warm_start` (shift or hold); there is no exact time
alignment of the warm start. Large SQP/PCG budgets
are available within backend limits; they may make calculation slower than 1×.
The N, interval and horizon inputs sit together: horizon is `(N − 1) × interval`.
Editing either time input updates the other using the selected compiled N.

Choose Reach or Figure eight in the task selector. Reach also offers an
**Orientation goal**: enable it to hold the displayed grasp orientation, then
press **R** on the task handle to rotate it. Costs exposes running and terminal
orientation weights alongside the position, joint-speed and torque weights.
These controls construct the native MPC cost menu; zero-weight terms are omitted.
Orientation error is shown in degrees and retained in freezes and replay plots.
See [orientation goals and cost menus](docs/live-api.md#orientation-goal-and-cost-menus).

 Reach defaults to world-axis
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
plays at the selected session speed (1× while following a growing Live tip),
independently of how slowly it was calculated. At a growing history's unavailable end, playback holds until more
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

The settings are `tiago_mpc`'s `MpcParams` with their defaults: horizon N
and knot interval, costs, SQP/PCG budgets and tolerance, ADMM choices, bound
margins/fractions, warm start, the warm-up solve, the SQP time limit and
predictor friction; the end-effector frame is shown as fixed. The SQP time
limit (`max_sqp_time_s`) defaults to none, shown as "none": Live and
precalculation run on the simulation clock, where `tiago_mpc`'s 10 ms
wall-clock limit does not belong; a limit can still be set (Felix,
2026-10-23). Every reseed of the controller (configuring, Reset, an anchor, a
preview, rollback) runs `tiago_mpc`'s `Mpc.warmup` from that
state with the task reference then: GATO's warm-up solve while **Warm-up
solve** is on (the default), the plain controller reset when it is off. The
warm-up is no plan and is not timed. Ordinary Pause/resume retains the same native invocation,
pending plans and warm state remain parked. Cancel wakes and joins the old
invocation; Reset creates fresh execution and controller state. A numerical
source must provide the shared-loop callbacks; the source probe reports an
older source as incompatible. Changing a setting never compiles a module,
and an N that is not compiled for the chosen
predictor shows as unavailable. Use Settings › Backend to build modules
explicitly, or to inspect changed `tiago_mpc` code and Apply. See the
[execution API](docs/execution-api.md) and [prediction fields](docs/live-api.md).

Predicted tool path, task reference, and recorded simulated motion have separate
labels. The display shows solver work, constraint violation and solve time for
each plan. A finite plan does not establish convergence. A persistent simulation
coordinator and a separate persistent solver child keep native calls independent
of HTTP and rendering. Requests are asynchronous: physics advances while a solve
is pending, with synchronization at possible activation boundaries. Control
arrays and buffered solve recordings have separate shared-memory paths.
See [process ownership](docs/architecture.md).

This MVP is a simulation diagnostic. It does not command a physical robot,
check collisions, or provide experiment/timing evidence. Plotting exposes only
diagnostics actually retained by the selected solver or recording.

## Saved tracks

**Add track** opens a searchable catalog with a small preview of the selected
recording's end-effector path. Upload files or a folder from that dialog. Added
tracks play, pause and scrub with the session clock. They use recorded sample
timestamps and interpolation. A saved prediction displays its knot states;
it remains distinct from executed simulated motion. Native recorded joints
are displayed directly; saved GPU predictions use their recorded coordinate signs, including joint 6.
The full robot supplies context, with the left arm in a bent resting display
pose (`[0.39, -1.73, 0.38, -2.35, 0, -1.21, -0.04]` native radians) and the torso
at zero by default. Portable recordings can supply their own fixed context.

The orientation cube at the top right snaps to Front, Back, Left, Right, Top
and Bottom while preserving the current pan target and zoom distance.
Top places the robot's forward direction toward screen right. Cube corners
select the eight equal-angle diagonal views.

**Export animation** in the viewport downloads the aggregate window as a
30 fps MP4, using the visible tracks in Live or Replay mode. Its dialog offers
720p through 2160p, a main view or main with Top and Right views, and a main
camera orientation including Current viewport. Current viewport preserves the
framing with letterboxing when needed. See [animation export](docs/animation-export.md)
for capture contents and encoder setup.

**Fit robot** frames the full robot in its current pose. **Fit trajectory**
frames a completed precalculated closed-loop path when available;
otherwise it uses the full tracking reference, or the task start and reaching target. Both
commands retain the viewing direction and adjust the center and distance with
margin for the viewport's current shape. Trajectory fitting uses a 40% margin
(previously 15%); robot fitting retains 15%. They do not run the solver.

The **Joints** tab shows each right-arm joint's limit use against the physical
URDF limits: a position range bar with a marker for the current value, end
ticks at the URDF bounds and shaded near bands, and velocity and torque bars of
|value| up to a 100 % tick, overflowing past it when beyond. Bars use one colour
per quantity while inside, amber when near, red at the limit and red outlined
beyond (the states of [Presentation settings](docs/presentation.md#joint-limit-states)).
The lock left of the switch keeps the tab read-only (locked, the default,
remembered per viewer). Unlocked, in Live at t = 0, the position column is
headed START and edits the start pose (above): drag a gauge, or type a
position and press Enter; a circular arrow beside each modified joint resets
it. A Reset button at the top of the tab, left of the lock, is always shown:
greyed out while the start pose is the default, enabled when it differs (also
locked), and then returns the whole start pose to the default as one settings
change, also mid-run (running, paused or after t = 0), starting a new run at
t = 0; its tooltip lists the differing joints. Away from t = 0 or
locked, the joint table shows the state at the cursor as before. Velocity and torque are never editable.
A **Gauges / Numbers** switch in the tab header swaps the bars for a compact
table of the same cells: position (rad), velocity (rad/s) and torque (N m) as
signed numbers in the same state colours. Both views read the same telemetry
at the playback cursor; the choice is remembered per viewer (browser
`localStorage`, default Gauges). Hovering a bar or number shows a tooltip at
once, without the native delay: the exact native value, the URDF limit, the
utilisation, the state with the distance to the bound and, when known, the MPC
bound. Missing telemetry displays “—”; a value without a known limit shows as a
number. Recordings can carry
their historical limits, otherwise the current display URDF supplies them. Recorded torque
holds between its saved command timestamps; a prediction's final knot has no
torque. Live torque reports the last command actually applied to the plant.

The canonical full URDF supplies the torso-to-root transform for every tool
path and reference. Models and existing recordings stay in `tiago_mpc` and are
read-only; the viewer imports its MPC (`tiago_mpc.mpc`), plant (`SimPlant`)
and shared native execution loop from the selected source. The Live history (current run only), preview captures,
Run again results (only while their Live run or replay is current) and solver logs
are RAM-backed runtime files in `<system temp>/tiago-mpc-visualizer-<uid>/`
(`/tmp` on this host, tmpfs; `TIAGO_VISUALIZER_RUNTIME_DIR` overrides it; startup
prints it and warns when it is not RAM-backed); see
[runtime files](docs/execution-api.md#runtime-files). Only what must persist is
written to disk: uploads, the config file (only when a setting actually changes),
build logs and validation artifacts under this checkout's ignored `_expr_data/`;
compiled modules stay in the selected GATO cache (see [Run](#run)).

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
no Python packages. Tests that need `tiago_mpc` (its model, `experiments/replay.py`
or `MpcParams` defaults) take it from `TIAGO_MPC_ROOT` (default `../tiago_mpc-visualizer-base`);
none of them needs a compiled module or the GPU. Run the opt-in GPU conformance
check only when the experiment locks are free:

```bash
"$python_bin" scripts/check_conformance.py --mpc-root /absolute/path/to/tiago_mpc
```

It runs `tiago_mpc.loops.run_virtual_time` headless with a `Reach` task and
in-process `Mpc`, then through Live's `NativeSession`, adapter and persistent
solver child. Both use the same native integration grid, loss-free RK4 plant,
500 Hz commands, 100 Hz TO, Live's default `MpcParams` without an SQP wall-time
limit, and declared 5.5 ms latency (first activation at 6 ms). It compares every
command-tick state, applied command and returned plan, including unused plans.
The default run spans 300 TO intervals (3 s); `--steps`, `--to-hz`,
`--solve-latency` and `--latency-compensation` select additional cases. For
example, `--to-hz 500 --solve-latency 0.001 --steps 500` exercises 500 Hz TO.
Optional age expiry is disabled on both sides; the finite horizon still applies.

Use the selected checkout's prepared interpreter and pass the source explicitly
(`--mpc-root`, else `TIAGO_MPC_ROOT`, else `../tiago_mpc-visualizer-base`);
the script does not read saved source selection and never compiles a missing
module. Raw outputs and comparisons are retained below `_expr_data/conformance/`.
This is numerical conformance, not a throughput benchmark. Historical results
from the old independent scheduler do not qualify this implementation.

Mesh ownership and model provenance remain with the selected MPC checkout;
see its `models/README.md` and license files.
