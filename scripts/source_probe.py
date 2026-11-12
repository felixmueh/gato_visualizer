#!/usr/bin/env python3
"""Selected-interpreter source probe and explicitly requested GATO module builds.

probe prints one JSON object: whether tiago_mpc's MPC API imports from the selected
checkout, the cache in effect (selection.effective_cache: the override, else
tiago_mpc's cache_root() default), which modules find_binary finds (KNOT_COUNTS, with and without predictor
friction), the MpcParams defaults and the coordinate contract. It never compiles.
build runs compile_binary per requested N (CPU only), streams JSON progress and
finishes with a {event: result, result: <probe>} line.
model resolves one predictor draft and checks find_binary for the offered N,
without importing native modules for capture discovery or constructing a solver.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from dataclasses import fields, is_dataclass, replace
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
from native_cost import native_params, with_knot_count, validate_native_cost


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
    from live_mpc import import_tiago
    tiago = import_tiago(root)
    mpc = importlib.import_module("tiago_mpc.mpc")
    for name in ("MpcParams", "TIAGO", "Mpc", "find_binary", "compile_binary"):
        if not hasattr(mpc, name):
            raise ValueError(f"tiago_mpc.mpc lacks {name}; the visualizer needs the step-13 MPC API")
    if not hasattr(mpc.Mpc, "warmup") or not hasattr(mpc.TIAGO, "max_sqp_time_s"):
        raise ValueError("tiago_mpc.mpc lacks Mpc.warmup or MpcParams.max_sqp_time_s; "
                         "the visualizer needs tiago_mpc 31c405a or later (steps 15 and 16)")
    if not all(hasattr(mpc.Mpc, name) for name in ("request", "result")):
        raise ValueError("tiago_mpc.mpc lacks Mpc.request or Mpc.result; the visualizer needs the request/result MPC API")
    sim = importlib.import_module("tiago_mpc.sim")
    plant, config = sim.SimPlant, getattr(sim, "SimConfig", None)
    if (not is_dataclass(config) or not {"q", "qd", "substep", "integrator", "friction", "friction_law"} <=
            {field.name for field in fields(config)} or not callable(getattr(config, "build", None)) or
            "config" not in inspect.signature(plant).parameters):
        raise ValueError("The visualizer needs tiago_mpc.sim.SimConfig(..., friction_law=...).build() and SimPlant(config)")
    from gato.cost_menu import CostMenu
    solver_settings = getattr(mpc, "SolverSettings", None)
    default_cost = getattr(importlib.import_module("tiago_mpc.costs"), "default_cost", None)
    if (not is_dataclass(solver_settings) or not isinstance(mpc.TIAGO.solver, solver_settings)
            or not isinstance(getattr(mpc.TIAGO, "cost", None), CostMenu)
            or {"q_cost", "N_cost", "qd_cost", "u_cost"} & {field.name for field in fields(solver_settings)}
            or not callable(default_cost) or not {"position", "terminal_position", "velocity", "torque",
                                                   "orientation", "terminal_orientation"} <=
            set(inspect.signature(default_cost).parameters)):
        raise ValueError("The visualizer needs native MpcParams.cost CostMenu and SolverSettings (tiago_mpc 221acad or later)")
    if not is_dataclass(mpc.MpcParams) or "friction_law" not in {field.name for field in fields(mpc.MpcParams)}:
        raise ValueError("The visualizer needs MpcParams.friction_law (coefficient-only friction API)")
    start = getattr(plant, "start", None)
    if (not callable(getattr(importlib.import_module("tiago_mpc.clock"), "VirtualClock", None)) or
            not callable(start) or "clock" not in inspect.signature(start).parameters):
        raise ValueError("The visualizer needs tiago_mpc.clock.VirtualClock and SimPlant.start(clock)")
    interfaces = importlib.import_module("tiago_mpc.interfaces")
    required_fields = {"State": {"t", "q", "qd"}, "Plan": {"t0", "dt", "states", "torques", "stats"}}
    if not all(is_dataclass(getattr(interfaces, name, None)) and required <=
               {field.name for field in fields(getattr(interfaces, name))}
               for name, required in required_fields.items()):
        raise ValueError("The visualizer needs tiago_mpc.interfaces.State and Plan")
    record = importlib.import_module("tiago_mpc.record")
    if not all(callable(getattr(record, name, None)) for name in ("to_dict", "from_dict", "provenance")):
        raise ValueError("The visualizer needs tiago_mpc.record.to_dict, from_dict and provenance")
    require_shared_loop(importlib.import_module("tiago_mpc.loops"), interfaces,
                        importlib.import_module("tiago_mpc.laws"))
    if not hasattr(tiago, "arm_urdf"):
        raise ValueError("tiago_mpc.tiago lacks arm_urdf; the visualizer needs tiago_mpc's derived arm (2026-10-23)")
    # An importable solver alone cannot make a checkout displayable. Check the same
    # full model/assets and grasp-frame binding the restarted backend will construct.
    from server import RobotKinematics, canonical_model_assets
    canonical_model_assets(root)
    from live_mpc import body_joints
    kinematics = RobotKinematics(tiago.FULL_URDF, body_joints(root), end_effector_frame=tiago.GRASP_FRAME,
                                 reduced_urdf=tiago.arm_urdf())
    return tiago, mpc, kinematics, tiago.urdf_friction()


def require_shared_loop(loops, interfaces, laws):
    """Fail explicitly when a selected source cannot run Live's shared engine."""
    run = getattr(loops, "run_virtual_time", None)
    required = {"settings", "duration", "compensation", "safety", "effort_handling",
                "tick_callbacks", "solve_completed_callbacks", "diagnostic_callbacks",
                "before_tick_callbacks", "cancelled",
                "start_time_s", "initial_command"}
    setting_fields = {"command_period", "update_period", "solve_latency_s"}
    if not callable(run) or not required <= set(inspect.signature(run).parameters):
        raise ValueError("The visualizer needs tiago_mpc's shared run_virtual_time API "
                         "(settings, duration, compensation, safety, effort handling, tick, solve-completed and diagnostic "
                         "callbacks, before-tick callbacks, cancellation, "
                         "start time and initial command); "
                         "select a source with the shared Live loop")
    if inspect.signature(run).parameters["duration"].default is not inspect.Parameter.empty:
        raise ValueError("The visualizer needs run_virtual_time with a required finite duration")
    settings = getattr(loops, "VirtualTimeSettings", None)
    if not inspect.isclass(settings) or not is_dataclass(settings) or not setting_fields <= {
            field.name for field in fields(settings)}:
        raise ValueError("The visualizer needs tiago_mpc.loops.VirtualTimeSettings with command/update periods "
                         "and solve latency")
    safety = getattr(laws, "ExecutionSafety", None)
    if (not inspect.isclass(safety) or not is_dataclass(safety) or
            "max_plan_age_s" not in {field.name for field in fields(safety)} or
            not callable(getattr(safety, "validate", None)) or
            not {"plan", "t", "state"} <= set(inspect.signature(safety.validate).parameters)):
        raise ValueError("The visualizer needs tiago_mpc.laws.ExecutionSafety(max_plan_age_s=...) "
                         "with validate(plan, t, state)")
    payload_fields = {
        "SolveCompleted": {"request_time_s", "initial", "reference", "updates", "plan"},
        "Tick": {"t", "state", "command", "plan", "plan_activated", "update", "requested_command", "clipped"},
        "Diagnostic": {"t", "kind", "message", "data"},
    }
    for name, required_fields in payload_fields.items():
        payload = getattr(interfaces, name, None)
        if not is_dataclass(payload) or not required_fields <= {field.name for field in fields(payload)}:
            raise ValueError(f"The visualizer needs tiago_mpc.interfaces.{name} from the shared Live loop")
    if not callable(getattr(laws, "EffortClip", None)):
        raise ValueError("The visualizer needs tiago_mpc.laws.EffortClip")


def variant(mpc, n, friction):
    return replace(with_knot_count(mpc.TIAGO, n), friction=friction)


def find_variant(mpc, params, n):
    """A custom menu only offers its captured horizon; never overwrite its objective."""
    from tiago_mpc.record import to_dict
    from native_cost import cost_weights
    validate_native_cost(params)
    if n != params.N and cost_weights(to_dict(params.cost)) is None:
        return None
    return mpc.find_binary(with_knot_count(params, n))


_UNPINNED_SETTINGS = object()

def requested_params(selection, mpc, params=None, source_settings=None, source_settings_module=_UNPINNED_SETTINGS):
    """Resolve a draft, or retain already captured native params without current hooks."""
    from tiago_mpc.record import to_dict
    from worktree_settings import describe_settings, resolve_predictor, validate_description
    base = mpc.TIAGO if params is None else native_params(params)
    if not isinstance(base, mpc.MpcParams):
        raise ValueError("params must be the selected package's serialized MpcParams")
    validate_native_cost(base)
    if params is not None and source_settings is None:
        # Historical inspection/build supplies already-resolved native params.
        # Even importing a current provider would make history depend on its code.
        description = validate_description({})
        description["module"] = None
        return base, dict(values=None, effective=to_dict(base), module=None), description
    description = describe_settings(selection["mpc_root"])
    values = description["predictor"]["defaults"] if source_settings is None else source_settings
    expected = description["module"] if source_settings_module is _UNPINNED_SETTINGS else source_settings_module
    actual, captured = resolve_predictor(selection["mpc_root"], values, base, to_dict, expected_module=expected)
    validate_native_cost(actual)
    return actual, captured, description


def experiment_defaults():
    """The selected source's native execution defaults as Live controls: the
    virtual-time loop's default timing and whether it compensates latency."""
    import inspect
    from tiago_mpc import loops
    signature = inspect.signature(loops.run_virtual_time).parameters
    timing = signature["settings"].default
    compensation = signature["compensation"].default
    return dict(execution=dict(control_hz=1 / timing.command_period,
                               to_hz=1 / timing.update_period if timing.update_period else 0.,
                               solve_latency_s=timing.solve_latency_s,
                               latency_compensation=compensation is not None))


def probe(selection, tiago, mpc, kinematics, friction, params=None, source_settings=None, source_settings_module=_UNPINNED_SETTINGS):
    from solver_process import model_contract
    from tiago_mpc.record import provenance, to_dict
    actual, captured, description = requested_params(selection, mpc, params, source_settings, source_settings_module)
    source_provenance = provenance()  # before native capability imports can alter package metadata
    from worktree_settings import has_predictor_settings
    exact = (params is not None or source_settings is not None
             or source_settings_module is not _UNPINNED_SETTINGS or has_predictor_settings(description))
    python_capture = "capture_iterations" in inspect.signature(importlib.import_module("gato").BSQP.solve).parameters
    available, modules, captures = dict(off=[], on=[]), [], dict(off={}, on={})
    variants = [("on" if actual.friction is not None else "off", actual)] if exact else [
        ("off", replace(actual, friction=None)), ("on", replace(actual, friction=friction))]
    for mode, model_params in variants:
        for n in KNOT_COUNTS:
            path = find_variant(mpc, model_params, n)
            modules.append(dict(N=n, friction=mode == "on", status="compatible" if path else "missing",
                                path=None if path is None else str(path)))
            if path is not None:
                available[mode].append(n)
                captures[mode][str(n)] = python_capture and module_captures(path)
    digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
    roles = {role: dict(description[role], module=description["module"]) for role in ("simulation", "predictor")}
    return dict(compatible=True, supported_N=list(KNOT_COUNTS),
                available_N=sorted(set(available["off"]) | set(available["on"])),
                available_N_by_friction=available, modules=modules, exact_availability=exact,
                defaults=to_dict(mpc.TIAGO), experiment_defaults=experiment_defaults(),
                friction=to_dict(friction), source_settings=roles,
                effective_settings=dict(params=to_dict(actual), modules=dict(predictor=captured["module"])),
                requested_source_settings=captured["values"],
                contract=model_contract(kinematics, tiago),
                model_identity=dict(full_urdf_sha256=digest(tiago.FULL_URDF), native_urdf_sha256=digest(tiago.arm_urdf()),
                                    armature=list(getattr(actual, "armature", (0.,)*7)), friction=to_dict(actual.friction)),
                capabilities=dict(iteration_capture_by_friction=captures, python_iteration_capture=python_capture,
                                  exact_resume=False, shared_loop=True),
                selection=dict(selection, effective_cache=str(importlib.import_module("tiago_mpc.util").cache_root())),
                source=dict(source_identity(selection["mpc_root"]), gato=source_provenance["gato"]),
                python=dict(executable=sys.executable, version=sys.version, prefix=sys.prefix))


def model(selection, tiago, mpc, kinematics, friction, params=None, source_settings=None, source_settings_module=_UNPINNED_SETTINGS):
    """Read-only native availability for one resolved draft; no guessed cache identity.

    The full effective MpcParams goes to find_binary, so the selected package owns
    which settings affect compilation. Missing modules are a valid draft status.
    """
    from tiago_mpc.record import to_dict
    from tiago_mpc.util import cache_root
    actual, captured, description = requested_params(selection, mpc, params, source_settings, source_settings_module)
    if type(actual.N) is not int or actual.N not in KNOT_COUNTS:
        raise ValueError(f"Requested N must be among {', '.join(map(str, KNOT_COUNTS))}")
    available, binary = [], None
    for n in KNOT_COUNTS:
        path = find_variant(mpc, actual, n)
        if path is not None:
            available.append(n)
            if n == actual.N:
                binary = str(path)
    by_mode = dict(off=[], on=[])
    by_mode["on" if actual.friction is not None else "off"] = available
    roles = {role: dict(description[role], module=description["module"]) for role in ("simulation", "predictor")}
    return dict(compatible=True, selection=dict(selection, effective_cache=str(cache_root())),
                exact_availability=True, supported_N=list(KNOT_COUNTS), available_N=available,
                available_N_by_friction=by_mode, source_settings=roles,
                requested_source_settings=captured["values"],
                effective_settings=dict(params=to_dict(actual), modules=dict(predictor=captured["module"])),
                compilation=dict(ready=binary is not None, N=actual.N, supported_N=list(KNOT_COUNTS),
                                 available_N=available, binary_path=binary))


def module_captures(path):
    """Whether the compiled module records SQP iterations; importing it needs no GPU."""
    name = "gato." + Path(path).name.split(".")[0]
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, path)
        module = sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return bool(getattr(module, "ITERATION_CAPTURE_AVAILABLE", False))


def build(selection, loaded, ns, emit, rebuild=False, prediction_friction=False, params=None, source_settings=None, source_settings_module=_UNPINNED_SETTINGS):
    """compile_binary per N: CPU only, a no-op when cached unless rebuild, which
    unlinks the old module (processes that loaded it keep their mapping)."""
    tiago, mpc, kinematics, friction = loaded
    from worktree_settings import describe_settings, has_predictor_settings
    extension = (has_predictor_settings(describe_settings(selection["mpc_root"]))
                 if params is None and selection.get("mpc_root") else False)
    exact = (params is not None or extension or source_settings is not None
             or source_settings_module is not _UNPINNED_SETTINGS)
    actual = (requested_params(selection, mpc, params, source_settings, source_settings_module)[0] if exact else
              replace(mpc.TIAGO, friction=friction if prediction_friction else None))
    validate_native_cost(actual)
    jobs = build_jobs()
    emit(dict(event="progress", stage="starting", jobs=jobs, N=ns, prediction_friction=prediction_friction,
              exact_availability=exact))
    for n in ns:
        emit(dict(event="progress", stage="building", N=n, jobs=jobs))
        stop = threading.Event()
        def report():
            while not stop.wait(5):
                emit(dict(event="progress", stage="building", N=n, message="GATO compilation is running"))
        thread = threading.Thread(target=report, daemon=True)
        thread.start()
        try:
            path = mpc.compile_binary(with_knot_count(actual, n),
                                      use_cache=not rebuild, jobs=jobs)
        finally:
            stop.set()
            thread.join()
        emit(dict(event="progress", stage="built", N=n, path=str(path)))
    return probe(selection, *loaded, params=params, source_settings=source_settings,
                 source_settings_module=source_settings_module)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("probe", "model", "build"))
    parser.add_argument("--mpc-root", required=True)
    parser.add_argument("--python")
    parser.add_argument("--cache")
    parser.add_argument("--N", nargs="+", type=int, default=[])
    parser.add_argument("--prediction-friction", action="store_true", help="Build the predictor-friction variant")
    parser.add_argument("--rebuild", action="store_true", help="Rebuild requested modules even when cached")
    parser.add_argument("--params-json", help="Exact native MpcParams; without source settings these are already resolved")
    parser.add_argument("--source-settings-json", help="Predictor adapter values for the requested native base params")
    parser.add_argument("--source-settings-module-json", default=argparse.SUPPRESS,
                        help="Expected settings module identity; explicit null pins absence")
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
            params = json.loads(args.params_json) if args.params_json is not None else None
            source_settings = json.loads(args.source_settings_json) if args.source_settings_json is not None else None
            source_settings_module = (json.loads(args.source_settings_module_json)
                                      if hasattr(args, "source_settings_module_json") else _UNPINNED_SETTINGS)
            if args.operation == "build":
                result = build(selection, loaded, sorted(set(args.N)), emit, args.rebuild, args.prediction_friction, params, source_settings, source_settings_module)
                if not set(args.N) <= set(result["available_N"] if result.get("exact_availability") else
                                          result["available_N_by_friction"]["on" if args.prediction_friction else "off"]):
                    raise RuntimeError("Build finished, but find_binary does not find every requested module")
            elif args.operation == "model":
                result = model(selection, *loaded, params=params, source_settings=source_settings,
                               source_settings_module=source_settings_module)
            else:
                result = probe(selection, *loaded, params=params, source_settings=source_settings,
                 source_settings_module=source_settings_module)
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
