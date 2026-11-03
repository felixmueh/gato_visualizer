"""HTTP settings, worker lifecycle and record acceptance for spawned execution."""
from __future__ import annotations
from collections import deque
from copy import deepcopy
import json
import multiprocessing as mp
import os
from pathlib import Path
import queue
import threading
import time
import traceback

from execution_session import DEFAULT_EXECUTION, validate_anchor, validate_execution
from history_store import HistoryGenerationError, HistoryStore, NO_SEGMENT
from presentation_settings import DEFAULT_PRESENTATION, validate_presentation
from runtime_files import runtime_directory
from solver_lifecycle import run_with_parent
from execution_worker import estimated_states, MAX_STATES, worker_main

SHUTDOWN_GRACE_SECONDS = 10


class LiveFreezeConflict(ValueError):
    pass


class LiveSettingsConflict(ValueError):
    def __init__(self, settings):
        super().__init__("Settings changed")
        self.settings = settings


def merge_settings(current, patch):
    """Merge objects recursively; arrays, scalars and null replace values."""
    result = deepcopy(current)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_settings(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


class ProcessLiveService:
    """One persistent spawn worker, bounded IPC, lossless history, latest SSE.

    Settings and cancellation use a shared revision checked at solve/physics
    boundaries. Old-generation results cannot replace the current trajectory.
    """
    def __init__(self, mpc_root, adapter_factory=None, schema_factory=None,
                 worker_target=worker_main, render_factory=None, solver_profile=None,
                 report_hz=DEFAULT_PRESENTATION["report_hz"]):
        from record_ingestion import RecordIngestion, buffer_bytes
        ingestion_capacity = buffer_bytes()  # Reject invalid budgets before spawning anything.
        self.report_hz = validate_presentation(dict(DEFAULT_PRESENTATION, report_hz=report_hz))["report_hz"]
        self.mpc_root = Path(mpc_root).expanduser().resolve()
        if solver_profile is None:
            if adapter_factory is None:
                from source_runtime import resolve_selection
                selection = resolve_selection(self.mpc_root)
            else:
                import sys
                selection = dict(mpc_root=str(self.mpc_root), python=sys.executable,
                                 cache=None, effective_cache=None)
            solver_profile = dict(id="simulator", name="Simulator checkout", **selection)
        self.active_profile_id = solver_profile["id"]
        self.active_profile = deepcopy(solver_profile)
        self.profile_switch = dict(state="idle")
        self._profile_revision_floor = 0
        self.condition = threading.Condition()
        self.events = deque(maxlen=256)
        self.latest = {}
        self.segment = None  # the active generation's segment header
        self._unannounced_segment = None
        self.cursor = self.version = self.next_version = self.subscribers = 0
        self.generation = 0
        self._generation_start = dict(kind="current")
        self.closed = False
        self._freeze_epoch = 0
        self._freeze_interrupted = False
        self.context = mp.get_context("spawn")
        self.commands = self.context.Queue(maxsize=64)
        self.results = self.context.Queue(maxsize=8)
        self.revision = self.context.Value("q", 0)
        self.shutdown = self.context.Event()
        self._process = self.context.Process(target=run_with_parent,
            args=(os.getpid(), worker_target, self.mpc_root, self.commands, self.results, self.revision, self.shutdown,
                  adapter_factory, schema_factory, solver_profile, self.report_hz), name="live-mpc-compute", daemon=True)
        self._process.start()
        try:
            ready = self.results.get(timeout=60)
            if ready.get("kind") != "ready":
                raise RuntimeError(ready.get("message", "Numerical worker failed during setup"))
            self.schema = ready["schema"]
            self.schema['live_playback'] = dict(version=1)
            self.schema["compile_selection"] = {key: self.active_profile.get(key)
                for key in ("mpc_root", "python", "cache", "effective_cache")}
            self.schema["compile_profile_id"] = self.active_profile_id
            self.ingestion = RecordIngestion(self.context, self.results, capacity=ingestion_capacity)
        except BaseException:
            self.shutdown.set()
            self._process.join(timeout=3)
            if self._process.is_alive():
                self._process.terminate()
                self._process.join()
            raise
        self.config = deepcopy(self.schema["defaults"]["config"])
        self.task = deepcopy(self.schema["defaults"]["task"])
        self.execution = deepcopy(self.schema["defaults"].get("execution", DEFAULT_EXECUTION))
        self.source_settings = deepcopy(self.schema["defaults"].get("source_settings", dict(simulation={}, predictor={})))
        self.effective_settings = deepcopy(self.schema.get("effective_settings", {}))
        self.schema["execution"] = dict(defaults=deepcopy(self.execution),
            max_duration_s=120, max_states=MAX_STATES,
            rates_order=["simulation_hz", "control_hz", "to_hz"],
            solve_latency=dict(field="solve_latency_s", measured="measured", units="s", minimum=0),
            back_to_back_to_hz=0)
        # Runtime scratch on tmpfs (runtime_files); only the current run is kept.
        self.history_store = HistoryStore(runtime_directory("history"))
        self.inspection_store = HistoryStore(runtime_directory("solves"))
        # Called with the new generation when a run stops being current (Run again results).
        self.generation_listeners = []
        if render_factory is None:
            from live_presentation import LiveRenderer
            render_factory = LiveRenderer
        self.renderer = render_factory(self.mpc_root)
        self._preview_requested = False
        self.publish(dict(type="status", state="idle", message="Live MPC ready; connect to preview",
                          settings_version=0, generation=0, N=self.config["N"], dt_s=self.config["dt_s"],
                          job_active=False, calculation=self.execution["calculation"]))
        self.publish(self._history_metadata())
        self.thread = threading.Thread(target=self._receive, name="live-mpc-history", daemon=True)
        self.thread.start()

    def publish(self, event):
        self.publish_events([event])

    def publish_events(self, events):
        with self.condition:
            for event in events:
                self.cursor += 1
                self.events.append((self.cursor, event))
                if event["type"] in ("status", "segment", "plan", "state", "history"):
                    self.latest[event["type"]] = event
            self.condition.notify_all()

    def subscribe(self):
        with self.condition:
            self.subscribers += 1
            if not self._preview_requested:
                self._preview_requested = True
                self.commands.put_nowait(dict(type="preview", token=self.revision.value,
                                               generation=self.generation, settings_version=self.version,
                                               bridge_command_epoch=self._freeze_epoch + 1))
                self._freeze_epoch += 1
            return self.cursor, [dict(type="settings", **self.settings_snapshot()),
                                 *[self.latest[k] for k in ("status", "segment", "plan", "state", "history") if k in self.latest]]

    def unsubscribe(self):
        with self.condition:
            self.subscribers = max(0, self.subscribers-1)
            stop = not self.subscribers and self.execution["calculation"] == "on_play"
        if stop and not self.closed:
            self.command(dict(type="pause"))

    def read_events(self, cursor, timeout=1):
        with self.condition:
            self.condition.wait_for(lambda: self.closed or self.cursor > cursor, timeout=timeout)
            return self.cursor, [event for seq, event in self.events if seq > cursor]

    def _reset_stores(self):
        """A new generation: the previous run stops being current (under the condition)."""
        self.history_store.reset(self.generation)
        self.inspection_store.reset(self.generation)
        self.history_store.complete = False
        self._freeze_interrupted = False
        for listener in self.generation_listeners:
            listener(self.generation)

    def _history_metadata(self):
        return dict(self.history_store.metadata(), settings_version=self.version)

    def history(self, generation, after=0, limit=256):
        return self.history_store.page(generation, after, limit)

    def history_json(self, generation, after=0, limit=256):
        return self.history_store.page_json(generation, after, limit)

    def playback_json(self, generation, after=0, limit=256):
        return self.history_store.page_json(generation, after, limit, playback=True)

    def plans_json(self, generation, identifiers):
        return self.history_store.plans_json(generation, identifiers)

    def _check_freeze(self, generation):
        if generation != self.generation:
            raise HistoryGenerationError(f"History changed; current generation={self.generation}")
        status = self.latest.get("status", {})
        if (self.closed or self.profile_switch["state"] == "switching" or status.get("job_active") or
                status.get("state", "paused") not in ("idle", "paused", "error") or
                status.get("generation", generation) != generation or
                status.get("settings_version", self.version) != self.version or
                status.get("bridge_command_epoch", 0) < self._freeze_epoch):
            raise LiveFreezeConflict("A Live job or settings change is active; wait for it to finish before freezing")

    def freeze(self, generation, writer, publish):
        """Export a stable idle prefix, then publish only if it is still current.

        `writer(records, complete)` returns an owned file. Neither JSON reading
        nor compression blocks command handling or the history receiver.
        """
        from live_freeze import committed_records
        if type(generation) is not int or generation < 0:
            raise ValueError("Freeze requires one nonnegative integer generation")
        with self.condition:
            self._check_freeze(generation)
            epoch = self._freeze_epoch
            prefix = self.history_store.open_committed_prefix(generation)
            # History's complete means the requested endpoint was reached, even
            # when that endpoint is also a breaching tick. Freeze describes the
            # current stop: breach/cancel remains incomplete until Play resumes.
            prefix["complete"] = prefix["complete"] and not getattr(self, "_freeze_interrupted", False)
        path = None
        try:
            with prefix["reader"] as reader:
                records = committed_records(reader, byte_end=prefix["byte_end"], cursor=prefix["cursor"])
                path = writer(records, prefix["complete"])
            with self.condition:
                self._check_freeze(generation)
                if epoch != self._freeze_epoch or len(self.history_store.offsets) != prefix["cursor"]:
                    raise LiveFreezeConflict("History changed while freezing; try again when Live is idle")
                return publish(path)
        except BaseException:
            if path is not None:
                Path(path).unlink(missing_ok=True)
            raise

    def set_report_hz(self, report_hz):
        report_hz = validate_presentation(dict(DEFAULT_PRESENTATION, report_hz=report_hz))["report_hz"]
        with self.condition:
            # Preferences remain saveable if the numerical worker is absent.
            if not self.closed and self._process.is_alive():
                try:
                    self.commands.put_nowait(dict(type="set_report_hz", report_hz=report_hz))
                except queue.Full:
                    raise ValueError("Command queue full; wait for the current solve to return") from None
            self.report_hz = report_hz

    def switch_solver_profile(self, profile, anchor=None):
        anchor = validate_anchor(anchor)
        with self.condition:
            if self.closed or not self._process.is_alive():
                raise ValueError("Numerical coordinator is unavailable")
            if self.profile_switch["state"] == "switching":
                raise ValueError("A solver profile switch is in progress")
            if self.commands.full():
                raise ValueError("Command queue full; wait for the current solve to return")
            with self.revision.get_lock():
                self.revision.value += 1
            self.profile_switch = dict(state="switching", profile_id=profile["id"])
            self._profile_revision_floor = self.revision.value
            self._preview_requested = True
            request = dict(type="switch_solver_profile", profile=deepcopy(profile), anchor=anchor,
                token=self.revision.value, generation=self.generation, target_generation=self.generation+1,
                settings_version=self.version, config=deepcopy(self.config), task=deepcopy(self.task),
                execution=deepcopy(self.execution), source_settings=deepcopy(self.source_settings),
                previous_profile_id=self.active_profile_id)
            self.commands.put_nowait(request)
            self.publish(dict(type="status", state="paused", message="Switching solver profile",
                generation=self.generation, settings_version=self.version, job_active=False))

    def refresh_compiled(self, selection, probe):
        """After a Build, list the new modules without a restart (Felix, 2026-10-23).

        A Build into the active solver's own checkout, interpreter and cache only adds
        modules, which the child finds with find_binary at its next configure. Updates
        the available N here, in the coordinator, and in the browser (a compiled_modules
        event). Returns False, changing nothing, for another selection, a changed source
        identity or an incompatible probe: those still need Apply and its restart."""
        from live_mpc import available_modules, source_identity
        keys = ("mpc_root", "python", "effective_cache")
        if not probe.get("compatible"):
            return False
        available = available_modules(probe)
        source = (dict(deepcopy(probe["source"]), mpc_root=str(selection["mpc_root"])) if "source" in probe else
                  source_identity(Path(selection["mpc_root"]).expanduser().resolve()))
        with self.condition:
            active = self.active_profile
            if (self.closed or not self._process.is_alive() or self.profile_switch["state"] == "switching" or
                    any(str(active.get(key)) != str(selection.get(key)) for key in keys) or
                    source != self.schema.get("source")):
                return False
            if self.schema.get("exact_availability") or probe.get("exact_availability"):
                # The build may belong to an unaccepted browser draft. Refresh
                # the accepted model, never label its running history as that draft.
                from source_runtime import probe_selection
                from live_mpc import mpc_params
                role = self.schema["source_settings"]["predictor"]
                accepted = probe_selection(active, params=mpc_params(self.config),
                    source_settings=self.source_settings["predictor"], source_settings_module=role.get("module"))
                if not accepted.get("compatible"):
                    return False
                available = available_modules(accepted)
            try:
                self.commands.put_nowait(dict(type="refresh_compiled", **deepcopy(available)))
            except queue.Full:
                return False
            self.schema.update(deepcopy(available))
            for spec in self.schema["parameters"]:
                if spec["path"] == "N":
                    spec["choices"] = list(available["available_N"])
            self.publish(dict(type="compiled_modules", **deepcopy(available)))
        return True

    def pause_for_inspection(self, identifier, timeout=15):
        """Pause at a committed chunk boundary, preserving controller/session state."""
        with self.condition:
            if self.closed or self.profile_switch["state"] == "switching":
                raise ValueError("Live is unavailable or switching solver profiles")
            if self.commands.full():
                raise ValueError("Live command queue is busy")
            token = self.revision.value
            self.commands.put_nowait(dict(type="inspection_pause", token=token,
                inspection_id=identifier, generation=self.generation, settings_version=self.version))
            ready = self.condition.wait_for(lambda: self.closed or self.revision.value != token or
                self.latest.get("status", {}).get("inspection_pause_id") == identifier, timeout=timeout)
            if not ready or self.closed or self.revision.value != token:
                raise ValueError("Live did not reach an inspection pause boundary; try again when idle")

    def settings_snapshot(self):
        """Accepted settings, read without subscribing or scheduling numerical work."""
        with self.condition:
            return dict(config=deepcopy(self.config), task=deepcopy(self.task),
                        execution=deepcopy(self.execution), source_settings=deepcopy(getattr(self, "source_settings", dict(simulation={}, predictor={}))),
                        effective_settings=deepcopy(getattr(self, "effective_settings", {})),
                        available_N=deepcopy(self.schema.get("available_N", [])),
                        available_N_by_friction=deepcopy(self.schema.get("available_N_by_friction", {})),
                        exact_availability=bool(self.schema.get("exact_availability")), settings_version=self.version,
                        generation=self.generation)

    def command(self, command):
        # Merge, validation and acceptance share the lock: disjoint client patches
        # cannot overwrite one another and a rejected patch changes nothing.
        with self.condition:
            return self._command_locked(command)

    def _command_locked(self, command):
        from live_mpc import validate_settings, validate_source_settings, mpc_params, available_modules
        if not isinstance(command, dict):
            raise ValueError("Live command must be a JSON object")
        kind = command.get("type")
        allowed = {"set_settings": {"type", "config", "task", "execution", "source_settings", "anchor", "reset", "expected_settings_version"},
                   "patch_settings": {"type", "patch", "anchor", "reset", "expected_settings_version"},
                   "precalculate": {"type", "anchor"}, "preview": {"type", "anchor"}, "play": {"type"},
                   "pause": {"type"}, "cancel": {"type"}, "reset": {"type"}}
        if kind not in allowed or not set(command) <= allowed[kind]:
            raise ValueError("Unknown live command or unexpected command fields")
        request = deepcopy(command)
        presentation_only = False
        if kind in ("set_settings", "patch_settings"):
            if "expected_settings_version" in request:
                expected = request.pop("expected_settings_version")
                if type(expected) is not int or expected < 0:
                    raise ValueError("expected_settings_version must be a nonnegative integer")
                if expected != self.version:
                    raise LiveSettingsConflict(self.settings_snapshot())
        if kind == "patch_settings":
            patch = request.pop("patch", None)
            if (not isinstance(patch, dict) or not patch or
                    set(patch) - {"config", "task", "execution", "source_settings"} or
                    any(not isinstance(value, dict) for value in patch.values())):
                raise ValueError("patch requires config, task, execution or source_settings objects")
            presentation_only = (set(patch) == {"execution"} and
                                 set(patch["execution"]) == {"continue_at_end"} and
                                 not {"anchor", "reset"}.intersection(request))
            current = dict(config=self.config, task=self.task, execution=self.execution,
                           source_settings=getattr(self, "source_settings", dict(simulation={}, predictor={})))
            task_kind = patch.get("task", {}).get("kind", self.task["kind"])
            if task_kind != self.task["kind"]:
                descriptor = next((task for task in self.schema["tasks"] if task["kind"] == task_kind), None)
                if descriptor is None:
                    raise ValueError("Unknown task kind")
                current["task"] = descriptor["defaults"]
            request.update(merge_settings(current, patch))
            request["type"] = kind = "set_settings"
        checked_model = None
        if kind == "set_settings":
            if "reset" in request and not isinstance(request["reset"], bool):
                raise ValueError("reset must be a boolean")
            if request.get("reset") and request.get("anchor") is not None:
                raise ValueError("Choose reset or an anchor, not both")
            if not {"config", "task"} <= set(request):
                raise ValueError("set_settings requires config and task")
            exact_model = bool(self.schema.get("exact_availability") or
                               (isinstance(request["config"], dict) and "armature" in request["config"]))
            request["config"], request["task"] = validate_settings(request["config"], request["task"], self.schema,
                                                                  check_available=not exact_model)
            request["source_settings"] = validate_source_settings(self.schema, request.get("source_settings",
                getattr(self, "source_settings", None)))
            if exact_model and not presentation_only:
                from source_runtime import probe_selection
                role = self.schema["source_settings"]["predictor"]
                checked_model = probe_selection(self.active_profile, params=mpc_params(request["config"]),
                    source_settings=request["source_settings"]["predictor"], source_settings_module=role.get("module"))
                if not checked_model.get("compatible"):
                    raise ValueError(checked_model.get("error", "Predictor settings could not be resolved"))
                if checked_model["effective_settings"]["params"]["N"] not in checked_model["available_N"]:
                    raise ValueError(f"Not compiled: N={checked_model['effective_settings']['params']['N']} for the requested predictor settings. "
                                     "Build this exact model in Settings › Backend (Build selected N).")
            request["execution"] = validate_execution(request.get("execution", self.execution))
            if request["execution"]["calculation"] == "automatic" and estimated_states(request["execution"]) > MAX_STATES:
                raise ValueError(f"Requested rates/duration exceed {MAX_STATES} stored states; reduce duration or rates")
        if "anchor" in command:
            request["anchor"] = validate_anchor(command["anchor"])
        with self.condition:
            if self.closed:
                raise ValueError("Live service is closed")
            if self.profile_switch["state"] == "switching":
                raise ValueError("A solver profile switch is in progress")
            if not self._process.is_alive():
                raise ValueError("Numerical worker stopped; restart the server")
            if presentation_only:
                # This is the browser's tip-extension preference, not a change to
                # generated motion. Sharing it must not discard history or solve.
                self.execution = request["execution"]
                self.publish(dict(type="settings", **self.settings_snapshot()))
                return self.next_version
            if kind == "precalculate" or (kind == "play" and self.execution["calculation"] != "on_play"):
                retained = self.history_store.state_count if kind == "play" else 0
                if retained+estimated_states(self.execution) > MAX_STATES:
                    raise ValueError(f"Requested calculation exceeds {MAX_STATES} stored states; reduce rates/duration or reset")
            # Queue saturation is rejected before changing visible generations.
            if self.commands.full():
                raise ValueError("Command queue full; wait for the current solve to return")
            # A new start pose starts a new run at t = 0 from it, as Reset; an anchor
            # sent with it is not used (Felix, 2026-10-23).
            new_start = (kind == "set_settings" and request["config"]["plant"]["start_pose_rad"] !=
                         self.config["plant"]["start_pose_rad"])
            if kind == "set_settings":
                self.next_version += 1
                self.version = self.next_version
                self.config, self.task, self.execution = request["config"], request["task"], request["execution"]
                self.source_settings = deepcopy(request["source_settings"])
                if checked_model is not None:
                    self.schema.update(available_modules(checked_model))
                    self.effective_settings = merge_settings(getattr(self, "effective_settings", {}),
                                                             checked_model.get("effective_settings", {}))
                    self.schema["effective_settings"] = deepcopy(self.effective_settings)
                    for spec in self.schema["parameters"]:
                        if spec["path"] == "N":
                            spec["choices"] = list(self.schema["available_N"])
            # Pause is playback-only during explicit precalculation. It must not
            # invalidate a manual/automatic job; Cancel is the separate control.
            if kind == "pause" and self.execution["calculation"] != "on_play":
                return self.next_version
            # Pause parks the current native invocation, preserving its pending
            # plan and controller. Replacement/cancellation permanently ends it.
            if kind not in ("play", "pause"):
                with self.revision.get_lock():
                    self.revision.value += 1
            if kind in ("set_settings", "reset", "precalculate"):
                if kind == "reset" or (kind == "set_settings" and (request.get("reset") or new_start)):
                    self._generation_start = dict(kind="reset")
                elif request.get("anchor") is not None:
                    self._generation_start = dict(kind="anchor", anchor=deepcopy(request["anchor"]))
                else:
                    tip = self.latest.get("state")
                    self._generation_start = (dict(kind="anchor", anchor={key: deepcopy(tip[key]) for key in ("sim_time_s", "q", "qd")})
                                              if tip and all(key in tip for key in ("sim_time_s", "q", "qd")) else dict(kind="current"))
                self.generation += 1
                self._reset_stores()
                for key in ("segment", "plan", "state"):
                    self.latest.pop(key, None)
                if kind == "set_settings":
                    self.publish(dict(type="settings", **self.settings_snapshot()))
                self.publish(self._history_metadata())
            request.update(token=self.revision.value, generation=self.generation, settings_version=self.version,
                           config=deepcopy(self.config), task=deepcopy(self.task), execution=deepcopy(self.execution),
                           source_settings=deepcopy(getattr(self, "source_settings", dict(simulation={}, predictor={}))),
                           generation_start=deepcopy(self._generation_start), bridge_command_epoch=self._freeze_epoch + 1)
            self.commands.put_nowait(request)
            self._freeze_epoch += 1
            if kind == "cancel":
                self._freeze_interrupted = True
            elif kind in ("play", "precalculate"):
                self._freeze_interrupted = False
            return self.next_version

    def _receive(self):
        ingestion = getattr(self, 'ingestion', None)
        ingestion_failed = False
        while True:
            try:
                packet = (ingestion or self.results).get(timeout=.1)
            except EOFError:
                if not self.closed:
                    self.publish(dict(type='error', message='Numerical worker exited; restart the server'))
                return
            except queue.Empty:
                if not self._process.is_alive():
                    if ingestion is not None:
                        ingestion.finish()
                        if ingestion.process.is_alive():
                            continue
                    if not self.closed:
                        self.publish(dict(type="error", message="Numerical worker exited; restart the server"))
                    if ingestion_failed:
                        self.ingestion.reclaim_abandoned(self._process.pid)
                    return
                if ingestion is not None and not ingestion.process.is_alive():
                    if not self.closed:
                        self.publish(dict(type='error', message='Recording ingestion exited; restart the server'))
                        self.shutdown.set()
                    # Once ingestion is dead, this thread owns its input queue.
                    # Keep draining locators until numerical shutdown completes.
                    ingestion_failed = True
                    ingestion = None
                continue
            if self.closed or ingestion_failed:
                from solver_exchange import discard_records
                discard_records(packet.get('records', ()))
                continue
            try:
                kind = packet.get("kind")
                if kind in ("profile_activated", "profile_failed"):
                    with self.condition:
                        if packet.get("token") != self.revision.value:
                            continue
                        identifier = packet["profile"]["id"]
                        if kind == "profile_activated":
                            self.generation = packet["generation"]
                            self._reset_stores()
                            self._generation_start = dict(kind="current")
                            for key in ("segment", "plan", "state"):
                                self.latest.pop(key, None)
                            self.active_profile_id = identifier
                            self.active_profile = deepcopy(packet["profile"])
                            self.profile_switch = dict(state="idle")
                            for key in ("available_N", "available_N_by_friction", "supported_N", "exact_availability", "parameters", "friction", "source", "source_settings"):
                                if key in packet["schema"]:
                                    self.schema[key] = deepcopy(packet["schema"][key])
                            self.schema["compile_selection"] = {key: self.active_profile.get(key)
                                for key in ("mpc_root", "python", "cache", "effective_cache")}
                            self.schema["compile_profile_id"] = self.active_profile_id
                            self.source_settings = deepcopy(packet.get("source_settings", self.source_settings))
                            self.effective_settings = deepcopy(packet.get("effective_settings", {}))
                            self.schema["effective_settings"] = deepcopy(self.effective_settings)
                            self.publish(dict(type="settings", **self.settings_snapshot()))
                            self.publish_events([dict(type="solver_profile", state="active",
                                profile_id=identifier, generation=self.generation,
                                switch_revision=self._profile_revision_floor), self._history_metadata()])
                        else:
                            self.active_profile_id = packet.get("active_profile_id")
                            self.profile_switch = dict(state="failed", profile_id=identifier, error=packet["message"])
                            self.publish(dict(type="solver_profile", state="failed", profile_id=identifier,
                                generation=self.generation, active_profile_id=self.active_profile_id,
                                switch_revision=self._profile_revision_floor, error=packet["message"]))
                    continue
                # A queued record from the replaced solver cannot enter either
                # history while the activation transaction is in progress.
                if (self.profile_switch["state"] == "switching" or
                        packet.get("token", -1) < self._profile_revision_floor):
                    from solver_exchange import discard_records
                    discard_records(packet.get('records', ()))
                    continue
                if kind == "resolved_settings":
                    with self.condition:
                        if packet.get("generation") == self.generation and packet.get("token") == self.revision.value:
                            self.source_settings = deepcopy(packet["source_settings"])
                            self.effective_settings = deepcopy(packet["effective_settings"])
                            self.schema["effective_settings"] = deepcopy(self.effective_settings)
                            self.publish(dict(type="settings", **self.settings_snapshot()))
                    continue
                if kind == "resolved_settings":
                    with self.condition:
                        if packet.get("generation") == self.generation and packet.get("token") == self.revision.value:
                            self.source_settings = deepcopy(packet["source_settings"])
                            self.effective_settings = deepcopy(packet["effective_settings"])
                            self.schema["effective_settings"] = deepcopy(self.effective_settings)
                            self.publish(dict(type="settings", **self.settings_snapshot()))
                    continue
                if kind == "failure":
                    with self.condition:
                        if packet.get("generation") == self.generation and packet.get("token") == self.revision.value:
                            self.publish(dict(type="error", generation=packet.get("generation"),
                                              message=packet["message"], detail=packet.get("detail")))
                    continue
                if packet.get("generation") != self.generation:
                    from solver_exchange import discard_records
                    discard_records(packet.get('records', ()))
                    continue
                if kind == 'ingestion_failure':
                    if packet.get('token') == self.revision.value:
                        raise RuntimeError(packet['message'])
                    continue
                if kind == "records":
                    from solver_exchange import resolve_record, discard_records
                    captured_records = []
                    try:
                        for record in packet['records']:
                            captured_records.append(resolve_record(record))
                    except BaseException:
                        discard_records(packet['records'][len(captured_records):])
                        raise
                    records = []
                    latest_plan = latest_state = segment = None
                    for record in captured_records:
                        if record["type"] == "segment":
                            segment = record
                        elif record["type"] == "plan":
                            record = self.renderer((record, None, ()), self._context(packet["generation"], segment))[0]
                            latest_plan = record
                        elif record["type"] == "state":
                            record = self.renderer((None, record, ()), self._context(packet["generation"], segment))[0]
                            latest_state = record
                        record["generation"] = packet["generation"]
                        record.setdefault("settings_version", self.version)
                        records.append(record)
                    encoded_records = self.history_store.encode(records)
                    with self.condition:
                        if (packet["generation"] != self.generation or
                                packet.get("token", -1) < self._profile_revision_floor):
                            continue
                        self.history_store.append_encoded(encoded_records)
                        self.history_store.complete = packet.get("complete", False)
                        if segment:
                            self.segment = self.latest["segment"] = self._unannounced_segment = segment
                            if "effective_settings" in segment["context"]:
                                self.effective_settings = deepcopy(segment["context"]["effective_settings"])
                                self.schema["effective_settings"] = deepcopy(self.effective_settings)
                        # History is independent of the latest-value SSE display.
                        # Every record remains queryable even when SSE coalesces.
                        if latest_plan:
                            self.latest["plan"] = latest_plan
                        if latest_state:
                            self.latest["state"] = latest_state
                        # A report may span several bounded IPC messages. Commit
                        # every record, announce the newest tip only at its end.
                        if packet.get("report_end", True):
                            events = [self._history_metadata(), *filter(None, [self._unannounced_segment])]
                            self._unannounced_segment = None
                            events.extend(self.latest[key] for key in ("plan", "state") if key in self.latest)
                            self.publish_events(events)
                elif kind == "events":
                    if packet.get("token") != self.revision.value:
                        continue
                    with self.condition:
                        if packet.get("generation") != self.generation or packet.get("token") != self.revision.value:
                            continue
                        rendered_events = []
                        inspection_records = []
                        for event in packet["events"]:
                            if event.get("type") == "plan" and "_states" in event:
                                event = self.renderer((event, None, ()), self._context(self.generation))[0]
                                event["generation"] = self.generation
                                if event.get("origin") == "preview":
                                    inspection_records.append(event)
                            rendered_events.append(event)
                            if "complete" in event:
                                self.history_store.complete = bool(event["complete"])
                            if event.get("type") == "status" and event.get("breach"):
                                self._freeze_interrupted = True
                        if inspection_records:
                            # Previews read their context from the same segment header.
                            self.inspection_store.append(([] if self.inspection_store.segment else [self.segment]) +
                                                         inspection_records)
                        # Routine progress follows the report already announced
                        # above; avoid requesting the same history prefix twice.
                        self.publish_events(rendered_events if packet.get("progress") else
                                            [*rendered_events, self._history_metadata()])
                elif kind == "complete":
                    with self.condition:
                        if packet.get("generation") != self.generation or packet.get("token") != self.revision.value:
                            continue
                        self.history_store.complete = True
                        self.publish(self._history_metadata())
            except Exception as exc:
                # Presentation/storage failure must not kill the IPC drainer
                # and strand a numerical worker behind a full bounded queue.
                self.publish(dict(type="error", message=f"Live history: {exc}",
                                  detail=traceback.format_exc()))
                try:
                    self.command(dict(type="cancel"))
                except (ValueError, queue.Full):
                    pass

    def _context(self, generation, segment=None):
        """The context of a plan or state of generation: its segment header's."""
        header = segment or self.segment
        if header is None or header["generation"] != generation:
            raise ValueError(NO_SEGMENT)
        return header["context"]

    def close(self):
        with self.condition:
            self.closed = True
            self.shutdown.set()
            with self.revision.get_lock():
                self.revision.value += 1
            self.condition.notify_all()
        self.ingestion.begin_close()
        # Pause/cancel remain cooperative. Explicit backend shutdown is bounded
        # even if native work is stuck. The child has a parent-death guard and
        # borrowed lease FDs keep GPU locks held until child cleanup completes.
        self._process.join(timeout=SHUTDOWN_GRACE_SECONDS)
        if self._process.is_alive():
            directory = runtime_directory("coordinator-lifecycle")
            (directory / f"shutdown-{time.time_ns()}.json").write_text(json.dumps(dict(
                reason=f"Explicit backend shutdown exceeded {SHUTDOWN_GRACE_SECONDS}s cooperative grace",
                coordinator_pid=self._process.pid, active_profile_id=self.active_profile_id,
                generation=self.generation, settings_version=self.version)) + "\n")
            self._process.terminate()
            self._process.join(timeout=2)
            if self._process.is_alive():
                self._process.kill()
                self._process.join(timeout=2)
        self.ingestion.finish()
        self.thread.join(timeout=2)
        self.ingestion.close()
        self.ingestion.reclaim_abandoned(self._process.pid)
        self.history_store.close()
        self.inspection_store.close()
        self.commands.close()
        self.results.close()
