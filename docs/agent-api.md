# Agent controls

Agents and scripts use the same local HTTP API as the browser. The stdlib-only
CLI wraps it; it needs no MPC imports or special Python environment:

```bash
python3 scripts/control.py get
python3 scripts/control.py get live
python3 scripts/control.py get schema
```

The default URL is `http://127.0.0.1:8090`. Set `TIAGO_VISUALIZER_URL` or put
`--url http://host:port` before the command. Paths in source/profile requests
belong to the server's filesystem. Settings are JSON on stdout; request errors
are JSON on stderr and exit nonzero. `get all` retains an unavailable service
as an `error` entry while still returning the other services' metadata.

## Change settings

Send only the fields to change. Nested objects merge into the current settings,
arrays replace their whole value, and JSON `null` is a value (for example,
no SQP wall-time limit). Every editable Live field in the returned schema can
be changed through this route, using the same validation as the UI:

```bash
python3 scripts/control.py patch live '{"config":{"cost_weights":{"position":20},"solver":{"max_sqp_iters":10},"max_sqp_time_s":null}}'
python3 scripts/control.py patch live '{"execution":{"to_hz":50}}'
python3 scripts/control.py patch live '{"task":{"kind":"figure8","width_m":0.2,"period_s":12}}'
python3 scripts/control.py patch presentation '{"buffer_ms":400,"ghost_start_opacity_percent":65}'
```

Use `@file.json` to read a JSON object from a file or `-` to read stdin.
For example, `python3 scripts/control.py patch live @settings.json` sends the
object in `settings.json`. An invalid patch is rejected without partially
applying its fields. Settings/N changes only load compiled modules; compilation
remains an explicit Source / Build operation.

Connected Live viewers receive the accepted settings immediately and update
their fields, task geometry, start pose and reset indicators. Replay viewers
also refresh the retained Live settings; their recorded tracks stay immutable.
Presentation preferences update in open viewers through a one-second poll,
including during Replay playback. Browser edits submit only their changed
fields so an unrelated agent change is preserved.

The response to a Live change means **accepted**, with a `settings_version`.
It does not mean the numerical worker has finished configuring, warming up or
solving. [Live events](live-api.md#events) and
[history](execution-api.md#authoritative-history) report subsequent results.
The new reference or prediction may therefore appear later than the fields.

`get live` returns current accepted `config`, `task`, `execution`,
`settings_version` and `generation`; `get schema` returns defaults, available
compiled horizons and field definitions. Read these before choosing values.
To ensure a change still applies to a version you inspected:

```bash
python3 scripts/control.py patch live '{"config":{"cost_weights":{"position":20}}}' --expected-version 7
```

A stale version returns HTTP 409 and the current snapshot under `settings`. The CLI does not
retry a mutation automatically. Read the latest values and decide whether to
reapply. Without a version guard, supplied fields are changed atomically against
the latest settings; unrelated fields are preserved.

A patch containing only `execution.continue_at_end`, with no anchor/reset,
shares that playback preference without replacing history, changing the numerical
settings version, or requesting numerical work.

Changes normally use the committed simulation tip. To choose a specific
continuation state, pass `--anchor @anchor.json` with native
`{"sim_time_s":2,"q":[...7 positions...],"qd":[...7 velocities...]}`.
Use `--reset` to start at time zero from the configured start pose. A start-pose
change itself starts a new run at zero. Numerical settings changes replace the current Live
history, following the [execution contract](execution-api.md#settings-and-commands).

## Commands and source selection

```bash
python3 scripts/control.py command preview
python3 scripts/control.py command precalculate
python3 scripts/control.py command play
python3 scripts/control.py command pause
python3 scripts/control.py command cancel
python3 scripts/control.py command reset
```

Preview computes a horizon without moving the plant. Precalculate uses
`execution.duration_s`; set it with a settings patch first. Pause stops On Play
generation; Cancel also cancels explicit Manual/Automatic precalculation.
These are numerical commands; browser playback and scrubbing remain local.
Preview and precalculate optionally accept `--anchor`.

To select an existing MPC checkout/worktree for both simulator and solver:

```bash
python3 scripts/control.py source inspect /path/to/tiago_mpc-worktree
python3 scripts/control.py source apply /path/to/tiago_mpc-worktree
```

The default is the sibling `tiago_mpc-visualizer-base` worktree, branch
`visualizer/base`. It advances only when Felix requests an update. From a clean
base, fast-forward with `git -C ../tiago_mpc-visualizer-base merge --ff-only main`,
sync its own uv environment, then inspect and apply that same source path through
the CLI above. Source Apply reloads updated code even when the path is unchanged.

Optional `--python '<checkout>/.venv/bin/python'` and `--cache /path/to/cache`
use the same path/default rules as Settings › Backend. Apply validates and
saves the selection, then restarts the backend. Its accepted response precedes
the restart. Open browsers detect the new backend identity, reload source-bound
objects, and show the selected source. A source change starts a fresh Live run.
The API selects existing worktrees; it does not run Git checkout operations or
create worktrees. Changing the visualizer's own checkout remains a launcher
operation.

For a solver-only change that retains the simulator:

```bash
python3 scripts/control.py profile save trial /path/to/solver-worktree --name 'Trial solver'
python3 scripts/control.py profile activate trial
python3 scripts/control.py get profiles
```

Activation is asynchronous. Open viewers also poll the saved profile catalog
and active selection, including in Replay mode. `switch_revision` identifies
each accepted activation independently of ordinary history generation changes,
including reactivation of the same profile and failed retries. Profile status
reports completion or failure; see
[solver profiles](solver-profiles.md#http-and-local-settings).

## HTTP routes

| Action | Request |
| --- | --- |
| Read accepted Live settings | `GET /api/live/settings` |
| Patch Live settings | `POST /api/live/command` with `{"type":"patch_settings","patch":{"config":{...},"task":{...},"execution":{...}},"expected_settings_version":7}`; groups and version guard are optional |
| Read schema/defaults | `GET /api/live/schema` |
| Read presentation settings | `GET /api/presentation/settings` |
| Patch presentation settings | `POST /api/presentation/settings/patch` with `{"buffer_ms":400}` |
| Select/check source | `POST /api/source/apply` or `/inspect` with `{"mpc_root":"/path/to/worktree"}` |
| Read source/build status | `GET /api/source` |
| Save solver profile | `POST /api/solver-profiles` with `{"profile":{"id":"trial","name":"Trial","mpc_root":"/path/to/worktree"}}` |
| Activate solver profile | `POST /api/solver-profiles/activate` with `{"profile_id":"trial"}` |

JSON requests need `Content-Type: application/json`. Existing full
`set_settings` commands and presentation replacement requests remain supported;
partial patches are preferable for automation.

The current task kinds remain `reach` and `figure8`. An arbitrary sampled
tracking reference requires further task support. Portable recording export,
the watched library and `?replay=` links provide the existing recording handoff;
this interface does not remotely add tracks to an already-open browser or
control its camera, timeline cursor, track offsets or other local session state.
