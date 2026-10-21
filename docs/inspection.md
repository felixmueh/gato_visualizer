# Episode and Solve inspection

Design decisions agreed with Felix on 2026-10-21. This is a specification, not a
claim that the inspection UI or new solver diagnostics are implemented.
Canonical terminology is in [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md).

## Source and inspection context

Keep one active source, obtained through Live computation or Replay. Replace
the Graphs inspection tab with Episode and Solve tabs. An MPC episode may
provide saved solves; a standalone solve is also a valid source. Episode
inspection is unavailable when no episode accompanies a standalone solve.

The Episode tab hosts episode plots and aggregates. The Solve tab hosts the
selected solve's plots, diagnostics and iteration controls. Changing inspection
tabs does not itself start computation, pause execution, or change the main
timeline's clock. Selecting a solve changes the inspected prediction without
rewriting recorded episode motion.

## Episode analysis range

The Episode header selects Entire episode (default), Through cursor, or Visible
window. Entire episode means all currently available active history, including
precalculated samples beyond the playback cursor. Through cursor begins at the
active segment's first sample. Visible window follows the explicitly selected
timeline window. Zoom otherwise changes presentation, not aggregate scope.

## Solve selection and pinned state

Follow cursor selects the recorded solve associated with the displayed episode
state/control sample. Prefer the recorded plan association; any timestamp-based
fallback must be explicit rather than silently substituting the newest solve.
Preview solves remain distinguishable from recorded controller solves.

Pin solve freezes the selected solve and its SQP iteration selection while the
episode cursor and Live computation can continue. Show a persistent muted-red
badge/border and visible Pinned text with the solve identity and episode
timestamp where available. Colour is supplemental to the text and toggle state.
Returning to Follow cursor clears the pinned treatment. Plot placement on the
timeline uses the label Show on timeline to distinguish it from Pin solve.

## Per-solve cursor: SQP iterations

The solve cursor selects a discrete SQP iteration, not time. Show the initial
guess as Seed when available, then recorded SQP iterations with their actual
indices and statuses. Do not invent intermediate records to fill the requested
iteration cap. A rejected step or early stop can legitimately have no new
trajectory snapshot.

Selecting an iteration updates graph markers on iteration-index plots, the
iteration-specific data of other solve plots, and the 3D prediction when that
iteration's trajectory was recorded. Missing trajectories or metrics remain
explicitly unavailable; do not substitute the final trajectory as though it
belonged to every iteration. Solver-iteration selection does not advance the
robot's recorded episode state.

Prediction-horizon scrubbing is deferred. Horizon-time profiles may still show
the selected iteration's predicted positions/velocities/controls, but no second
horizon cursor or prediction playback is introduced by this design.

Recommended control placement, still a UI proposal: a compact, labelled SQP
iteration strip at the top of the Solve inspector, with previous/next buttons,
Seed / iteration k of K, and a horizontal slider. Keep it distinct from the
episode's bottom timeline. Explicit manipulation should pin the selected solve
so incoming Live solves do not replace it mid-inspection; this automatic pinning
detail remains a proposal rather than an implemented rule.

## Continue SQP

Continue SQP requests an additional per-solve iteration budget beyond the
original cap. It preserves the selected solve's initial robot state, exact
reference, model, bounds and problem settings. It does not change global Live
defaults, advance the plant or episode clock, or retroactively replace an
episode's historically applied plan. Preserve the original solve and result;
retain a linked inspection continuation containing the additional work.

Record requested additional iterations separately from actual completed
iterations and stop reason. Preserve the solver's existing stopping behavior;
an additional budget is an upper bound, not a demand to disable stopping.

The proposed default is to continue from the latest available checkpoint of
the selected solve. Continuing from an earlier scrubbed iteration would require
an explicit From iteration k action and a checkpoint at that iteration; this
choice remains open. A trajectory snapshot alone is not a complete optimizer
checkpoint. A fresh warm-seeded solve must be named as such rather than offered
as an exact continuation.

## Current diagnostic capability boundary

At GATO 37a6768d575c4a09e2ec90e51a7c4029568e3fec, the public API exposes the
final predicted trajectory, initial/final merit, and some per-SQP merit,
line-search and PCG statistics when enabled. The visualizer currently retains
the final trajectory and summary counts, not those detailed traces.

The public API does not expose per-SQP trajectory snapshots or complete
checkpoint/restore/resume. The SQP cap is constructor-sized, including native
telemetry allocation, so changing a Python parameter does not extend an
existing solver instance. Repeating solve with a saved trajectory is a new
warm-seeded invocation with different initialization/finalization semantics.

Full iteration scrubbing and exact continuation therefore require separately
implemented recording/session support. UI availability and plot requirements
must describe recorded capabilities accurately, including imported data with
only a final result. This document authorizes no solver algorithm change or
silent substitution for missing diagnostic data.

## Consequences for the plotting contract

- A plot declares Episode and/or Solve input context and required/optional data.
- Episode time, SQP iteration, prediction-horizon time and measured wall time
  remain explicit axis identities.
- The host owns the episode cursor, selected/pinned solve, SQP iteration cursor
  and episode analysis range; plugin parameters are separate user inputs.
- Iteration-history plots follow the SQP cursor with a graph marker. Plots of
  the selected iteration's prediction change their data when it changes.
- Episode-time plots can share the episode timeline. An SQP-index plot cannot
  be placed on that timeline as though its index were elapsed seconds.
- Plot computations are read-only; Continue SQP is a Solve-inspector action,
  not an effect of evaluating a plot.
- Standard and custom plots use the same contract and availability rules.
