"""One isolated tiago_mpc Mpc. No plant stepping or lock acquisition."""
from __future__ import annotations
# Arm before NumPy, model imports or native extension initialization.
import sys
if __name__ == "__main__":
    from solver_lifecycle import arm_parent_death_signal
    arm_parent_death_signal(int(sys.argv[sys.argv.index("--parent-pid") + 1]))

import argparse
from dataclasses import replace
import hashlib
import importlib
import inspect
import os
import socket
from pathlib import Path
import time
import traceback

import numpy as np

from solver_process import receive_leased_message, send_message, model_contract

DIAGNOSTICS = ("initial_merit", "final_merit", "min_merit", "step_size", "pcg_iters", "pcg_times_us",
               "ls_num_iters", "budget_hit", "linsys", "admm_r_prim", "admm_r_dual", "row_max_violation",
               "row_sum_violation")


def finite_or_none(value):
    """Plain JSON values; nonfinite telemetry is reported as unavailable."""
    if isinstance(value, np.ndarray):
        return finite_or_none(value.tolist())
    if isinstance(value, (list, tuple)):
        return [finite_or_none(item) for item in value]
    if isinstance(value, (float, np.floating)) and not np.isfinite(value):
        return None
    return value.item() if isinstance(value, np.generic) else value


def plan_stats(stats, restarted):
    """Plan.stats under the keys the visualizer's plots and panels read."""
    violation = stats.get("row_viol")
    if violation is not None and not np.isfinite(violation).all():
        violation = None  # nonfinite constraint telemetry is unavailable, never zero
    return dict(sqp_iters=stats["sqp"], pcg_iters=stats["pcg"], admm_iters=stats["admm"],
                admm_linsys_iters=stats["admm_linsys"], admm_linsys_mode=stats["admm_linsys_mode"],
                zero_pcg_rows=stats["zero_pcg_rows"], budget_hit=stats["budget_hit"],
                solve_time_ms=stats["solve_time_us"] / 1000, step_wall_s=stats["wall_s"],
                row_violation=None if violation is None else np.asarray(violation).tolist(),
                controller_restarted=restarted)


FLOAT32_MAX = float(np.finfo(np.float32).max)


def solver_state(state):
    """A native state GATO can take: after an unstable plant the state can be finite
    in float64 but beyond GATO's float32 range, which GATO reports misleadingly as
    a nonfinite reset x0."""
    x = np.asarray(state, dtype=float)
    if not np.isfinite(x).all() or np.abs(x).max() > FLOAT32_MAX:
        raise ValueError("The state is beyond the solver's range (the plant became unstable); press Reset")
    return x


class SolverSession:
    """tiago_mpc's Mpc for the configured MpcParams, and what the coordinator records."""

    def __init__(self, root):
        from live_mpc import import_tiago
        from server import RobotKinematics
        self.tiago = import_tiago(root)
        self.root = Path(root).resolve()
        self.module = importlib.import_module("tiago_mpc.mpc")
        arm = self.tiago.arm_urdf()
        self.kinematics = RobotKinematics(self.tiago.FULL_URDF, end_effector_frame=self.tiago.GRASP_FRAME,
                                          reduced_urdf=arm)
        digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
        self.model_identity = dict(full_urdf_sha256=digest(self.tiago.FULL_URDF),
                                   native_urdf_sha256=digest(arm))
        self.mpc = None
        self.restarted = True
        self.seed = None  # (state, reference) of the last reseed while no solve followed

    def bootstrap(self):
        return dict(contract=model_contract(self.kinematics, self.tiago), model_identity=self.model_identity)

    def configure(self, params, max_sqp_iters=None, source_settings=None, settings_module=None):
        """Mpc(params, find_binary(params)): loads a compiled module, never compiles."""
        from inspection_problem import capture_constraint_bounds
        from live_mpc import LIMIT_KEYS, mpc_bounds_from_rows, urdf_joint_limits
        from tiago_mpc.record import from_dict, to_dict
        m = self.module
        params = from_dict(params)
        if not isinstance(params, m.MpcParams):
            raise ValueError("Solver configuration must be tagged MpcParams from tiago_mpc.record.to_dict")
        from worktree_settings import resolve_predictor
        if source_settings is not None:
            params, resolution = resolve_predictor(self.root, source_settings, params, to_dict,
                                                   expected_module=settings_module)
        else:
            resolution = dict(values=None, effective=to_dict(params), module=None)
        if max_sqp_iters is not None:
            params = replace(params, solver=params.solver.replace(max_sqp_iters=max_sqp_iters))
        binary = m.find_binary(params)
        if binary is None:
            raise ValueError(f"Not compiled: N={params.N} {'with' if params.friction else 'without'} predictor "
                             "friction. Build it in Settings › Backend (Build selected N).")
        self.mpc = self.seed = None  # release previous buffers only after valid model lookup
        self.mpc = m.Mpc(params, binary)
        self.restarted = True
        solver = self.mpc.controller.solver
        rows = capture_constraint_bounds(solver)
        configuration = to_dict(params)
        gpu_urdf = self.tiago.runtime_urdf(params.friction)
        self.configuration = configuration
        self.model_identity = dict(self.model_identity, gpu_urdf_sha256=hashlib.sha256(gpu_urdf.read_bytes()).hexdigest(),
                                   end_effector_frame=self.tiago.GRASP_FRAME,
                                   armature=list(getattr(params, "armature", (0.,)*7)),
                                   friction=to_dict(params.friction))
        capture = (bool(getattr(solver.lib, "ITERATION_CAPTURE_AVAILABLE", False)) and
                   "capture_iterations" in inspect.signature(solver.solve).parameters)
        return dict(capabilities=dict(iteration_capture=capture, exact_resume=False),
                    binary=dict(path=str(binary), sha256=hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
                                native_source_id=getattr(solver.lib, "NATIVE_SOURCE_ID", None)),
                    joint_limits=urdf_joint_limits(self.tiago.limits()),
                    mpc_bounds=mpc_bounds_from_rows(rows, {key: configuration[key] for key in LIMIT_KEYS}),
                    constraint_bounds_native=rows, configuration=configuration, settings_resolution=resolution,
                    resolved=to_dict(self.mpc.params),  # what GATO resolved, None followed its default
                    model_identity=self.model_identity, prediction_friction=configuration["friction"],
                    prediction_friction_law=configuration["friction_law"], armature=configuration["armature"])

    def reset(self, state, time_s, reference):
        """Reseed the controller from a native state and the task reference for a request
        then: mpc.warmup, which resets it and, with params.warmup, runs GATO's warm-up
        solve (as run() before its first tick); without the warm-up, the plain controller
        reset. A reseed repeating the previous one, with no solve in between, changes
        nothing and is skipped. Returns whether a warm-up ran and its wall time."""
        from tiago_mpc.interfaces import State
        mpc, x = self.mpc, solver_state(state)
        reference = np.asarray(reference, dtype=np.float32).reshape(mpc.N, 6)
        seed = (x.tobytes(), reference.tobytes())
        if seed == self.seed:
            return dict(warmup=False, skipped=True, wall_s=0.)
        self.seed = None
        started = time.perf_counter()
        if mpc.params.warmup:
            mpc.warmup(State(float(time_s), x[:7], x[7:]), reference)
        else:
            mpc.controller.reset(x)
        self.seed, self.restarted = seed, True
        return dict(warmup=mpc.params.warmup, skipped=False, wall_s=time.perf_counter() - started)

    def solve(self, state, time_s, reference, origin, settings_version, measured_time_s=None):
        from tiago_mpc.interfaces import State
        mpc, x = self.mpc, solver_state(state)
        reference = np.asarray(reference, dtype=np.float32).reshape(mpc.N, 6)
        if origin == "preview":
            self.reset(x, time_s, reference)
        self.seed = None  # the solve moves the controller on from its seed
        initial = State(float(time_s), x[:7], x[7:])
        if measured_time_s is not None:
            from tiago_mpc.interfaces import Prediction
            initial = Prediction(float(time_s), x[:7], x[7:], measured_t=float(measured_time_s))
        mpc.request(initial, reference)
        plan = mpc.result()
        stats = plan_stats(plan.stats, self.restarted)
        self.restarted = False
        raw = mpc.step.solve.stats
        measured = float(getattr(plan, "measured_t", time_s))
        return dict(type="plan", origin=origin, settings_version=settings_version,
                    initial_state=dict(q=x[:7].tolist(), qd=x[7:].tolist(), time_s=float(time_s),
                                       measured_time_s=measured),
                    plan_origin_time_s=float(plan.t0), measured_time_s=measured,
                    sim_time_s=float(time_s), N=mpc.N, dt_s=mpc.dt,
                    _states=np.array(plan.states), _torques=np.array(plan.torques), stats=stats,
                    diagnostics={name: finite_or_none(getattr(raw, name)) for name in DIAGNOSTICS if hasattr(raw, name)})


def serve(channel, root):
    session = None
    while True:
        request, lease_descriptors = receive_leased_message(channel)
        identity = {key: request.get(key) for key in ("protocol", "epoch", "request_id")}
        operation, payload = request.get("operation"), request.get("payload", {})
        try:
            if identity["protocol"] != 1:
                raise ValueError("Unsupported solver RPC protocol")
            if operation == "bootstrap":
                session = SolverSession(root)
                result = session.bootstrap()
            elif operation == "close":
                session = None
                send_message(channel, dict(identity, ok=True, result=None))
                return
            elif session is None:
                raise ValueError("Solver process is not initialized")
            elif operation == "configure":
                result = session.configure(payload["params"], payload.get("max_sqp_iters"),
                                           payload.get("source_settings"), payload.get("settings_module"))
            elif session.mpc is None:
                raise ValueError("Solver is not configured")
            elif operation == "reset":
                result = session.reset(payload["state"], payload["time_s"], payload["reference"])
                if result["warmup"]:  # diagnostics log: one line per warm-up
                    print(f"reseed at t={payload['time_s']:.3f} s: warm-up {1e3 * result['wall_s']:.1f} ms",
                          file=sys.stderr, flush=True)
            elif operation == "solve":
                result = dict(plan=session.solve(payload["state"], payload["time_s"], payload["reference"],
                                                 payload["origin"], payload["settings_version"],
                                                 measured_time_s=payload.get("measured_time_s")))
            elif operation == "inspect":
                from inspection_worker import inspect_solve
                session.seed = None  # the cold solve leaves the solver elsewhere
                result = inspect_solve(session, payload)
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
