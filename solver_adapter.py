"""Fixed simulator with a replaceable, isolated solver implementation."""
from copy import deepcopy
import importlib
from pathlib import Path
from types import MappingProxyType

import numpy as np

from live_mpc import MPCAdapter
from live_presentation import snapshot
from solver_process import SolverProcess, model_contract, validate_contract

RESET_TIMEOUT_SECONDS = 30


class RemoteController:
    def __init__(self, adapter):
        self.adapter = adapter

    def reset(self, native_state):
        self.adapter.remote.request("reset", timeout=RESET_TIMEOUT_SECONDS,
                                    state=np.asarray(native_state).tolist())


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
        self._plan_context = None
        self.profile_schema = None
        # Every interface to the coordinator now uses native coordinates.
        self.signs, self.state_signs = np.ones(7), np.ones(14)
        self.controller = RemoteController(self)

    def preflight_profile(self, profile, config, task):
        n = config["N"]
        from source_runtime import probe_selection
        selection = {key: profile[key] for key in ("mpc_root", "python", "cache")}
        checked = probe_selection(selection, operation="profile-probe")
        if not checked.get("compatible"):
            raise ValueError(checked.get("error", "Solver profile has no compatible prebuilt modules"))
        if n not in checked.get("available_N", []):
            raise ValueError(f"Solver profile has no compatible prebuilt N={n} module; available N: {checked.get('available_N', [])}")
        validate_contract(self.contract, checked.get("contract", {}))
        from live_mpc import validate_settings
        validate_settings(config, task, checked["schema"])
        return checked

    def select_profile(self, profile):
        self.close_solver()
        remote = SolverProcess(profile, lease_fds=lambda: [handle.fileno() for handle in self.gpu_locks.handles])
        try:
            ready = remote.request("bootstrap", timeout=60)
            validate_contract(self.contract, ready["contract"])
        except BaseException:
            remote.close()
            raise
        self.remote, self.profile = remote, deepcopy(profile)
        self.profile_schema = ready["schema"]

    def configure(self, config_path, task):
        if self.remote is None:
            raise ValueError("No active solver profile; select a compatible profile")
        from friction_settings import load_configuration
        _, _, effective = load_configuration(config_path, self.mpc_root)
        if effective["N"] not in self.profile_schema["available_N"]:
            raise ValueError(f"Solver profile has no compatible prebuilt N={effective['N']} module")
        predictor = self.remote.request("configure", timeout=120, config_path=str(Path(config_path).resolve()), task=task)
        context = predictor.pop("plan_context")
        self.simulator_joint_dynamics = effective.get("simulator_joint_dynamics")
        law = (self.simulator_joint_dynamics or {}).get("model")
        self.simulator_identity = dict(self.simulator_identity,
            passive_joint_dynamics=deepcopy(self.simulator_joint_dynamics),
            friction_source=effective.get("friction_source"),
            integrator=("tiago_mpc.joint_dynamics.plant_stick_slip_step" if law == "coulomb_stick_slip_viscous"
                        else "tiago_mpc.joint_dynamics.plant_rk4" if law else "reach_sim.rk4"))
        self.problem_configuration = deepcopy(predictor["configuration"])
        self.problem_configuration.update(simulator_joint_dynamics=deepcopy(self.simulator_joint_dynamics),
                                          simulator_friction_source=effective.get("friction_source"))
        self.configure_task(effective, task)
        self.joint_limits = predictor["joint_limits"]
        self.profile_identity = dict(profile=deepcopy(self.profile), process_epoch=self.remote.epoch,
            predictor=predictor, simulator=self.simulator_identity,
            simulator_joint_dynamics=self.simulator_joint_dynamics, coordinate_contract=self.contract,
            joint_dynamics_differ=self.simulator_joint_dynamics != predictor.get("prediction_joint_dynamics"),
            physical_model_differs=(self.simulator_joint_dynamics != predictor.get("prediction_joint_dynamics")) or any(predictor["model_identity"].get(key) != self.simulator_identity.get(key)
                for key in ("full_urdf_sha256", "gpu_urdf_sha256")))
        # Freeze once per configuration. The session/presenter detaches this
        # shared context when producing public records; old plans keep their
        # original context across settings/profile changes.
        context.update(problem_configuration=self.problem_configuration, simulator_joint_dynamics=self.simulator_joint_dynamics, task_anchors=self.task_anchors, task_path_xyz=self.task_path_xyz,
                       solver_profile=self.profile_identity, simulator_identity=self.simulator_identity)
        self._plan_context = snapshot(context)
        self.controller.reset(self.x)
        self.restarted = True

    def solve_snapshot(self, origin, settings_version):
        if self.task["kind"] == "figure8":
            self.update_tracking_reference()
        response = self.remote.request("solve", state=self.x, time_s=self.t,
            reference=self.reference, origin=origin, settings_version=settings_version)
        event = response["plan"]
        self.u = np.asarray(response["torque_nm"])
        self.last_xu = np.asarray(event["_xu"]).copy()
        self.sequence += 1
        # Target/anchors are simulator-owned; the child's model never moves them.
        event.update(seq=self.sequence, _xu=self.last_xu, _signs=self.signs,
            _reference=self.reference, target_xyz=self.target_world_at(self.t).tolist())
        self.restarted = False
        return MappingProxyType(dict(self._plan_context, **snapshot(event)))

    def _state_fields(self, rtf=0, settings_version=0):
        event = super()._state_fields(rtf, settings_version)
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
            self._plan_context = None
