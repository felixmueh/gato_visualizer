"""Live settings, task geometry and GPU locks around tiago_mpc's MPC.

The settings are asdict(MpcParams) plus the visualizer's simulated-plant group;
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

ROOT = Path(__file__).resolve().parent
# The reach task's tolerances (values of tiago_mpc experiments/reach.py:Reach).
POSITION_TOL_M, SPEED_L1_TOL_RAD_S = .05, 1.
# Predictor friction is a compiled variant; its tanh width is fixed (Felix, 2026-10-22).
PREDICTOR_SMOOTHING_RAD_S = .03
# The simulated plant: loss-free RK4 by default; plant friction (URDF coefficients) needs
# semi-implicit Euler and then defaults to tiago_mpc's constraint Coulomb law, with the
# width used only by the tanh law (Felix, 2026-10-23). Commands are clipped to the raw
# URDF effort limit; Live stops where a simulated position, velocity or applied torque
# breaches its raw URDF limit (Felix, 2026-10-23). Simulation settings only:
# tiago_mpc's robot path never clips.
PLANT_DEFAULTS = dict(integrator="rk4", friction=False, coulomb_law="constraint", friction_width_rad_s=.03,
                      clip_effort=True, stop_on_breach=dict(position=True, velocity=True, torque=True))
FRICTION_PATHS = ("friction", "plant.integrator", "plant.friction", "plant.coulomb_law", "plant.friction_width_rad_s")
# The start pose (plant.start_pose_rad) is the seven native joint positions the
# simulated arm starts from at t = 0, velocities zero; Reset returns to it. Its
# default is the simulator source's tiago.Q_START, so it is not a constant here
# (start_pose_spec; Felix, 2026-10-23).


def import_tiago(mpc_root):
    """tiago_mpc.tiago from the selected checkout, with its own external/gato first."""
    mpc_root = Path(mpc_root).expanduser().resolve()
    for location in (mpc_root / "external/gato/python", mpc_root):
        if str(location) not in sys.path:
            sys.path.insert(0, str(location))
    tiago = importlib.import_module("tiago_mpc.tiago")
    if tiago.ROOT.resolve() != mpc_root:
        raise ValueError(f"tiago_mpc imports from {tiago.ROOT}, not the selected checkout {mpc_root}")
    gato = importlib.import_module("gato")
    if not Path(gato.__file__).resolve().is_relative_to(mpc_root / "external/gato"):
        raise ValueError(f"GATO imports from {gato.__file__}, outside the selected tiago_mpc checkout")
    return tiago


def source_identity(mpc_root):
    def git(path, *args):
        try:
            return subprocess.check_output(["git", "-C", str(path), *args], text=True,
                                           stderr=subprocess.DEVNULL, timeout=5).strip()
        except (OSError, subprocess.SubprocessError):
            return None
    return dict(mpc_root=str(mpc_root), mpc_commit=git(mpc_root, "rev-parse", "HEAD"),
                mpc_dirty=bool(git(mpc_root, "status", "--porcelain")),
                gato_commit=git(mpc_root / "external/gato", "rev-parse", "HEAD"))


def mpc_params(config):
    """The asdict(MpcParams) part of a Live config: everything but the plant group."""
    return {key: deepcopy(value) for key, value in config.items() if key != "plant"}


LABELS = {"N": "Knot points", "dt_s": "Knot interval (s)", "q_cost": "Tool position cost",
          "qd_cost": "Joint speed cost", "u_cost": "Control cost", "N_cost": "Terminal position cost",
          "friction": "Predictor friction", "plant.integrator": "Plant integrator",
          "plant.friction": "Plant friction", "plant.coulomb_law": "Coulomb law",
          "plant.friction_width_rad_s": "tanh width (rad/s)",
          "ee_frame": "End-effector frame", "warmup": "Warm-up solve", "max_sqp_time_s": "SQP time limit (s)",
          "plant.clip_effort": "Clip effort", "plant.stop_on_breach.position": "Joint limits",
          "plant.stop_on_breach.velocity": "Velocity", "plant.stop_on_breach.torque": "Torque",
          "plant.start_pose_rad": "Start pose"}
DESCRIPTIONS = {
    "friction": "The predictor's dynamics: loss-free, or the URDF Coulomb and viscous coefficients with "
                "tanh Coulomb of a fixed width (a compiled GATO variant)",
    "plant.integrator": "RK4 is loss-free; semi-implicit Euler (damping implicit) also simulates plant friction",
    "plant.friction": "The URDF Coulomb and viscous coefficients in the simulated plant",
    "plant.coulomb_law": "constraint: a joint sticks while the needed friction is within ±c and slips at c; "
                         "sign: c·sign(v), can chatter near zero; tanh: c·tanh(v/width), creeps below breakaway. "
                         "sign and tanh use the previous step's velocity",
    "plant.friction_width_rad_s": "Velocity scale of the plant's tanh Coulomb law",
    "plant.clip_effort": "Clip each command to ± the URDF effort limit before it reaches the simulated plant "
                         "(simulation only; the robot path never clips)",
    "plant.stop_on_breach.position": "Pause where a simulated joint position leaves its URDF limits",
    "plant.stop_on_breach.velocity": "Pause where a simulated joint speed exceeds its URDF velocity limit",
    "plant.stop_on_breach.torque": "Pause where the torque applied to the simulated plant (after clipping) "
                                   "exceeds its URDF effort limit",
    "plant.start_pose_rad": "Native joint positions the simulated arm starts from at t = 0, velocities zero; "
                            "within the URDF position limits"}
RANGES = {"dt_s": (.001, .1), "solver.max_sqp_iters": (1, 100000), "solver.max_pcg_iters": (1, 1000000),
          "solver.pcg_tol": (1e-8, 1), "solver.solve_ratio": (.001, 1), "solver.mu": (1e-6, 1e5),
          "solver.rho": (1e-8, 1e4), "admm.iters": (1, 200), "admm.eps_rel": (1e-8, 1),
          "joint_margin_rad": (0, .5), "velocity_fraction": (.01, 1), "effort_fraction": (.01, 1),
          "max_sqp_time_s": (1e-4, 10), "plant.friction_width_rad_s": (1e-4, 1)}
LIMIT_KEYS = ("joint_margin_rad", "velocity_fraction", "effort_fraction")
NULLABLE = ("max_sqp_time_s",)  # None: no wall-time limit, within solver.max_sqp_iters
# Live and precalculation run on the simulation clock, so Live's default has no
# wall-time limit for the SQP iterations; the user can still set one (Felix, 2026-10-23).
SIMULATION_CLOCK_DEFAULTS = dict(max_sqp_time_s=None)


def start_pose_spec(tiago):
    """The start pose's default (tiago.Q_START) and range (the raw URDF position
    limits), from the simulator source: the plant starts there, not the solver."""
    limits = tiago.limits()
    return dict(default=np.asarray(tiago.Q_START, dtype=float).tolist(),
                lower=np.asarray(limits.lower, dtype=float).tolist(),
                upper=np.asarray(limits.upper, dtype=float).tolist())


def parameter_specs(config, available_n, predictor_friction, start_pose):
    """One entry per leaf of the Live config; predictor friction is one choice and
    the start pose one entry of kind joints, edited in the Joints tab."""
    friction_label = f"URDF, tanh {predictor_friction['width_rad_s']:g} rad/s"
    choices = {"N": list(available_n), "solver.linsys": [None], "solver.exact_hessian": [False],
               "ee_frame": [config["ee_frame"]], "warm_start": ["shift", "hold"],
               "admm_linsys": ["pcg", "bdsv_factor", "auto"],
               "friction": [dict(value=None, label="Loss-free"),
                            dict(value=deepcopy(predictor_friction), label=friction_label)],
               "plant.integrator": [dict(value="rk4", label="RK4"), dict(value="euler", label="Semi-implicit Euler")],
               "plant.coulomb_law": ["tanh", "sign", "constraint"]}
    specs = []
    def visit(value, path=""):
        for key, item in value.items():
            name = f"{path}.{key}" if path else key
            if isinstance(item, dict) and name != "friction":
                visit(item, name)
                continue
            spec = dict(path=name, label=LABELS.get(name, LABELS.get(key, key.replace("_", " ").capitalize())),
                        group="Friction" if name in FRICTION_PATHS else "Costs" if key.endswith("cost") else (
                            "Limit handling" if name.startswith(("plant.clip_effort", "plant.stop_on_breach.")) else
                            "ADMM" if name.startswith("admm.") else "Limits" if name in LIMIT_KEYS else "Solver"),
                        scale="linear")
            if name in DESCRIPTIONS:
                spec["description"] = DESCRIPTIONS[name]
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
            elif isinstance(item, bool):
                spec["kind"] = "bool"
            elif isinstance(item, str):  # a new text field: shown, fixed at its default
                spec.update(kind="choice", choices=[item], disabled=True, label=spec["label"] + " (fixed)")
            else:
                spec["kind"] = "int" if isinstance(item, int) else "float"
                lo, hi = RANGES.get(name, (0, 1e5) if key.endswith("cost") else (1e-8, 1e4))
                spec.update(min=lo, max=hi, nullable=item is None or name in NULLABLE)
                if lo > 0 and hi / lo >= 1000:
                    spec["scale"] = "log"
            specs.append(spec)
    visit(config)
    return specs


REACH_DEFAULT_TASK = dict(kind="reach", target_offset_m=[.15, .2, .2])


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


def validate_settings(config, task, schema):
    """Reject malformed, missing or extra fields before handing work to CUDA."""
    if not isinstance(config, dict) or not isinstance(task, dict):
        raise ValueError("config and task must be JSON objects")
    expected = {s["path"]: s for s in schema["parameters"]}
    def flatten(value, prefix=""):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Configuration keys must be strings")
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(item, dict) and path not in expected:
                result.update(flatten(item, path))
            else:
                result[path] = item
        return result
    values = flatten(config)
    if set(values) != set(expected):
        raise ValueError(f"Complete config required; missing={sorted(set(expected)-set(values))}, "
                         f"unknown={sorted(set(values)-set(expected))}")
    for path, spec in expected.items():
        value = values[path]
        kind = spec["kind"]
        if kind == "joints":
            valid = (isinstance(value, list) and len(value) == len(spec["lower"]) and all(
                not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x) and lo <= x <= hi
                for x, lo, hi in zip(value, spec["lower"], spec["upper"])))
            if not valid:
                raise ValueError(f"Invalid {path}: {len(spec['lower'])} finite native joint positions "
                                 "within the URDF position limits required")
            continue
        if kind == "bool":
            valid = isinstance(value, bool)
        elif path == "N" and "available_N_by_friction" in schema:
            valid = type(value) is int  # whether it is compiled is checked below, by mode
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
    available = schema.get("available_N_by_friction", {}).get(mode)
    if available is not None and config["N"] not in available:
        raise ValueError(f"Not compiled: N={config['N']} {'with' if mode == 'on' else 'without'} predictor "
                         "friction. Build it in Settings › Backend (Build selected N).")
    task_kind = task.get("kind")
    required_task_fields = ({"kind", "target_offset_m"} if task_kind == "reach" else
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
            fcntl.flock(handle, fcntl.LOCK_UN)
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
    return dict(available_N=sorted(set(by_mode["off"]) | set(by_mode["on"])), available_N_by_friction=by_mode)


def build_schema(probe, mpc_root, start_pose):
    """The Live schema from a selected-interpreter source probe (scripts/source_probe.py)
    and the simulator's start pose (start_pose_spec)."""
    from execution_session import DEFAULT_EXECUTION
    if not probe.get("compatible"):
        raise ValueError(probe.get("error") or "Selected source is incompatible")
    defaults = dict(deepcopy(probe["defaults"]), **SIMULATION_CLOCK_DEFAULTS,
                    plant=dict(deepcopy(PLANT_DEFAULTS), start_pose_rad=list(start_pose["default"])))
    modules = available_modules(probe)
    by_mode, available = modules["available_N_by_friction"], modules["available_N"]
    predictor = probe["friction"]
    friction = dict(coefficients={key: predictor[key] for key in ("coulomb_nm", "viscous_nm_s_per_rad")},
                    predictor=deepcopy(predictor), source="reduced right-arm URDF (tiago.urdf_friction)")
    return dict(available_N_by_friction=by_mode, available_N=available, friction=friction,
                defaults=dict(config=defaults, task=deepcopy(REACH_DEFAULT_TASK), execution=deepcopy(DEFAULT_EXECUTION)),
                parameters=parameter_specs(defaults, available, predictor, start_pose),
                tasks=[dict(kind="reach", label="Reach", defaults=deepcopy(REACH_DEFAULT_TASK)),
                       dict(kind="figure8", label="Figure eight", defaults=deepcopy(FIGURE8_DEFAULT_TASK),
                            parameters=[dict(path="width_m", label="Width (m)", min=.01, max=.6),
                                        dict(path="height_m", label="Height (m)", min=.01, max=.6),
                                        dict(path="period_s", label="Period (s)", min=1., max=120.)])],
                source=source_identity(Path(mpc_root).expanduser().resolve()))


# Process/transport/history policy belongs to the visualizer bridge and never
# initializes CUDA here.
from execution_bridge import ProcessLiveService as LiveService
