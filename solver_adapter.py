"""The simulation coordinator's view of one task: plant state, task geometry and a
replaceable, isolated solver child. Imports tiago_mpc's tiago/sim/clock only."""
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import asdict
import hashlib
from pathlib import Path

import numpy as np

from live_mpc import (POSITION_TOL_M, REACH_DEFAULT_TASK, SPEED_L1_TOL_RAD_S, figure8_reference,
                      import_tiago, mpc_params, source_identity)
from live_presentation import mutable, snapshot
from solver_process import SolverProcess, model_contract, validate_contract

class RemoteController:
    def __init__(self, adapter):
        self.adapter = adapter

    def reset(self, native_state):
        """Reseed the child's controller from native_state at the adapter's time, with the
        task reference a request then would get: mpc.warmup (GATO's warm-up solve unless
        params.warmup is off). Like a solve, the warm-up has no deadline. It is no plan:
        no record, no interval timing."""
        a = self.adapter
        return a.remote.request("reset", state=np.asarray(native_state).tolist(), time_s=float(a.t),
                                reference=a.task_reference().tolist())


class SimulatorAdapter:
    """Only this process advances x/t, on tiago_mpc's SimPlant; the child solves."""
    def __init__(self, mpc_root):
        from server import RobotKinematics
        self.mpc_root = Path(mpc_root).resolve()
        self.tiago = tiago = import_tiago(self.mpc_root)
        arm = tiago.arm_urdf()
        self.kinematics = RobotKinematics(tiago.FULL_URDF, end_effector_frame=tiago.GRASP_FRAME,
                                          reduced_urdf=arm)
        self.contract = model_contract(self.kinematics, tiago)
        digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
        self.model_identity = dict(full_urdf_sha256=digest(tiago.FULL_URDF), native_urdf_sha256=digest(arm),
                                   end_effector_frame=tiago.GRASP_FRAME, source=source_identity(self.mpc_root))
        limits = tiago.limits()
        self.simulator_identity = dict(deepcopy(self.model_identity), joint_names=list(tiago.RIGHT_ARM_JOINTS),
            lower_position_rad=limits.lower.tolist(), upper_position_rad=limits.upper.tolist(),
            velocity_rad_s=limits.velocity.tolist(), effort_nm=limits.effort.tolist(),
            plant="tiago_mpc.sim.SimPlant", friction=None)
        self.default_target = tiago.fk(tiago.Q_REACH, tiago.GRASP_FRAME)
        self.figure8_start_world = self.kinematics.target_to_world(tiago.fk(tiago.Q_START, tiago.GRASP_FRAME))
        self.task_anchors = snapshot(dict(reach=self.kinematics.target_to_world(self.default_target).tolist(),
                                          figure8=self.figure8_start_world.tolist()))
        self.task = deepcopy(REACH_DEFAULT_TASK)
        self.plant_friction = None
        self.limit_handling = None
        self.joint_limits = self.mpc_bounds = None
        self.remote = self.profile = self.profile_identity = self.profile_schema = None
        self._segment_context = None
        self.controller = RemoteController(self)
        self.reset_state()

    def reset_state(self):
        self.x = np.r_[self.tiago.Q_START, np.zeros(7)]
        self.t = 0.
        self.u = np.zeros(7)
        self.sequence = 0
        self.applied_torque = None

    def preflight_profile(self, profile, config, task):
        """CPU-only probe of the profile's interpreter; returns its Live schema."""
        from live_mpc import build_schema, validate_settings
        from source_runtime import probe_selection
        checked = probe_selection({key: profile[key] for key in ("mpc_root", "python", "cache")})
        schema = build_schema(checked, profile["mpc_root"])
        validate_contract(self.contract, checked.get("contract", {}))
        validate_settings(config, task, schema)
        return schema

    def select_profile(self, profile, schema):
        self.close_solver()
        remote = SolverProcess(profile, lease_fds=lambda: [handle.fileno() for handle in self.gpu_locks.handles])
        try:
            ready = remote.request("bootstrap", timeout=60)
            validate_contract(self.contract, ready["contract"])
        except BaseException:
            remote.close()
            raise
        self.remote, self.profile, self.profile_schema = remote, deepcopy(profile), schema

    def configure(self, config, task):
        if self.remote is None:
            raise ValueError("No active solver profile; select a compatible profile")
        params = mpc_params(config)
        mode = "on" if params["friction"] is not None else "off"
        if params["N"] not in self.profile_schema["available_N_by_friction"][mode]:
            raise ValueError(f"Not compiled: N={params['N']} {'with' if mode == 'on' else 'without'} predictor "
                             "friction. Build it in Settings › Backend (Build selected N).")
        if params["ee_frame"] != self.kinematics.end_effector_frame:
            raise ValueError(f"The simulator tracks {self.kinematics.end_effector_frame}, not {params['ee_frame']}")
        predictor = self.remote.request("configure", timeout=120, params=params)
        self.plant_friction = self.tiago.urdf_friction() if config["plant"]["friction"] else None
        raw = self.tiago.limits()
        self.limit_handling = dict(limits=dict(lower=raw.lower, upper=raw.upper, velocity=raw.velocity, effort=raw.effort),
                                   clip_effort=config["plant"]["clip_effort"],
                                   stop_on_breach=dict(config["plant"]["stop_on_breach"]))
        self.simulator_identity = dict(self.simulator_identity,
                                       friction=self.plant_friction and asdict(self.plant_friction),
                                       clip_effort=config["plant"]["clip_effort"])
        self.problem_configuration = deepcopy(predictor["configuration"])
        self.settings = dict(config=deepcopy(config), task=deepcopy(task))
        self.configure_task(params["N"], params["dt_s"], task)
        self.joint_limits, self.mpc_bounds = predictor["joint_limits"], predictor["mpc_bounds"]
        self.profile_identity = dict(profile=deepcopy(self.profile), process_epoch=self.remote.epoch,
            predictor=predictor, simulator=self.simulator_identity, coordinate_contract=self.contract,
            friction_differs=self.simulator_identity["friction"] != predictor["prediction_friction"],
            physical_model_differs=self.simulator_identity["friction"] != predictor["prediction_friction"] or any(
                predictor["model_identity"].get(key) != self.model_identity[key]
                for key in ("full_urdf_sha256", "native_urdf_sha256")))
        # Constant within a segment: recorded once in its header, never per record.
        # Frozen once per configuration, so an emitted header keeps its context.
        self._segment_context = snapshot(dict(
            problem_configuration=self.problem_configuration, model_identity=predictor["model_identity"],
            task=self.task, end_effector_frame=self.kinematics.end_effector_frame, task_anchors=self.task_anchors,
            task_path_xyz=self.task_path_xyz, joint_limits=self.joint_limits, mpc_bounds=self.mpc_bounds,
            constraint_bounds_native=predictor["constraint_bounds_native"],
            simulator_identity=self.simulator_identity, solver_profile=self.profile_identity,
            position_tol_m=POSITION_TOL_M, speed_l1_tol_rad_s=SPEED_L1_TOL_RAD_S,
            source=self.model_identity["source"]))
        self.controller.reset(self.x)

    def configure_task(self, n, dt, task):
        """The coordinator owns world-space task geometry and exact references."""
        self.N, self.dt = n, dt
        self.task = deepcopy(task)
        self.task_path_xyz = (figure8_reference(np.linspace(0., task["period_s"], 257),
                                                self.figure8_start_world, task).tolist()
                              if task["kind"] == "figure8" else None)
        world_target = self.kinematics.target_to_world(self.default_target) + np.asarray(task["target_offset_m"])
        self.target = self.kinematics.world_from_torso.actInv(world_target)
        self.reference = np.zeros((self.N, 6), dtype=np.float32)
        self.reference[:, :3] = self.target
        if self.task["kind"] == "figure8":
            self.update_tracking_reference()

    def target_world_at(self, timestamp):
        if self.task["kind"] == "figure8":
            return figure8_reference([timestamp], self.figure8_start_world, self.task)[0]
        return self.kinematics.target_to_world(self.target)

    def update_tracking_reference(self):
        world = figure8_reference(self.t+np.arange(self.N)*self.dt, self.figure8_start_world, self.task)
        self.reference[:, :3] = np.asarray([self.kinematics.world_from_torso.actInv(point) for point in world])

    def new_plant(self, substep):
        """tiago_mpc's SimPlant at the current state and time. Its simulation clock
        never moves backward, so every anchor, reset or rollback takes a new one."""
        from tiago_mpc.clock import Clock
        from tiago_mpc.sim import SimPlant
        plant = SimPlant(self.x[:7], self.x[7:], substep=substep, friction=self.plant_friction,
                         clock=Clock.simulation(self.t))
        plant.start()
        return plant

    def task_reference(self):
        """The reference for a request at the current time: the figure-eight window from
        self.t, else the fixed target."""
        if self.task["kind"] == "figure8":
            self.update_tracking_reference()
        return self.reference

    def segment_header(self, settings_version, execution):
        """The record that starts a segment: its constant context, which the state,
        control, plan, breach and interval records of that generation leave out,
        including the complete effective settings (config with its plant group,
        task, execution) and the source identity."""
        context = dict(mutable(self._segment_context),
                       settings=dict(deepcopy(self.settings), execution=deepcopy(execution)))
        return dict(type="segment", sim_time_s=float(self.t), settings_version=settings_version, context=context)

    def solve_snapshot(self, origin, settings_version):
        self.task_reference()
        response = self.remote.request("solve", state=self.x, time_s=self.t,
            reference=self.reference, origin=origin, settings_version=settings_version)
        self.sequence += 1
        # Target/anchors are simulator-owned; the child's model never moves them.
        event = dict(response["plan"], seq=self.sequence, _reference=self.reference.copy(),
                     target_xyz=self.target_world_at(self.t).tolist())
        return snapshot(event)

    def _state_fields(self, settings_version=0):
        """Borrowed state fields, consumed immediately by one detachment API."""
        return dict(type="state", sim_time_s=self.t, _x=self.x, settings_version=settings_version,
                    torque_nm=None if self.applied_torque is None else self.applied_torque.tolist(),
                    target_xyz=self.target_world_at(self.t).tolist())

    def state_snapshot(self, settings_version=0):
        return snapshot(self._state_fields(settings_version))

    def state_record(self, settings_version=0):
        """Detach once into IPC-ready containers; never expose plant buffers."""
        def detach(value):
            if value is None or type(value) in (str, int, float, bool):
                return value
            if isinstance(value, np.ndarray):
                copied = value.copy()
                copied.flags.writeable = False
                return copied
            if isinstance(value, Mapping):
                return {key: detach(item) for key, item in value.items()}
            if isinstance(value, (list, tuple)):
                return [detach(item) for item in value]
            return value
        return detach(self._state_fields(settings_version))

    def close_solver(self):
        try:
            if self.remote is not None:
                self.remote.close()
        finally:
            self.remote = None
            self.profile = self.profile_identity = None
            self._segment_context = None
