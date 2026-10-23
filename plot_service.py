"""Bounded asynchronous CPU plotting, isolated from HTTP and native MPC work."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
import multiprocessing as mp
import os
from pathlib import Path
import queue
import threading
import time
import uuid

from plot_sources import SourceReader, inspect_source
from solver_lifecycle import run_with_parent

ROOT = Path(__file__).resolve().parent
MAX_RESULT_BYTES = 8*1024*1024
MAX_CACHE_BYTES = 32*1024*1024


def reduce_spec(spec, pixels=1200):
    """Display-only min/max reduction; full-data aggregates are already computed.

    Preserve each null-gap boundary and both extrema in every pixel bucket.
    This runs after plugin evaluation and never changes summary table rows.
    """
    spec = deepcopy(spec)
    for series in spec.get("series", []):
        xs, ys = series.get("x", []), series.get("y", [])
        if len(xs) <= pixels*4 or len(xs) != len(ys):
            continue
        if spec.get("x", {}).get("identity") == "category":
            return dict(version=1, kind="unavailable", title=spec.get("title", "Plot"),
                        message="Too many distinct categories for this display. Select fewer categories.")
        if series.get("style") == "bar" or "bin_edges" in series:
            return dict(version=1, kind="unavailable", title=spec.get("title", "Plot"),
                        message="Too many distinct bars for this display. Reduce histogram bins or select a smaller range.")
        chosen = {0, len(xs)-1}
        for start in range(0, len(xs), max(1, len(xs)//pixels)):
            stop = min(len(xs), start+max(1, len(xs)//pixels))
            valid = [i for i in range(start, stop) if ys[i] is not None and xs[i] is not None]
            if valid:
                chosen.update((valid[0], valid[-1], min(valid, key=lambda i: ys[i]),
                               max(valid, key=lambda i: ys[i])))
            for i in range(start, stop):
                if ys[i] is None or xs[i] is None:
                    # Keep a single null in a contiguous gap plus both sides.
                    if i == 0 or (ys[i-1] is not None and xs[i-1] is not None):
                        chosen.update((max(0, i-1), i))
                    if i+1 < len(xs) and ys[i+1] is not None and xs[i+1] is not None:
                        chosen.update((i, i+1))
        indices = sorted(chosen)
        if len(indices) > pixels*8:
            return dict(version=1, kind="unavailable", title=spec.get("title", "Plot"),
                        message="The requested display contains too many distinct gaps. Select a smaller visible range.")
        series["x"], series["y"] = [xs[i] for i in indices], [ys[i] for i in indices]
        if isinstance(series.get("hover"), list) and len(series["hover"]) == len(xs):
            series["hover"] = [series["hover"][i] for i in indices]
        # Structured, not a note: the browser shows it on hover only.
        spec.setdefault("display_reduction", []).append(
            dict(series=series.get("label"), original=len(xs), displayed=len(indices)))
    return spec


def _worker_main(commands, results, directories, mpc_root, default_scene):
    """Fresh interpreter: project plot imports cannot touch the live solver."""
    try:
        from gato_visualizer.plotting import Registry, EpisodeView, SolveView, InspectionContext
        registry = Registry()
        for directory in directories:
            registry.load_directory(directory)
        catalog = [*registry.catalog("episode"), *registry.catalog("solve")]
        results.put(dict(type="ready", catalog=catalog, errors=registry.errors))
        reader = SourceReader(mpc_root, default_scene)
        cache = OrderedDict()
        cache_bytes = 0
        while True:
            job = commands.get()
            if job is None:
                return
            try:
                request = job["request"]
                descriptor = job["descriptor"]
                key = hashlib.sha256(json.dumps(dict(request=request, descriptor=descriptor),
                                                sort_keys=True).encode()).hexdigest()
                if key in cache:
                    payload, payload_bytes = cache[key]
                    cache.move_to_end(key)
                else:
                    raw = reader.read(descriptor)
                    selection = dict(request.get("selection") or {})
                    if "solve_seq" in selection and selection["solve_seq"] is not None:
                        selection["solve_id"] = selection["solve_seq"]
                    if "trajectory_index" in request["source"]:
                        selection.setdefault("trajectory_index", request["source"]["trajectory_index"])
                    analysis = request.get("range") or {}
                    selected, inspection = inspect_source(raw, selection, analysis)
                    iteration = selection.get("iteration", selection.get("iteration_index"))
                    source = request["source"]
                    clock = (f"live:{source['generation']}" if source["kind"] == "live" else
                             f"inspection:{source['id']}" if source["kind"] == "inspection" else
                             f"replay:{source.get('id', 'default')}:{source.get('trajectory_index', 0)}")
                    context = InspectionContext(episode_cursor_s=analysis.get("cursor_s"),
                        analysis_range=analysis.get("mode", "entire"),
                        visible_window=((analysis.get("start_s"), analysis.get("end_s"))
                                        if analysis.get("mode") in ("visible", "window") else None),
                        selected_solve_id=None if selected is None else selected.get("seq", selected["id"]), sqp_iteration=iteration,
                        clock=clock)
                    scope = request["context"]
                    # Part of the request, hence of the cache key; never cached in the source.
                    thresholds = request.get("limit_settings") or {}
                    view = (EpisodeView({**raw, "limit_settings": thresholds}, context=context) if scope == "episode" else
                            SolveView({**(selected or {}), "limit_settings": thresholds} if selected else {}, context=context))
                    if inspection["selected_solve"] is not None:
                        solve = inspection["selected_solve"]
                        solve.update(seq=solve["id"], sim_time_s=solve.get("time_s"),
                                     has_prediction=bool(solve.get("selected_prediction") or solve["final_prediction"]), can_continue=False,
                                     reason=solve["capabilities"]["continue_reason"])
                    states = raw.get("states", [])
                    wanted = selection.get("iteration_paths")
                    trace = None if selected is None else selected.get("iteration_trace")
                    paths = None if wanted is None or trace is None else trace.path_chunk(wanted)
                    payload = dict(catalog=registry.catalog(scope, view), errors=registry.errors,
                        inspection=inspection, context=dict(inspection,
                            clock=clock, time_origin_s=raw.get("time_origin_s", 0),
                            joint_names=list(raw.get("joint_names", [f"arm_right_{i}_joint" for i in range(1, 8)])),
                            bounds=([states[0]["sim_time_s"], states[-1]["sim_time_s"]] if states else None)),
                        results=[])
                    if paths is not None:
                        # Top level: the context and inspection share selected_solve.
                        payload["iteration_paths"] = paths
                    # A Live segment records one record_every (execution setting); plans
                    # and intervals are always complete, states and commands may be thinned.
                    record_every = max((s.get("record_every", 1) for s in states[:1] + states[-1:]), default=1)
                    for plot in request.get("plots", []):
                        try:
                            spec = registry.evaluate(plot["plot_id"], view, plot.get("inputs", {}))
                            definition = registry.definitions[plot["plot_id"]]
                            if (scope == "episode" and record_every > 1 and spec.get("kind") != "unavailable" and
                                    {"states", "controls", "torque_samples"} & {*definition["requires"], *definition["optional"]}):
                                # Structured like display_reduction: the browser shows it on hover.
                                spec["recording"] = dict(record_every=record_every)
                            if scope == "solve" and selected is None:
                                spec = dict(version=1, kind="unavailable", title=spec.get("title", plot["plot_id"]),
                                            message="No recorded solve is associated with this selection.")
                            payload["results"].append(dict(instance_id=plot["instance_id"],
                                spec=reduce_spec(spec, request.get("pixels", 1200))))
                        except Exception as exc:
                            payload["results"].append(dict(instance_id=plot["instance_id"], error=str(exc)))
                    payload_bytes = len(json.dumps(payload, allow_nan=False, separators=(",", ":")).encode())
                    if payload_bytes > MAX_RESULT_BYTES:
                        raise ValueError("Plot payload exceeds 8 MiB; reduce the requested range, pixels or number of cards")
                    cache[key] = payload, payload_bytes
                    cache_bytes += payload_bytes
                    while len(cache) > 16 or cache_bytes > MAX_CACHE_BYTES:
                        _, (_, removed_bytes) = cache.popitem(last=False)
                        cache_bytes -= removed_bytes
                results.put(dict(type="result", job_id=job["job_id"], payload=payload, payload_bytes=payload_bytes))
            except Exception as exc:
                results.put(dict(type="result", job_id=job["job_id"], error=str(exc)))
    except BaseException as exc:
        results.put(dict(type="fatal", error=f"Plot worker: {type(exc).__name__}: {exc}"))


class PlotService:
    """One running request, a bounded coalescing pending set, retained job status.

    Requests from the same browser inspector replace its obsolete pending job.
    An obsolete in-flight result is discarded. Plugins only run in the spawned
    process; HTTP handlers snapshot small selectors and never read long history.
    """
    def __init__(self, mpc_root, config_path, default_scene, *, live=None, replays=None,
                 worker_target=_worker_main, timeout_s=30, inspections=None):
        from visualizer_config import load_visualizer_config
        self.mpc_root, self.config_path = Path(mpc_root), Path(config_path)
        self.override = load_visualizer_config(config_path).plotters_directory
        self.default_scene, self.live, self.replays = default_scene, live, replays
        self.worker_target, self.timeout_s = worker_target, timeout_s
        self.inspections = inspections
        self.lock = threading.RLock()
        self.pending, self.jobs = OrderedDict(), OrderedDict()
        self.active = None
        self.catalog, self.errors = [], []
        self.registry_revision = 0
        self.closed = False
        self._start_worker()
        self.thread = threading.Thread(target=self._pump, name="plot-coordinator", daemon=True)
        self.thread.start()

    def _start_worker(self):
        context = mp.get_context("spawn")
        self.commands, self.results = context.Queue(maxsize=1), context.Queue(maxsize=2)
        self.process = context.Process(target=run_with_parent,
            args=(os.getpid(), self.worker_target, self.commands, self.results, [str(ROOT/"plotters"), str(self.directory)],
                  str(self.mpc_root), self.default_scene), name="plot-cpu-compute", daemon=True)
        self.process.start()
        self.worker_available = True
        self.registry_revision += 1
        self.ready = False
        self.started_at = time.monotonic()

    @property
    def directory(self):
        return self.override or self.mpc_root/"_visualizer"

    def settings(self):
        with self.lock:
            return dict(directory=str(self.directory), override=None if self.override is None else str(self.override),
                        default_directory=str(self.mpc_root/"_visualizer"), bundled_directory=str(ROOT/"plotters"),
                        registry_revision=self.registry_revision, errors=deepcopy(self.errors), ready=self.ready)

    def update_settings(self, body):
        from visualizer_config import save_local_settings
        if not isinstance(body, dict) or set(body) - {"directory", "plotters_directory"}:
            raise ValueError("Plot settings require directory: null or a local Python plotting directory")
        value = body.get("directory", body.get("plotters_directory"))
        if value is not None and (not isinstance(value, str) or not value.strip() or "\x00" in value):
            raise ValueError("directory must be null or a nonempty local path")
        directory = Path(value).expanduser() if value is not None else None
        if directory is not None:
            if not directory.is_absolute():
                directory = self.config_path.parent/directory
            directory = directory.resolve()
        with self.lock:
            save_local_settings(self.config_path, plotters_directory=None if directory is None else str(directory))
            self.override = directory
            self._restart_locked("Plotting directory changed")
            return self.settings()

    def _stop_worker(self):
        self.worker_available = False
        if self.process.is_alive():
            self.process.terminate()
        self.process.join(timeout=2)
        if self.process.is_alive():
            self.process.kill()
            self.process.join(timeout=2)
        self.commands.cancel_join_thread()
        self.results.cancel_join_thread()
        self.commands.close()
        self.results.close()

    def _restart_locked(self, reason):
        for job in self.jobs.values():
            if job["state"] in ("pending", "running"):
                job.update(state="superseded", error=reason)
        self.pending.clear()
        self.active = None
        self._stop_worker()
        self.catalog, self.errors = [], []
        self._start_worker()

    def reload(self):
        with self.lock:
            self._restart_locked("Plot registry reloaded")
            return self.settings()

    def static_catalog(self, context=None):
        with self.lock:
            plots = deepcopy(self.catalog)
            if context:
                plots = [plot for plot in plots if plot.get("context", plot.get("scope")) == context]
            return dict(catalog=plots, plots=plots, **self.settings())

    def _descriptor(self, source):
        if source.get("kind") == "inspection":
            if set(source) != {"kind", "id"} or not isinstance(source.get("id"), str):
                raise ValueError("Inspection source requires exactly kind and retained result id")
            if self.inspections is None:
                raise ValueError("Solve inspection results are unavailable")
            return self.inspections.descriptor(source["id"])
        if source.get("kind") == "live":
            if self.live is None:
                raise ValueError("Live history is unavailable")
            descriptor = self.live.history_store.plot_source(source.get("generation"))
            if hasattr(self.live, "inspection_store"):
                descriptor["preview_source"] = self.live.inspection_store.plot_source(source.get("generation"))
            # A preview is a detached already-rendered record, never the active
            # native solver. Copy under the short latest-event lock only.
            with self.live.condition:
                preview = self.live.latest.get("plan")
                if "preview_source" not in descriptor and preview and preview.get("origin") == "preview":
                    descriptor["preview"] = deepcopy(preview)
            return descriptor
        if source.get("kind") != "replay":
            raise ValueError("Select Live generation or Replay catalog id")
        identifier = source.get("id", "default")
        if identifier == "default":
            return dict(kind="replay", id="default", revision="default")
        if self.replays is None:
            raise ValueError("Replay library is unavailable")
        # The watched catalog already validated this path. Do not scan/reload
        # NPZs or derive robot FK in an HTTP plotting request.
        with self.replays.lock:
            loaded = getattr(self.replays, "loaded", {}).get(identifier)
            path = loaded[2] if loaded is not None else self.replays.paths.get(identifier)
            cached = loaded[:2] if loaded is not None else self.replays.cache.get(identifier)
            if path is None or cached is None:
                raise ValueError("Recording was not found; refresh the replay library")
            signature, item = cached
            if item.get("status") != "ready":
                raise ValueError(item.get("error", "Recording unavailable"))
            requested = source.get("revision")
            if requested is not None and requested != item["revision"]:
                raise ValueError("Replay changed; explicitly reload the selected recording")
            return dict(kind="replay", id=identifier, path=str(path), signature=list(signature), revision=item["revision"])

    def submit(self, body, *, catalog=False):
        if not isinstance(body, dict) or body.get("context") not in ("episode", "solve"):
            raise ValueError("Plot context must be episode or solve")
        if not isinstance(body.get("source"), dict):
            raise ValueError("A source selector is required; browser history uploads are not accepted")
        request = deepcopy(body)
        if set(request)-{"context", "source", "selection", "range", "plots", "pixels", "client_id", "plot_id", "parameters", "instance_id", "limit_settings"}:
            raise ValueError("Unknown plot request fields")
        # The browser's current limit-state presentation settings (near band,
        # at-tolerances). Plotters read them through limit_settings(raw).
        from gato_visualizer.plotting.limit_use import validate_limit_settings
        request["limit_settings"] = validate_limit_settings(request.get("limit_settings"))
        if not isinstance(request.get("selection", {}), dict) or not isinstance(request.get("range", {}), dict):
            raise ValueError("selection and range must be objects")
        selected = request.get("selection", {})
        iteration = selected.get("iteration", selected.get("iteration_index"))
        if iteration is not None and iteration != "seed" and (type(iteration) is not int or iteration < 0):
            raise ValueError("SQP iteration must be null, seed, or an actual nonnegative integer index")
        paths = selected.get("iteration_paths")
        if paths is not None and (type(paths) is not int or paths < 0):
            raise ValueError("iteration_paths must be null or a nonnegative SQP iteration index")
        analysis = request.get("range", {})
        if analysis.get("mode", "entire") not in ("entire", "through_cursor", "visible", "window"):
            raise ValueError("Unknown episode analysis range")
        import math
        for key in ("cursor_s", "start_s", "end_s"):
            if key in analysis and (isinstance(analysis[key], bool) or not isinstance(analysis[key], (float, int)) or not math.isfinite(analysis[key])):
                raise ValueError(f"range.{key} must be a finite time")
        if analysis.get("mode") == "visible" and (analysis.get("start_s") is None or analysis.get("end_s") is None or analysis["start_s"] > analysis["end_s"]):
            raise ValueError("Visible range requires start_s <= end_s")
        # An aggregate window may omit either bound; omitted means unbounded.
        if analysis.get("mode") == "window" and analysis.get("start_s") is not None and analysis.get("end_s") is not None and analysis["start_s"] > analysis["end_s"]:
            raise ValueError("Aggregate window requires start_s <= end_s")
        if type(request.get("pixels", 1200)) is not int or not 16 <= request.get("pixels", 1200) <= 2000:
            raise ValueError("pixels must be an integer within [16,2000]")
        if "plot_id" in request:
            request["plots"] = [dict(instance_id=request.get("instance_id", "plot"), plot_id=request.pop("plot_id"), inputs=request.pop("parameters", {}))]
        request["plots"] = [] if catalog else request.get("plots", [])
        if not isinstance(request["plots"], list) or len(request["plots"]) > 32:
            raise ValueError("Request at most 32 plot instances")
        for plot in request["plots"]:
            if not isinstance(plot, dict) or not isinstance(plot.get("plot_id"), str) or not isinstance(plot.get("instance_id"), str) or not isinstance(plot.get("inputs", {}), dict):
                raise ValueError("Each plot requires instance_id, plot_id and inputs")
        descriptor = self._descriptor(request["source"])
        channel = str(request.get("client_id", "browser"))+":"+request["context"]+":"+("catalog" if catalog else "evaluate")
        with self.lock:
            if self.closed:
                raise ValueError("Plot service is closed")
            for job in self.jobs.values():
                if job["channel"] == channel and job["state"] in ("pending", "running"):
                    job["state"] = "superseded"
            self.pending.pop(channel, None)
            if len(self.pending) >= 32:
                _, displaced = self.pending.popitem(last=False)
                self.jobs[displaced]["state"] = "superseded"
            identifier = uuid.uuid4().hex
            self.jobs[identifier] = dict(job_id=identifier, id=identifier, state="pending", channel=channel,
                request=request, descriptor=descriptor, registry_revision=self.registry_revision,
                data_revision=(f"{descriptor['generation']}:{descriptor['cursor']}:"
                               f"{descriptor.get('preview_source', {}).get('cursor', 0)}"
                               if descriptor["kind"] == "live" else descriptor.get("revision")),
                generation=descriptor.get("generation"))
            self.pending[channel] = identifier
            while len(self.jobs) > 128:
                oldest = next((key for key, job in self.jobs.items() if job["state"] not in ("pending", "running")), None)
                if oldest is None:
                    break
                del self.jobs[oldest]
            return self.job(identifier)

    def job(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if job is None:
                raise KeyError("Plot job expired or was not found")
            if job["descriptor"]["kind"] == "live" and self.live is not None and job["descriptor"]["generation"] != self.live.generation:
                job["state"] = "superseded"
            return deepcopy({key: value for key, value in job.items() if key not in ("channel", "request", "descriptor", "started_at", "payload_bytes")})

    def _pump(self):
        while True:
            with self.lock:
                if self.closed:
                    return
                try:
                    packet = self.results.get_nowait() if self.worker_available else None
                except (queue.Empty, EOFError, OSError, ValueError):
                    packet = None
                if packet:
                    if packet["type"] == "ready":
                        self.catalog, self.errors, self.ready = packet["catalog"], packet["errors"], True
                    elif packet["type"] == "fatal":
                        self.errors = [packet["error"]]
                        for job in self.jobs.values():
                            if job["state"] in ("pending", "running"):
                                job.update(state="failed", error=packet["error"])
                        self.pending.clear()
                        self.active = None
                        self.ready = False
                        self._stop_worker()
                        self.started_at = float("inf")
                    elif packet["type"] == "result":
                        job = self.jobs.get(packet["job_id"])
                        if job and job["state"] == "running":
                            if "error" in packet:
                                job.update(state="failed", error=packet["error"])
                            else:
                                job.update(state="complete", payload_bytes=packet.get("payload_bytes", 0), **packet["payload"])
                                retained_bytes = sum(j.get("payload_bytes", 0) for j in self.jobs.values())
                                for old_id in list(self.jobs):
                                    if retained_bytes <= MAX_CACHE_BYTES:
                                        break
                                    old = self.jobs[old_id]
                                    if old_id != packet["job_id"] and old["state"] not in ("pending", "running"):
                                        retained_bytes -= old.get("payload_bytes", 0)
                                        del self.jobs[old_id]
                        if self.active == packet["job_id"]:
                            self.active = None
                if self.active:
                    job = self.jobs.get(self.active)
                    if not self.process.is_alive() or time.monotonic()-job["started_at"] > self.timeout_s:
                        if job["state"] == "running":
                            job.update(state="failed", error="Plot worker stopped or exceeded the CPU evaluation timeout")
                        self._restart_locked("Plot worker stopped or exceeded the CPU evaluation timeout")
                elif self.worker_available and not self.process.is_alive():
                    self.errors = ["Plot worker exited; reload the plot registry"]
                    self.ready = False
                    self._stop_worker()
                    for identifier in self.pending.values():
                        self.jobs[identifier].update(state="failed", error=self.errors[0])
                    self.pending.clear()
                    self.started_at = float("inf")
                elif self.worker_available and not self.ready and time.monotonic()-self.started_at > self.timeout_s:
                    self.errors = ["Plot registry initialization timed out; reload after fixing the plot module"]
                    self._stop_worker()
                    for identifier in self.pending.values():
                        self.jobs[identifier].update(state="failed", error=self.errors[0])
                    self.pending.clear()
                    # Remain available for explicit reload; do not respawn a bad import in a loop.
                    self.started_at = float("inf")
                if self.ready and self.active is None and self.pending:
                    _, identifier = self.pending.popitem(last=False)
                    job = self.jobs[identifier]
                    if job["state"] == "pending":
                        self.commands.put_nowait(dict(job_id=identifier, request=job["request"], descriptor=job["descriptor"]))
                        job.update(state="running", started_at=time.monotonic())
                        self.active = identifier
            time.sleep(.01)

    def close(self):
        with self.lock:
            self.closed = True
            self._stop_worker()
        self.thread.join(timeout=2)
