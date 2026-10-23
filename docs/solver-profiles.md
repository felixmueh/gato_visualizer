# Solver profiles against one simulator

Status: backend process boundary, sequential profile switching and isolated
fresh inspection are implemented. Retained native checks cover selected N32
source/model configurations; they do not qualify every profile/horizon or task
success. See [the verification map](architecture.md#verification) for maintained
checks and their scope.
Source / Build (Settings › Backend) still selects the complete simulator checkout;
its Apply action restarts the backend. Solver-profile activation keeps that simulator, HTTP
service and browser session running.

## Ownership and lifecycle

The simulator checkout supplies `tiago_mpc.tiago` (model, assets, initial
posture, limits, friction coefficients), `SimPlant` and the task geometry. The
simulator friction switch gives `SimPlant` the URDF friction (hard-sign Coulomb
plus viscous) or none; both it and predictor friction default to loss-free.
Profile selection never changes the plant. See [friction](friction.md).

Named solver profiles identify a TIAGo checkout/worktree, Python interpreter
and compiled-module cache. The interpreter and cache are saved as templates in
which the literal `<checkout>` stands for the profile's checkout (for example
`<checkout>/.venv/bin/python`); the backend substitutes it, expands `~` and
rejects other `<…>` tokens. Defaults are not saved, so they keep following the
checkout; absolute paths still work. Profile status carries both the resolved
paths and the stored `templates`. Exactly one persistent Live solver child exists.
An explicit inspection may temporarily start a separate child while Live is
paused/idle, under the same canonical GPU lease. Only one GPU job runs at a
time; the temporary child preserves private Live controller state and can be
terminated by inspection Stop. Inactive profile workers are never kept warm. `SimulatorAdapter`
owns simulation, scheduling, exact references and native states; `SolverProcess`
launches `solver_worker.py` with the selected Python using `subprocess`, which
works inside the existing daemon coordinator. A private socket carries framed
JSON metadata and typed binary array buffers for ordinary solve replies, avoiding
q/v/u JSON lists. Native stdout/stderr go to `solver-processes/` in the
RAM-backed [runtime directory](execution-api.md#runtime-files), which keeps the
logs of the last 16 children.

The coordinator owns creation, configuration, calls and graceful destruction
under the canonical experiment GPU locks. The child never acquires those locks. Each RPC lends duplicated file descriptors
for the coordinator's existing locked file descriptions through `SCM_RIGHTS`;
the child closes them after the call. This keeps the lease alive through an
unexpected coordinator exit without attempting a second flock acquisition.
Lock roots derive from the simulator repository's common Git directory, not a
solver worktree's parent. RPC protocol, epoch and request IDs reject mismatched
replies. A publication revision floor rejects late packets from an old profile.
The child arms Linux parent-death termination before numerical imports and
checks the expected parent PID to cover startup races. Bootstrap/configure have
60s/120s deadlines, reset has a 30s deadline, and close has a 5s deadline. Failed startup/teardown gets
bounded terminate/kill cleanup while the coordinator owns the GPU lease; logs
remain retained. Ordinary solve requests and Pause/cancel remain cooperative.
Explicit backend shutdown waits 10s, then stops its own coordinator if necessary;
parent-death cleanup terminates its child, with borrowed leases held until exit.
The backend handles SIGTERM like Ctrl-C and closes its services and their
children. The multiprocessing children (simulation coordinator, plot worker)
poll their parent and exit when it is gone, even after SIGKILL; a
multiprocessing resource tracker then exits with them. They do not use the
parent-death signal, which follows the starting thread, and HTTP handler
threads may restart the plot worker.
No other user's process is terminated.

Normal settings and profile switching only load compiled modules: the child
constructs `Mpc(params, find_binary(params))` and refuses with "Not compiled"
when the lookup finds none. Source / Build (`compile_binary`) remains the
explicit build operation; a Build for the active profile's own checkout,
interpreter and cache adds its N without a restart (Felix, 2026-10-23).

Activation cancels calculation and runs a CPU-only selected-interpreter preflight
(the source probe: `tiago_mpc` API, `find_binary` per N and predictor friction,
coordinate contract) and validates the current settings against the profile's
schema. A predictable
preflight failure retains the working child, pauses and preserves history.
After successful preflight it captures native q/qd/task time, stops the old child,
starts the replacement and reseeds its controller (`Mpc.warmup`). A successful
switch starts a fresh identified history generation at the captured state and
stays paused. Every prior disk recording remains intact. There is no transfer
of private warm-start state between implementations.

A failed switch stays paused and keeps the prior history generation/file active.
Preflight failure keeps the prior active profile usable. Failure after the old
child has stopped reports no active solver; select a compatible profile to resume. Other mutations are rejected while
switching. Existing plots retain their instances, but current generation-change
rules still clear the pinned Solve. This feature adds no historical-generation
browsing UI and does not broaden stale-generation plot acceptance.

## Compatibility and provenance

Whether a module exists for the profile's `MpcParams` is `tiago_mpc`'s
`find_binary` lookup; `tiago_mpc` and GATO own the cache keys. Coordinate
compatibility is checked separately: native joint order, dimensions, units, actuator-torque semantics,
reference frame, root transform, end-effector frame and TCP offset must agree.
Different physical model hashes/limits/configurations are explicitly recorded;
intentional predictor differences do not change the fixed simulator.

The child returns `tiago_mpc`'s native `Plan` states and knot torques; `Mpc`
applies the joint-6 GPU signs. Historical plans keep their recorded signs. Plan
statistics come from `Plan.stats`, the per-iteration diagnostics from
`mpc.step`. Every solve records profile/process identity, source/model
identities, effective solver configuration, bounds, predictor dynamics, actual
binary path/hash/native source ID and inspection capabilities. States and applied
controls carry the profile/process identity and exact plan sequence association.

## HTTP and local settings

- `GET /api/solver-profiles` returns `profiles`, `active_profile_id`,
  `simulator_source`, `switch` and `generation`.
- `POST /api/solver-profiles` accepts `{profile: {id, name, mpc_root, python?,
  cache?}}` and saves it in `visualizer.json.solver_profiles`. The reserved
  `simulator` profile follows Source / Build. Cache defaults to the selected
  project's cache. Saving does not load a solver or compile.
- `POST /api/solver-profiles/activate` accepts `{profile_id, anchor?}` and returns
  HTTP 202 `{state: "switching", profile_id}`. The optional anchor contains
  native `q`, `qd`, and `sim_time_s`; omission uses the committed simulation tip.
- SSE `solver_profile` events contain `state: "active" | "failed"`, `profile_id`,
  `generation`, optional `error`, and on failure `active_profile_id` (retained
  previous profile after preflight rejection, null after replacement failure). Success refreshes `/api/live/schema` for
  compatible knot counts and preserves current Live settings. An unavailable
  current N fails explicitly; there is no automatic N substitution.
- Catalog `switch.state` is `idle`, `switching` or `failed`. `idle` with the
  requested `active_profile_id` confirms success when SSE is unavailable.

## Inspection extension boundary

RPC operations are `bootstrap`, `configure`, `reset`, `solve`, `inspect`, and `close`.
The same request envelope can host inspection work with captured native state,
exact reference/configuration, explicit cold initialization, a finite SQP cap
and an optional wall budget. Configuration reports `capabilities.iteration_capture`
only when both Python and native APIs support it; `exact_resume` is false.
Capture support is checked against the actual selected Python/native module.
The implemented orchestration and cold-start limits are in [inspection.md](inspection.md).

An inspection operation must retain full trajectory traces as binary artifacts
in the RAM-backed runtime directory (`solve-inspections/`, kept while their source
is current; see [inspection](inspection.md)) and return a compact descriptor. Never transport all iteration trajectories through JSON RPC or plot
context. Plot readers load the binary trace; only the selected iteration's
prediction and small iteration-index/status metadata cross HTTP. Inspection
results remain separate from applied plans and never advance the plant.
