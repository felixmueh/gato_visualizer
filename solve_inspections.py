"""Bounded fresh-solve jobs, isolated from Live state and browser transports."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
import json
import math
import os
import shutil
from pathlib import Path
import threading
import time
import uuid
from urllib.parse import urlparse
from urllib.request import url2pathname

from inspection_problem import captured_problem
from plot_sources import SourceReader, inspect_source, serializable
from runtime_files import ended_owner, owner_tag, runtime_directory

TERMINAL = {"completed", "failed", "cancelled", "busy"}


def profile_fingerprint(profile):
    """Cheap invalidation for cached CPU probes; never import the selected MPC.

    Watch source/model inputs and binaries rather than history/solve revisions.
    File metadata includes ctime and inode, so replacing a rebuilt binary even
    with its original name/mtime invalidates the result. Source / Build Apply
    also restarts this service and therefore drops the entire cache.
    """
    root, python = Path(profile["mpc_root"]), Path(profile["python"])
    # The cache in effect: the override, else tiago_mpc's resolved default.
    effective = profile.get("effective_cache") or profile.get("cache")
    caches = () if effective is None else (Path(effective),)
    paths = {python, python.parent.parent / "pyvenv.cfg", *(cache / "manifest.json" for cache in caches),
             root / "pyproject.toml", root / "uv.lock", root / ".python-version"}
    gato_roots = []
    for packages in (python.parent.parent / "lib").glob("python*/site-packages"):
        paths.add(packages)
        paths.update(packages.glob("*.dist-info/METADATA"))
        gato_roots.append(packages / "gato")
        for metadata in packages.glob("gato_mpc-*.dist-info"):
            direct_url = metadata / "direct_url.json"
            paths.update((direct_url, metadata / "RECORD"))
            if direct_url.is_file():
                source = json.loads(direct_url.read_text())
                url = urlparse(source.get("url", ""))
                if source.get("dir_info", {}).get("editable") and url.scheme == "file":
                    gato_roots.append(Path(url2pathname(url.path)))
    suffixes = {".py", ".h", ".hpp", ".cuh", ".cu", ".cpp", ".cmake", ".json", ".urdf", ".xml", ".so"}
    for directory in (root / "tiago_mpc", root / "models",
                      *gato_roots,
                      *(cache / name for cache in caches for name in ("modules", "robots"))):
        for folder, directories, files in os.walk(directory):
            directories[:] = [name for name in directories if name not in
                              {"__pycache__", ".git", "build", "CMakeFiles", "meshes", "_expr_data",
                               ".cache", ".venv", ".venv-container", "node_modules", "dist"}]
            paths.update(Path(folder) / name for name in files if Path(name).suffix in suffixes)
    tool_path = str(python.parent) + os.pathsep + os.environ.get("PATH", "")
    for tool in ("nvcc", "c++", "cmake"):
        found = shutil.which(tool, path=tool_path)
        if found:
            paths.add(Path(found))
    stamps = []
    for path in sorted(paths):
        try:
            stat = path.stat()
            value = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        except FileNotFoundError:
            value = None
        stamps.append((str(path), value))
    return (tuple(sorted(profile.items())), tuple(stamps), tool_path,
            os.environ.get("CUDAHOSTCXX"), os.environ.get("CUDA_HOME"))


class InspectionService:
    """Run again jobs and their results.

    Results are runtime scratch (Felix, 2026-10-23): RAM-backed files under
    <runtime>/solve-inspections/p<pid>/<id>/, kept only while their source is
    current. A Live result goes when its generation stops being current, a Replay
    result when another recording (or revision) is loaded; failed or cancelled jobs
    leave nothing; leftovers of ended servers go at start and everything at close.
    """
    def __init__(self, plots, profiles, *, live=None, directory=None, process_factory=None,
                 locks_factory=None, probe=None, pause_timeout_s=15):
        self.plots, self.profiles, self.live = plots, profiles, live
        base = Path(directory or runtime_directory("solve-inspections")).resolve()
        base.mkdir(parents=True, exist_ok=True)
        for folder in base.iterdir():
            if ended_owner(folder.name):
                shutil.rmtree(folder, ignore_errors=True)
        self.directory = base / owner_tag()
        self.directory.mkdir(exist_ok=True)
        self.results = {}  # id -> (owner, descriptor) of completed results still current
        self.process_factory, self.locks_factory, self.probe = process_factory, locks_factory, probe
        self.pause_timeout_s = pause_timeout_s
        self.lock = threading.Condition()
        self.reader_lock = threading.Lock()
        self.probe_lock = threading.Lock()
        self.probe_cache = OrderedDict()
        self.reader = SourceReader(plots.mpc_root, plots.default_scene)
        self.jobs = OrderedDict()
        self.pending = []
        self.active = self.remote = None
        self.closed = False
        self.thread = threading.Thread(target=self._pump, name="solve-inspections", daemon=True)
        self.thread.start()
        if live is not None and hasattr(live, "generation_listeners"):
            live.generation_listeners.append(lambda generation: self._discard(
                lambda owner: owner[0] == "live" and owner[1] != generation))
        replays = getattr(plots, "replays", None)
        if replays is not None and hasattr(replays, "listeners"):
            replays.listeners.append(lambda current: self._discard(
                lambda owner: owner[0] == "replay" and owner[1:] != current))

    def _owner(self, descriptor):
        """The source a result belongs to: ("live", generation) or ("replay", id, revision)."""
        if descriptor.get("kind") == "live":
            return ("live", descriptor.get("generation"))
        if descriptor.get("kind") == "inspection":
            with self.lock:
                if descriptor["id"] not in self.results:
                    raise ValueError("Inspection result is not available")
                return self.results[descriptor["id"]][0]
        return ("replay", descriptor.get("id"), descriptor.get("revision"))

    def _current(self, owner):
        if owner[0] == "live":
            return self.live is None or owner[1] == getattr(self.live, "generation", owner[1])
        current = getattr(getattr(self.plots, "replays", None), "current", None)
        return current is None or owner[1:] == current

    def _discard(self, stale):
        """Delete the results whose source stopped being current."""
        with self.lock:
            identifiers = [key for key, (owner, _) in self.results.items() if stale(owner)]
            for identifier in identifiers:
                del self.results[identifier]
        for identifier in identifiers:
            shutil.rmtree(self.directory / identifier, ignore_errors=True)

    def _request(self, body, capability=False):
        if not isinstance(body, dict) or set(body)-{"source", "selection", "profile_id", "sqp_iters", "budget_s"}:
            raise ValueError("Run again requires source, selection, sqp_iters and optional budget_s/profile_id")
        source, selection = body.get("source"), body.get("selection")
        if not isinstance(source, dict) or not isinstance(selection, dict):
            raise ValueError("Select a retained source and solve")
        selectors = [key for key in ("solve_id", "solve_seq", "trajectory_index") if selection.get(key) is not None]
        if len(selectors) != 1:
            raise ValueError("Select exactly one retained solve explicitly")
        if selectors == ["trajectory_index"] and (type(selection["trajectory_index"]) is not int or selection["trajectory_index"] < 0):
            raise ValueError("trajectory_index must be a nonnegative integer")
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
        return dict(body=deepcopy(body), descriptor=descriptor, profile=profile, owner=self._owner(descriptor))

    def _problem(self, request):
        selection = deepcopy(request["body"]["selection"])
        if selection.get("solve_seq") is not None:
            selection["solve_id"] = selection["solve_seq"]
        if request["descriptor"].get("kind") == "live":
            identifier = selection.get("solve_id")
            if type(identifier) not in (str, int) or not str(identifier):
                raise ValueError("Live inspection requires an explicit retained solve id")
            preview = str(identifier).startswith("preview:")
            descriptor = request["descriptor"]
            store = getattr(self.live, "history_store", None)
            if store is None:
                raise ValueError("Indexed Live solve history is unavailable")
            selected = store.selected_plan(descriptor, identifier, missing_ok=preview)
            if selected is None:
                descriptor = descriptor.get("preview_source")
                if descriptor is None or descriptor.get("generation") != request["descriptor"].get("generation"):
                    raise ValueError("Selected preview solve is not retained in this source")
                store = getattr(self.live, "inspection_store", None)
                if store is None:
                    raise ValueError("Indexed Live preview history is unavailable")
                selected = store.selected_plan(descriptor, identifier)
            return captured_problem(selected), str(identifier)
        with self.reader_lock:
            raw = self.reader.read(request["descriptor"])
            if selection.get("trajectory_index") is not None and not any(
                    plan.get("trajectory_index") == selection["trajectory_index"] for plan in raw.get("plans", ())):
                raise ValueError("Selected replay trajectory is not a retained solve in this source")
            selected, _ = inspect_source(raw, selection)
            problem = captured_problem(serializable(selected), replay_scene=raw.get("scene"))
        return problem, str(selected["id"])

    def _checked(self, request, problem):
        from solver_process import validate_contract
        friction = problem["problem_configuration"].get("friction")
        if isinstance(friction, dict) and "law" in friction:
            raise ValueError("Run again unavailable: this recording uses the older embedded friction-law format; "
                             "its recorded motion remains viewable")
        profile = request["profile"]
        checked = self._profile_capabilities(profile, problem["problem_configuration"])
        if not checked.get("compatible"):
            raise ValueError(checked.get("error", "Active solver profile is incompatible"))
        n = problem["problem_configuration"]["N"]
        mode = "on" if problem["problem_configuration"].get("friction") is not None else "off"
        available = (checked.get("available_N", []) if checked.get("exact_availability") else
                     checked.get("available_N_by_friction", {}).get(mode, []))
        if n not in available:
            raise ValueError(f"Active solver profile has no compatible prebuilt N={n} module")
        contract = problem["original_solver_profile"].get("coordinate_contract")
        if contract is not None:
            validate_contract(contract, checked.get("contract", {}))
        # Normal UI bounds on SQP cap do not constrain this explicit finite
        # inspection cap. Native allocation validation remains authoritative.
        return checked

    def _profile_capabilities(self, profile, params=None):
        from source_runtime import probe_selection
        # One probe per unchanged selected environment, including concurrent
        # capability requests and Run again preflight. This lock is independent
        # of Live and job lifecycle locks; no numerical scheduling is changed.
        with self.probe_lock:
            key = json.dumps(dict(profile=profile, params=params), sort_keys=True)
            fingerprint = profile_fingerprint(profile)
            cached = self.probe_cache.get(key)
            if cached is None or cached[0] != fingerprint:
                selection = {name: profile[name] for name in ("mpc_root", "python", "cache")}
                result = ((self.probe or probe_selection)(selection, params=params) if params is not None else
                          (self.probe or probe_selection)(selection))
                if profile_fingerprint(profile) != fingerprint:
                    raise ValueError("Solver source or binaries changed while checking capability; select again")
                self.probe_cache[key] = (fingerprint, {name: result[name] for name in
                    ("compatible", "available_N", "available_N_by_friction", "exact_availability", "capabilities", "contract", "error") if name in result})
                while len(self.probe_cache) > 8:
                    self.probe_cache.popitem(last=False)
            self.probe_cache.move_to_end(key)
            return deepcopy(self.probe_cache[key][1])

    def capability(self, body):
        try:
            request = self._request(body, capability=True)
            problem, solve_id = self._problem(request)
            checked = self._checked(request, problem)
            return dict(available=True, reason=None, initialization="cold_state",
                        mode="independent_sqp_caps",
                        profile_id=request["profile"]["id"], solve_id=solve_id,
                        capabilities=checked.get("capabilities", {}), stop_behavior="terminate_isolated_worker_no_partial_trace")
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
            if identifier not in self.results:
                raise ValueError("Inspection result is not available: its source is no longer current")
            return deepcopy(self.results[identifier][1])

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
                    kept = identifier in self.results
                    self.lock.notify_all()
                if not kept:  # failed, cancelled, busy or no longer current: nothing to keep
                    shutil.rmtree(self.directory / identifier, ignore_errors=True)

    def _execute(self, identifier, job):
        from live_mpc import GPULocks
        from solver_process import SolverProcess, validate_contract
        request = job["_request"]
        problem, solve_id = self._problem(request)
        checked = self._checked(request, problem)
        requested = job["requested"]
        n = problem["problem_configuration"]["N"]
        if (requested["sqp_iters"]+1)*(21*n-7)*4 > 256*1024*1024:
            raise ValueError("Requested capped-solve trajectories exceed the 256 MiB inspection limit; reduce SQP cap")
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
                # The captured MpcParams with the requested SQP cap (a replace in the child).
                (folder / "configuration.json").write_text(json.dumps(dict(
                    params=problem["problem_configuration"], max_sqp_iters=requested["sqp_iters"]),
                    allow_nan=False, indent=2)+"\n")
                remote = (self.process_factory or SolverProcess)(request["profile"],
                    lease_fds=lambda: [handle.fileno() for handle in locks.handles])
                self.remote = remote
                job.update(phase="configuring", message="Constructing isolated inspection solver")
            ready = remote.request("bootstrap", timeout=60)
            validate_contract(checked["contract"], ready["contract"])
            configured = remote.request("configure", timeout=120, params=problem["problem_configuration"],
                                        max_sqp_iters=requested["sqp_iters"])
            actual = dict(profile=request["profile"], process_epoch=remote.epoch,
                          predictor=configured, coordinate_contract=ready["contract"])
            with self.lock:
                if job.get("_cancelled"):
                    return
                job.update(phase="solving", message="Running independent cold solves for SQP caps 1 through the selected maximum",
                           actual_solver_profile=actual, original_solve_id=solve_id)
            descriptor = remote.request("inspect", id=identifier, artifact_directory=str(folder),
                problem=problem, original=dict(job["original"], solve_id=solve_id),
                actual_solver_profile=actual, **requested)
            with self.lock:
                if not job.get("_cancelled") and not self._current(request["owner"]):
                    job.update(state="failed", message="Source changed during Run again; result discarded")
                elif not job.get("_cancelled"):
                    self.results[identifier] = (request["owner"], descriptor)
                    job.update(state="completed", phase="completed", message="Independent cold capped solves recorded",
                               source=dict(kind="inspection", id=identifier), artifact={key: descriptor[key]
                                   for key in ("mode", "snapshot_count", "solves_run", "max_sqp_cap", "stop_reason")},
                               mode=descriptor["mode"], snapshot_count=descriptor["snapshot_count"], solves_run=descriptor["solves_run"],
                               max_sqp_cap=descriptor["max_sqp_cap"], stop_reason=descriptor["stop_reason"])
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
        # Shutdown or restart: no source is current any more.
        with self.lock:
            self.results.clear()
        shutil.rmtree(self.directory, ignore_errors=True)
