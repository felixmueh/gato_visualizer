"""The tiago_mpc checkout the replay tests read: TIAGO_MPC_ROOT, default ../tiago_mpc."""
import importlib.util
import os
from pathlib import Path
import sys

MPC_ROOT = Path(os.environ.get("TIAGO_MPC_ROOT") or Path(__file__).resolve().parents[2] / "tiago_mpc").resolve()
MODEL = MPC_ROOT / "models/tiago_pro/tiago_pro.urdf"
REPLAY_EXPORTER = MPC_ROOT / "experiments/replay.py"


def replay_exporter():
    """tiago_mpc's experiments/replay.py (save_replay); it imports tiago_mpc.tiago."""
    if str(MPC_ROOT) not in sys.path:
        sys.path.append(str(MPC_ROOT))
    spec = importlib.util.spec_from_file_location("tiago_mpc_replay_exporter", REPLAY_EXPORTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
