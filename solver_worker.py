"""One isolated GATO implementation. No plant stepping or lock acquisition."""
from __future__ import annotations
# Arm before NumPy, model imports or native extension initialization.
import sys
if __name__ == "__main__":
    from solver_lifecycle import arm_parent_death_signal
    arm_parent_death_signal(int(sys.argv[sys.argv.index("--parent-pid") + 1]))

import argparse
import os
import hashlib
import inspect
import socket
from pathlib import Path
import traceback

import numpy as np

from solver_process import receive_leased_message, send_message, model_contract, native_plan


def serve(channel, root):
    from live_mpc import MPCAdapter, build_schema
    root = Path(root).resolve()
    adapter = None
    while True:
        request, lease_descriptors = receive_leased_message(channel)
        identity = {key: request.get(key) for key in ("protocol", "epoch", "request_id")}
        operation, payload = request.get("operation"), request.get("payload", {})
        try:
            if identity["protocol"] != 1:
                raise ValueError("Unsupported solver RPC protocol")
            if operation == "bootstrap":
                schema = build_schema(root)
                adapter = MPCAdapter(root)
                result = dict(schema=schema, contract=model_contract(adapter), model_identity=adapter.model_identity)
            elif operation == "configure":
                if adapter is None:
                    raise ValueError("Solver process is not initialized")
                # The child's x only caches the last request's input; the
                # simulator sends its own state right after configuring. Do not
                # seed the new controller from a rejected blown-up state.
                adapter.reset_state(reset_controller=False)
                adapter.configure(payload["config_path"], payload["task"])
                module = adapter.solver.lib
                module_path = Path(module.__file__)
                capture = (bool(getattr(module, "ITERATION_CAPTURE_AVAILABLE", False)) and
                           "capture_iterations" in inspect.signature(adapter.solver.solve).parameters)
                result = dict(capabilities=dict(iteration_capture=capture, exact_resume=False),
                    binary=dict(path=str(module_path), sha256=hashlib.sha256(module_path.read_bytes()).hexdigest(),
                        native_source_id=getattr(module, "NATIVE_SOURCE_ID", None)),
                    joint_limits=adapter.joint_limits,
                    constraint_bounds_native=adapter.constraint_bounds_native,
                    configuration=adapter.problem_configuration, model_identity=adapter.model_identity,
                    prediction_joint_dynamics=adapter.problem_configuration.get("prediction_joint_dynamics"),
                    gpu_joint_coordinate_signs=adapter.signs.tolist(), plan_context=adapter.plan_context())
            elif operation == "reset":
                adapter.x = np.asarray(payload["state"], dtype=float)
                adapter.controller.reset(adapter.x * adapter.state_signs)
                adapter.restarted = True
                result = None
            elif operation == "solve":
                adapter.x = np.asarray(payload["state"], dtype=float)
                adapter.t = float(payload["time_s"])
                event = adapter.solve_snapshot(payload["origin"], payload["settings_version"],
                                              reference=payload["reference"], include_context=False)
                result = dict(plan=native_plan(event), torque_nm=adapter.u)
            elif operation == "inspect":
                if adapter is None or adapter.solver is None:
                    raise ValueError("Inspection solver is not configured")
                from inspection_worker import inspect_solve
                result = inspect_solve(adapter, payload)
            elif operation == "close":
                if adapter is not None:
                    adapter.controller = adapter.solver = None
                    adapter = None
                send_message(channel, dict(identity, ok=True, result=None))
                return
            else:
                raise ValueError(f"Unsupported solver operation: {operation}")
            send_message(channel, dict(identity, ok=True, result=result), array_buffers=operation == "solve")
        except Exception as exc:
            traceback.print_exc()
            send_message(channel, dict(identity, ok=False, error=str(exc)))
        finally:
            for descriptor in lease_descriptors:
                os.close(descriptor)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fd", type=int, required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()
    with socket.socket(fileno=args.fd) as channel:
        serve(channel, args.root)
