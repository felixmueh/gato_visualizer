#!/usr/bin/env python3
"""Compare headless and observed execution of the same native virtual-time loop.

Uses a prebuilt MPC, declared latency, 500 Hz commands and loss-free RK4 plant.
Compares every command-tick state, applied command and returned solve (including
plans never activated). Prediction knot spacing is independent of --to-hz.
No compilation occurs; the shared experiment GPU leases must be free.
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
from execution_session import DEFAULT_EXECUTION
from native_session import NativeSession
from live_mpc import GPULocks, build_schema, import_tiago, mpc_params, start_pose_spec
from source_runtime import probe_selection, resolve_selection
from visualizer_config import DEFAULT_MPC_ROOT

COMMAND_PERIOD_S = .002
SOLVE_LATENCY_S = .0055  # intentionally between command ticks: activation at 6 ms


def reference_plant(config):
    """Use the same native integration grid as the observed path."""
    return config.build()


def run_reference(plant, mpc, task, output, duration, *, to_hz=100., latency=SOLVE_LATENCY_S, compensation=None):
    """Record the current native loop without compiling or owning the passed MPC."""
    from tiago_mpc.laws import EffortClip, ExecutionSafety, SampleKnot
    from tiago_mpc.loops import VirtualTimeSettings, run_virtual_time
    from tiago_mpc.record import RunRecord
    law = SampleKnot()
    timing = VirtualTimeSettings(command_period=COMMAND_PERIOD_S, update_period=1/to_hz,
                                 solve_latency_s=latency)
    safety, effort_handling = ExecutionSafety(max_plan_age_s=None), EffortClip()
    record = RunRecord(output, task=task, params=mpc.params, plant=plant.config,
                       law=law, settings=timing, loop="run_virtual_time", duration=duration,
                       compensation=compensation, safety=safety, effort_handling=effort_handling)
    try:
        outcome = run_virtual_time(plant, mpc, task, law, tick_callbacks=(record,),
                                   settings=timing, duration=duration, compensation=compensation,
                                   safety=safety, effort_handling=effort_handling,
                                   solve_completed_callbacks=(record.solve_completed,),
                                   diagnostic_callbacks=(record.diagnostic,))
        record.metadata.update(status=outcome.status, reason=outcome.reason, end_t=outcome.t)
    except BaseException as error:
        record.metadata.update(status="interrupted" if isinstance(error, KeyboardInterrupt) else "error",
                               error=traceback.format_exc())
        raise
    finally:
        for diagnostic in plant.take_diagnostics():
            record.diagnostic(diagnostic)
        record.save()
    return record


def reference_arrays(record):
    """Command history plus all solves, independently of activation."""
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
    parser.add_argument("--steps", type=int, default=300, help="control-update intervals")
    parser.add_argument("--to-hz", type=float, default=100.)
    parser.add_argument("--solve-latency", type=float, default=SOLVE_LATENCY_S)
    parser.add_argument("--latency-compensation", action="store_true")
    parser.add_argument("--atol", type=float, default=1e-3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 0 < args.to_hz <= 500 or not 1 <= args.steps <= 10000 or args.steps/args.to_hz > 120:
        parser.error("Require 0 < TO Hz <= 500, steps in [1,10000] and duration <= 120 s")
    if args.solve_latency < 0 or not np.isfinite(args.solve_latency):
        parser.error("Solve latency must be finite nonnegative seconds")
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
    from tiago_mpc.record import to_dict
    from tiago_mpc.sim import SimConfig
    params = replace(TIAGO, dt_s=.01, max_sqp_time_s=None)  # the simulation clock: no wall-time limit
    if not params.warmup:
        parser.error("The comparison covers the default warm-up")
    binary = find_binary(params)
    if binary is None:
        parser.exit(2, "Not compiled: build the default N loss-free module first\n")
    locks = GPULocks(root)
    if not locks.acquire():
        parser.exit(2, "GPU is busy: experiment locks are held\n")
    adapter = session = None
    try:
        from tiago_mpc.prediction import LatencyCompensation
        duration = args.steps/args.to_hz
        compensation = LatencyCompensation(latency_s=args.solve_latency) if args.latency_compensation else None
        mpc = Mpc(params, binary)
        task = Reach(position_tol_m=0.)  # never arrives: compare the whole duration

        plant = reference_plant(SimConfig(substep=.001))
        try:
            record = run_reference(plant, mpc, task, output / "reference", duration,
                                   to_hz=args.to_hz, latency=args.solve_latency, compensation=compensation)
        finally:
            plant.close()
            mpc.close()
        ticks, reference = reference_arrays(record)
        np.savez_compressed(output / 'reference.npz', time_s=ticks, **reference)
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
        config = dict(defaults, dt_s=params.dt_s, plant=dict(defaults["plant"], integrator="rk4", friction=False))
        if "cost_weights" in config:
            from native_cost import cost_weights
            config["cost_weights"] = cost_weights(to_dict(params.cost))
        if mpc_params(config) != to_dict(params):
            parser.error("Live's default MpcParams differ from the reference's")
        adapter.configure(config, dict(kind="reach", target_offset_m=[0., 0., 0.]))
        np.testing.assert_allclose(adapter.target, task.target_m, rtol=0, atol=1e-12)
        session = NativeSession(adapter, dict(DEFAULT_EXECUTION, simulation_hz=1000.,
                                                 control_hz=1 / COMMAND_PERIOD_S, to_hz=args.to_hz,
                                                 solve_latency_s=args.solve_latency,
                                                 latency_compensation=args.latency_compensation), duration_s=duration)
        records = [session.initial_state()]
        from solver_exchange import resolve_record
        while not session.finished:
            records.extend(resolve_record(record) for record in session.advance_interval(duration))
        states = {round(r["sim_time_s"], 9): np.asarray(r["_x"]) for r in records if r["type"] == "state"}
        actual = dict(state=np.array([states[round(t, 9)] for t in ticks]),
                      command=np.array([r["torque_nm"] for r in records if r["type"] == "control"]).reshape(-1, 7),
                      plan_states=np.array([r["_states"] for r in records if r["type"] == "plan"]),
                      plan_torques=np.array([r["_torques"] for r in records if r["type"] == "plan"]))
        np.savez_compressed(output / "visualizer.npz", time_s=ticks, **actual)
        checks = {key: compare_arrays(reference[key], actual[key], args.atol) for key in reference}
        passed = all(c["shape_equal"] and c["max_abs_difference"] <= args.atol for c in checks.values())
        result = dict(passed=passed, atol=args.atol, steps=args.steps,
                      plant_case="loss_free_rk4",
                      command_period_s=COMMAND_PERIOD_S, update_period_s=1/args.to_hz, reference_status=expected_status,
                      solve_latency_s=args.solve_latency, latency_compensation=args.latency_compensation,
                      reference_ticks=len(ticks), checks=checks, binary=str(binary),
                      params=json.loads(json.dumps(config)),
                      note="Diagnostic conformance only; no timing or convergence claim")
        (output / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({key: value for key, value in result.items() if key != "params"}, indent=2))
        print(f"Raw outputs retained: {output}")
        return 0 if passed else 1
    finally:
        # Destroy the solver child while the comparison still owns the GPU.
        if session is not None:
            session.close()
        if adapter is not None:
            adapter.close_solver()
        locks.release()


if __name__ == "__main__":
    raise SystemExit(main())
