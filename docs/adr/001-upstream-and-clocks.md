# ADR 001: Reuse upstream numerics and own execution clocks

Status: accepted; records the 2026-10-21 timing decision.

The visualizer needs responsive previews, precalculation and recorded playback,
while `tiago_mpc` has self-contained experiments and robot timing requirements.
Import its model preparation, complete configuration loader, controller and
`reach_sim.rk4` unchanged. Keep the visualizer's episode loop and independent
simulation/control/TO clocks here; do not require a shared upstream timing engine.
Prediction knot spacing remains separate and upstream warm-start heuristics stay
intact. Slow numerical work reduces wall-clock progress, not simulated duration.

This leaves a small application scheduling adapter to maintain and verify. The
synchronous adapter conformance check covers upstream reuse; scheduler and solver
boundary tests cover production composition. Neither is a general convergence or
performance certificate. The simulator stays fixed across compatible solver
profile changes, and presently uses the loss-free plant.

Implementation and exact timing semantics: [execution-api.md](../execution-api.md).
Source ownership and verification: [architecture.md](../architecture.md).
