#!/usr/bin/env python3
"""Opt-in GPU conformance with unchanged reach_sim, retaining all raw outputs.

Run when the GPU is available: this script acquires the experiment locks.
Timing is intentionally excluded. Plans, controls and native RK4 states must
match bit for bit, so a source drift or a mismatch fails loudly.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Match the upstream builder and source probe before resolving cached toolchains.
# Keep the selected virtualenv path; resolving its Python symlink would lose it.
os.environ["PATH"] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")
from live_mpc import GPULocks, MPCAdapter, import_mpc
from visualizer_config import DEFAULT_MPC_ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mpc-root", type=Path, default=Path(os.environ.get("TIAGO_MPC_ROOT", DEFAULT_MPC_ROOT)))
    parser.add_argument("--config", type=Path)
    parser.add_argument("--steps", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.steps <= 10:
        parser.error("--steps must be in [1, 10]")
    reach, configuration = import_mpc(args.mpc_root)
    _, settings, effective = configuration.load_configuration(args.config)
    settings["save_plan_steps"] = args.steps
    output = (args.output or ROOT / "_expr_data/conformance" /
              datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")).resolve()
    if not output.is_relative_to(ROOT / "_expr_data"):
        parser.error("--output must be beneath this visualizer's _expr_data")
    output.mkdir(parents=True, exist_ok=False)
    config_path = output / "config.json"
    config_path.write_text(json.dumps(settings, indent=2)+"\n")
    timeout = args.steps * effective["dt_s"]
    command = [sys.executable, str(args.mpc_root / "examples/reach_sim.py"), "--config", str(config_path),
               "--timeout", str(timeout), "--output", str(output / "reference")]
    locks = GPULocks(args.mpc_root)
    if not locks.acquire():
        parser.exit(2, "GPU is busy: experiment locks are held\n")
    adapter = None
    try:
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(args.mpc_root / "external/gato/python") + os.pathsep + environment.get("PYTHONPATH", "")
        with (output / "reference.log").open("w") as log:
            reference_process = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=environment)
        summary = json.loads((output / "reference/summary.json").read_text())
        if summary["status"] == "error":
            raise RuntimeError(f"Unchanged reach_sim failed; see {output / 'reference.log'}")
        adapter = MPCAdapter(args.mpc_root, reach=reach)
        adapter.configure(config_path, dict(kind="reach", target_offset_m=[0, 0, 0]))
        samples = [(0.0, adapter.x.copy(), None)]
        plans = []
        for index in range(summary["solve_calls"]):
            plans.append(adapter.solve("play", 0))
            np.savez_compressed(output / f"adapter_plan_{index:04d}.npz", xu=adapter.last_xu,
                                state=adapter.x, reference=adapter.reference, signs=adapter.signs)
            samples.extend(adapter.advance(end_time=timeout))
        np.savez_compressed(output / "adapter_trajectory.npz", time_s=[x[0] for x in samples],
                            state=[x[1] for x in samples], applied_torque_nm=[x[2] for x in samples[1:]])
        (output / "adapter_plans.json").write_text(json.dumps(plans, allow_nan=False)+"\n")
        checks = {}
        for index in range(summary["solve_calls"]):
            with np.load(output / f"reference/plan_{index:04d}.npz") as expected, \
                    np.load(output / f"adapter_plan_{index:04d}.npz") as actual:
                for key in ("xu", "state", "reference", "signs"):
                    checks[f"plan_{index:04d}.{key}"] = bool(np.array_equal(expected[key], actual[key]))
        with np.load(output / "reference/trajectory.npz") as expected, \
                np.load(output / "adapter_trajectory.npz") as actual:
            for key in ("time_s", "state", "applied_torque_nm"):
                checks[key] = bool(np.array_equal(expected[key], actual[key]))
        result = dict(passed=all(checks.values()), checks=checks, reference_command=command,
                      reference_exit_code=reference_process.returncode,
                      reference_status=summary["status"], solve_calls=summary["solve_calls"],
                      note="Diagnostic conformance only; no timing or convergence claim")
        (output / "comparison.json").write_text(json.dumps(result, indent=2)+"\n")
        print(json.dumps(result, indent=2))
        print(f"Raw outputs retained: {output}")
        return 0 if result["passed"] else 1
    finally:
        # Destroy CUDA buffers/events while the comparison still owns the GPU.
        if adapter is not None:
            adapter.controller = None
            adapter.solver = None
            adapter = None
        locks.release()


if __name__ == "__main__":
    raise SystemExit(main())
