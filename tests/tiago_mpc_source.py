"""The tiago_mpc checkout the replay tests read: TIAGO_MPC_ROOT, default ../tiago_mpc."""
import importlib.util
import os
from pathlib import Path
import sys

MPC_ROOT = Path(os.environ.get("TIAGO_MPC_ROOT") or Path(__file__).resolve().parents[2] / "tiago_mpc").resolve()
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


_PROBE = None


def live_probe():
    """What scripts/source_probe.py reports for MPC_ROOT, without compiled modules:
    the MpcParams defaults, the predictor friction and the coordinate contract."""
    global _PROBE
    if _PROBE is None:
        from dataclasses import asdict
        import json
        from live_mpc import PREDICTOR_SMOOTHING_RAD_S, import_tiago
        from server import RobotKinematics
        from solver_process import model_contract
        tiago = import_tiago(MPC_ROOT)
        mpc = importlib.import_module("tiago_mpc.mpc")
        kinematics = RobotKinematics(tiago.FULL_URDF, end_effector_frame=tiago.GRASP_FRAME, reduced_urdf=tiago.ARM_URDF)
        plain = lambda value: json.loads(json.dumps(value))
        _PROBE = dict(compatible=True, available_N=[], available_N_by_friction=dict(off=[], on=[]), modules=[],
                      defaults=plain(asdict(mpc.TIAGO)),
                      friction=plain(asdict(tiago.urdf_friction(PREDICTOR_SMOOTHING_RAD_S))),
                      contract=model_contract(kinematics, tiago),
                      capabilities=dict(iteration_capture_by_friction=dict(off={}, on={}), exact_resume=False))
    from copy import deepcopy
    return deepcopy(_PROBE)
