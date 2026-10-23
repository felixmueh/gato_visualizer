# ADR 003: Retain all numerical history and batch presentation

Status: accepted; records the implemented history/reporting/playback decisions.

Latest-value events are useful for status but cannot supply complete executed
motion, deadline intervals or inspection data. Retain every committed plan,
control update, recorded state and timing interval in the run's history.
Batch publication at a wall-clock report cadence and split reports into bounded
IPC packets. The parent commits each packet before notifying clients; SSE notices
may coalesce because clients fetch cursor pages from authoritative history.
Backpressure may slow generation, never silently discard committed records.

Browser playback follows recorded simulation timestamps at 1x. Buffering uses
received simulation-time lead, never computational progress or network arrival
as a replacement clock. Defaults are 20 Hz reports, 200 ms buffering and sample
hold; optional interpolation changes display only. Runtime presentation edits
preserve settings version, history generation and private controller state.

Numerical TO/control/simulation rates and knot spacing remain independent.
Finite jobs have explicit capacity limits; continuous history grows on disk.
A slow numerical boundary can delay publication, and neither bounded packets
nor larger HTTP pages guarantee real-time throughput.

Amendment (Felix, 2026-10-23; replaces the same day's `record_every` amendment):
the history records at the control events, every command, plan and interval and
the state at every command tick and TO update; physics steps between them are
simulated, not recorded. This is the recording rule, never backpressure:
reporting and IPC still discard nothing that was recorded. Context constant
within a segment is written once, in the segment header, not with every record.
Only the current run is kept, in RAM-backed runtime files, so continuous history
grows in RAM, not on disk. See [recording](../execution-api.md#recording),
[segment header](../execution-api.md#segment-header) and
[runtime files](../execution-api.md#runtime-files).

Current limits/defaults: [presentation.md](../presentation.md).
History cursors and interval timing: [execution-api.md](../execution-api.md).
