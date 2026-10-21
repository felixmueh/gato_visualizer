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

Select Live, adjust the target offset and settings, and inspect the preview.
The prediction recomputes when settings change. Preview resets the controller
at the current plant state and computes one plan; Play starts from that same
reset policy and advances the simulated plant with continuous MPC replanning.
Pause holds the current state; Reset returns to the comfortable starting pose.
Changing settings during Play restarts the controller at the current state.
Reset also restarts the episode's plan count.

Choose Reach or Figure eight in the task selector. Figure eight follows a
horizontal world-XY path, starting at the comfortable-pose tool position. Its
default full spans are 24 × 16 cm with a 24 s period; dimensions, period and
world offsets are editable. Preview at a paused state uses that simulation
time's reference phase; Reset returns the phase to zero.

Pause enables the Live history slider. Scrubbing shows the saved robot state,
prediction and joint telemetry. Play always returns to the newest backend state
and continues there. History is retained in the browser with a bounded window;
the actual retained interval appears beside the controls. Reset clears history.

The settings include horizon N and knot interval, costs, SQP/PCG budgets and
tolerance, ADMM and warm-start choices, and bound margins/fractions. Only
modules prepared for the current MPC/toolchain are offered; changing a setting
never launches a compilation. Restart the server and rerun setup after changing
`tiago_mpc` code. The live API and event fields are in [docs/live-api.md](docs/live-api.md).

Predicted tool path, reference, and simulated motion have separate labels.
The display shows solver work, constraint violation and solve time for each
plan. A finite plan does not establish convergence. Simulated time is separate
from computation time; Play advances one knot interval after each solve using
the unchanged reaching RK4 plant. Solve latency does not advance the plant.
The real-time factor shows when playback falls behind wall time.

The native CUDA binding holds Python's interpreter lock during a solve.
Pause/settings requests can therefore wait for that solve to finish, especially
with large solver budgets. Browser camera controls continue to work. Closing
the last live view pauses solving and releases the experiment locks.

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
frames the selected Replay motion and reference. In Live, it frames the full
tracking reference, or the available task start and reaching target. Both
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
