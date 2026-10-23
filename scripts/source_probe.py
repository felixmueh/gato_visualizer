#!/usr/bin/env python3
"""Selected-interpreter source probe and explicitly requested GATO module builds.

probe prints one JSON object: whether tiago_mpc's MPC API imports from the selected
checkout, the cache in effect (selection.effective_cache: the override, else
tiago_mpc's cache_root() default), which modules find_binary finds (KNOT_COUNTS, with and without predictor
friction), the MpcParams defaults and the coordinate contract. It never compiles.
build runs compile_binary per requested N (CPU only), streams JSON progress and
finishes with a {event: result, result: <probe>} line.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from dataclasses import asdict, replace
import hashlib
import importlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from source_runtime import KNOT_COUNTS, build_jobs, resolve_selection, source_identity


def load_source(selection):
    """tiago_mpc's mpc and tiago modules from the selected checkout, checked for the API
    the visualizer uses, plus the display model it will construct."""
    sys.dont_write_bytecode = True
    # An explicit override, else unset: tiago_mpc's cache_root() then picks its default.
    if selection["cache"]:
        os.environ["GATO_CACHE_DIR"] = selection["cache"]
    else:
        os.environ.pop("GATO_CACHE_DIR", None)
    os.environ["PATH"] = str(Path(selection["python"]).parent) + os.pathsep + os.environ.get("PATH", "")
    root = Path(selection["mpc_root"])
    from live_mpc import PREDICTOR_SMOOTHING_RAD_S, import_tiago
    tiago = import_tiago(root)
    mpc = importlib.import_module("tiago_mpc.mpc")
    for name in ("MpcParams", "TIAGO", "Mpc", "find_binary", "compile_binary"):
        if not hasattr(mpc, name):
            raise ValueError(f"tiago_mpc.mpc lacks {name}; the visualizer needs the step-13 MPC API")
    if not hasattr(mpc.Mpc, "warmup") or not hasattr(mpc.TIAGO, "max_sqp_time_s"):
        raise ValueError("tiago_mpc.mpc lacks Mpc.warmup or MpcParams.max_sqp_time_s; "
                         "the visualizer needs tiago_mpc 31c405a or later (steps 15 and 16)")
    if not {"integrator", "coulomb_law"} <= set(inspect.signature(importlib.import_module("tiago_mpc.sim").SimPlant).parameters):
        raise ValueError("tiago_mpc.sim.SimPlant lacks integrator or coulomb_law; the visualizer needs "
                         "tiago_mpc's plant options (2026-10-23)")
    if not hasattr(tiago, "arm_urdf"):
        raise ValueError("tiago_mpc.tiago lacks arm_urdf; the visualizer needs tiago_mpc's derived arm (2026-10-23)")
    # An importable solver alone cannot make a checkout displayable. Check the same
    # full model/assets and grasp-frame binding the restarted backend will construct.
    from server import RobotKinematics, canonical_model_assets
    canonical_model_assets(root)
    kinematics = RobotKinematics(tiago.FULL_URDF, end_effector_frame=tiago.GRASP_FRAME, reduced_urdf=tiago.arm_urdf())
    return tiago, mpc, kinematics, tiago.urdf_friction(PREDICTOR_SMOOTHING_RAD_S)


def variant(mpc, n, friction):
    return replace(mpc.TIAGO, N=n, friction=friction)


def probe(selection, tiago, mpc, kinematics, friction):
    from solver_process import model_contract
    python_capture = "capture_iterations" in inspect.signature(importlib.import_module("gato").BSQP.solve).parameters
    available, modules, captures = dict(off=[], on=[]), [], dict(off={}, on={})
    for mode, losses in (("off", None), ("on", friction)):
        for n in KNOT_COUNTS:
            path = mpc.find_binary(variant(mpc, n, losses))
            modules.append(dict(N=n, friction=mode == "on", status="compatible" if path else "missing",
                                path=None if path is None else str(path)))
            if path is not None:
                available[mode].append(n)
                captures[mode][str(n)] = python_capture and module_captures(path)
    digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return dict(compatible=True, available_N=sorted(set(available["off"]) | set(available["on"])),
                available_N_by_friction=available, modules=modules,
                defaults=json.loads(json.dumps(asdict(mpc.TIAGO))), friction=json.loads(json.dumps(asdict(friction))),
                contract=model_contract(kinematics, tiago),
                model_identity=dict(full_urdf_sha256=digest(tiago.FULL_URDF), native_urdf_sha256=digest(tiago.arm_urdf())),
                capabilities=dict(iteration_capture_by_friction=captures, python_iteration_capture=python_capture,
                                  exact_resume=False),
                selection=dict(selection, effective_cache=str(importlib.import_module("tiago_mpc.util").cache_root())),
                source=source_identity(selection["mpc_root"]),
                python=dict(executable=sys.executable, version=sys.version, prefix=sys.prefix))


def module_captures(path):
    """Whether the compiled module records SQP iterations; importing it needs no GPU."""
    name = "gato." + Path(path).name.split(".")[0]
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, path)
        module = sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return bool(getattr(module, "ITERATION_CAPTURE_AVAILABLE", False))


def build(selection, loaded, ns, emit, rebuild=False, prediction_friction=False):
    """compile_binary per N: CPU only, a no-op when cached unless rebuild, which
    unlinks the old module (processes that loaded it keep their mapping)."""
    tiago, mpc, kinematics, friction = loaded
    jobs = build_jobs()
    emit(dict(event="progress", stage="starting", jobs=jobs, N=ns, prediction_friction=prediction_friction))
    for n in ns:
        emit(dict(event="progress", stage="building", N=n, jobs=jobs))
        stop = threading.Event()
        def report():
            while not stop.wait(5):
                emit(dict(event="progress", stage="building", N=n, message="GATO compilation is running"))
        thread = threading.Thread(target=report, daemon=True)
        thread.start()
        try:
            path = mpc.compile_binary(variant(mpc, n, friction if prediction_friction else None),
                                      use_cache=not rebuild, jobs=jobs)
        finally:
            stop.set()
            thread.join()
        emit(dict(event="progress", stage="built", N=n, path=str(path)))
    return probe(selection, *loaded)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("probe", "build"))
    parser.add_argument("--mpc-root", required=True)
    parser.add_argument("--python")
    parser.add_argument("--cache")
    parser.add_argument("--N", nargs="+", type=int, default=[])
    parser.add_argument("--prediction-friction", action="store_true", help="Build the predictor-friction variant")
    parser.add_argument("--rebuild", action="store_true", help="Rebuild requested modules even when cached")
    args = parser.parse_args(argv)
    output = sys.stdout
    lock = threading.Lock()
    def emit(value):
        with lock:
            print(json.dumps(value), file=output, flush=True)
    try:
        selection = resolve_selection(args.mpc_root, args.python, args.cache)
        if os.path.abspath(sys.executable) != selection["python"]:
            os.execve(selection["python"], [selection["python"], str(Path(__file__).resolve()),
                                          *(sys.argv[1:] if argv is None else argv)], os.environ.copy())
        if args.operation == "build" and (not args.N or not set(args.N) <= set(KNOT_COUNTS)):
            raise ValueError(f"Explicit build requires --N among {', '.join(map(str, KNOT_COUNTS))}")
        # Source helpers/codegen may print: keep stdout a strict JSON protocol.
        with redirect_stdout(sys.stderr):
            loaded = load_source(selection)
            if args.operation == "build":
                result = build(selection, loaded, sorted(set(args.N)), emit, args.rebuild, args.prediction_friction)
                if not set(args.N) <= set(result["available_N_by_friction"]["on" if args.prediction_friction else "off"]):
                    raise RuntimeError("Build finished, but find_binary does not find every requested module")
            else:
                result = probe(selection, *loaded)
        emit(dict(event="result", result=result) if args.operation == "build" else result)
        return 0
    except Exception as exc:
        result = dict(compatible=False, available_N=[], modules=[], error=f"{type(exc).__name__}: {exc}")
        if "selection" in locals():
            result.update(selection=selection, source=source_identity(selection["mpc_root"]))
        emit(dict(event="error", **result) if args.operation == "build" else result)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
