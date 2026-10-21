#!/usr/bin/env python3
"""Selected-interpreter CPU probe and explicitly requested GATO cache build.

probe prints one JSON object. build streams JSON progress and finishes with a
{event: result, result: ...} line. GATO build logs remain in its normal cache;
the job receipt/progress belong to this visualizer's ignored _expr_data.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import importlib
import inspect
import json
import os
import shutil
import tempfile
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from source_runtime import (build_jobs, discover_compatible_modules, package_binaries, prepared_model,
                            resolve_selection, source_identity)


def load_source(selection):
    sys.dont_write_bytecode = True
    os.environ["GATO_CACHE_DIR"] = selection["cache"]
    os.environ["PATH"] = str(Path(selection["python"]).parent) + os.pathsep + os.environ.get("PATH", "")
    root = Path(selection["mpc_root"])
    sys.path[:0] = [str(root / "examples"), str(root / "external/gato/python")]
    reach = importlib.import_module("reach_sim")
    if Path(reach.ROOT).resolve() != root:
        raise ValueError("reach_sim imported from outside the selected checkout")
    if not Path(reach.gato.__file__).resolve().is_relative_to(root / "external/gato"):
        raise ValueError("GATO imported from outside the selected checkout")
    # An ABI-compatible solver alone cannot make a checkout displayable. Check
    # the same full model/assets and grasp-frame binding the restarted backend
    # will construct, before persisting a selection or starting compilation.
    from server import RobotKinematics, canonical_model_assets
    canonical_model_assets(root)
    RobotKinematics(root / "models/tiago_pro/tiago_pro.urdf",
                    end_effector_frame=reach.EE_FRAME, reduced_urdf=reach.URDF)
    importlib.import_module("reaching_config").load_configuration()
    return reach


def probe(selection, reach, requested_ns=()):
    data = discover_compatible_modules(reach, requested_ns)
    data.update(selection=selection, source=source_identity(selection["mpc_root"]),
                python=dict(executable=sys.executable, version=sys.version, prefix=sys.prefix))
    return data


def build(selection, reach, ns, emit, rebuild=False):
    """Use upstream registration, cache locking and ensure_module without solvers."""
    from gato import _cache
    if not _cache.detect_arch():
        raise RuntimeError("GPU architecture is unknown; cannot build a verified current binary")
    package = Path(reach.gato.__file__).parent
    if any(package_binaries(package, reach.PLANT, n) for n in ns):
        raise RuntimeError("Package binaries shadow the cache for requested N; select another checkout")
    jobs = build_jobs()
    emit(dict(event="progress", stage="starting", jobs=jobs, N=ns))
    with prepared_model(reach, retain=True) as (_, gpu_path, _):
        emit(dict(event="progress", stage="registering", N=ns))
        reach.gato.register_robot(reach.PLANT, gpu_path, N=ns,
                                  ee_frame=reach.EE_FRAME, build=False)
        for n in ns:
            if rebuild:
                # The lookup and removal form one cache mutation. Release this
                # lock before ensure_module, which acquires the same lock itself.
                archive = None
                with _cache._locked(_cache.cache_dir()):
                    existing = _cache.find_module(reach.PLANT, n)
                    if existing is not None:
                        archive_root = ROOT / "_expr_data/source-builds"
                        archive_root.mkdir(parents=True, exist_ok=True)
                        archive = Path(tempfile.mkdtemp(prefix=f"previous-N{n}-", dir=archive_root))
                        shutil.move(str(existing), archive / Path(existing).name)
                        meta = Path(existing).parent / "meta.json"
                        if meta.exists():
                            shutil.copy2(meta, archive / "meta.json")
                if archive is not None:
                    emit(dict(event="progress", stage="archived", N=n, path=str(archive)))
            emit(dict(event="progress", stage="building", N=n, jobs=jobs))
            robot, plant_root = _cache.resolve(reach.PLANT)
            key, _ = _cache.module_key(robot, n, "default", plant_root, _cache.detect_arch())
            log_path = Path(selection["cache"]) / "modules" / reach.PLANT / key / "build.log"
            emit(dict(event="progress", stage="building", N=n, log=str(log_path)))
            stop = threading.Event()
            def report():
                # Tail upstream's log without replacing its build/cache machinery.
                offset = 0
                while not stop.wait(2):
                    text = ""
                    try:
                        with log_path.open() as stream:
                            if log_path.stat().st_size < offset:
                                offset = 0
                            stream.seek(offset)
                            text = stream.read(65536)
                            offset = stream.tell()
                    except OSError:
                        pass
                    emit(dict(event="progress", stage="building", N=n, jobs=jobs,
                              message=text or "GATO compilation is running"))
            thread = threading.Thread(target=report, daemon=True)
            thread.start()
            try:
                path = _cache.ensure_module(reach.PLANT, n, jobs=jobs)
            finally:
                stop.set()
                thread.join()
            emit(dict(event="progress", stage="built", N=n, path=str(path)))
    return probe(selection, reach, ns)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("probe", "profile-probe", "build"))
    parser.add_argument("--mpc-root", required=True)
    parser.add_argument("--python")
    parser.add_argument("--cache")
    parser.add_argument("--N", nargs="+", type=int, default=[])
    parser.add_argument("--rebuild", action="store_true", help="Explicitly rebuild requested current binaries, preserving previous bytes in _expr_data")
    args = parser.parse_args(argv)
    output = sys.stdout
    lock = threading.Lock()
    receipt = None
    def emit(value):
        line = json.dumps(value, sort_keys=True)
        with lock:
            print(line, file=output, flush=True)
            if receipt is not None:
                receipt.write(line + "\n")
                receipt.flush()
    try:
        selection = resolve_selection(args.mpc_root, args.python, args.cache)
        if os.path.abspath(sys.executable) != selection["python"]:
            os.execve(selection["python"], [selection["python"], str(Path(__file__).resolve()),
                                          *(sys.argv[1:] if argv is None else argv)], os.environ.copy())
        if args.operation == "build":
            if not args.N or any(n < 2 or n > 4096 for n in args.N):
                raise ValueError("Explicit build requires --N integers between 2 and 4096")
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            path = ROOT / "_expr_data/source-builds" / f"{stamp}.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            receipt = path.open("x")
            temp_root = ROOT / "_expr_data/source-builds/tmp"
            temp_root.mkdir(parents=True, exist_ok=True)
            os.environ["TMPDIR"] = str(temp_root)
            emit(dict(event="progress", stage="validating", log=str(path)))
        # Source helpers/codegen may print: keep stdout a strict JSON protocol.
        with redirect_stdout(sys.stderr):
            reach = load_source(selection)
            if args.operation == "build":
                result = build(selection, reach, sorted(set(args.N)), emit, args.rebuild)
                if not set(args.N).issubset(result["available_N"]):
                    raise RuntimeError("Build finished without all requested current compatible binaries")
            else:
                result = probe(selection, reach, args.N)
                if args.operation == "profile-probe":
                    # CPU geometry only: no BSQP/controller or GPU allocations.
                    from live_mpc import MPCAdapter, build_schema
                    from solver_process import model_contract
                    from gato import _cache
                    python_capture = "capture_iterations" in inspect.signature(reach.gato.BSQP.solve).parameters
                    iteration_capture = {}
                    for n in result["available_N"]:
                        module = _cache.load_module(reach.PLANT, n, build_if_missing=False)
                        iteration_capture[str(n)] = python_capture and bool(
                            getattr(module, "ITERATION_CAPTURE_AVAILABLE", False))
                    result["capabilities"] = dict(iteration_capture_by_N=iteration_capture,
                        python_iteration_capture=python_capture, exact_resume=False)
                    adapter = MPCAdapter(Path(selection["mpc_root"]), reach=reach)
                    result.update(contract=model_contract(adapter), model_identity=adapter.model_identity,
                        schema=build_schema(Path(selection["mpc_root"]), available_n=result["available_N"]))
        emit(dict(event="result", result=result) if args.operation == "build" else result)
        return 0
    except Exception as exc:
        result = dict(compatible=False, available_N=[], modules=[], error=f"{type(exc).__name__}: {exc}")
        if "selection" in locals():
            result.update(selection=selection, source=source_identity(selection["mpc_root"]))
        emit(dict(event="error", **result) if args.operation == "build" else result)
        return 1
    finally:
        if receipt is not None:
            receipt.close()


if __name__ == "__main__":
    raise SystemExit(main())
