# Solver profiles against one simulator

Status: feasibility review and proposed architecture, not implemented.
The current Source / Build dialog selects one complete TIAGo MPC checkout;
Apply restarts the backend and reconstructs its source-bound objects.

## Proposed first version

Keep a fixed simulator profile for a running session: its prepared TIAGo model,
integrator, assets, initial posture and plant parameters define the world.
Initially use an existing `tiago_mpc` checkout. An internally pinned simulator
could come later; maintaining another simulator is not required for switching
solver implementations.

Add named solver profiles, each identifying a `tiago_mpc` checkout/worktree,
Python interpreter and compiled-module cache. Run one active solver in its own
process. Its environment and imports must be isolated from other profiles;
loading two incompatible GATO installations in one Python process is unsuitable.
Existing compatible binaries can be reused without copying or rebuilding them.

Switch while paused. Capture native joint position, velocity and task time,
stop the previous solver process, validate/start the selected profile, and reset
its controller from that state. Keep the simulator, HTTP server and browser
open. Begin an identified history segment; retain old disk recordings and their
source identities. A failed switch stays paused with the existing history intact.
Do not promise to migrate an optimizer's private warm-start state between
implementations.

## Implementation boundary

The numerical coordinator owns simulation, scheduling and GPU arbitration.
Extract the solver part of the current `MPCAdapter` behind a process interface:
native state, reference and configuration go in; native predictions, diagnostics
and source identity come out. Each implementation adapter owns its joint-6 GPU
conversion. The plant must never receive implementation-specific GPU coordinates.

This is a medium backend refactor, not just a profile dropdown. Current
`live_mpc`, `execution_session` and worker code directly combine model setup,
controller construction and simulation. The present numerical worker is a
daemon, so naively spawning another multiprocessing child inside it will fail;
worker supervision must be adjusted deliberately. A coordinator must own the
shared GPU locks and lease work to children, avoiding a child waiting on a lock
already held by its parent. Canonical lock paths cannot depend on a worktree's
different parent directory. Late results from a replaced profile must be rejected.

## Compatibility and provenance

Distinguish binary loadability from robot compatibility. The latter includes
native joint order, units, torque semantics, root/reference frames and grasp TCP.
Record model, limits, friction and solver configuration differences explicitly:
intentional predictor changes can be the point of the comparison, but must not
silently change the fixed plant. Record a solver-profile identity on every solve
and applied plan so switching never relabels older results.

Start with sequential switching and one controller acting on one plant.
Keeping inactive workers warm can reduce subsequent switch latency, at the cost
of memory and lifecycle complexity. Multiple prediction overlays can be added
as sequential shadow solves. Comparing independent closed-loop outcomes needs
separate plant histories; simultaneous GPU execution introduces contention and
is a separate feature.
