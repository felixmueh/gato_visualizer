# ADR 001: Share the native execution loop

Status: accepted, 2026-11-03. Supersedes the 2026-10-21 independent scheduler
and the 2026-10-27 Schedule-only reuse decision.

Live and experiments use `tiago_mpc.loops.run_virtual_time` with a required native
`VirtualTimeSettings` object. It owns command/update periods, solve latency,
compensation, maximum plan age and effort handling. Duration is a separate
required invocation argument; Live uses `None` for its retained callback-gated
run. Scheduling,
pending-plan activation, command evaluation, horizon/age validity, plant
integration and latency prediction have one implementation. The predictor
uses the same command law and effort handling as actual execution, with private
state for hypothetical commands. It remains in the numerical path because its
output is the next solve's input.

The native loop offers small typed callbacks: Tick, SolveCompleted and Event,
plus a before-command boundary callback and a cancellation predicate. A
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
torque arrays, and `VirtualTimeSettings.effort_handling` defaults to
`EffortClip`. Live passes the watched limits to `EffortClip` when clipping is
enabled and `None` otherwise; experiments may select `RejectOnEffort` or another
effort-handling callable. The physical robot keeps its stricter safety policy.
Live disables optional age expiry by default (`max_plan_age_s`
null), while the finite plan horizon still applies. The old implicit hold of
the final command is removed.

The numerical coordinator and persistent solver remain separate processes for
all profiles, including matching sources. The co-location draft was removed.
The shared loop submits requests without waiting and integrates the plant under
the existing plan up to the first possible activation boundary. It then waits
for the result if necessary. Measured latency uses the next possible command
tick as a conservative barrier; declared zero latency waits immediately.
Observers can request `quiesce_at` before a blocking report/pause callback.

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
