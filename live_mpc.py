"""Live settings, task geometry and GPU locks around tiago_mpc's MPC.

The settings are record.to_dict(MpcParams) plus the visualizer's simulated-plant group;
their defaults are TIAGO's with no SQP wall-time limit (the simulation clock).
The parameter specs and defaults come from the selected interpreter's source
probe; this module imports no tiago_mpc solver code and no GATO module.
"""
from __future__ import annotations

from copy import deepcopy
import fcntl
import importlib
import math
from pathlib import Path
import subprocess
import sys

import numpy as np

from adapters.tiago import LABELS, DESCRIPTIONS, GATO_DEFAULT_PATHS, GATO_NONE_MEANINGS, RANGES, PARAMETER_EFFECTS

ROOT = Path(__file__).resolve().parent
# The reach task's tolerances (values of tiago_mpc experiments/reach.py:Reach).
POSITION_TOL_M, SPEED_L1_TOL_RAD_S = .05, 1.
# Predictor friction is a compiled variant; its tanh width is fixed (Felix, 2026-10-22).
PREDICTOR_SMOOTHING_RAD_S = .03
# The simulated plant defaults to URDF friction with the constraint Coulomb law
# and semi-implicit Euler (Felix, 2026-10-26), with the
# width used only by the tanh law (Felix, 2026-10-23). Commands are clipped to the raw
# URDF effort limit; Live stops where a simulated position, velocity or applied torque
# breaches its raw URDF limit (Felix, 2026-10-23). Simulation settings only:
# tiago_mpc's robot path never clips.
PLANT_DEFAULTS = dict(integrator="euler", friction=True, coulomb_law="constraint", friction_width_rad_s=.03,
                      clip_effort=True, stop_on_breach=dict(position=True, velocity=True, torque=True))
FRICTION_PATHS = ("friction", "friction_law", "plant.integrator", "plant.friction", "plant.coulomb_law", "plant.friction_width_rad_s")
# The start pose (plant.start_pose_rad) is the seven native joint positions the
# simulated arm starts from at t = 0, velocities zero; Reset returns to it. Its
# default is the simulator source's tiago.Q_START, so it is not a constant here
# (start_pose_spec; Felix, 2026-10-23).


def import_tiago(mpc_root):
    """tiago_mpc from the selected checkout; GATO comes from its selected uv environment."""
    mpc_root = Path(mpc_root).expanduser().resolve()
    if str(mpc_root) not in sys.path:
        sys.path.insert(0, str(mpc_root))
    tiago = importlib.import_module("tiago_mpc.tiago")
    if tiago.ROOT.resolve() != mpc_root:
        raise ValueError(f"tiago_mpc imports from {tiago.ROOT}, not the selected checkout {mpc_root}")
    return tiago


def source_identity(mpc_root):
    from source_runtime import source_identity as checkout_identity
    from tiago_mpc.record import provenance
    return dict(checkout_identity(mpc_root), mpc_root=str(mpc_root), gato=provenance()["gato"])


def mpc_params(config):
    """The native serialized MpcParams, including its fixed type metadata."""
    params = {key: deepcopy(value) for key, value in config.items() if key not in ("plant", "cost_weights")}
    if "cost_weights" in config:
        from native_cost import serialized_cost
        params["cost"] = serialized_cost(config["N"], config["cost_weights"])
    return params


def orientation_goal(task):
    """The reach's grasp orientation goal as a world rotation vector, or None."""
    return task.get("orientation_rad") if task.get("kind") == "reach" else None


# Native references use NaN to disable orientation without changing the cost menu.
def solver_params(config, task):
    """Native params remain intact; reference NaNs disable absent orientation goals."""
    return mpc_params(config)


LIMIT_KEYS = ("joint_margin_rad", "velocity_fraction", "effort_fraction")
NULLABLE = ("max_sqp_time_s",)  # None: no wall-time limit, within solver.max_sqp_iters
# A None default follows GATO's own default (MpcParams); these follow it as integers.
INTEGER_PATHS = ("admm.iters", "admm.check_every")
GATO_DEFAULT = dict(value=None, label="GATO default")
# Live and precalculation run on the simulation clock, so Live's default has no
# wall-time limit for the SQP iterations; the user can still set one (Felix, 2026-10-23).
SIMULATION_CLOCK_DEFAULTS = dict(max_sqp_time_s=None)


def validate_source_settings(schema, values=None):
    """The two independent source/profile value scopes; no source import here."""
    from worktree_settings import ROLES, validate_values
    sections = schema.get("source_settings", {})
    empty = dict(defaults={}, parameters=[], controls=[], module=None)
    description = {role: sections.get(role, empty) for role in ROLES}
    supplied = ({role: deepcopy(description[role]["defaults"]) for role in ROLES}
                if values is None else values)
    if not isinstance(supplied, dict) or set(supplied) != set(ROLES):
        raise ValueError("source_settings requires simulation and predictor objects")
    return {role: validate_values(description, role, supplied[role]) for role in ROLES}


def start_pose_spec(tiago):
    """The start pose's default (tiago.Q_START) and range (the raw URDF position
    limits), from the simulator source: the plant starts there, not the solver."""
    limits = tiago.limits()
    return dict(default=np.asarray(tiago.Q_START, dtype=float).tolist(),
                lower=np.asarray(limits.lower, dtype=float).tolist(),
                upper=np.asarray(limits.upper, dtype=float).tolist())


def body_joints(mpc_root):
    """The fixed joints of Live's robot body: the posture at which the source's body cover
    was fitted (tiago_mpc.collision.body_posture(), the default cover's), so the drawn body,
    its cover and the obstacles line up. Empty for a source without collision rows: the
    display's own posture (server.FIXED_DISPLAY_JOINTS)."""
    if not (Path(mpc_root).expanduser() / "tiago_mpc/collision.py").is_file():
        return {}
    import_tiago(mpc_root)
    posture = getattr(importlib.import_module("tiago_mpc.collision"), "body_posture", None)
    return {} if posture is None else {name: float(value) for name, value in posture().items()}


def model_inputs(config, predictor_values, schema):
    """What the native model lookup of a Live draft depends on: its native config and
    predictor adapter values without the fields annotated effect runtime (as the
    browser's modelCheckInputs). Equal inputs reuse the accepted model's availability."""
    def without(values, specs):
        result = deepcopy(values)
        for spec in specs:
            if spec.get("effect") != "runtime":
                continue
            *parents, last = spec["path"].split(".")
            parent = result
            for key in parents:
                parent = parent.get(key) if isinstance(parent, dict) else None
            if isinstance(parent, dict):
                parent.pop(last, None)
        return result
    predictor = schema.get("source_settings", {}).get("predictor", {}).get("parameters", [])
    # The viewer's convenience cost weights stay as such (runtime); the menu they build
    # depends otherwise only on N. A custom native menu is compared whole.
    native = {key: value for key, value in config.items() if key != "plant"}
    return (without(native, [spec for spec in schema["parameters"] if not spec["path"].startswith("plant.")]),
            without(predictor_values or {}, predictor))


def end_effector_spec(tiago):
    """The simulator's grasp frame and its local origin on the full display model."""
    from robot_frames import fixed_frame_spec
    return fixed_frame_spec(tiago.arm_urdf(), tiago.GRASP_FRAME)


def parameter_specs(config, available_n, predictor_friction, start_pose):
    """One entry per leaf of the Live config; predictor friction is one choice and
    the start pose one entry of kind joints, edited in the Joints tab."""
    friction_label = "URDF coefficients"
    choices = {"N": list(available_n), "solver.linsys": [None], "solver.exact_hessian": [False],
               "solver.cost_curvature": [False],
               "warm_start": [GATO_DEFAULT, "shift", "hold"],
               "reset_rho_each_step": [GATO_DEFAULT, True, False],
               "admm_linsys": [GATO_DEFAULT, "pcg", "bdsv_factor", "auto"],
               "linsys": [GATO_DEFAULT, "pcg", "bdsv", "bdsv_first", "auto"],
               "friction": [dict(value=None, label="Loss-free"),
                            dict(value=deepcopy(predictor_friction), label=friction_label)],
               "plant.integrator": [dict(value="rk4", label="RK4"), dict(value="euler", label="Euler")],
               "plant.coulomb_law": ["tanh", "sign", "constraint"]}
    if "friction_law" in config:
        choices["friction_law"] = [dict(value=deepcopy(config["friction_law"]),
                                        label=f"tanh {config['friction_law']['width_rad_s']:g} rad/s")]
    if "collision" in config:
        # MpcParams.collision (a source with GATO's collision rows): the base value stays
        # fixed; a source settings adapter that claims it resolves the rows.
        choices["collision"] = [dict(value=deepcopy(config["collision"]),
                                     label="Off" if config["collision"] is None else "Configured")]
    specs = []
    def visit(value, path=""):
        for key, item in value.items():
            if key == "type" or (not path and key == "cost"):
                continue  # native serialization metadata, not a user parameter
            name = f"{path}.{key}" if path else key
            if isinstance(item, dict) and name not in ("friction", "friction_law", "collision"):
                visit(item, name)
                continue
            spec = dict(path=name, label=LABELS.get(name, LABELS.get(key, key.replace("_", " ").capitalize())),
                        group="Friction" if name in FRICTION_PATHS else "Costs" if key.endswith("cost") or name.startswith("cost_weights.") else (
                            "Limit handling" if name.startswith(("plant.clip_effort", "plant.stop_on_breach.")) else
                            "Collision rows" if name == "collision" else
                            "ADMM" if name.startswith("admm.") else "Limits" if name in LIMIT_KEYS else "Solver"),
                        scale="linear", effect="runtime" if name.startswith("plant.") else PARAMETER_EFFECTS.get(name, "compiled_model"))
            if name in DESCRIPTIONS:
                spec["description"] = DESCRIPTIONS[name]
            if name in GATO_DEFAULT_PATHS:
                spec["gato_default"] = True  # None follows GATO; the panel shows its resolved value
                if name in GATO_NONE_MEANINGS:
                    spec["gato_none"] = GATO_NONE_MEANINGS[name]  # GATO's own None
            if name.startswith("cost_weights."):
                spec["effect"] = "runtime"
            if name == "plant.start_pose_rad":
                spec.update(kind="joints", group="Start pose", lower=list(start_pose["lower"]),
                            upper=list(start_pose["upper"]))
                specs.append(spec)
                continue
            if name.startswith("plant.stop_on_breach."):
                spec["row"] = "Stop on breach"  # three checkboxes side by side
            if name in choices:
                spec.update(kind="choice", choices=choices[name])
                if len(choices[name]) == 1 and name != "N":
                    spec.update(disabled=True, label=spec["label"] + " (fixed)")
            elif isinstance(item, (list, tuple)):
                spec.update(kind="vector", length=len(item), min=0., max=1e5)
            elif isinstance(item, bool):
                spec["kind"] = "bool"
            elif isinstance(item, str):  # a new text field: shown, fixed at its default
                spec.update(kind="choice", choices=[item], disabled=True, label=spec["label"] + " (fixed)")
            else:
                spec["kind"] = "int" if isinstance(item, int) or name in INTEGER_PATHS else "float"
                lo, hi = RANGES.get(name, (0, 1e5) if key.endswith("cost") or name.startswith("cost_weights.") else (1e-8, 1e4))
                spec.update(min=lo, max=hi, nullable=item is None or name in NULLABLE or name in GATO_DEFAULT_PATHS)
                if lo > 0 and hi / lo >= 1000:
                    spec["scale"] = "log"
            specs.append(spec)
    visit(config)
    return specs


REACH_DEFAULT_TASK = dict(kind="reach", target_offset_m=[.15, .2, .2], orientation_rad=None)


FIGURE8_DEFAULT_TASK = dict(kind="figure8", target_offset_m=[0, 0, 0],
                            width_m=.24, height_m=.16, period_s=24., orientation_xyzw=[0., 0., 0., 1.])


def figure8_reference(times, start_xyz, task):
    """Rotatable loop anchored at its static phase-zero back edge.

    orientation_xyzw rotates local XY geometry into the world frame; translation
    remains in world coordinates. Identity preserves the historical XY path.

    Geometry follows the retained tracking examples: x=(w/2)(1-cos phase),
    y=(h/2)sin(2 phase). Unlike their experiment-specific 20 mm edge offset,
    the interactive default starts exactly at the comfortable-pose tool.
    """
    phase = 2*np.pi*np.asarray(times, dtype=float)/task["period_s"]
    xyz = np.broadcast_to(np.asarray(start_xyz, dtype=float), (len(phase), 3)).copy()
    xyz += np.asarray(task["target_offset_m"])
    local = np.zeros_like(xyz)
    local[:, 0] = .5*task["width_m"]*(1-np.cos(phase))
    local[:, 1] = .5*task["height_m"]*np.sin(2*phase)
    x, y, z, w = task.get("orientation_xyzw", [0., 0., 0., 1.])
    rotation = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                         [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                         [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    xyz += local @ rotation.T
    return xyz


def choice_value(choice):
    """A spec choice is a plain value or {value, label}."""
    return choice["value"] if isinstance(choice, dict) and set(choice) == {"value", "label"} else choice


def validate_settings(config, task, schema, *, check_available=True):
    """Reject malformed, missing or extra fields before handing work to CUDA."""
    if not isinstance(config, dict) or not isinstance(task, dict):
        raise ValueError("config and task must be JSON objects")
    expected = {s["path"]: s for s in schema["parameters"]}
    fixed_types = {}
    fixed_cost = schema["defaults"]["config"].get("cost")
    def collect_types(value, prefix=""):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else key
            if key == "type":
                fixed_types[path] = item
            elif path != "cost" and isinstance(item, dict) and path not in expected:
                collect_types(item, path)
    collect_types(schema["defaults"]["config"])
    def flatten(value, prefix=""):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Configuration keys must be strings")
            path = f"{prefix}.{key}" if prefix else key
            if path != "cost" and isinstance(item, dict) and path not in expected:
                result.update(flatten(item, path))
            else:
                result[path] = item
        return result
    values = flatten(config)
    required = set(expected) | set(fixed_types) | ({"cost"} if fixed_cost is not None else set())
    if set(values) != required:
        raise ValueError(f"Complete config required; missing={sorted(required-set(values))}, "
                         f"unknown={sorted(set(values)-required)}")
    if fixed_cost is not None and config.get("cost") != fixed_cost:
        raise ValueError("Native cost is fixed by this profile; edit the exposed cost weights")
    if fixed_cost is not None and "cost_weights" not in schema["defaults"]["config"] and config.get("N") != schema["defaults"]["config"]["N"]:
        raise ValueError(f"Custom CostMenu fixes N={schema['defaults']['config']['N']}; changing its horizon requires an explicit menu")
    for path, tag in fixed_types.items():
        if type(values[path]) is not str or values[path] != tag:
            raise ValueError(f"Invalid fixed configuration type {path}: {values[path]!r}")
    for path, spec in expected.items():
        value = values[path]
        kind = spec["kind"]
        if kind in ("joints", "vector"):
            valid = (isinstance(value, list) and len(value) == (spec["length"] if kind == "vector" else len(spec["lower"])) and all(
                not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x) and lo <= x <= hi
                for x, lo, hi in zip(value,
                    [spec.get("min", -math.inf)]*spec["length"] if kind == "vector" else spec["lower"],
                    [spec.get("max", math.inf)]*spec["length"] if kind == "vector" else spec["upper"])))
            if not valid:
                raise ValueError(f"Invalid {path}: finite vector with the declared length and bounds required")
            continue
        if kind == "bool":
            valid = isinstance(value, bool)
        elif path == "N" and "available_N_by_friction" in schema:
            offered = schema.get("supported_N")
            valid = type(value) is int and (offered is None or value in offered)
            # Legacy schemas only publish cached choices; those are not the supported-N domain.
        elif kind == "choice":
            valid = any(type(value) is type(choice) and value == choice
                        for choice in map(choice_value, spec["choices"]))
        elif value is None:
            valid = bool(spec.get("nullable"))
        else:
            valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            valid = valid and spec["min"] <= value <= spec["max"]
            if kind == "int":
                valid = valid and isinstance(value, int)
        if not valid:
            raise ValueError(f"Invalid {path}: {value!r}")
    plant = config.get("plant", {})
    if plant.get("friction") and plant.get("integrator") == "rk4":
        raise ValueError("Plant friction needs the semi-implicit Euler integrator; RK4 is loss-free")
    mode = "on" if config.get("friction") is not None else "off"
    available = (schema.get("available_N") if schema.get("exact_availability") else
                 schema.get("available_N_by_friction", {}).get(mode))
    if check_available and available is not None and config["N"] not in available:
        raise ValueError(f"Not compiled: N={config['N']} {'with' if mode == 'on' else 'without'} predictor "
                         "friction. Build it in Settings › Backend (Build selected N).")
    task_kind = task.get("kind")
    required_task_fields = (set(REACH_DEFAULT_TASK) if task_kind == "reach" else
                            (set(FIGURE8_DEFAULT_TASK) - {"orientation_xyzw"}) if task_kind == "figure8" else None)
    supplied_task_fields = set(task)
    if task_kind == "figure8":
        supplied_task_fields.discard("orientation_xyzw")  # Legacy unrotated tasks remain valid.
    if required_task_fields is None or supplied_task_fields != required_task_fields:
        raise ValueError("task requires a complete reach or figure8 object")
    if task_kind == "figure8":
        quaternion = task.get("orientation_xyzw", [0., 0., 0., 1.])
        if (not isinstance(quaternion, list) or len(quaternion) != 4 or
                any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in quaternion) or
                abs(sum(x*x for x in quaternion) - 1.) > 1e-6):
            raise ValueError("orientation_xyzw must be a finite unit quaternion [x, y, z, w]")
        for field, lo, hi in (("width_m", .01, .6), ("height_m", .01, .6), ("period_s", 1., 120.)):
            value = task[field]
            if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                    not math.isfinite(value) or not lo <= value <= hi):
                raise ValueError(f"{field} must be finite within [{lo}, {hi}]")
    if task_kind == "reach" and task["orientation_rad"] is not None:
        rotation = task["orientation_rad"]
        if (not isinstance(rotation, list) or len(rotation) != 3 or
                any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in rotation) or
                math.hypot(*rotation) > math.pi + 1e-6):
            raise ValueError("orientation_rad must be null or a finite rotation vector [x, y, z] of at most pi rad")
        if "cost" not in config:
            raise ValueError("The selected tiago_mpc has no orientation cost menu")
    offset = task["target_offset_m"]
    if (not isinstance(offset, list) or len(offset) != 3 or
            any(isinstance(x, bool) or not isinstance(x, (int, float)) or
                not math.isfinite(x) or abs(x) > 1 for x in offset)):
        raise ValueError("target_offset_m must have three finite world offsets within +/-1 m")
    return deepcopy(config), deepcopy(task)


class GPULocks:
    """Same lock paths, ordering and parent-exists policy as random100/run.py."""
    def __init__(self, mpc_root):
        root = Path(mpc_root).resolve()
        try:
            common = subprocess.check_output(["git", "-C", str(root), "rev-parse",
                "--path-format=absolute", "--git-common-dir"], text=True, stderr=subprocess.DEVNULL).strip()
            workspace = Path(common).parent.parent
        except (OSError, subprocess.SubprocessError):
            workspace = root.parent
        self.paths = (workspace / "GATO-upstream-contributions/.gpu.lock",
                      Path("/tmp/a2rlab-timing.lock"),
                      workspace / "GATO/.git/experiment-runner.lock")
        self.handles = []

    def acquire(self):
        if self.handles:
            return True
        try:
            for path in self.paths:
                if path.parent.exists():
                    handle = path.open("a")
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BaseException:
                        handle.close()
                        raise
                    self.handles.append(handle)
        except (BlockingIOError, OSError):
            self.release()
            return False
        return True

    def release(self):
        for handle in reversed(self.handles):
            # SCM_RIGHTS gives the solver the same open-file description.
            # Closing our copy lets outstanding work retain its borrowed lock;
            # LOCK_UN would revoke that lock while the child is still solving.
            handle.close()
        self.handles.clear()


def urdf_joint_limits(limits):
    """Physical URDF limits (tiago.limits()) in native coordinates: the 100 % reference of limit use."""
    return dict(lower_position_rad=np.asarray(limits.lower, dtype=float).tolist(),
                upper_position_rad=np.asarray(limits.upper, dtype=float).tolist(),
                velocity_rad_s=np.asarray(limits.velocity, dtype=float).tolist(),
                effort_nm=np.asarray(limits.effort, dtype=float).tolist(),
                source="URDF limits (native coordinates)")


def mpc_bounds_from_rows(rows, limit_bounds):
    """Displayed MPC bounds: the installed native constraint rows, symmetric
    velocity/torque rows as magnitudes. Unrepresentable rows stay absent."""
    result = dict(lower_position_rad=[float(v) for v in rows[0]["lo"]],
                  upper_position_rad=[float(v) for v in rows[0]["hi"]],
                  source="MPC bounds installed in the Live solver (native coordinates)",
                  limit_bounds=deepcopy(dict(limit_bounds)))
    for key, group in (("velocity_rad_s", rows[1]), ("effort_nm", rows[2])):
        lo, hi = np.asarray(group["lo"], dtype=float), np.asarray(group["hi"], dtype=float)
        if np.allclose(-lo, hi, rtol=1e-6, atol=1e-9) and np.all(hi > 0):
            result[key] = hi.tolist()
    return result


def available_modules(probe):
    """The compiled N a source probe found: per predictor-friction mode and their union."""
    by_mode = {mode: list(probe["available_N_by_friction"][mode]) for mode in ("off", "on")}
    return dict(available_N=(list(probe["available_N"]) if probe.get("exact_availability") else
                             sorted(set(by_mode["off"]) | set(by_mode["on"]))),
                available_N_by_friction=by_mode, exact_availability=bool(probe.get("exact_availability")))


def build_schema(probe, mpc_root, start_pose, *, end_effector=None, simulation_settings=None):
    """The Live schema from a selected-interpreter source probe (scripts/source_probe.py)
    and simulator model metadata. A separate solver profile supplies its own
    probe/root but retains the simulator's start pose and grasp-frame origin."""
    from execution_session import DEFAULT_EXECUTION
    if not probe.get("compatible"):
        raise ValueError(probe.get("error") or "Selected source is incompatible")
    defaults = dict(deepcopy(probe["defaults"]), **SIMULATION_CLOCK_DEFAULTS,
                    plant=dict(deepcopy(PLANT_DEFAULTS), start_pose_rad=list(start_pose["default"])))
    from native_cost import cost_weights, serialized_cost
    weights = cost_weights(defaults.get("cost"))
    if weights is not None:
        # Editable starting weights; absent orientation targets mask these rows.
        # Preserve a source's explicitly configured orientation objective.
        if weights["orientation"] == weights["terminal_orientation"] == 0:
            weights.update(orientation=1., terminal_orientation=8.)
        defaults["cost_weights"] = weights
        defaults["cost"] = serialized_cost(defaults["N"], weights)
    modules = available_modules(probe)
    by_mode, available = modules["available_N_by_friction"], modules["available_N"]
    predictor = probe["friction"]
    friction = dict(coefficients={key: predictor[key] for key in ("coulomb_nm", "viscous_nm_s_per_rad")},
                    predictor=deepcopy(predictor), source="reduced right-arm URDF (tiago.urdf_friction)")
    from worktree_settings import ROLES
    empty = dict(defaults={}, parameters=[], controls=[], module=None)
    role_settings = {role: deepcopy(probe.get("source_settings", {}).get(role, empty)) for role in ROLES}
    if simulation_settings is not None:
        role_settings["simulation"] = deepcopy(simulation_settings)
    source_values = {role: deepcopy(role_settings[role]["defaults"]) for role in ROLES}
    offered = list(probe.get("supported_N", available))
    custom_cost = defaults.get("cost") is not None and weights is None
    if custom_cost:
        offered = [defaults["N"]]
    specs = parameter_specs(defaults, offered, predictor, start_pose)
    if custom_cost:
        next(spec for spec in specs if spec["path"] == "N").update(
            disabled=True, description="This custom CostMenu fixes its knot count; changing N requires an explicit menu.")
    for spec in specs:
        path = spec["path"]
        role = "simulation" if path.startswith("plant.") else "predictor"
        native = path.removeprefix("plant.")
        native = {"start_pose_rad": "q", "coulomb_law": "friction_law",
                  "friction_width_rad_s": "friction_law.width_rad_s"}.get(native, native)
        if any(native == owner or native.startswith(owner + ".") for owner in role_settings[role]["controls"]):
            spec.update(controlled_by_source=True, source_role=role,
                        effective_path=("plant." if role == "simulation" else "params.") + native)
            # The adapter resolves it: neither fixed nor edited here.
            if spec.pop("disabled", False):
                spec["label"] = spec["label"].removesuffix(" (fixed)")
    grasp = end_effector if end_effector is not None else end_effector_spec(import_tiago(mpc_root))
    return dict(available_N_by_friction=by_mode, available_N=available, friction=friction,
                **({"supported_N": offered} if "supported_N" in probe else {}),
                exact_availability=modules["exact_availability"], source_settings=role_settings,
                orientation_goal_supported=isinstance(defaults.get("cost"), dict) and defaults["cost"].get("type") == "CostMenu",
                **({"fixed_horizon_N": defaults["N"]} if custom_cost else {}),
                effective_settings=deepcopy(probe.get("effective_settings", {})),
                end_effector=deepcopy(grasp),
                defaults=dict(config=defaults, task=deepcopy(REACH_DEFAULT_TASK), execution=deepcopy(DEFAULT_EXECUTION),
                              source_settings=source_values),
                parameters=specs,
                tasks=[dict(kind="reach", label="Reach", defaults=deepcopy(REACH_DEFAULT_TASK)),
                       dict(kind="figure8", label="Figure eight", defaults=deepcopy(FIGURE8_DEFAULT_TASK),
                            parameters=[dict(path="width_m", label="Width (m)", min=.01, max=.6),
                                        dict(path="height_m", label="Height (m)", min=.01, max=.6),
                                        dict(path="period_s", label="Period (s)", min=1., max=120.)])],
                source=dict(deepcopy(probe["source"] if "source" in probe else
                                     source_identity(Path(mpc_root).expanduser().resolve())),
                            mpc_root=str(probe.get("selection", {}).get("mpc_root", mpc_root))))


# Process/transport/history policy belongs to the visualizer bridge and never
# initializes CUDA here.
from execution_bridge import ProcessLiveService as LiveService
