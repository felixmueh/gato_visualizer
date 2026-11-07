# ADR 001: Share the native execution loop

Status: accepted, 2026-11-03. Supersedes the 2026-10-21 independent scheduler
and the 2026-10-27 Schedule-only reuse decision.

Live and experiments use `tiago_mpc.loops.run_virtual_time` with a required native
`VirtualTimeSettings` object. It owns only command/update periods and solve latency.
Compensation, safety and effort handling are explicit invocation arguments. Duration is a separate
required finite invocation argument. Live uses a finite maximum duration for its
retained callback-gated run, relaxing the experiment duration guard only in its
simulation process. Scheduling,
pending-plan activation, command evaluation, horizon/age validity, plant
integration and latency prediction have one implementation. The predictor
uses the same command law and effort handling as actual execution, with private
state for hypothetical commands. It remains in the numerical path because its
output is the next solve's input.

The native loop offers separate typed callback sequences for Tick,
SolveCompleted and Diagnostic, plus before-tick callbacks and a cancellation predicate. A
SolveCompleted observation exists for every returned plan, even if it never
commands. The simulated plant observes physics endpoints and queues breach
events until the next command boundary. This requires no event broker.

`NativeSession` runs one invocation on a retained coordinator thread. Its
callback parks to pause or report bounded batches. Ordinary resume preserves
pending plans and warm state. Cancel sets a flag, wakes the callback and joins
the invocation; reset/reconfiguration builds fresh execution and controller
state. On Play pacing and wall-time-anchor rebasing remain visualizer concerns.
No special pause memory management is introduced.

Virtual plans are validated for shape and finite values. Command laws return
native `Command | Fault`, and the loop's separate `effort_handling` argument defaults to
`EffortClip`. Handlers receive `Command` and return `Command | Fault`.
Live passes the watched limits to `EffortClip` when clipping is
enabled and `None` otherwise; experiments may select `RejectOnEffort` or another
effort-handling callable. The physical robot keeps its stricter safety policy.
Live uses `ExecutionSafety(max_plan_age_s=None)` to disable optional age expiry.
The native default safety uses a 100 ms age limit. Custom objects can implement
structural `SafetyInterface.validate(plan, t, state) -> Fault | None`, while the
finite plan horizon always applies. The old implicit hold of
the final command is removed.

The numerical coordinator and persistent solver remain separate processes for
all profiles, including matching sources. The co-location draft was removed.
The shared loop submits requests without waiting and integrates the plant under
the existing plan up to the first possible activation boundary. It then waits
for the result if necessary. Measured latency uses the next possible command
tick as a conservative barrier; declared zero latency waits immediately.
Before-tick callbacks may block to pause before collecting an outstanding solve.
Its reply remains unread until resume. The coordinator closes its borrowed GPU
descriptors on pause; the child retains the shared lock until its work finishes.

Recurring control uses preallocated shared arrays and small socket notifications.
A separate bounded RAM recording ring carries complete numerical captures to
the history process; it applies backpressure and retains slots until consumed,
including across run retirement. Statistics conversion, FK and JSON run there.
The current forecast is unchanged. Native resource costs and physics overlap,
so total active wall time is measured directly rather than summed.

The [handoff](../handoff-live-500hz-throughput.md) links measurements of the
intermediate synchronous path and the asynchronous trial. None establishes
universal throughput parity or real-time operation for every solver configuration.

Contract: [execution-api.md](../execution-api.md).
Ownership and verification: [architecture.md](../architecture.md).
