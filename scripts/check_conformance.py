#!/usr/bin/env python3
"""Opt-in GPU conformance of the visualizer's Live loop with tiago_mpc's own reach.

Runs experiments.reach.reach(SimPlant(substep=.001), Mpc(params), run_simulation) in
this process, then the visualizer's SimulatorAdapter, solver child and
MultirateSession from the same start, target and MpcParams (Live's defaults: TIAGO
without the SQP wall-time limit, warm-up on), and compares the states at every command
tick, the commands and the plans. The rates are the reach's defaults: commands every
2 ms (500 Hz), a control update every knot (100 Hz), physics on a 1 ms grid. run()
warms up from the start state before its first tick; the session's configure reseeds
the same way (mpc.warmup in the solver child). Both use tiago_mpc's Mpc and SimPlant;
this checks the visualizer's scheduling, hold law, reseed and process boundary against
run(). The default reach arrives quickly, so the reference reach gets a zero position
tolerance: it never arrives and runs for the whole duration (default 3 s). Timing is
excluded. Run it with the selected checkout's interpreter while the GPU is free: it
takes the experiment locks.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
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

COMMAND_PERIOD_S = .002  # the reach's default command period (experiments/common.py, run_experiment)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mpc-root", type=Path, default=Path(os.environ.get("TIAGO_MPC_ROOT", DEFAULT_MPC_ROOT)))
    parser.add_argument("--steps", type=int, default=300, help="knot intervals of 10 ms")
    parser.add_argument("--atol", type=float, default=1e-9)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--accumulated-ticks", action="store_true",
                        help="keep run()'s accumulated tick times (deadline += period) instead of the 1 ms grid")
    args = parser.parse_args()
    if not 1 <= args.steps <= 800:
        parser.error("--steps must be in [1, 800] (the reach's 8 s timeout)")
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
    from tiago_mpc.mpc import TIAGO, Mpc, MpcParams, find_binary
    from tiago_mpc.sim import SimPlant
    params = replace(TIAGO, max_sqp_time_s=None)  # the simulation clock: no wall-time limit
    if not params.warmup:
        parser.error("The comparison covers the default warm-up")
    if params.dt_s != .01:
        parser.error("The comparison assumes the default 10 ms knot interval")
    binary = find_binary(params)
    if binary is None:
        parser.exit(2, "Not compiled: build the default N loss-free module first\n")
    locks = GPULocks(root)
    if not locks.acquire():
        parser.exit(2, "GPU is busy: experiment locks are held\n")
    adapter = None
    try:
        duration = args.steps * params.dt_s
        mpc = Mpc(params, binary)
        task = Reach(position_tol_m=0.)  # never arrives: compare the whole duration

        class GridPlant(SimPlant):
            """run() accumulates its tick times (deadline += period) and SimPlant its substeps
            (t + h); MultirateSession steps to origin + k/rate. The substep lengths then differ
            by an ulp, and GATO's float32 solve amplifies that round-off after about a hundred
            plans. This plant steps run()'s ticks on the session's 1 ms grid, k/1000."""
            def advance(self, t):
                for k in range(round(self.t * 1000) + 1, round(t * 1000) + 1):
                    super().advance(k / 1000)

        plant = (SimPlant if args.accumulated_ticks else GridPlant)(substep=.001)
        record = reach(plant, mpc, task=task, out=output / "reference", duration=duration,
                       command_period=COMMAND_PERIOD_S, update_period=params.dt_s)
        expected, expected_status = record.trajectory, record.summary["status"]
        del mpc, record

        from solver_adapter import SimulatorAdapter
        profile = dict(id="conformance", name="Conformance", **{key: selection[key] for key in ("mpc_root", "python", "cache")})
        schema = build_schema(probe_selection(profile), root)
        adapter = SimulatorAdapter(root)
        adapter.gpu_locks = locks
        adapter.select_profile(profile, schema)
        config = schema["defaults"]["config"]
        if MpcParams.from_dict({key: value for key, value in config.items() if key != "plant"}) != params:
            parser.error("Live's default MpcParams differ from the reference's")
        adapter.configure(config, dict(kind="reach", target_offset_m=[0., 0., 0.]))
        np.testing.assert_allclose(adapter.target, task.target_m, rtol=0, atol=1e-12)
        session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, simulation_hz=1000.,
                                                 control_hz=1 / COMMAND_PERIOD_S, to_hz=1 / params.dt_s))
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
        def check(expected, got):
            if expected.shape != got.shape:
                return dict(shape_equal=False, max_abs_difference=None)
            rows = np.abs(expected - got).reshape(len(expected), -1).max(axis=1)
            beyond = np.flatnonzero(rows > args.atol)
            return dict(shape_equal=True, max_abs_difference=float(rows.max()),
                        first_row_beyond_atol=int(beyond[0]) if len(beyond) else None,
                        max_abs_difference_before_it=float(rows[:beyond[0]].max(initial=0.)) if len(beyond) else None)
        checks = {key: check(reference[key], actual[key]) for key in reference}
        passed = all(c["shape_equal"] and c["max_abs_difference"] <= args.atol for c in checks.values())
        result = dict(passed=passed, atol=args.atol, steps=args.steps, accumulated_ticks=args.accumulated_ticks,
                      command_period_s=COMMAND_PERIOD_S, update_period_s=params.dt_s, reference_status=expected_status,
                      reference_ticks=len(ticks), checks=checks, binary=str(binary),
                      params=json.loads(json.dumps(config)),
                      note="Diagnostic conformance only; no timing or convergence claim")
        (output / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({key: value for key, value in result.items() if key != "params"}, indent=2))
        print(f"Raw outputs retained: {output}")
        return 0 if passed else 1
    finally:
        # Destroy the solver child while the comparison still owns the GPU.
        if adapter is not None:
            adapter.close_solver()
        locks.release()


if __name__ == "__main__":
    raise SystemExit(main())
