# ADR 002: Isolate solver state and explicit inspection

Status: accepted; records implemented profile and inspection decisions.

Native solves can hold the Python GIL, and loaded Python/CUDA modules cannot be
safely replaced in place. Keep HTTP/history, the simulation coordinator, the
persistent optimizer child and CPU plot evaluation in separate ownership domains.
A solver profile selects a prepared interpreter/source/cache; activating it
replaces the optimizer child under GPU leases and begins a new history segment.
Private warm state is never transferred between implementations.

Amendment, 2026-11-03: isolation remains, with asynchronous numerical requests
and shared control arrays. The coordinator's native loop integrates the plant
while the solver works, and waits at a potential activation boundary. Full
captures go to a separate RAM ring drained by a CPU ingestion process. It copies
raw bytes into a byte-bounded queue before history does FK/JSON processing;
presentation delays therefore consume buffer capacity before slowing simulation.
The ring and queue each default to 256 MiB, with explicit startup budgets. There is
no automatically selected in-process solver path. Pause quiesces GPU work and
retains pending activation/controller state. Cancel wakes and joins the run,
finishes/discards outstanding work and releases uncommitted recordings before
replacement. Reset/settings/profile changes configure a fresh controller.

Run again needs authentic intermediate data without mutating the episode's
controller. Pause Live at a committed boundary, retain its idle child, and run a
separate cold inspection solver from captured problem inputs. Only one GPU job
runs at a time. Explicit inspection Stop may terminate that temporary child;
ordinary Pause/cancel remains cooperative. The extra idle CUDA context consumes
resources. Full traces stay binary; CPU plots decode only the selected snapshot.

Exact optimizer checkpoint/resume is unavailable. A captured final trajectory
is insufficient to claim exact continuation or reproduce the original warm
initialization. Missing state, reference or installed bounds makes Run again
unavailable; do not reconstruct them from display geometry or limits.

Lifecycle and lease details: [solver-profiles.md](../solver-profiles.md).
Cold inspection, capture limits and Stop: [inspection.md](../inspection.md).
