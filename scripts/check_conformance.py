#!/usr/bin/env python3
"""Opt-in GPU conformance of the visualizer's Live loop with tiago_mpc's own reach.

Runs experiments.reach.reach(SimPlant(substep=.001), Mpc(TIAGO), run_simulation) in
this process, then the visualizer's SimulatorAdapter, solver child and
MultirateSession at 1000/100/100 Hz from the same start, target and MpcParams, and
compares the states at every command tick, the commands and the plans. Both use
tiago_mpc's Mpc and SimPlant; this checks the visualizer's scheduling, hold law and
process boundary against run(). Timing is excluded. Run it with the selected
checkout's interpreter while the GPU is free: it takes the experiment locks.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from execution_session import DEFAULT_EXECUTION, MultirateSession
from live_mpc import GPULocks, build_schema, import_tiago
from source_runtime import probe_selection, resolve_selection
from visualizer_config import DEFAULT_MPC_ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mpc-root", type=Path, default=Path(os.environ.get("TIAGO_MPC_ROOT", DEFAULT_MPC_ROOT)))
    parser.add_argument("--steps", type=int, default=10, help="command ticks of 10 ms")
    parser.add_argument("--atol", type=float, default=1e-9)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.steps <= 100:
        parser.error("--steps must be in [1, 100]")
    output = (args.output or ROOT / "_expr_data/conformance" /
              datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")).resolve()
    if not output.is_relative_to(ROOT / "_expr_data"):
        parser.error("--output must be beneath this visualizer's _expr_data")
    output.mkdir(parents=True, exist_ok=False)
    root = args.mpc_root.expanduser().resolve()
    selection = resolve_selection(root, python=sys.executable, cache=os.environ.get("GATO_CACHE_DIR"))
    os.environ["GATO_CACHE_DIR"] = selection["cache"]
    import_tiago(root)
    sys.path.insert(0, str(root))  # tiago_mpc's experiments package
    from experiments.reach import Reach, reach
    from tiago_mpc.mpc import TIAGO, Mpc, find_binary
    from tiago_mpc.sim import SimPlant
    if TIAGO.dt_s != .01:
        parser.error("The comparison assumes the default 10 ms knot interval")
    binary = find_binary(TIAGO)
    if binary is None:
        parser.exit(2, "Not compiled: build the default N loss-free module first\n")
    locks = GPULocks(root)
    if not locks.acquire():
        parser.exit(2, "GPU is busy: experiment locks are held\n")
    adapter = None
    try:
        duration = args.steps * TIAGO.dt_s
        mpc = Mpc(TIAGO, binary)
        record = reach(SimPlant(substep=.001), mpc, out=output / "reference", duration=duration)
        expected = record.trajectory
        del mpc, record

        from solver_adapter import SimulatorAdapter
        profile = dict(id="conformance", name="Conformance", **{key: selection[key] for key in ("mpc_root", "python", "cache")})
        schema = build_schema(probe_selection(profile), root)
        adapter = SimulatorAdapter(root)
        adapter.gpu_locks = locks
        adapter.select_profile(profile, schema)
        config = schema["defaults"]["config"]
        adapter.configure(config, dict(kind="reach", target_offset_m=[0., 0., 0.]))
        np.testing.assert_allclose(adapter.target, Reach().target_m, rtol=0, atol=1e-12)
        session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, simulation_hz=1000., control_hz=100., to_hz=100.))
        records = [session.initial_state()]
        while adapter.t < duration - 1e-12:
            records.extend(session.advance_interval(duration))
        states = {round(r["sim_time_s"], 9): np.asarray(r["_x"]) for r in records if r["type"] == "state"}
        ticks = expected["time_s"]
        actual = dict(state=np.array([states[round(t, 9)] for t in ticks]),
                      command=np.array([r["torque_nm"] for r in records if r["type"] == "control"]),
                      plan_states=np.array([r["_states"] for r in records if r["type"] == "plan"]),
                      plan_torques=np.array([r["_torques"] for r in records if r["type"] == "plan"]))
        np.savez_compressed(output / "visualizer.npz", time_s=ticks, **actual)
        sent = np.isfinite(expected["command"]).all(axis=1)
        reference = dict(state=expected["state"], command=expected["command"][sent],
                         plan_states=expected["plan_states"], plan_torques=expected["plan_torques"])
        checks = {key: dict(shape_equal=reference[key].shape == actual[key].shape,
                            max_abs_difference=float(np.max(np.abs(reference[key] - actual[key])))
                            if reference[key].shape == actual[key].shape else None)
                  for key in reference}
        passed = all(c["shape_equal"] and c["max_abs_difference"] <= args.atol for c in checks.values())
        result = dict(passed=passed, atol=args.atol, steps=args.steps, checks=checks, binary=str(binary),
                      params=json.loads(json.dumps(config)),
                      note="Diagnostic conformance only; no timing or convergence claim")
        (output / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
        print(f"Raw outputs retained: {output}")
        return 0 if passed else 1
    finally:
        # Destroy the solver child while the comparison still owns the GPU.
        if adapter is not None:
            adapter.close_solver()
        locks.release()


if __name__ == "__main__":
    raise SystemExit(main())
