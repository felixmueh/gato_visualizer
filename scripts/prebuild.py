#!/usr/bin/env python3
"""Prepare the visualizer's solver modules explicitly, never from the UI."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mpc-root", type=Path,
                        default=Path(os.environ.get("TIAGO_MPC_ROOT", ROOT.parent / "tiago_mpc")))
    parser.add_argument("--N", type=int, nargs="+", default=[16, 32, 64, 128])
    args = parser.parse_args()
    mpc_root = args.mpc_root.expanduser().resolve()
    if not args.N or any(n not in (16, 32, 64, 128) for n in args.N):
        parser.error("Supported N values: 16 32 64 128")
    os.environ["GATO_CACHE_DIR"] = str(ROOT / ".cache/gato")
    os.environ["PATH"] = str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"]
    # Use the selected checkout even when the interpreter has another editable install.
    sys.path[:0] = [str(mpc_root / "examples"), str(mpc_root / "external/gato/python")]
    import reach_sim
    import gato
    from gato import _cache

    with ExitStack() as stack:
        # Respect experiment windows during code generation/building too. No GPU
        # kernels or solver construction are needed to populate the cache.
        for path in (mpc_root.parent / "GATO-upstream-contributions/.gpu.lock",
                     Path("/tmp/a2rlab-timing.lock"),
                     mpc_root.parent / "GATO/.git/experiment-runner.lock"):
            if not path.parent.is_dir():
                continue
            handle = stack.enter_context(path.open("a"))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                parser.exit(2, f"GPU experiment owns {path}; run setup after it finishes.\n")
        _, gpu_urdf, _ = reach_sim.runtime_urdf()
        gato.register_robot(reach_sim.PLANT, gpu_urdf, N=sorted(set(args.N)),
                            ee_frame=reach_sim.EE_FRAME, build=True, jobs=1)
        modules = {str(n): str(_cache.find_module(reach_sim.PLANT, n)) for n in args.N}
        if any(value == "None" for value in modules.values()):
            raise RuntimeError("A built module is missing from the current cache identity")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        receipt = ROOT / "_expr_data/prebuild" / f"{stamp}.json"
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(dict(python=sys.executable, mpc_root=str(mpc_root),
                                          cache=os.environ["GATO_CACHE_DIR"], modules=modules), indent=2) + "\n")
        print(f"Ready: N={', '.join(modules)}\nReceipt: {receipt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
