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

Prepare the supported horizon modules once, and again after changing the MPC,
model or toolchain. This is the only step that compiles CUDA:

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
GPU setup/solving respects the experiment locks. If another experiment owns
them, setup exits with an explanation and the live viewer reports GPU busy.
Replay and camera controls remain available.

Use another MPC checkout, interpreter, or replay recording with:

```bash
TIAGO_MPC_ROOT=/workspace/tiago_mpc-other ./scripts/start.sh --port 8090
TIAGO_PYTHON=/path/to/python ./scripts/start.sh --port 8090
./scripts/start.sh --port 8090 --run-dir /absolute/path/to/recording
```

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

## Live MPC

Select Live, adjust the target offset and settings, and inspect the prediction.
**Preview** computes one optimized horizon from the displayed state. It does
not advance the simulated plant. **Reset state** returns to the comfortable
starting pose, clears recorded motion, and restarts the episode's plan count.
Live settings stay intact when switching to Replay and back; replay metadata
never replaces the Live configuration.

The **Calculation** menu selects how full closed-loop motion is generated:

- **On Play:** calculate as playback needs new motion, paced at at most 1×.
- **Manual:** press **Precalculate** to prepare the requested duration.
- **Automatic:** settings edits replace obsolete work and calculate the requested
  duration from the displayed state captured when the edit began.

Every calculation repeats optimization, control application and physics
integration for the chosen **Calculation duration**. **Cancel calculation**
stops after the current numerical operation; it cannot interrupt a native solve.
Playback and calculation are independent. Play with no recorded motion starts
calculation. **Continue simulation at end**, off by default, decides whether
playing through existing history extends it or stops at its end. Changing this
toggle preserves the recording. **Go latest** only moves the displayed time.
Pressing Play at a completed recording's end with Continue off replays it from
the beginning. At a growing recording's end, playback waits for new samples.

Set **Simulation Hz ≥ Control Hz ≥ TO / replanning Hz**. Simulation Hz controls
RK4 integration, Control Hz samples the active plan's torque, and TO Hz requests
new plans. The prediction knot interval is separate. The existing upstream
warm-start behavior is preserved and has no UI setting. Large SQP/PCG budgets
are available within backend limits; they may make calculation slower than 1×.

Choose Reach or Figure eight in the task selector. Figure eight follows a
horizontal world-XY path, starting at the comfortable-pose tool position. Its
default full spans are 24 × 16 cm with a 24 s period; dimensions, period and
world offsets are editable. Preview at a paused state uses that simulation
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
Restart the server and rerun setup after changing `tiago_mpc` code. See the
[execution API](docs/execution-api.md) and [prediction fields](docs/live-api.md).

Predicted tool path, task reference, and recorded simulated motion have separate
labels. The display shows solver work, constraint violation and solve time for
each plan. A finite plan does not establish convergence. A separate persistent
compute process keeps native solver calls independent of HTTP and rendering.

This MVP is a simulation diagnostic. It does not command a physical robot,
check collisions, or provide experiment/timing evidence. Live convergence plots
remain follow-up work.

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
margin for the viewport's current shape. They do not run the solver.

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
checkout's ignored `_expr_data/`; compiled modules stay in `.cache/gato`.

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
