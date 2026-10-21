"""Live diagnostic MPC: unchanged tiago_mpc helpers, one CUDA-owning worker.

This is intentionally not an experiment runner. The only duplicated numerical
logic is reach_sim's controller setup and fixed-interval episode stepping.
"""
from __future__ import annotations

from collections import deque
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
import threading
import time
import traceback

import numpy as np

ROOT = Path(__file__).resolve().parent
SUPPORTED_N = (16, 32, 64, 128)


def import_mpc(mpc_root):
    """Set our cache before reach_sim's setdefault and import unchanged sources."""
    mpc_root = Path(mpc_root).expanduser().resolve()
    os.environ["GATO_CACHE_DIR"] = str(ROOT / ".cache/gato")
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
    limits = {"dt_s": (.001, .1), "solver_params.max_sqp_iters": (1, 20),
              "solver_params.max_pcg_iters": (1, 800),
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
    if task.get("kind") != "reach" or set(task) != {"kind", "target_offset_m"}:
        raise ValueError("This MVP supports reaching tasks only")
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
        self.kinematics = RobotKinematics(Path(mpc_root) / "models/tiago_pro/tiago_pro.urdf")
        path, self.gpu_path, self.signs = self.reach.runtime_urdf()
        self.state_signs = np.tile(self.signs, 2)
        self.model = self.pin.buildModelFromUrdf(str(path))
        self.data = self.model.createData()
        self.fid = self.model.getFrameId(self.reach.EE_FRAME)
        if (self.model.nq, self.model.nv) != (7, 7) or self.fid >= self.model.nframes:
            raise ValueError("Unexpected reduced TIAGo model or end-effector frame")
        self.default_target = self.reach.ee_position(
            self.model, self.data, self.reach.Q_START_RAD + self.reach.Q_GOAL_DELTA_RAD, self.fid)
        self.solver = self.controller = None
        self.sequence = 0
        self.reset_state()

    def reset_state(self, reset_controller=True):
        self.x = np.r_[self.reach.Q_START_RAD, np.zeros(7)]
        self.t = 0.0
        if reset_controller and self.controller is not None:
            self.controller.reset(self.x * self.state_signs)

    def configure(self, config_path, task):
        _, settings, effective = importlib.import_module("reaching_config").load_configuration(config_path)
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
        world_target = self.kinematics.target_to_world(self.default_target) + np.asarray(task["target_offset_m"])
        self.target = self.kinematics.world_from_torso.actInv(world_target)
        self.reference = np.zeros((self.N, 6), dtype=np.float32)
        self.reference[:, :3] = self.target
        self.controller.reset(self.x * self.state_signs)
        self.restarted = True

    def solve(self, origin, settings_version):
        from server import decode_prediction
        if origin == "preview":
            self.controller.reset(self.x * self.state_signs)
        step = self.controller.step(self.x * self.state_signs, self.reference.ravel())
        self.u = np.asarray(step.u, dtype=float) * self.signs
        self.last_xu = np.asarray(step.solve.xu).copy()
        if not np.isfinite(self.u).all() or not np.isfinite(self.last_xu).all():
            raise FloatingPointError("Nonfinite torque or predicted trajectory")
        q = decode_prediction(self.last_xu, self.signs, self.N)
        stats = step.solve.stats
        self.sequence += 1
        event = dict(type="plan", seq=self.sequence, origin=origin, settings_version=settings_version,
                     sim_time_s=self.t, N=self.N, dt_s=self.dt,
                     knot_time_s=(np.arange(self.N) * self.dt).tolist(), q=q.tolist(),
                     ee_xyz=self.kinematics.ee_positions(q).tolist(),
                     reference_xyz=[self.kinematics.target_to_world(row[:3]).tolist()
                                    for row in self.reference],
                     stats=dict(sqp_iters=int(np.sum(stats.sqp_iters)), pcg_iters=int(np.sum(stats.pcg_iters)),
                                admm_iters=int(np.sum(stats.admm_iters)),
                                admm_linsys_iters=int(np.sum(stats.admm_linsys_iters)),
                                solve_time_ms=float(step.solve.solve_time_us)/1000,
                                row_violation=np.asarray(step.row_viol).tolist(),
                                controller_restarted=self.restarted))
        # Constraint telemetry can be nonfinite even for a finite trajectory.
        # Report unavailable telemetry explicitly instead of fabricating convergence.
        violation = np.asarray(step.row_viol)
        if not np.isfinite(violation).all():
            event["stats"]["row_violation"] = None
        json.dumps(event, allow_nan=False)
        self.restarted = False
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
            samples.append((self.t, self.x.copy(), self.u.copy()))
        return samples

    def state_event(self, rtf=0):
        ee = self.kinematics.ee_positions(self.x[None, :7])[0]
        distance = float(np.linalg.norm(ee-self.kinematics.target_to_world(self.target)))
        arrived = distance <= self.reach.POSITION_TOL_M and np.abs(self.x[7:]).sum() <= self.reach.SPEED_L1_TOL_RAD_S
        return dict(type="state", sim_time_s=self.t, q=self.x[:7].tolist(), qd=self.x[7:].tolist(),
                    ee_xyz=ee.tolist(), distance_m=distance, arrived=bool(arrived), rtf=float(rtf))


class LiveService:
    """Thread-safe command/event bridge. HTTP threads never touch the adapter."""
    def __init__(self, mpc_root, adapter_factory=MPCAdapter):
        self.mpc_root = Path(mpc_root).expanduser().resolve()
        self.reach, configuration = import_mpc(self.mpc_root)
        from gato import _cache
        try:
            from gato.builder import _codegen_key
            gpu_path = self.reach.runtime_urdf()[1]
            entry = _cache.robot_entry(self.reach.PLANT)
            current_key = _codegen_key(gpu_path, self.reach.EE_FRAME, .15, None, False)
            available = ([n for n in SUPPORTED_N if _cache.find_module(self.reach.PLANT, n) is not None]
                         if entry and entry.get("codegen_key") == current_key else [])
        except (OSError, ValueError, KeyError):
            available = []
        _, settings, _ = configuration.load_configuration()
        defaults = {k: deepcopy(v) for k, v in settings.items() if k not in ("description", "save_plan_steps")}
        self.schema = dict(defaults=dict(config=defaults, task=dict(kind="reach", target_offset_m=[0, 0, 0])),
                           available_N=available, parameters=parameter_specs(defaults, available),
                           source=source_identity(self.mpc_root))
        self.config, self.task = deepcopy(defaults), deepcopy(self.schema["defaults"]["task"])
        self.adapter_factory = adapter_factory
        self.condition = threading.Condition()
        self.commands = deque()
        self.events = deque(maxlen=256)
        self.latest = {}
        self.cursor = self.version = self.subscribers = self.next_version = 0
        self.closed = False
        self.thread = threading.Thread(target=self._run, name="live-mpc-gpu", daemon=True)
        self.publish(dict(type="status", state="idle", message="Live reaching ready; connect to preview",
                          settings_version=0, N=defaults["N"], dt_s=defaults["dt_s"]))
        self.thread.start()

    def publish(self, event):
        json.dumps(event, allow_nan=False)
        with self.condition:
            self.cursor += 1
            self.events.append((self.cursor, event))
            if event["type"] in ("status", "plan", "state"):
                self.latest[event["type"]] = event
            self.condition.notify_all()

    def subscribe(self):
        with self.condition:
            self.subscribers += 1
            self.condition.notify_all()
            return self.cursor, [self.latest[k] for k in ("status", "plan", "state") if k in self.latest]

    def unsubscribe(self):
        with self.condition:
            self.subscribers = max(0, self.subscribers - 1)
            if not self.subscribers:
                self.commands.append(dict(type="pause"))
            self.condition.notify_all()

    def read_events(self, cursor, timeout=1):
        with self.condition:
            self.condition.wait_for(lambda: self.closed or self.cursor > cursor, timeout=timeout)
            return self.cursor, [event for seq, event in self.events if seq > cursor]

    def command(self, command):
        if not isinstance(command, dict) or command.get("type") not in ("set_settings", "play", "pause", "reset"):
            raise ValueError("Unknown live command")
        kind = command["type"]
        if kind == "set_settings":
            if set(command) != {"type", "config", "task"}:
                raise ValueError("set_settings requires config and task")
            config, task = validate_settings(command["config"], command["task"], self.schema)
            command = dict(type=kind, config=config, task=task)
        elif set(command) != {"type"}:
            raise ValueError(f"Unexpected {kind} command fields")
        with self.condition:
            if self.closed:
                raise ValueError("Live service is closed")
            if kind == "set_settings":
                self.next_version += 1
                command["settings_version"] = self.next_version
                if self.commands and self.commands[-1]["type"] == kind:
                    self.commands.pop()
            if len(self.commands) >= 64:
                raise ValueError("Command queue full")
            self.commands.append(command)
            self.condition.notify_all()
            return self.next_version

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
        # CUDA destruction waits for the shared experiment window too. Returning
        # early would let process teardown free CUDA resources outside the lock.
        self.thread.join()

    def _run(self):
        locks = GPULocks(self.mpc_root)
        adapter = None
        playing = False
        needs_config = needs_preview = True
        needs_restart = False
        wall_epoch = sim_epoch = next_tick = 0.0
        last_state_at = 0.0
        last_busy = 0.0
        def status(state, message):
            self.publish(dict(type="status", state=state, message=message,
                              settings_version=self.version, N=self.config["N"], dt_s=self.config["dt_s"]))
        try:
            while True:
                with self.condition:
                    if self.closed:
                        return
                    commands = list(self.commands)
                    self.commands.clear()
                    clients = self.subscribers
                for command in commands:
                    kind = command["type"]
                    if kind == "set_settings":
                        self.config, self.task = command["config"], command["task"]
                        self.version = command["settings_version"]
                        needs_config = needs_preview = True
                    elif kind == "play":
                        playing = True
                        needs_restart = True
                        wall_epoch, sim_epoch = time.monotonic(), adapter.t if adapter else 0
                        next_tick = wall_epoch
                    elif kind == "pause":
                        playing = False
                        locks.release()
                        status("paused", "Paused; solve latency does not advance simulated time")
                    elif kind == "reset":
                        if adapter is not None:
                            adapter.reset_state(reset_controller=False)
                        needs_restart = True
                        needs_preview = True
                        wall_epoch, sim_epoch = time.monotonic(), 0
                        next_tick = wall_epoch
                if not clients:
                    playing = False
                    locks.release()
                ready = not playing or time.monotonic() >= next_tick
                if clients and ready and (playing or needs_preview):
                    if not locks.acquire():
                        if time.monotonic() - last_busy > 1:
                            status("gpu_busy", "Experiment GPU locks are held; waiting without solving")
                            last_busy = time.monotonic()
                    else:
                        try:
                            if adapter is None:
                                adapter = self.adapter_factory(self.mpc_root, reach=self.reach)
                            if needs_config:
                                folder = ROOT / "_expr_data/live"
                                folder.mkdir(parents=True, exist_ok=True)
                                path = folder / f"config-{time.time_ns()}-v{self.version}.json"
                                path.write_text(json.dumps(self.config, indent=2, allow_nan=False)+"\n")
                                adapter.configure(path, self.task)
                                needs_config = False
                                wall_epoch, sim_epoch = time.monotonic(), adapter.t
                                next_tick = wall_epoch
                            if needs_restart:
                                adapter.controller.reset(adapter.x * adapter.state_signs)
                                adapter.restarted = True
                                needs_restart = False
                            self.publish(adapter.solve("play" if playing else "preview", self.version))
                            needs_preview = False
                            if playing:
                                adapter.advance()
                                now = time.monotonic()
                                if now-last_state_at >= 1/60:
                                    self.publish(adapter.state_event((adapter.t-sim_epoch)/max(now-wall_epoch, 1e-9)))
                                    last_state_at = now
                                status("playing", "Simulated MPC motion; target held until paused")
                                # Fixed dt plant advances, paced at a maximum of real time.
                                next_tick = max(next_tick + adapter.dt, now)
                            else:
                                self.publish(adapter.state_event())
                                status("paused", "Preview: reset at current state followed by one solve")
                                locks.release()
                        except Exception as exc:
                            playing = needs_preview = False
                            needs_config = True
                            locks.release()
                            self.publish(dict(type="error", message=str(exc), detail=traceback.format_exc()))
                            status("error", str(exc))
                with self.condition:
                    timeout = min(.1, max(0, next_tick-time.monotonic())) if playing and locks.handles else .1
                    self.condition.wait(timeout=timeout)
        finally:
            if adapter is not None:
                # CUDA buffer/event destruction belongs to this worker too.
                # A graceful shutdown waits for an experiment owner to finish.
                while not locks.acquire():
                    time.sleep(.1)
                adapter.controller = None
                adapter.solver = None
                adapter = None
            locks.release()
