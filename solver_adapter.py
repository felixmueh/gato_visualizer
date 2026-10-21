"""Fixed simulator with a replaceable, isolated solver implementation."""
from copy import deepcopy
import importlib
from pathlib import Path

import numpy as np

from live_mpc import MPCAdapter
from solver_process import SolverProcess, model_contract, validate_contract


class RemoteController:
    def __init__(self, adapter):
        self.adapter = adapter

    def reset(self, native_state):
        self.adapter.remote.request("reset", state=np.asarray(native_state).tolist())


class SimulatorAdapter(MPCAdapter):
    """Only this process advances x/t with the selected simulator's RK4."""
    def __init__(self, mpc_root):
        super().__init__(mpc_root)
        self.simulator_identity = dict(deepcopy(self.model_identity),
            joint_names=list(self.model.names)[1:],
            lower_position_rad=self.model.lowerPositionLimit.tolist(),
            upper_position_rad=self.model.upperPositionLimit.tolist(),
            velocity_rad_s=self.model.velocityLimit.tolist(), effort_nm=self.model.effortLimit.tolist(),
            passive_joint_dynamics=None, integrator="reach_sim.rk4")
        self.contract = model_contract(self)
        self.remote = None
        self.profile = None
        self.profile_identity = None
        self.profile_schema = None
        # Every interface to the coordinator now uses native coordinates.
        self.signs, self.state_signs = np.ones(7), np.ones(14)
        self.controller = RemoteController(self)

    def select_profile(self, profile):
        self.close_solver()
        remote = SolverProcess(profile)
        try:
            ready = remote.request("bootstrap")
            validate_contract(self.contract, ready["contract"])
        except BaseException:
            remote.close()
            raise
        self.remote, self.profile = remote, deepcopy(profile)
        self.profile_schema = ready["schema"]

    def configure(self, config_path, task):
        if self.remote is None:
            raise ValueError("No active solver profile; select a compatible profile")
        _, _, effective = importlib.import_module("reaching_config").load_configuration(config_path)
        if effective["N"] not in self.profile_schema["available_N"]:
            raise ValueError(f"Solver profile has no compatible prebuilt N={effective['N']} module")
        predictor = self.remote.request("configure", config_path=str(Path(config_path).resolve()), task=task)
        self.problem_configuration = deepcopy(effective)
        self.configure_task(effective, task)
        self.joint_limits = predictor["joint_limits"]
        self.profile_identity = dict(profile=deepcopy(self.profile), process_epoch=self.remote.epoch,
            predictor=predictor, simulator=self.simulator_identity,
            simulator_joint_dynamics=None, coordinate_contract=self.contract,
            physical_model_differs=any(predictor["model_identity"].get(key) != self.simulator_identity.get(key)
                for key in ("full_urdf_sha256", "gpu_urdf_sha256")))
        self.controller.reset(self.x)
        self.restarted = True

    def solve_snapshot(self, origin, settings_version):
        if self.task["kind"] == "figure8":
            self.update_tracking_reference()
        response = self.remote.request("solve", state=self.x.tolist(), time_s=self.t,
            reference=self.reference.tolist(), origin=origin, settings_version=settings_version)
        event = response["plan"]
        self.u = np.asarray(response["torque_nm"])
        self.last_xu = np.asarray(event["_xu"])
        self.sequence += 1
        # Target/anchors are simulator-owned; the child's model never moves them.
        event.update(seq=self.sequence, _xu=self.last_xu, _signs=self.signs,
            _reference=self.reference.copy(), task_anchors=self.task_anchors,
            target_xyz=self.target_world_at(self.t).tolist(), task_path_xyz=self.task_path_xyz,
            solver_profile=deepcopy(self.profile_identity), simulator_identity=self.simulator_identity)
        self.restarted = False
        return event

    def state_snapshot(self, rtf=0, settings_version=0):
        from live_presentation import mutable
        event = mutable(super().state_snapshot(rtf, settings_version))
        event.update(simulator_identity=self.simulator_identity,
                     solver_profile=dict(id=self.profile["id"], process_epoch=self.remote.epoch))
        return event

    def close_solver(self):
        try:
            if self.remote is not None:
                self.remote.close()
        finally:
            self.remote = None
            self.profile = self.profile_identity = None
