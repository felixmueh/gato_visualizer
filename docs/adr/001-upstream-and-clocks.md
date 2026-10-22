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
profile changes. At the original decision, it used the loss-free plant.

Amendment, 2026-10-22: simulator and predictor friction are independently
configurable numerical settings. New UI defaults enable both, with hard-sign
Coulomb plus viscous friction in the simulator and smooth tanh Coulomb plus
viscous friction in the predictor (0.03 rad/s smoothing). The simulator reuses
upstream `joint_dynamics.plant_rk4` when friction is enabled; loss-free settings
retain `reach_sim.rk4`. Configuration changes start a new history segment through
the existing settings transaction. These defaults are not a numerical or physical
qualification. See the [friction contract](../friction.md) for legacy settings,
source provenance and explicit binary preparation.

Implementation and exact timing semantics: [execution-api.md](../execution-api.md).
Source ownership and verification: [architecture.md](../architecture.md).
