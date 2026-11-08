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
import struct
from pathlib import Path
import time
import traceback

import numpy as np

from solver_process import receive_leased_message, send_message, model_contract, reference_from_wire

DIAGNOSTICS = ("initial_merit", "final_merit", "min_merit", "step_size", "pcg_iters", "pcg_times_us",
               "ls_num_iters", "budget_hit", "linsys", "admm_r_prim", "admm_r_dual", "row_max_violation",
               "row_sum_violation")


def finite_or_none(value):
    """Plain JSON values; nonfinite telemetry is reported as unavailable."""
    if isinstance(value, dict):
        return {key: finite_or_none(item) for key, item in value.items()}
    if isinstance(value, np.ndarray):
        return finite_or_none(value.tolist())
    if isinstance(value, (list, tuple)):
        return [finite_or_none(item) for item in value]
    if isinstance(value, (float, np.floating)) and not np.isfinite(value):
        return None
    return value.item() if isinstance(value, np.generic) else value


def capture_diagnostic(value):
    """Detach numerical telemetry once; JSON formatting belongs to presentation."""
    if isinstance(value, np.ndarray):
        return value.copy()
    if isinstance(value, (tuple, list)):
        array = np.asarray(value)
        if array.dtype.kind in "biuf":
            return array.copy()
        return [capture_diagnostic(item) for item in value]
    return finite_or_none(value)


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


# Collision fields that only change GATO's runtime environment: the obstacles and the body cover.
ENVIRONMENT_FIELDS = ("obstacles", "capsules", "boxes", "planes", "body")


def environment_arguments(collision):
    """set_collision_environment's arguments: Collision.environment() is a dict of them
    (spheres, capsules, cuboids, planes), or the spheres alone in a source before capsules,
    boxes and planes."""
    environment = collision.environment()
    return dict(environment) if isinstance(environment, dict) else dict(spheres=environment)


def environment_only(current, params):
    """Whether params differ from the loaded current only in the collision environment:
    MpcParams.collision's obstacles and body cover (GATO's runtime environment).
    The arm cover, posture, margin, mechanism and rho are compiled into the module or
    installed with the rows, so they need a new Mpc."""
    before, after = getattr(current, "collision", None), getattr(params, "collision", None)
    if before is None or after is None:
        return False
    def strip(value, collision):
        fields = {name: (None if name == "body" else ()) for name in ENVIRONMENT_FIELDS if hasattr(collision, name)}
        return replace(value, collision=replace(collision, **fields))
    return strip(current, before) == strip(params, after)


def gpu_urdf_path(tiago, module, params, binary):
    """The GPU URDF that Mpc loaded for params (tiago_mpc.mpc._plant): with collision rows
    the arm's sphere cover replaces its collision meshes. Checked against the loaded
    module's plant name, which hashes that file's bytes."""
    collision = getattr(params, "collision", None)
    if collision is None:
        path = tiago.runtime_urdf(params.friction)
    else:
        from tiago_mpc.collision import arm_cover
        path = tiago.runtime_urdf(params.friction, arm_cover(collision.arm))
    name = Path(binary).name
    if name.startswith("bsqpN"):  # a GATO module's name carries its plant, which hashes this file
        plant = module.plant_name(path, params.friction, params.armature, params.friction_law)
        if not name.startswith(f"bsqpN{params.N}_{plant}."):
            raise ValueError(f"The GPU URDF {path} does not belong to the loaded module {name}")
    return path


def collision_spheres(params):
    """The shapes of GATO's collision rows for display: the arm's cover by link (in the
    links' frames), the body's cover (ROOT_FRAME: spheres, and body_capsules and body_boxes
    where the stored cover has them) and the obstacles (ROOT_FRAME; spheres, and capsules,
    boxes and planes in Collision's layouts where the source has them); None without rows.
    The covers are tiago_mpc's stored ones (tiago_mpc/data/collision/)."""
    collision = getattr(params, "collision", None)
    if collision is None:
        return None
    from tiago_mpc.collision import arm_cover, body_cover, body_posture
    spheres = lambda values: [[float(item) for item in sphere] for sphere in values]
    body = dict(spheres=(), capsules=(), boxes=()) if collision.body is None else body_cover(collision.body)
    return dict(arm={link: spheres(group) for link, group in arm_cover(collision.arm).items()},
                body=spheres(body["spheres"]), body_capsules=spheres(body["capsules"]), body_boxes=spheres(body["boxes"]),
                obstacles=spheres(collision.obstacles),
                **{name: spheres(getattr(collision, name)) for name in ("capsules", "boxes", "planes") if hasattr(collision, name)},
                mechanism=collision.mechanism,
                margin_m=float(collision.margin_m), rho=float(collision.rho),
                posture=body_posture(collision.body))


class SolverSession:
    """tiago_mpc's Mpc for the configured MpcParams, and what the coordinator records."""

    def __init__(self, root):
        from live_mpc import body_joints, import_tiago
        from server import RobotKinematics
        self.tiago = import_tiago(root)
        self.root = Path(root).resolve()
        self.module = importlib.import_module("tiago_mpc.mpc")
        arm = self.tiago.arm_urdf()
        self.kinematics = RobotKinematics(self.tiago.FULL_URDF, body_joints(root), end_effector_frame=self.tiago.GRASP_FRAME,
                                          reduced_urdf=arm)
        digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
        self.model_identity = dict(full_urdf_sha256=digest(self.tiago.FULL_URDF),
                                   native_urdf_sha256=digest(arm))
        self.mpc = self.binary = self.requested = None
        self.binary_sha256 = (None, None)  # (path, SHA256) of the loaded module, hashed once per module
        self.restarted = True
        self.seed = None  # (state, reference) of the last reseed while no solve followed

    def bootstrap(self):
        return dict(contract=model_contract(self.kinematics, self.tiago), model_identity=self.model_identity)

    def configure(self, params, max_sqp_iters=None, source_settings=None, settings_module=None):
        """Mpc(params, find_binary(params)): loads a compiled module, never compiles.

        A change of only the collision environment (MpcParams.collision's obstacles or body
        cover) keeps the loaded Mpc and uploads the new environment, as load_controller
        does (GATO's set_collision_environment, callable between solves): the module, the
        rows and every other setting are the same. The coordinator reseeds afterwards."""
        from inspection_problem import capture_constraint_bounds
        from live_mpc import LIMIT_KEYS, mpc_bounds_from_rows, urdf_joint_limits
        from tiago_mpc.record import to_dict
        started = time.perf_counter()
        m = self.module
        from native_cost import native_params, validate_native_cost
        params = native_params(params)
        if not isinstance(params, m.MpcParams):
            raise ValueError("Solver configuration must be tagged MpcParams from tiago_mpc.record.to_dict")
        from worktree_settings import resolve_predictor
        if source_settings is not None:
            params, resolution = resolve_predictor(self.root, source_settings, params, to_dict,
                                                   expected_module=settings_module)
        else:
            resolution = dict(values=None, effective=to_dict(params), module=None)
        if max_sqp_iters is not None:
            params = replace(params, solver=replace(params.solver, max_sqp_iters=max_sqp_iters))
        validate_native_cost(params)
        # Compared with the requested params: Mpc.params holds GATO's resolved values.
        if self.mpc is not None and self.requested != params and environment_only(self.requested, params):
            # The binary and installed rows stay; only GATO's runtime environment changes.
            self.mpc.controller.solver.set_collision_environment(**environment_arguments(params.collision))
            self.mpc.params = replace(self.mpc.params, collision=params.collision)
            self.seed, kind, binary = None, "environment", self.binary
        else:
            binary = m.find_binary(params)
            if binary is None:
                raise ValueError(f"Not compiled: N={params.N} {'with' if params.friction else 'without'} predictor "
                                 f"friction{'' if getattr(params, 'collision', None) is None else ' and with collision rows'}. "
                                 "Build it in Settings › Backend (Build selected N).")
            self.mpc = self.seed = None  # release previous buffers only after valid model lookup
            self.mpc = m.Mpc(params, binary)
            self.binary, kind = binary, "load"
            if self.binary_sha256[0] != str(binary):
                self.binary_sha256 = (str(binary), hashlib.sha256(Path(binary).read_bytes()).hexdigest())
            # The module's GPU URDF; an environment update keeps both.
            self.gpu_urdf_sha256 = hashlib.sha256(gpu_urdf_path(self.tiago, m, params, binary).read_bytes()).hexdigest()
        self.requested, self.restarted = params, True
        solver = self.mpc.controller.solver
        rows = capture_constraint_bounds(solver)
        configuration = to_dict(params)
        self.configuration = configuration
        self.model_identity = dict(self.model_identity, gpu_urdf_sha256=self.gpu_urdf_sha256,
                                   end_effector_frame=self.tiago.GRASP_FRAME,
                                   armature=list(getattr(params, "armature", (0.,)*7)),
                                   friction=to_dict(params.friction))
        capture = (bool(getattr(solver.lib, "ITERATION_CAPTURE_AVAILABLE", False)) and
                   "capture_iterations" in inspect.signature(solver.solve).parameters)
        result = dict(capabilities=dict(iteration_capture=capture, exact_resume=False),
                      binary=dict(path=str(binary), sha256=self.binary_sha256[1],
                                  native_source_id=getattr(solver.lib, "NATIVE_SOURCE_ID", None)),
                      joint_limits=urdf_joint_limits(self.tiago.limits()),
                      mpc_bounds=mpc_bounds_from_rows(rows, {key: configuration[key] for key in LIMIT_KEYS}),
                      constraint_bounds_native=rows, configuration=configuration, settings_resolution=resolution,
                      resolved=to_dict(self.mpc.params),  # what GATO resolved, None followed its default
                      model_identity=self.model_identity, prediction_friction=configuration["friction"],
                      prediction_friction_law=configuration["friction_law"], armature=configuration["armature"],
                      collision=collision_spheres(params), configure=dict(kind=kind, wall_s=time.perf_counter()-started))
        # Diagnostics log: one line per configuration (solver_process keeps the log).
        print(f"configure ({kind}): {1e3 * result['configure']['wall_s']:.1f} ms", file=sys.stderr, flush=True)
        return result

    def reset(self, state, time_s, reference):
        """Reseed the controller from a native state and the task reference for a request
        then: mpc.warmup, which resets it and, with params.warmup, runs GATO's warm-up
        solve (as run() before its first tick); without the warm-up, the plain controller
        reset. A reseed repeating the previous one, with no solve in between, changes
        nothing and is skipped. Returns whether a warm-up ran and its wall time."""
        from tiago_mpc.interfaces import State
        mpc, x = self.mpc, solver_state(state)
        reference = reference_from_wire(reference, mpc.N)
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
        reference = reference_from_wire(reference, mpc.N)
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
                    _states=plan.states, _torques=plan.torques, stats=stats,
                    _native_stats=dict(plan.stats),
                    diagnostics={name: capture_diagnostic(getattr(raw, name)) for name in DIAGNOSTICS if hasattr(raw, name)})


def serve(channel, root):
    session = None
    control = recording = None
    capture_error = None
    while True:
        request, lease_descriptors = receive_leased_message(channel)
        identity = {key: request.get(key) for key in ("protocol", "epoch", "request_id")}
        operation, payload = request.get("operation"), request.get("payload", {})
        notified = False
        reserved = None
        try:
            if operation == 'submit_stream' and control is not None:
                control.mark_busy()
            if identity["protocol"] != 1:
                raise ValueError("Unsupported solver RPC protocol")
            if capture_error is not None and operation not in ('close','end_stream','configure'):
                raise RuntimeError(f'Previous solve recording failed: {capture_error}')
            if operation == "bootstrap":
                session = SolverSession(root)
                result = session.bootstrap()
            elif operation == "close":
                if control is not None:
                    control.close()
                if recording is not None:
                    recording.close()
                session = None
                send_message(channel, dict(identity, ok=True, result=None))
                return
            elif session is None:
                raise ValueError("Solver process is not initialized")
            elif operation == "configure":
                result = session.configure(payload["params"], payload.get("max_sqp_iters"),
                                           payload.get("source_settings"), payload.get("settings_module"))
                capture_error = None
            elif session.mpc is None:
                raise ValueError("Solver is not configured")
            elif operation == 'start_stream':
                from solver_exchange import ControlArrays, RecordingRing
                if control is not None:
                    raise RuntimeError('A numerical stream is already active')
                if payload['n'] != session.mpc.N or payload['dt'] != session.mpc.dt:
                    raise ValueError('Numerical stream differs from the configured MPC')
                control = ControlArrays(payload['n'], payload['dt'], payload['control_path'])
                recording = RecordingRing(payload['recording_path']) if payload['recording_path'] else None
                result = None
            elif operation == 'end_stream':
                control.close()
                if recording is not None:
                    recording.close()
                control = recording = None
                result = None
            elif operation == 'submit_stream':
                if control is None:
                    raise ValueError('No numerical stream configured')
                identifier = request['request_id']
                initial, reference = control.read_request(identifier)
                session.seed = None
                started = time.perf_counter()
                session.mpc.request(initial, reference)
                plan = session.mpc.result(block=True)
                wall_s = time.perf_counter()-started
                slot = recording.reserve(identifier) if recording is not None else 0
                reserved = slot if recording is not None else None
                control.write_result(identifier, plan, wall_s)
                channel.sendall(b'R'+struct.pack('!QI', identifier, slot))
                notified = True
                if recording is not None:
                    raw = session.mpc.step.solve.stats
                    record = dict(type='plan', origin='play', N=session.mpc.N, dt_s=session.mpc.dt,
                        plan_origin_time_s=plan.t0, measured_time_s=plan.measured_t,
                        initial_state=dict(q=initial.q, qd=initial.qd, time_s=initial.t,
                                           measured_time_s=plan.measured_t),
                        _states=plan.states, _torques=plan.torques, _reference=reference,
                        _native_stats=plan.stats, _controller_restarted=session.restarted,
                        diagnostics={name:getattr(raw,name) for name in DIAGNOSTICS if hasattr(raw,name)})
                    recording.put(identifier, record, slot=slot)
                session.restarted = False
                continue
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
            if reserved is not None:
                if notified:
                    recording.put(request['request_id'],dict(_recording_error=f'Solve recording failed: {exc}'),slot=reserved)
                else:
                    from solver_exchange import take_record
                    take_record(dict(path=str(recording.path),slot=reserved,request_id=request['request_id']),discard=True)
            if notified:
                # Keep CUDA objects idle until the coordinator reconfigures or
                # closes under its next GPU lease. No unsolicited control reply.
                capture_error = str(exc)
                continue
            send_message(channel, dict(identity, ok=False, error=str(exc)))
        finally:
            try:
                for descriptor in lease_descriptors:
                    os.close(descriptor)
            finally:
                if operation == 'submit_stream' and control is not None:
                    control.mark_idle()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fd", type=int, required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()
    with socket.socket(fileno=args.fd) as channel:
        serve(channel, args.root)
