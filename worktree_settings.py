"""Visualizer-owned adapters with an optional checkout-local override.

Trusted local Python is imported only by a selected source/profile child. HTTP
code may use the pure description/value validators without loading a provider.
"""
from copy import deepcopy
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys

ROLES = ("simulation", "predictor")
_PATH = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
_LOADED = {}
_UNSET = object()
BUNDLED_ADAPTER = Path(__file__).resolve().parent / "adapters/tiago.py"


def plain(value):
    """Detach finite JSON metadata/values; no objects or callables cross RPC."""
    try:
        return json.loads(json.dumps(value, allow_nan=False))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Worktree settings must be finite JSON values: {exc}") from exc


def leaves(value, prefix="", paths=()):
    out = {}
    for name, item in value.items():
        if not isinstance(name, str) or not _PATH.fullmatch(name):
            raise ValueError(f"Invalid settings key {name!r}")
        path = f"{prefix}.{name}" if prefix else name
        if isinstance(item, dict) and path not in paths:
            out.update(leaves(item, path, paths))
        else:
            out[path] = item
    return out


def choice_value(choice):
    return choice["value"] if isinstance(choice, dict) and set(choice) == {"value", "label"} else choice


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# Obstacle layouts (descriptor kind shapes, tiago_mpc.collision.Collision): sphere (x, y, z,
# r), capsule (ax, ay, az, bx, by, bz, r), box (cx, cy, cz, qx, qy, qz, qw, hx, hy, hz;
# quaternion xyzw, half-extents) and plane (nx, ny, nz, d; free side n.p >= d).
SHAPE_WIDTHS = {"sphere": 4, "capsule": 7, "box": 10, "plane": 4}


def _shape_valid(spec, item):
    """Finite values of the shape's width; positions (and a plane's d) within bound, sizes in
    (min_size, max_size], a nonzero quaternion or normal."""
    shape = spec["shape"]
    if not isinstance(item, list) or len(item) != SHAPE_WIDTHS[shape] or not all(_number(value) for value in item):
        return False
    bound, low, high = spec.get("bound", math.inf), spec.get("min_size", 0), spec.get("max_size", math.inf)
    sized = lambda values: all(low < value <= high for value in values)
    within = lambda values: all(abs(value) <= bound for value in values)
    if shape == "sphere":
        return within(item[:3]) and sized(item[3:])
    if shape == "capsule":
        return within(item[:6]) and sized(item[6:])
    if shape == "box":
        return within(item[:3]) and math.hypot(*item[3:7]) > 1e-9 and sized(item[7:])
    return math.hypot(*item[:3]) > 1e-9 and within(item[3:])


def _check_value(spec, value):
    kind = spec["kind"]
    if kind == "bool":
        valid = isinstance(value, bool)
    elif kind == "choice":
        valid = any(type(value) is type(choice) and value == choice
                    for choice in map(choice_value, spec["choices"]))
    elif kind == "shapes":
        valid = isinstance(value, list) and len(value) <= spec.get("max_count", math.inf) and all(
            _shape_valid(spec, item) for item in value)
    elif value is None:
        valid = bool(spec.get("nullable")) and kind != "vector"
    else:
        values = value if kind == "vector" else [value]
        valid = kind != "vector" or isinstance(value, list) and len(value) == spec["length"]
        valid = valid and all(_number(item) and (kind != "int" or type(item) is int)
                              and ("min" not in spec or (item > spec["min"] if spec.get("min_exclusive") else item >= spec["min"]))
                              and ("max" not in spec or (item < spec["max"] if spec.get("max_exclusive") else item <= spec["max"]))
                              for item in values)
    if not valid:
        raise ValueError(f"Invalid {spec['path']}: {value!r}")


def validate_values(description, role, values):
    """Complete scoped values, including inactive controls; presentation hides none from validation."""
    if role not in ROLES or not isinstance(values, dict):
        raise ValueError(f"{role}: settings must be an object")
    detached = plain(values)
    specs = {item["path"]: item for item in description[role]["parameters"]}
    supplied = leaves(detached, paths=specs)
    if set(supplied) != set(specs):
        raise ValueError(f"{role}: complete settings required; missing={sorted(specs.keys()-supplied.keys())}, "
                         f"unknown={sorted(supplied.keys()-specs.keys())}")
    for name, spec in specs.items():
        _check_value(spec, supplied[name])
    return detached


def validate_description(value):
    """Small fixed descriptor vocabulary, shared by server and generic renderer."""
    result = plain(value)
    if not isinstance(result, dict) or set(result) - {*ROLES, "presets"}:
        raise ValueError("describe() must return simulation/predictor sections and optional presets")
    for role in ROLES:
        section = result.setdefault(role, dict(defaults={}, parameters=[], controls=[]))
        if not isinstance(section, dict) or set(section) != {"defaults", "parameters", "controls"}:
            raise ValueError(f"{role}: defaults, parameters and controls are required")
        if not isinstance(section["defaults"], dict) or not isinstance(section["parameters"], list):
            raise ValueError(f"{role}: defaults object and parameters list required")
        controls = section["controls"]
        if (not isinstance(controls, list)
                or any(not isinstance(path, str) or not _PATH.fullmatch(path) for path in controls)
                or len(set(controls)) != len(controls)):
            raise ValueError(f"{role}: controls must be distinct native field paths")
        paths = set()
        for spec in section["parameters"]:
            if not isinstance(spec, dict) or not isinstance(spec.get("path"), str) or not _PATH.fullmatch(spec["path"]):
                raise ValueError(f"{role}: each parameter needs a dotted field path")
            if spec["path"] in paths:
                raise ValueError(f"{role}: duplicate parameter {spec['path']}")
            paths.add(spec["path"])
            kind = spec.get("kind")
            if kind not in ("bool", "float", "int", "choice", "vector", "shapes"):
                raise ValueError(f"{role}.{spec['path']}: unsupported kind {kind!r}")
            if kind == "shapes":
                # A list of obstacles of one shape (SHAPE_WIDTHS): positions within ±bound,
                # sizes (radius, half-extent) in (min_size, max_size], at most max_count.
                if spec.get("shape") not in SHAPE_WIDTHS:
                    raise ValueError(f"{role}.{spec['path']}: shape must be one of {sorted(SHAPE_WIDTHS)}")
                for key in ("bound", "min_size", "max_size", "default_size"):
                    if key in spec and (not _number(spec[key]) or spec[key] < 0):
                        raise ValueError(f"{role}.{spec['path']}: {key} must be finite and nonnegative")
                if "max_count" in spec and (type(spec["max_count"]) is not int or spec["max_count"] < 1):
                    raise ValueError(f"{role}.{spec['path']}: max_count must be a positive integer")
            if spec.get("effect", "runtime") not in ("runtime", "compiled_model"):
                raise ValueError(f"{role}.{spec['path']}: effect must be runtime or compiled_model")
            for key in ("min", "max"):
                if key in spec and not _number(spec[key]):
                    raise ValueError(f"{role}.{spec['path']}: {key} must be finite")
                flag = key + "_exclusive"
                if flag in spec and (type(spec[flag]) is not bool or spec[flag] and key not in spec):
                    raise ValueError(f"{role}.{spec['path']}: {flag} needs a boolean and its finite bound")
            if "min" in spec and "max" in spec and spec["min"] > spec["max"]:
                raise ValueError(f"{role}.{spec['path']}: invalid range")
            if kind == "vector" and (type(spec.get("length")) is not int or spec["length"] < 1):
                raise ValueError(f"{role}.{spec['path']}: positive vector length required")
            if kind == "choice" and (not isinstance(spec.get("choices"), list) or not spec["choices"]):
                raise ValueError(f"{role}.{spec['path']}: nonempty choices required")
        for spec in section["parameters"]:
            for key in ("visible_if", "enabled_if"):
                condition = spec.get(key, {})
                if not isinstance(condition, dict) or set(condition) - paths:
                    raise ValueError(f"{role}.{spec['path']}: {key} must name settings in the same role")
        validate_values(result, role, section["defaults"])
    if not isinstance(result.setdefault("presets", []), list):
        raise ValueError("presets must be a list")
    return result


def adapter_path(root):
    """An explicit local override wins; a broken override never silently falls back."""
    local = Path(root).expanduser().resolve() / "_visualizer/_settings.py"
    override = local.exists() or local.is_symlink()
    path = local if override else BUNDLED_ADAPTER
    if not path.is_file():
        raise ValueError(f"Settings adapter is not a readable file: {path}")
    return path.resolve(), "worktree" if override else "bundled"


def has_predictor_settings(description):
    """Adapter identity alone does not change the standard native model catalog."""
    section = description["predictor"]
    return bool(section["parameters"] or section["controls"])


def load_provider(root):
    """Load once per process. Source Apply, not a live file edit, changes code lifetime."""
    root = Path(root).expanduser().resolve()
    key = str(root)
    if key not in _LOADED:
        path, origin = adapter_path(root)
        content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        name = "_tiago_visualizer_settings_" + hashlib.sha256(f"{root}:{path}".encode()).hexdigest()[:16]
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            # Hash and execute the same target bytes, including symlink targets.
            exec(compile(content, str(path), "exec"), module.__dict__)
            if not callable(getattr(module, "describe", None)):
                raise ValueError(f"Settings adapter needs describe(): {path}")
            description = validate_description(module.describe())
        except Exception:
            sys.modules.pop(name, None)
            raise
        identity = dict(path=str(path), sha256=digest, origin=origin)
        description["module"] = identity
        _LOADED[key] = (module, description)
    module, description = _LOADED[key]
    return module, deepcopy(description)


def describe_settings(root):
    return load_provider(root)[1]


def default_values(description):
    return {role: deepcopy(description[role]["defaults"]) for role in ROLES}


def changed_paths(before, after, prefix=""):
    if isinstance(before, dict) and isinstance(after, dict):
        result = []
        for name in before.keys() | after.keys():
            path = f"{prefix}.{name}" if prefix else name
            if name not in before or name not in after:
                result.append(path)
            else:
                result.extend(changed_paths(before[name], after[name], path))
        return result
    return [] if type(before) is type(after) and before == after else [prefix]


def check_controlled(before, after, controls):
    for path in changed_paths(before, after):
        if not any(path == owner or path.startswith(owner + ".") for owner in controls):
            raise ValueError(f"Settings builder changed unclaimed native field {path}")


def _builder(root, role, values, expected_module):
    module, description = load_provider(root)
    if expected_module is not _UNSET and description["module"] != expected_module:
        raise ValueError("Worktree settings module changed; Apply the source/profile again")
    checked = validate_values(description, role, values)
    builder = getattr(module, "build_" + role, None) if module is not None else None
    section = description[role]
    if builder is None and (section["parameters"] or section["controls"]):
        raise ValueError(f"{role}: provider needs build_{role}()")
    return builder, checked, description


def resolve_predictor(root, values, base, serialize, expected_module=_UNSET):
    builder, checked, description = _builder(root, "predictor", values, expected_module)
    params = base if builder is None else builder(checked, base)
    if type(params) is not type(base):
        raise ValueError("build_predictor() must return the selected package's native MpcParams")
    before, effective = plain(serialize(base)), plain(serialize(params))
    check_controlled(before, effective, description["predictor"]["controls"])
    return params, dict(values=checked, effective=effective, module=description["module"])


def resolve_simulation(root, values, base, default_law, serialize, expected_module=_UNSET):
    builder, checked, description = _builder(root, "simulation", values, expected_module)
    built = (base, default_law) if builder is None else builder(checked, base)
    if not isinstance(built, tuple) or len(built) != 2:
        raise ValueError("build_simulation() must return (native SimConfig, ControlLaw)")
    plant, law = built
    if type(plant) is not type(base) or not (law is None or callable(law)):
        raise ValueError("build_simulation() must return the selected package's SimConfig and a callable law "
                         "or None (the package loop's default)")
    before, effective = plain(serialize(base)), plain(serialize(plant))
    for field in ("q", "qd", "substep"):
        if before.get(field) != effective.get(field):
            raise ValueError(f"Simulation settings may not change runtime {field}")
    controls = description["simulation"]["controls"]
    check_controlled(before, effective, controls)
    effective_law = plain(serialize(law))
    check_controlled({"law": plain(serialize(default_law))}, {"law": effective_law}, controls)
    return plant, law, dict(values=checked, effective=dict(plant=effective, law=effective_law),
                           module=description["module"])
