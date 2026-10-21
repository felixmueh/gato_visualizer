"""Bounded fresh-solve jobs, isolated from Live state and browser transports."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
import json
import math
import re
from pathlib import Path
import threading
import time
import uuid

from inspection_problem import captured_problem, configuration_overrides
from plot_sources import SourceReader, inspect_source, serializable

ROOT = Path(__file__).resolve().parent
TERMINAL = {"completed", "failed", "cancelled", "busy"}


class InspectionService:
    def __init__(self, plots, profiles, *, live=None, directory=None, process_factory=None,
                 locks_factory=None, probe=None, pause_timeout_s=15):
        self.plots, self.profiles, self.live = plots, profiles, live
        self.directory = Path(directory or ROOT / "_expr_data/solve-inspections").resolve()
        self.process_factory, self.locks_factory, self.probe = process_factory, locks_factory, probe
        self.pause_timeout_s = pause_timeout_s
        self.lock = threading.Condition()
        self.reader_lock = threading.Lock()
        self.reader = SourceReader(plots.mpc_root, plots.default_scene)
        self.jobs = OrderedDict()
        self.pending = []
        self.active = self.remote = None
        self.closed = False
        self.thread = threading.Thread(target=self._pump, name="solve-inspections", daemon=True)
        self.thread.start()

    def _request(self, body, capability=False):
        if not isinstance(body, dict) or set(body)-{"source", "selection", "profile_id", "sqp_iters", "budget_s"}:
            raise ValueError("Run again requires source, selection, sqp_iters and optional budget_s/profile_id")
        source, selection = body.get("source"), body.get("selection")
        if not isinstance(source, dict) or not isinstance(selection, dict):
            raise ValueError("Select a retained source and solve")
        if not any(selection.get(key) is not None for key in ("solve_id", "solve_seq", "trajectory_index")):
            raise ValueError("Select one retained solve explicitly")
        if set(selection)-{"solve_id", "solve_seq", "trajectory_index"}:
            raise ValueError("Unknown selected solve fields")
        profile = self.profiles.active_selection(body.get("profile_id"))
        if not capability:
            cap = body.get("sqp_iters")
            if type(cap) is not int or not 1 <= cap <= 10000:
                raise ValueError("sqp_iters must be a finite integer within [1,10000]")
            budget = body.get("budget_s")
            if budget is not None and (isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget <= 0):
                raise ValueError("budget_s must be null or a positive finite number of seconds")
        descriptor = self.plots._descriptor(source)
        return dict(body=deepcopy(body), descriptor=descriptor, profile=profile)

    def _problem(self, request):
        selection = deepcopy(request["body"]["selection"])
        if selection.get("solve_seq") is not None:
            selection["solve_id"] = selection["solve_seq"]
        with self.reader_lock:
            selected, _ = inspect_source(self.reader.read(request["descriptor"]), selection)
            problem = captured_problem(serializable(selected))
        return problem, str(selected["id"])

    def _checked(self, request, problem):
        from source_runtime import probe_selection
        from solver_process import validate_contract
        profile = request["profile"]
        checked = (self.probe or probe_selection)(
            {key: profile[key] for key in ("mpc_root", "python", "cache")}, operation="profile-probe")
        if not checked.get("compatible"):
            raise ValueError(checked.get("error", "Active solver profile is incompatible"))
        n = problem["problem_configuration"]["N"]
        if n not in checked.get("available_N", []):
            raise ValueError(f"Active solver profile has no compatible prebuilt N={n} module")
        if not checked.get("capabilities", {}).get("iteration_capture_by_N", {}).get(str(n), False):
            raise ValueError("Active solver profile does not support native iteration capture; select a rebuilt capture-capable profile")
        contract = problem["original_solver_profile"].get("coordinate_contract")
        if contract is not None:
            validate_contract(contract, checked.get("contract", {}))
        # Normal UI bounds on SQP cap do not constrain this explicit finite
        # inspection cap. Native allocation validation remains authoritative.
        return checked

    def capability(self, body):
        try:
            request = self._request(body, capability=True)
            problem, solve_id = self._problem(request)
            checked = self._checked(request, problem)
            return dict(available=True, reason=None, initialization="cold_state",
                        profile_id=request["profile"]["id"], solve_id=solve_id,
                        capabilities=checked["capabilities"], stop_behavior="terminate_isolated_worker_no_partial_trace")
        except (ValueError, TypeError, KeyError, OSError) as exc:
            return dict(available=False, reason=str(exc), initialization="cold_state")

    def submit(self, body):
        request = self._request(body)
        with self.lock:
            if self.closed:
                raise ValueError("Solve inspection service is closed")
            if len(self.pending) >= 2:
                raise ValueError("Inspection queue is full; wait for or stop an existing job")
            identifier = uuid.uuid4().hex
            self.jobs[identifier] = dict(id=identifier, job_id=identifier, state="pending",
                requested=dict(sqp_iters=body["sqp_iters"], budget_s=body.get("budget_s")),
                profile_id=request["profile"]["id"], initialization="cold_state",
                original=dict(source=deepcopy(body["source"]), selection=deepcopy(body["selection"])),
                stop_behavior="terminate_isolated_worker_no_partial_trace", _request=request)
            self.pending.append(identifier)
            while len(self.jobs) > 64:
                expired = next((key for key, value in self.jobs.items() if value["state"] in TERMINAL), None)
                if expired is None:
                    break
                del self.jobs[expired]
            self.lock.notify_all()
            return self.job(identifier)

    def job(self, identifier):
        with self.lock:
            if identifier not in self.jobs:
                raise KeyError("Inspection job was not found or expired")
            return deepcopy({key: value for key, value in self.jobs[identifier].items() if not key.startswith("_")})

    def descriptor(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if job is not None:
                if job["state"] != "completed":
                    raise ValueError("Inspection result is not available")
                return deepcopy(job["_artifact"])
        # Binary artifacts survive job expiry/backend restart. Only opaque
        # generated ids can address files beneath this checkout's own storage.
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Invalid retained inspection id")
        folder = self.directory / identifier
        path, binary = folder / "metadata.json", folder / "iterations.npz"
        if not path.is_file() or not binary.is_file():
            raise ValueError("Inspection result is not available")
        metadata = json.loads(path.read_text())
        if metadata.get("id") != identifier:
            raise ValueError("Retained inspection identity is inconsistent")
        return dict(kind="inspection", id=identifier, path=str(path), binary_path=str(binary),
                    revision=identifier, iterations_run=metadata["iterations_run"], stop_reason=metadata["stop_reason"])

    def stop(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if job is None:
                raise KeyError("Inspection job was not found or expired")
            if job["state"] in TERMINAL:
                return self.job(identifier)
            job["_cancelled"] = True
            job.update(state="cancelled", message="Inspection worker terminated; no partial iteration trace is available")
            if identifier in self.pending:
                self.pending.remove(identifier)
                job["message"] = "Queued inspection cancelled before solver construction"
            remote = self.remote if self.active == identifier else None
        if remote is not None:
            remote.terminate("Inspection cancelled explicitly; partial trace unavailable")
        return self.job(identifier)

    def _pump(self):
        while True:
            with self.lock:
                self.lock.wait_for(lambda: self.closed or self.pending)
                if self.closed:
                    return
                identifier = self.pending.pop(0)
                self.active = identifier
                job = self.jobs[identifier]
                job.update(state="running", phase="preflight", message="Checking captured problem and active solver profile")
            try:
                self._execute(identifier, job)
            except Exception as exc:
                with self.lock:
                    if not job.get("_cancelled"):
                        job.update(state="failed", error=str(exc), message=str(exc))
            finally:
                with self.lock:
                    self.active = self.remote = None
                    self.lock.notify_all()

    def _execute(self, identifier, job):
        from live_mpc import GPULocks
        from solver_process import SolverProcess, validate_contract
        request = job["_request"]
        problem, solve_id = self._problem(request)
        checked = self._checked(request, problem)
        requested = job["requested"]
        n = problem["problem_configuration"]["N"]
        if (requested["sqp_iters"]+1)*(21*n-7)*4 > 256*1024*1024:
            raise ValueError("Requested iteration trajectories exceed the native 256 MiB capture limit; reduce SQP cap")
        if job.get("_cancelled"):
            return
        # Revalidate the active frozen selection after potentially slow CPU probe.
        if self.profiles.active_selection(request["profile"]["id"]) != request["profile"]:
            raise ValueError("Active solver profile changed while inspection was being prepared")
        with self.lock:
            job.update(phase="pausing_live", message="Waiting for a committed Live calculation boundary")
        if self.live is not None:
            self.live.pause_for_inspection(identifier, timeout=self.pause_timeout_s)
        locks = (self.locks_factory or GPULocks)(request["profile"]["mpc_root"])
        if not locks.acquire():
            with self.lock:
                if not job.get("_cancelled"):
                    job.update(state="busy", message="GPU is busy; canonical experiment or Live locks are held. Run again when idle.")
            return
        remote = None
        try:
            with self.lock:
                if job.get("_cancelled"):
                    return
                folder = self.directory / identifier
                folder.mkdir(parents=True, exist_ok=False)
                config = configuration_overrides(problem, requested["sqp_iters"])
                path = folder / "configuration.json"
                path.write_text(json.dumps(config, allow_nan=False, indent=2)+"\n")
                remote = (self.process_factory or SolverProcess)(request["profile"],
                    lease_fds=lambda: [handle.fileno() for handle in locks.handles])
                self.remote = remote
                job.update(phase="configuring", message="Constructing isolated inspection solver")
            ready = remote.request("bootstrap", timeout=60)
            validate_contract(checked["contract"], ready["contract"])
            configured = remote.request("configure", timeout=120, config_path=str(path), task=problem["task"])
            if not configured["capabilities"].get("iteration_capture"):
                raise ValueError("Configured solver has no native iteration capture capability")
            actual = dict(profile=request["profile"], process_epoch=remote.epoch,
                          predictor=configured, coordinate_contract=ready["contract"])
            with self.lock:
                if job.get("_cancelled"):
                    return
                job.update(phase="solving", message="Running one cold solve; wall budget is checked at native iteration boundaries",
                           actual_solver_profile=actual, original_solve_id=solve_id)
            descriptor = remote.request("inspect", id=identifier, artifact_directory=str(folder),
                problem=problem, original=dict(job["original"], solve_id=solve_id),
                actual_solver_profile=actual, **requested)
            with self.lock:
                if not job.get("_cancelled"):
                    job.update(state="completed", phase="completed", message="Fresh cold inspection solve recorded",
                               source=dict(kind="inspection", id=identifier), artifact={key: descriptor[key]
                                   for key in ("iterations_run", "stop_reason")}, _artifact=descriptor,
                               iterations_run=descriptor["iterations_run"], stop_reason=descriptor["stop_reason"])
        finally:
            if remote is not None:
                remote.close()
            locks.release()

    def close(self):
        with self.lock:
            self.closed = True
            identifiers = [key for key, job in self.jobs.items() if job["state"] not in TERMINAL]
            self.lock.notify_all()
        for identifier in identifiers:
            self.stop(identifier)
        self.thread.join(timeout=10)
