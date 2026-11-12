"""The tiago_mpc checkout the tests read: TIAGO_MPC_ROOT or the visualizer's stable base."""
import importlib.util
import os
from pathlib import Path
import sys
from visualizer_config import DEFAULT_MPC_ROOT
from execution_session import DEFAULT_EXECUTION
import source_runtime

# Complete execution settings for tests: the visualizer's own fields plus the native
# timing a schema supplies from tiago_mpc's defaults (fixed here for the schedulers).
EXECUTION = dict(DEFAULT_EXECUTION, control_hz=500., to_hz=100., solve_latency_s="measured",
                 latency_compensation=False)

MPC_ROOT = Path(os.environ.get("TIAGO_MPC_ROOT") or DEFAULT_MPC_ROOT).resolve()
MODEL = MPC_ROOT / "models/tiago_pro/tiago_pro.urdf"
REPLAY_EXPORTER = MPC_ROOT / "experiments/replay.py"


def replay_exporter():
    """tiago_mpc's experiments/replay.py (save_replay). Its tiago_mpc.tiago import
    is isolated, so tests that import another checkout's tiago_mpc are unaffected."""
    ours = lambda name: name == "tiago_mpc" or name.startswith("tiago_mpc.")
    others = {name: sys.modules.pop(name) for name in list(sys.modules) if ours(name)}
    sys.path.insert(0, str(MPC_ROOT))
    try:
        spec = importlib.util.spec_from_file_location("tiago_mpc_replay_exporter", REPLAY_EXPORTER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(MPC_ROOT))
        for name in [name for name in sys.modules if ours(name)]:
            del sys.modules[name]
        sys.modules.update(others)


def arm_urdf():
    """MPC_ROOT's reduced arm, which tiago_mpc derives into its cache (GATO_CACHE_DIR)."""
    from live_mpc import import_tiago
    return import_tiago(MPC_ROOT).arm_urdf()


_PROBE = None


def live_probe():
    """What scripts/source_probe.py reports for MPC_ROOT, without compiled modules:
    the MpcParams defaults, the predictor friction and the coordinate contract."""
    global _PROBE
    if _PROBE is None:
        from live_mpc import import_tiago
        from server import RobotKinematics
        from solver_process import model_contract
        tiago = import_tiago(MPC_ROOT)
        mpc = importlib.import_module("tiago_mpc.mpc")
        from live_mpc import body_joints
        kinematics = RobotKinematics(tiago.FULL_URDF, body_joints(MPC_ROOT), end_effector_frame=tiago.GRASP_FRAME,
                                     reduced_urdf=tiago.arm_urdf())
        from tiago_mpc.record import to_dict
        from worktree_settings import describe_settings, resolve_predictor
        from scripts.source_probe import experiment_defaults
        description = describe_settings(MPC_ROOT)
        effective, captured = resolve_predictor(MPC_ROOT, description["predictor"]["defaults"], mpc.TIAGO, to_dict)
        _PROBE = dict(compatible=True, supported_N=list(source_runtime.KNOT_COUNTS), available_N=[], available_N_by_friction=dict(off=[], on=[]), modules=[],
                      source_settings={role: dict(description[role], module=description["module"])
                                       for role in ("simulation", "predictor")},
                      effective_settings=dict(params=to_dict(effective), modules=dict(predictor=captured["module"])),
                      defaults=to_dict(mpc.TIAGO), experiment_defaults=experiment_defaults(),
                      friction=to_dict(tiago.urdf_friction()),
                      contract=model_contract(kinematics, tiago),
                      capabilities=dict(iteration_capture_by_friction=dict(off={}, on={}), exact_resume=False))
    from copy import deepcopy
    return deepcopy(_PROBE)


def start_pose():
    """MPC_ROOT's start pose specification (live_mpc.start_pose_spec: Q_START, URDF limits)."""
    from live_mpc import import_tiago, start_pose_spec
    return start_pose_spec(import_tiago(MPC_ROOT))
