"""Native-coordinate MPC adapter and schema using unchanged tiago_mpc helpers.

Visualizer execution timing and process/history transport live in the execution
modules. The synchronous fixed-loop adapter remains a conformance reference.
"""
from __future__ import annotations

from copy import deepcopy
import fcntl
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

import numpy as np

from live_presentation import render_plan, render_state, snapshot

ROOT = Path(__file__).resolve().parent


def import_mpc(mpc_root):
    """Use the startup-selected cache and import unchanged source in one worker."""
    mpc_root = Path(mpc_root).expanduser().resolve()
    os.environ.setdefault("GATO_CACHE_DIR", str(mpc_root / ".cache/gato"))
    for location in (mpc_root / "external/gato/python", mpc_root / "examples"):
        if str(location) not in sys.path:
            sys.path.insert(0, str(location))
    module = importlib.import_module("reach_sim")
    if module.ROOT.resolve() != mpc_root:
        raise ValueError("A different tiago_mpc root was already imported in this process")
    gato_path = Path(module.gato.__file__).resolve()
    if not gato_path.is_relative_to(mpc_root / "external/gato"):
        raise ValueError(f"GATO imports from {gato_path}, outside the selected tiago_mpc checkout")
    return module, importlib.import_module("reaching_config")


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


def parameter_specs(config, available_n):
    """One entry for every leaf in the complete reaching configuration."""
    specs = []
    labels = {"N": "Knot points", "dt_s": "Knot interval (s)",
              "q_cost": "Tool position cost", "qd_cost": "Joint speed cost",
              "u_cost": "Control cost", "N_cost": "Terminal position cost"}
    choices = {"N": list(available_n), "solver_params.linsys": [None], "solver_params.exact_hessian": [False],
               "controller.warm_start": ["shift", "hold"],
               "controller.admm_linsys": ["pcg", "bdsv_factor", "auto"]}
    limits = {"dt_s": (.001, .1), "solver_params.max_sqp_iters": (1, 100000),
              "solver_params.max_pcg_iters": (1, 1000000),
              "solver_params.pcg_tol": (1e-8, 1), "solver_params.solve_ratio": (.001, 1),
              "solver_params.mu": (1e-6, 1e5), "solver_params.rho": (1e-8, 1e4),
              "controller.limits_kw.iters": (1, 200),
              "controller.limits_kw.eps_rel": (1e-8, 1),
              "limit_bounds.joint_margin_rad": (0, .5),
              "limit_bounds.velocity_fraction": (.01, 1),
              "limit_bounds.effort_fraction": (.01, 1)}
    def visit(value, path=""):
        for key, item in value.items():
            name = f"{path}.{key}" if path else key
            if isinstance(item, dict):
                visit(item, name)
                continue
            spec = dict(path=name, label=labels.get(key, key.replace("_", " ").capitalize()),
                        group="Costs" if key.endswith("cost") else (
                            "ADMM" if name.startswith("controller.limits_kw.") else
                            "Limits" if name.startswith("limit_bounds.") else "Solver"),
                        scale="linear")
            if name in choices:
                spec.update(kind="choice", choices=choices[name])
                if len(choices[name]) == 1:
                    spec.update(disabled=True, label=spec["label"] + " (fixed by reaching adapter)")
            elif isinstance(item, bool):
                spec["kind"] = "bool"
            else:
                spec["kind"] = "int" if isinstance(item, int) else "float"
                lo, hi = limits.get(name, (0, 1e5) if key.endswith("cost") else (1e-8, 1e4))
                spec.update(min=lo, max=hi)
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


def validate_settings(config, task, schema):
    """Reject malformed, missing or extra fields before handing work to CUDA."""
    if not isinstance(config, dict) or not isinstance(task, dict):
        raise ValueError("config and task must be JSON objects")
    def flatten(value, prefix=""):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Configuration keys must be strings")
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(item, dict):
                result.update(flatten(item, path))
            else:
                result[path] = item
        return result
    values = flatten(config)
    expected = {s["path"]: s for s in schema["parameters"]}
    if set(values) != set(expected):
        raise ValueError(f"Complete config required; missing={sorted(set(expected)-set(values))}, "
                         f"unknown={sorted(set(values)-set(expected))}")
    for path, spec in expected.items():
        value = values[path]
        kind = spec["kind"]
        if kind == "bool":
            valid = isinstance(value, bool)
        elif kind == "choice":
            valid = any(type(value) is type(choice) and value == choice for choice in spec["choices"])
        else:
            valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            valid = valid and spec["min"] <= value <= spec["max"]
            if kind == "int":
                valid = valid and isinstance(value, int)
        if not valid:
            raise ValueError(f"Invalid {path}: {value!r}")
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
        self.paths = (Path(mpc_root).parent / "GATO-upstream-contributions/.gpu.lock",
                      Path("/tmp/a2rlab-timing.lock"),
                      Path(mpc_root).parent / "GATO/.git/experiment-runner.lock")
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


class MPCAdapter:
    """All instances and CUDA calls belong exclusively to the GPU worker."""
    def __init__(self, mpc_root, reach=None):
        self.reach = reach or import_mpc(mpc_root)[0]
        self.gato = self.reach.gato
        self.pin = self.reach.pin
        from server import RobotKinematics
        self.kinematics = RobotKinematics(Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf",
                                         end_effector_frame=self.reach.EE_FRAME)
        path, self.gpu_path, self.signs = self.reach.runtime_urdf()
        self.model_identity = dict(full_urdf_sha256=hashlib.sha256(
            (Path(mpc_root)/"models/tiago_pro/tiago_pro.urdf").read_bytes()).hexdigest(),
            gpu_urdf_sha256=hashlib.sha256(self.gpu_path.read_bytes()).hexdigest(),
            end_effector_frame=self.reach.EE_FRAME, source=source_identity(mpc_root))
        self.state_signs = np.tile(self.signs, 2)
        self.model = self.pin.buildModelFromUrdf(str(path))
        self.data = self.model.createData()
        self.fid = self.model.getFrameId(self.reach.EE_FRAME)
        if (self.model.nq, self.model.nv) != (7, 7) or self.fid >= self.model.nframes:
            raise ValueError("Unexpected reduced TIAGo model or end-effector frame")
        self.default_target = self.reach.ee_position(
            self.model, self.data, self.reach.Q_START_RAD + self.reach.Q_GOAL_DELTA_RAD, self.fid)
        self.figure8_start_world = self.kinematics.target_to_world(self.reach.ee_position(
            self.model, self.data, self.reach.Q_START_RAD, self.fid))
        self.task_anchors = snapshot(dict(
            reach=self.kinematics.target_to_world(self.default_target).tolist(),
            figure8=self.figure8_start_world.tolist()))
        self.task = deepcopy(REACH_DEFAULT_TASK)
        self.solver = self.controller = None
        self.sequence = 0
        self.reset_state()

    def reset_state(self, reset_controller=True):
        self.x = np.r_[self.reach.Q_START_RAD, np.zeros(7)]
        self.t = 0.0
        self.sequence = 0
        self.applied_torque = None
        if reset_controller and self.controller is not None:
            self.controller.reset(self.x * self.state_signs)

    def configure(self, config_path, task):
        _, settings, effective = importlib.import_module("reaching_config").load_configuration(config_path)
        self.problem_configuration = deepcopy(effective)
        from gato import _cache
        entry = _cache.robot_entry(self.reach.PLANT)
        if entry is None or entry.get("urdf_sha256") != hashlib.sha256(self.gpu_path.read_bytes()).hexdigest():
            raise ValueError("Prebuilt robot model is missing or stale. Run scripts/prebuild.py during setup")
        from gato.builder import _codegen_key
        if entry["codegen_key"] != _codegen_key(self.gpu_path, self.reach.EE_FRAME, .15, None, False):
            raise ValueError("Prebuilt generated model is stale; run scripts/prebuild.py")
        module = _cache.load_module(self.reach.PLANT, effective["N"], build_if_missing=False)
        if module is None:
            raise ValueError(f"No current prebuilt N={effective['N']} module; run scripts/prebuild.py")
        # Preloading the verified module ensures BSQP never enters its build fallback.
        self.solver = self.gato.BSQP(str(self.gpu_path), batch_size=1, N=effective["N"],
                                   dt=effective["dt_s"], plant_type=self.reach.PLANT,
                                   params=self.gato.SolverParams(**effective["solver_params"]))
        self.reach.check_model(self.solver, self.model, self.data, self.fid,
                              self.reach.Q_START_RAD + self.reach.Q_GOAL_DELTA_RAD, self.signs)
        options = settings.get("controller", {})
        self.controller = self.gato.MPCController(self.solver, limits="admm", linsys="pcg", **options)
        bounds = settings.get("limit_bounds", {})
        margin = float(bounds.get("joint_margin_rad", 0))
        self.joint_limits = dict(
            lower_position_rad=(self.model.lowerPositionLimit + margin).tolist(),
            upper_position_rad=(self.model.upperPositionLimit - margin).tolist(),
            velocity_rad_s=(self.model.velocityLimit * bounds.get("velocity_fraction", 1)).tolist(),
            effort_nm=(self.model.effortLimit * bounds.get("effort_fraction", 1)).tolist(),
            source="Live configured MPC bounds (native coordinates)")
        for group, key in ((0, "joint_margin_rad"), (1, "velocity_fraction"), (2, "effort_fraction")):
            if key not in bounds:
                continue
            value = float(bounds[key])
            if group == 0:
                if not 0 <= value < .5 * np.min(self.model.upperPositionLimit-self.model.lowerPositionLimit):
                    raise ValueError("Invalid joint margin")
                lo = (self.model.lowerPositionLimit + value) * self.signs
                hi = (self.model.upperPositionLimit - value) * self.signs
                lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
            else:
                if not 0 < value <= 1:
                    raise ValueError("Limit fractions must be in (0,1]")
                raw = self.model.velocityLimit if group == 1 else self.model.effortLimit
                lo, hi = -value * raw, value * raw
            self.solver.set_row_group_bounds(group, lo, hi)
        self.N, self.dt = effective["N"], effective["dt_s"]
        self.task = deepcopy(task)
        self.task_path_xyz = (figure8_reference(np.linspace(0., task["period_s"], 257),
                                              self.figure8_start_world, task).tolist()
                              if task["kind"] == "figure8" else None)
        world_target = self.kinematics.target_to_world(self.default_target) + np.asarray(task["target_offset_m"])
        self.target = self.kinematics.world_from_torso.actInv(world_target)
        self.reference = np.zeros((self.N, 6), dtype=np.float32)
        self.reference[:, :3] = self.target
        if self.task["kind"] == "figure8":
            self.update_tracking_reference()
        self.controller.reset(self.x * self.state_signs)
        self.restarted = True

    def target_world_at(self, timestamp):
        if self.task["kind"] == "figure8":
            return figure8_reference([timestamp], self.figure8_start_world, self.task)[0]
        return self.kinematics.target_to_world(self.target)

    def update_tracking_reference(self):
        world = figure8_reference(self.t+np.arange(self.N)*self.dt,
                                 self.figure8_start_world, self.task)
        self.reference[:, :3] = np.asarray([
            self.kinematics.world_from_torso.actInv(point) for point in world])

    def solve_snapshot(self, origin, settings_version):
        """Solve numerically and copy buffers; trajectory FK/encoding runs elsewhere."""
        if self.task["kind"] == "figure8":
            self.update_tracking_reference()
        if origin == "preview":
            self.controller.reset(self.x * self.state_signs)
        step = self.controller.step(self.x * self.state_signs, self.reference.ravel())
        self.u = np.asarray(step.u, dtype=float) * self.signs
        self.last_xu = np.asarray(step.solve.xu).copy()
        if not np.isfinite(self.u).all() or not np.isfinite(self.last_xu).all():
            raise FloatingPointError("Nonfinite torque or predicted trajectory")
        stats = step.solve.stats
        self.sequence += 1
        event = dict(type="plan", seq=self.sequence, origin=origin, settings_version=settings_version,
                     initial_state=dict(q=self.x[:7].tolist(), qd=self.x[7:].tolist(), time_s=self.t),
                     problem_configuration=deepcopy(getattr(self, "problem_configuration", {})),
                     model_identity=deepcopy(getattr(self, "model_identity", {})),
                     task=deepcopy(self.task),
                     end_effector_frame=self.reach.EE_FRAME, task_anchors=self.task_anchors,
                     sim_time_s=self.t, N=self.N, dt_s=self.dt, task_kind=self.task["kind"],
                     target_xyz=self.target_world_at(self.t).tolist(),
                     task_path_xyz=getattr(self, "task_path_xyz", None),
                     _xu=self.last_xu, _signs=self.signs, _reference=self.reference,
                     joint_limits=self.joint_limits,
                     stats=dict(sqp_iters=int(np.sum(stats.sqp_iters)), pcg_iters=int(np.sum(stats.pcg_iters)),
                                admm_iters=int(np.sum(stats.admm_iters)),
                                admm_linsys_iters=int(np.sum(stats.admm_linsys_iters)),
                                solve_time_ms=float(step.solve.solve_time_us)/1000,
                                row_violation=np.asarray(step.row_viol).tolist(),
                                controller_restarted=self.restarted))
        # Copy already-returned public telemetry only. No native solver handle,
        # invented SQP prediction or optimizer checkpoint enters history.
        def retained(value):
            if isinstance(value, np.ndarray):
                return retained(value.tolist())
            if isinstance(value, (list, tuple)):
                return [retained(item) for item in value]
            if isinstance(value, (float, np.floating)) and not np.isfinite(value):
                return None
            return value.item() if isinstance(value, np.generic) else value
        diagnostic_names = ("initial_merit", "final_merit", "min_merit", "step_size", "pcg_iters",
                            "pcg_times_us", "ls_num_iters", "budget_hit", "linsys",
                            "admm_r_prim", "admm_r_dual", "row_max_violation", "row_sum_violation")
        event["diagnostics"] = {name: retained(getattr(stats, name)) for name in diagnostic_names
                                if hasattr(stats, name)}
        # Constraint telemetry can be nonfinite even for a finite trajectory.
        # Report unavailable telemetry explicitly instead of fabricating convergence.
        violation = np.asarray(step.row_viol)
        if not np.isfinite(violation).all():
            event["stats"]["row_violation"] = None
        self.restarted = False
        return snapshot(event)

    def solve(self, origin, settings_version):
        """Synchronous diagnostic/conformance API, sharing the exact numerical path."""
        event = render_plan(self.solve_snapshot(origin, settings_version), self.kinematics)
        json.dumps(event, allow_nan=False)
        return event

    def advance(self, end_time=None):
        """The unchanged reach_sim fixed pacing, down to the RK4 substep order."""
        interval_end = self.t + self.dt if end_time is None else min(self.t + self.dt, end_time)
        samples = []
        while self.t < interval_end - 1e-12:
            h = min(self.reach.SIM_DT_S, interval_end - self.t)
            q, v = self.reach.rk4(self.model, self.data, self.x[:7], self.x[7:], self.u, h)
            self.x = np.r_[q, v]
            if not np.isfinite(self.x).all():
                raise FloatingPointError("Nonfinite simulated state")
            self.t += h
            self.applied_torque = self.u.copy()
            samples.append((self.t, self.x.copy(), self.u.copy()))
        return samples

    def state_snapshot(self, rtf=0, settings_version=0):
        return snapshot(dict(type="state", sim_time_s=self.t, _x=self.x,
                    end_effector_frame=self.reach.EE_FRAME, task_anchors=self.task_anchors,
                    settings_version=settings_version,
                    torque_nm=None if self.applied_torque is None else self.applied_torque.tolist(),
                    torque_kind="applied", joint_limits=self.joint_limits,
                    task_kind=self.task["kind"], target_xyz=self.target_world_at(self.t).tolist(),
                    _position_tol=self.reach.POSITION_TOL_M, _speed_tol=self.reach.SPEED_L1_TOL_RAD_S,
                    rtf=float(rtf)))

    def state_event(self, rtf=0):
        return render_state(self.state_snapshot(rtf), self.kinematics)


def build_schema(mpc_root):
    """Discover imports/build availability inside the numerical subprocess."""
    from execution_session import DEFAULT_EXECUTION
    mpc_root = Path(mpc_root).expanduser().resolve()
    reach, configuration = import_mpc(mpc_root)
    try:
        from source_runtime import discover_compatible_modules
        discovery = discover_compatible_modules(reach)
        available = discovery["available_N"]
    except (OSError, ValueError, KeyError):
        available = []
    _, settings, _ = configuration.load_configuration()
    defaults = {k: deepcopy(v) for k, v in settings.items() if k not in ("description", "save_plan_steps")}
    schema = dict(defaults=dict(config=defaults, task=deepcopy(REACH_DEFAULT_TASK),
                                                execution=deepcopy(DEFAULT_EXECUTION)),
                       available_N=available, parameters=parameter_specs(defaults, available),
                       tasks=[dict(kind="reach", label="Reach", defaults=deepcopy(REACH_DEFAULT_TASK)),
                              dict(kind="figure8", label="Figure eight", defaults=deepcopy(FIGURE8_DEFAULT_TASK),
                                   parameters=[dict(path="width_m", label="Width (m)", min=.01, max=.6),
                                               dict(path="height_m", label="Height (m)", min=.01, max=.6),
                                               dict(path="period_s", label="Period (s)", min=1., max=120.)])],
                       source=source_identity(mpc_root))
    return schema


# Numerical controller/plant operations stay above; process/transport/history
# policy belongs to the visualizer bridge and never initializes CUDA here.
from execution_bridge import ProcessLiveService as LiveService
