#!/usr/bin/env python3
"""Opt-in GPU conformance of the visualizer's Live loop with tiago_mpc's own reach.

Runs run_virtual_time with SimConfig(substep=.001), a prebuilt Mpc(params),
SampleKnot and a declared 5.5 ms solve latency in this process, then the visualizer's SimulatorAdapter, solver child and
MultirateSession from the same start, target and MpcParams (Live's defaults: TIAGO
without the SQP wall-time limit, warm-up on) and an explicitly loss-free RK4 plant
on both sides, independently of Live's plant defaults, and compares the states at every command
tick, the commands and the plans. The rates are the reach's defaults: commands every
2 ms (500 Hz), a control update every knot (100 Hz), physics on a 1 ms grid. The
session records the state at every command tick and every command, as in Live. run_virtual_time
warms up from the start state before its first tick; the session's configure reseeds
the same way (mpc.warmup in the solver child). Both use tiago_mpc's Mpc and SimPlant;
this checks the visualizer's scheduling, hold law, reseed and process boundary against
run_virtual_time. The default reach arrives quickly, so the reference reach gets a zero position
tolerance: it never arrives and runs for the whole duration (default 3 s). Both
sides include the declared solve delay; wall-clock performance is not compared. Run it with the selected checkout's interpreter while the GPU is free: it
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
import traceback

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from execution_session import DEFAULT_EXECUTION, MultirateSession
from live_mpc import GPULocks, build_schema, import_tiago, mpc_params, start_pose_spec
from source_runtime import probe_selection, resolve_selection
from visualizer_config import DEFAULT_MPC_ROOT

COMMAND_PERIOD_S = .002
SOLVE_LATENCY_S = .0055  # intentionally between command ticks: activation at 6 ms


def reference_plant(config, accumulated_ticks=False):
    """Build the native plant, optionally normalizing advances to Live's 1 ms grid."""
    from tiago_mpc.sim import SimPlant

    class GridPlant(SimPlant):
        # The loop accumulates command tick times while Live advances to origin +
        # k/rate. Splitting both into the same 1 ms endpoints avoids float32
        # optimizer amplification of ulp-sized substep differences.
        def advance(self, t):
            for k in range(round(self.t * 1000) + 1, round(t * 1000) + 1):
                super().advance(k / 1000)

    return config.build() if accumulated_ticks else GridPlant(config)


def run_reference(plant, mpc, task, output, duration):
    """Record the current native loop without compiling or owning the passed MPC."""
    from tiago_mpc.laws import SampleKnot
    from tiago_mpc.loops import VirtualTime, run_virtual_time
    from tiago_mpc.record import RunRecord
    law = SampleKnot()
    timing = VirtualTime(command_period=COMMAND_PERIOD_S, update_period=mpc.dt, solve_latency_s=SOLVE_LATENCY_S)
    record = RunRecord(output, task=task, params=mpc.params, plant=plant.config,
                       law=law, timing=timing, duration=duration)
    try:
        outcome = run_virtual_time(plant, mpc, task, law, [record],
                                   command_period=timing.command_period,
                                   update_period=timing.update_period,
                                   duration=duration, solve_latency_s=timing.solve_latency_s)
        record.metadata.update(status=outcome.status, reason=outcome.reason, end_t=outcome.t)
    except BaseException as error:
        record.metadata.update(status="interrupted" if isinstance(error, KeyboardInterrupt) else "error",
                               error=traceback.format_exc())
        raise
    finally:
        record.add_events(plant.take_events())
        record.save()
    return record


def reference_arrays(record):
    """The native RunRecord read interface, excluding ticks with no sent command."""
    ticks, plans = record.ticks, record.plans
    sent = np.isfinite(ticks["command"]).all(axis=1)
    return ticks["t"], dict(state=np.column_stack((ticks["q"], ticks["qd"])),
                            command=ticks["command"][sent], plan_states=plans["states"],
                            plan_torques=plans["torques"])


def compare_arrays(expected, got, atol):
    if expected.shape != got.shape:
        return dict(shape_equal=False, max_abs_difference=None)
    rows = np.abs(expected - got).reshape(len(expected), -1).max(axis=1) if len(expected) else np.array([])
    beyond = np.flatnonzero(rows > atol)
    return dict(shape_equal=True, max_abs_difference=float(rows.max(initial=0.)),
                first_row_beyond_atol=int(beyond[0]) if len(beyond) else None,
                max_abs_difference_before_it=float(rows[:beyond[0]].max(initial=0.)) if len(beyond) else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mpc-root", type=Path, default=Path(os.environ.get("TIAGO_MPC_ROOT", DEFAULT_MPC_ROOT)))
    parser.add_argument("--steps", type=int, default=300, help="knot intervals of 10 ms")
    parser.add_argument("--atol", type=float, default=1e-3)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--accumulated-ticks", action="store_true",
                        help="keep run_virtual_time's accumulated tick times instead of the 1 ms grid")
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
    if selection["cache"]:  # an explicit override; else tiago_mpc's default
        os.environ["GATO_CACHE_DIR"] = selection["cache"]
    import_tiago(root)
    sys.path.insert(0, str(root))  # tiago_mpc's experiments package
    from experiments.reach import Reach
    from tiago_mpc.mpc import TIAGO, Mpc, find_binary
    from tiago_mpc.record import from_dict
    from tiago_mpc.sim import SimConfig
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

        plant = reference_plant(SimConfig(substep=.001), args.accumulated_ticks)
        try:
            record = run_reference(plant, mpc, task, output / "reference", duration)
        finally:
            plant.close()
            mpc.close()
        ticks, reference = reference_arrays(record)
        expected_status = record.metadata["status"]
        del mpc, record

        from solver_adapter import SimulatorAdapter
        profile = dict(id="conformance", name="Conformance", **{key: selection[key] for key in ("mpc_root", "python", "cache")})
        schema = build_schema(probe_selection(profile), root, start_pose_spec(import_tiago(root)))
        adapter = SimulatorAdapter(root)
        adapter.gpu_locks = locks
        adapter.select_profile(profile, schema)
        # Preserve this loss-free RK4 comparison independently of the interactive
        # plant's constraint-friction defaults. The reference above is loss-free.
        defaults = schema["defaults"]["config"]
        config = dict(defaults, plant=dict(defaults["plant"], integrator="rk4", friction=False))
        if from_dict(mpc_params(config)) != params:
            parser.error("Live's default MpcParams differ from the reference's")
        adapter.configure(config, dict(kind="reach", target_offset_m=[0., 0., 0.]))
        np.testing.assert_allclose(adapter.target, task.target_m, rtol=0, atol=1e-12)
        session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, simulation_hz=1000.,
                                                 control_hz=1 / COMMAND_PERIOD_S, to_hz=1 / params.dt_s,
                                                 solve_latency_s=SOLVE_LATENCY_S))
        records = [session.initial_state()]
        while adapter.t < duration - 1e-12:
            records.extend(session.advance_interval(duration))
        states = {round(r["sim_time_s"], 9): np.asarray(r["_x"]) for r in records if r["type"] == "state"}
        actual = dict(state=np.array([states[round(t, 9)] for t in ticks]),
                      command=np.array([r["torque_nm"] for r in records if r["type"] == "control"]),
                      plan_states=np.array([r["_states"] for r in records if r["type"] == "plan"]),
                      plan_torques=np.array([r["_torques"] for r in records if r["type"] == "plan"]))
        np.savez_compressed(output / "visualizer.npz", time_s=ticks, **actual)
        checks = {key: compare_arrays(reference[key], actual[key], args.atol) for key in reference}
        passed = all(c["shape_equal"] and c["max_abs_difference"] <= args.atol for c in checks.values())
        result = dict(passed=passed, atol=args.atol, steps=args.steps, accumulated_ticks=args.accumulated_ticks,
                      plant_case="loss_free_rk4",
                      command_period_s=COMMAND_PERIOD_S, update_period_s=params.dt_s, reference_status=expected_status,
                      solve_latency_s=SOLVE_LATENCY_S,
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
