# tiago_mpc refactor integration — 2026-10-26

The visualizer now targets committed tiago_mpc `56db0fd`. The clean
`../tiago_mpc-visualizer-base` (`visualizer/base`) advanced from `9dbde7f`
with a fast-forward; its own container uv environment was synced from the lock.
The tiago_mpc main checkout's local ROS changes and refactor notes were not copied
or edited. Visualizer edits remain uncommitted, alongside existing local work.
A pre-edit source snapshot is under `_expr_data/refactor-20261026/baseline/`.

## Current integration

- State and Plan come from `tiago_mpc.interfaces`.
- Build each native plant with `SimConfig(q=..., qd=..., substep=...,
  integrator=..., friction=...).build()`, then start a fresh
  `VirtualClock(sim_time_s)` on Reset/anchor/rollback. MPC isolation, native
  coordinates and the joint-6 GPU boundary are unchanged.
- Native parameters use `record.to_dict` / `from_dict`. Fixed dataclass `type`
  tags are retained in settings, worker RPC and recorded problem configuration;
  schema validation requires their exact values and the UI does not expose them
  as controls. Friction-law identity survives (`Tanh`, `Sign`, `StickSlip`).
- Source and GATO metadata use public `record.provenance()["gato"]`. Source
  checks require SimConfig, VirtualClock, interfaces and native serialization;
  there is no old-API fallback or automatic compilation.
- The conformance reference composes `run_virtual_time`, `SampleKnot`,
  `SimConfig` and `RunRecord`; it reads native ticks/plans/metadata and uses
  explicit zero solve latency. Its reference MPC is constructed from an
  already located binary, never compiled implicitly.
- Portable NPZ v1 remains supported. The current upstream RunRecord exporter is
  exercised in a CPU roundtrip with typed predictor friction and MPC bounds.
  Historical untyped captured problems cannot Run again; they remain viewable.
  No historical recordings or frozen data were rewritten.

The visualizer retains its own simulation/control/TO schedule, no SQP wall-time
limit by default, reseed warm-up, hold-last policy, effort clipping and breach
handling. This API migration preserves Live's explicit joint-speed L1 arrival
rule and Euler-only plant-friction UI. Upstream Reach now uses grasp speed and
its plant supports more friction/integrator combinations; those are separate
behavior choices, not silently adopted here. Run again still requires a native
capture-capable profile; PyPI GATO0.1.5 does not supply trajectory capture.

## Completed verification

- 298 Python CPU tests pass, including current RunRecord export, native parameter
  tags/validation, source probing, plant reset/rollback and solver boundary tests.
- 373 JavaScript tests pass; production bundle builds.
- Native GPU conformance: 300 knot intervals / three simulated seconds,
  1501 command-tick states. States, commands, plan states and plan torques match
  upstream bit for bit (all maximum differences zero). Default loss-free N32,
  500 Hz commands, 100 Hz updates, 1 ms physics, warm-up enabled. This is a
  diagnostic correctness check, not a timing, convergence or friction qualification.
- Browser: current native schema/preview, hidden type metadata, lock-free
  viewport guard, short closed-loop precalculation, Freeze/replay, Replay mode
  and Reset pass with no page errors.
- One bounded independent review found no confirmed issues.

Logs, native raw records, comparison JSON and browser scripts/screenshots are
under `_expr_data/refactor-20261026/`. `conformance-native/comparison.json`
records the binary and configuration. Prior browser automation mistakes
(hidden popover input and an incorrect stats-field assertion) are retained as
separate attempt logs; neither was a production failure.

## Running services

Main's service on8090 was restarted through Source Apply against the unchanged
selected base path. The existing8093 link now runs the updated main visualizer
sources and retains its previous private replay/config paths. Both report native
MpcParams metadata and the current clean source. Existing browser pages reload
on backend identity change; manually reload if necessary. The private8094
browser-check server is stopped after verification.
