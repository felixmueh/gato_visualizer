"""Responsive HTTP bridge and lossless disk-backed history for spawned execution."""
from __future__ import annotations
from collections import deque
from copy import deepcopy
import json
import multiprocessing as mp
from pathlib import Path
import queue
import threading
import time
import traceback

from execution_session import DEFAULT_EXECUTION, MAX_RECORD_EVERY, validate_anchor, validate_execution
from presentation_settings import DEFAULT_PRESENTATION, validate_presentation
from execution_worker import estimated_states, MAX_STATES, worker_main

SHUTDOWN_GRACE_SECONDS = 10
MAX_HISTORY_PAGE_RECORDS = 2048

class HistoryGenerationError(ValueError):
    pass


class HistoryStore:
    """Append-only JSONL; bounded pages and a compact byte-offset index.

    Completed and superseded generations remain in the owning checkout's
    ignored data directory. HTTP never waits for a GPU/native solver call.
    """
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.generation = 0
        self.lock = threading.RLock()
        self.stream = None
        self.reset(0)

    def reset(self, generation):
        with self.lock:
            if self.stream:
                self.stream.close()
            self.generation = generation
            self.offsets = []
            self.plan_offsets = {}
            self.state_count = 0
            self.end_time = 0.
            self.complete = True
            self.path = self.directory / f"history-{time.time_ns()}-g{generation}.jsonl"
            self.stream = self.path.open("w+b")

    @staticmethod
    def plan_identity(record):
        identifier = str(record.get("id", record.get("seq")))
        return f"preview:{identifier}" if record.get("origin") == "preview" else identifier

    @staticmethod
    def encode(records):
        return [(json.dumps(record, allow_nan=False, separators=(",", ":")).encode()+b"\n",
                 float(record.get("sim_time_s", record.get("end_time_s", 0))), record.get("type") == "state",
                 HistoryStore.plan_identity(record) if record.get("type") == "plan" else None) for record in records]

    def append(self, records):
        self.append_encoded(self.encode(records))

    def append_encoded(self, encoded_records):
        encoded_records = list(encoded_records)
        if not encoded_records:
            return
        # Assemble the packet before taking the store lock. The receiver already
        # encoded each record outside the Live lock; file I/O is one batch, not
        # one buffered write/tell pair per physics state.
        payload = b"".join(record[0] for record in encoded_records)
        relative_offsets, plans = [], []
        offset = state_count = 0
        end_time = 0.
        for index, (encoded, timestamp, is_state, plan_id) in enumerate(encoded_records):
            relative_offsets.append(offset)
            if plan_id is not None:
                plans.append((plan_id, index, offset, len(encoded)))
            offset += len(encoded)
            state_count += is_state
            end_time = max(end_time, timestamp)
        with self.lock:
            start = self.stream.tell()
            self.stream.write(payload)
            self.stream.flush()
            cursor = len(self.offsets)
            self.offsets.extend(start + offset for offset in relative_offsets)
            for identifier, index, offset, size in plans:
                self.plan_offsets.setdefault(identifier, (cursor + index, start + offset, size))
            self.end_time = max(self.end_time, end_time)
            self.state_count += state_count

    def metadata(self):
        with self.lock:
            return dict(type="history", generation=self.generation, history_cursor=len(self.offsets),
                        history_end_s=self.end_time, complete=self.complete)

    def plot_source(self, generation):
        """Capture only committed storage identity; plotting reads outside locks."""
        with self.lock:
            if generation != self.generation:
                raise HistoryGenerationError(f"History changed; current generation={self.generation}")
            return dict(kind="live", generation=generation, path=str(self.path),
                        cursor=len(self.offsets), byte_end=self.stream.tell(),
                        complete=self.complete)

    def _page_encoded(self, generation, after, limit):
        # Snapshot one bounded committed byte window, then read outside locks.
        # Superseded files remain readable; later appends cannot enter this page.
        with self.lock:
            if generation != self.generation:
                raise HistoryGenerationError(f"History changed; current generation={self.generation}")
            if (type(after) is not int or type(limit) is not int or
                    not 0 <= after <= len(self.offsets) or not 1 <= limit <= MAX_HISTORY_PAGE_RECORDS):
                raise ValueError(f"after must be an existing history cursor; limit must be within [1,{MAX_HISTORY_PAGE_RECORDS}]")
            stop = min(after+limit, len(self.offsets))
            path = self.path
            offset = self.offsets[after] if stop > after else None
            end = self.offsets[stop] if stop < len(self.offsets) else self.stream.tell()
            complete, end_time = self.complete, self.end_time
        records = []
        if offset is not None:
            with path.open("rb") as reader:
                reader.seek(offset)
                encoded = reader.read(end-offset)
            records = encoded.split(b"\n")[:-1]
            if len(encoded) != end-offset or not encoded.endswith(b"\n") or len(records) != stop-after:
                raise ValueError("Committed Live history page is incomplete")
        return dict(generation=generation, next_cursor=stop, complete=complete,
                    records=records, history_end_s=end_time)

    def page(self, generation, after, limit):
        page = self._page_encoded(generation, after, limit)
        page["records"] = [json.loads(record) for record in page["records"]]
        return page

    def page_json(self, generation, after, limit):
        """Reuse validated JSONL records without decoding and re-encoding them."""
        page = self._page_encoded(generation, after, limit)
        head = {key: page[key] for key in ("generation", "next_cursor", "complete")}
        encode = lambda value: json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
        return (encode(head)[:-1] + b',"records":[' + b",".join(page["records"]) + b'],' +
                encode(dict(history_end_s=page["history_end_s"]))[1:])

    def selected_plan(self, descriptor, identifier):
        """Read one retained plan, never scan/decode unrelated physics states."""
        if type(identifier) not in (str, int) or not str(identifier):
            raise ValueError("Select a retained solve id")
        identifier = str(identifier)
        with self.lock:
            if (type(descriptor.get("generation")) is not int or
                    descriptor["generation"] != self.generation or descriptor.get("path") != str(self.path)):
                raise HistoryGenerationError(f"History changed; current generation={self.generation}")
            cursor, byte_end = descriptor.get("cursor"), descriptor.get("byte_end")
            if (descriptor.get("kind") != "live" or type(cursor) is not int or
                    not 0 <= cursor <= len(self.offsets) or type(byte_end) is not int):
                raise ValueError("Invalid committed Live history prefix")
            expected_end = self.offsets[cursor] if cursor < len(self.offsets) else self.stream.tell()
            if byte_end != expected_end:
                raise ValueError("Invalid committed Live history prefix")
            indexed = self.plan_offsets.get(identifier)
            if indexed is None or indexed[0] >= cursor or indexed[1] + indexed[2] > byte_end:
                raise ValueError("Selected solve is not retained in this source")
            _, offset, size = indexed
            path = self.path
        # Keep disk I/O and JSON decoding out of the append/metadata lock. A
        # concurrently superseded file remains retained, like history pages.
        with path.open("rb") as reader:
            reader.seek(offset)
            encoded = reader.read(size)
        if len(encoded) != size or not encoded.endswith(b"\n"):
            raise ValueError("Committed Live history prefix is incomplete")
        plan = json.loads(encoded)
        if not isinstance(plan, dict) or plan.get("type") != "plan" or self.plan_identity(plan) != identifier:
            raise ValueError("Selected retained solve identity changed")
        return plan

    def close(self):
        if self.stream:
            self.stream.close()


class ProcessLiveService:
    """One persistent spawn worker, bounded IPC, lossless history, latest SSE.

    Settings and cancellation use a shared revision checked at solve/physics
    boundaries. Old-generation results cannot replace the current trajectory.
    """
    def __init__(self, mpc_root, adapter_factory=None, schema_factory=None,
                 worker_target=worker_main, render_factory=None, solver_profile=None,
                 report_hz=DEFAULT_PRESENTATION["report_hz"]):
        self.report_hz = validate_presentation(dict(DEFAULT_PRESENTATION, report_hz=report_hz))["report_hz"]
        self.mpc_root = Path(mpc_root).expanduser().resolve()
        if solver_profile is None:
            if adapter_factory is None:
                from source_runtime import resolve_selection
                import os
                selection = resolve_selection(self.mpc_root, cache=os.environ.get("GATO_CACHE_DIR"))
            else:
                import sys
                selection = dict(mpc_root=str(self.mpc_root), python=sys.executable,
                                 cache=str(self.mpc_root / ".cache/gato"))
            solver_profile = dict(id="simulator", name="Simulator checkout", **selection)
        self.active_profile_id = solver_profile["id"]
        self.active_profile = deepcopy(solver_profile)
        self.profile_switch = dict(state="idle")
        self._profile_revision_floor = 0
        self.condition = threading.Condition()
        self.events = deque(maxlen=256)
        self.latest = {}
        self.cursor = self.version = self.next_version = self.subscribers = 0
        self.generation = 0
        self._generation_start = dict(kind="current")
        self.closed = False
        self.context = mp.get_context("spawn")
        self.commands = self.context.Queue(maxsize=64)
        self.results = self.context.Queue(maxsize=8)
        self.revision = self.context.Value("q", 0)
        self.shutdown = self.context.Event()
        self._process = self.context.Process(target=worker_target,
            args=(self.mpc_root, self.commands, self.results, self.revision, self.shutdown,
                  adapter_factory, schema_factory, solver_profile, self.report_hz), name="live-mpc-compute", daemon=True)
        self._process.start()
        try:
            ready = self.results.get(timeout=60)
            if ready.get("kind") != "ready":
                raise RuntimeError(ready.get("message", "Numerical worker failed during setup"))
            self.schema = ready["schema"]
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
        self.schema["execution"] = dict(defaults=deepcopy(self.execution),
            max_duration_s=120, max_states=MAX_STATES, max_record_every=MAX_RECORD_EVERY,
            rates_order=["simulation_hz", "control_hz", "to_hz"])
        self.history_store = HistoryStore(Path(__file__).resolve().parent / "_expr_data/live/history")
        self.inspection_store = HistoryStore(Path(__file__).resolve().parent / "_expr_data/live/solves")
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
                if event["type"] in ("status", "plan", "state", "history"):
                    self.latest[event["type"]] = event
            self.condition.notify_all()

    def subscribe(self):
        with self.condition:
            self.subscribers += 1
            if not self._preview_requested:
                self._preview_requested = True
                self.commands.put_nowait(dict(type="preview", token=self.revision.value,
                                               generation=self.generation, settings_version=self.version))
            return self.cursor, [self.latest[k] for k in ("status", "plan", "state", "history") if k in self.latest]

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

    def _history_metadata(self):
        return dict(self.history_store.metadata(), settings_version=self.version)

    def history(self, generation, after=0, limit=256):
        return self.history_store.page(generation, after, limit)

    def history_json(self, generation, after=0, limit=256):
        return self.history_store.page_json(generation, after, limit)

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
                execution=deepcopy(self.execution), previous_profile_id=self.active_profile_id)
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
        from live_mpc import build_schema
        keys = ("mpc_root", "python", "cache")
        if not probe.get("compatible"):
            return False
        schema = build_schema(probe, selection["mpc_root"])
        with self.condition:
            active = self.active_profile
            if (self.closed or not self._process.is_alive() or self.profile_switch["state"] == "switching" or
                    any(str(active.get(key)) != str(selection.get(key)) for key in keys) or
                    schema["source"] != self.schema.get("source")):
                return False
            available = dict(available_N=schema["available_N"], available_N_by_friction=schema["available_N_by_friction"])
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

    def command(self, command):
        from live_mpc import validate_settings
        if not isinstance(command, dict):
            raise ValueError("Live command must be a JSON object")
        kind = command.get("type")
        allowed = {"set_settings": {"type", "config", "task", "execution", "anchor", "reset"},
                   "precalculate": {"type", "anchor"}, "preview": {"type", "anchor"}, "play": {"type"},
                   "pause": {"type"}, "cancel": {"type"}, "reset": {"type"}}
        if kind not in allowed or not set(command) <= allowed[kind]:
            raise ValueError("Unknown live command or unexpected command fields")
        request = deepcopy(command)
        if kind == "set_settings":
            if "reset" in command and not isinstance(command["reset"], bool):
                raise ValueError("reset must be a boolean")
            if command.get("reset") and command.get("anchor") is not None:
                raise ValueError("Choose reset or an anchor, not both")
            if not {"config", "task"} <= set(command):
                raise ValueError("set_settings requires config and task")
            request["config"], request["task"] = validate_settings(command["config"], command["task"], self.schema)
            request["execution"] = validate_execution(command.get("execution", self.execution))
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
            if kind == "precalculate" or (kind == "play" and self.execution["calculation"] != "on_play"):
                retained = self.history_store.state_count if kind == "play" else 0
                if retained+estimated_states(self.execution) > MAX_STATES:
                    raise ValueError(f"Requested calculation exceeds {MAX_STATES} stored states; reduce rates/duration or reset")
            # Queue saturation is rejected before changing visible generations.
            if self.commands.full():
                raise ValueError("Command queue full; wait for the current solve to return")
            if kind == "set_settings":
                self.next_version += 1
                self.version = self.next_version
                self.config, self.task, self.execution = request["config"], request["task"], request["execution"]
            # Pause is playback-only during explicit precalculation. It must not
            # invalidate a manual/automatic job; Cancel is the separate control.
            if kind == "pause" and self.execution["calculation"] != "on_play":
                return self.next_version
            if kind != "play":
                with self.revision.get_lock():
                    self.revision.value += 1
            if kind in ("set_settings", "reset", "precalculate"):
                if kind == "reset" or (kind == "set_settings" and request.get("reset")):
                    self._generation_start = dict(kind="reset")
                elif request.get("anchor") is not None:
                    self._generation_start = dict(kind="anchor", anchor=deepcopy(request["anchor"]))
                else:
                    tip = self.latest.get("state")
                    self._generation_start = (dict(kind="anchor", anchor={key: deepcopy(tip[key]) for key in ("sim_time_s", "q", "qd")})
                                              if tip and all(key in tip for key in ("sim_time_s", "q", "qd")) else dict(kind="current"))
                self.generation += 1
                self.history_store.reset(self.generation)
                self.inspection_store.reset(self.generation)
                self.history_store.complete = False
                self.latest.pop("plan", None)
                self.latest.pop("state", None)
                self.publish(self._history_metadata())
            request.update(token=self.revision.value, generation=self.generation, settings_version=self.version,
                           config=deepcopy(self.config), task=deepcopy(self.task), execution=deepcopy(self.execution),
                           generation_start=deepcopy(self._generation_start))
            self.commands.put_nowait(request)
            return self.next_version

    def _receive(self):
        while not (self.closed and not self._process.is_alive()):
            try:
                packet = self.results.get(timeout=.1)
            except queue.Empty:
                if not self._process.is_alive() and not self.closed:
                    self.publish(dict(type="error", message="Numerical worker exited; restart the server"))
                    return
                continue
            if self.closed:
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
                            self.history_store.reset(self.generation)
                            self.inspection_store.reset(self.generation)
                            self.history_store.complete = False
                            self._generation_start = dict(kind="current")
                            self.latest.pop("state", None)
                            self.latest.pop("plan", None)
                            self.active_profile_id = identifier
                            self.active_profile = deepcopy(packet["profile"])
                            self.profile_switch = dict(state="idle")
                            for key in ("available_N", "available_N_by_friction", "parameters", "friction", "source"):
                                self.schema[key] = deepcopy(packet["schema"][key])
                            self.publish_events([dict(type="solver_profile", state="active",
                                profile_id=identifier, generation=self.generation), self._history_metadata()])
                        else:
                            self.active_profile_id = packet.get("active_profile_id")
                            self.profile_switch = dict(state="failed", profile_id=identifier, error=packet["message"])
                            self.publish(dict(type="solver_profile", state="failed", profile_id=identifier,
                                generation=self.generation, active_profile_id=self.active_profile_id, error=packet["message"]))
                    continue
                # A queued record from the replaced solver cannot enter either
                # history while the activation transaction is in progress.
                if (self.profile_switch["state"] == "switching" or
                        packet.get("token", -1) < self._profile_revision_floor):
                    continue
                if kind == "failure":
                    with self.condition:
                        if packet.get("generation") == self.generation and packet.get("token") == self.revision.value:
                            self.publish(dict(type="error", generation=packet.get("generation"),
                                              message=packet["message"], detail=packet.get("detail")))
                    continue
                if packet.get("generation") != self.generation:
                    continue
                if kind == "records":
                    records = []
                    latest_plan = latest_state = None
                    for record in packet["records"]:
                        if record["type"] == "plan":
                            record = self.renderer((record, None, ()))[0]
                            latest_plan = record
                        elif record["type"] == "state":
                            record = self.renderer((None, record, ()))[0]
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
                        # History is independent of the latest-value SSE display.
                        # Every record remains queryable even when SSE coalesces.
                        if latest_plan:
                            self.latest["plan"] = latest_plan
                        if latest_state:
                            self.latest["state"] = latest_state
                        # A report may span several bounded IPC messages. Commit
                        # every record, announce the newest tip only at its end.
                        if packet.get("report_end", True):
                            events = [self._history_metadata()]
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
                                event = self.renderer((event, None, ()))[0]
                                event["generation"] = self.generation
                                if event.get("origin") == "preview":
                                    inspection_records.append(event)
                            rendered_events.append(event)
                            if "complete" in event:
                                self.history_store.complete = bool(event["complete"])
                        if inspection_records:
                            self.inspection_store.append(inspection_records)
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

    def close(self):
        with self.condition:
            self.closed = True
            self.shutdown.set()
            with self.revision.get_lock():
                self.revision.value += 1
            self.condition.notify_all()
        # Pause/cancel remain cooperative. Explicit backend shutdown is bounded
        # even if native work is stuck. The child has a parent-death guard and
        # borrowed lease FDs keep GPU locks held until child cleanup completes.
        self._process.join(timeout=SHUTDOWN_GRACE_SECONDS)
        if self._process.is_alive():
            directory = Path(__file__).resolve().parent / "_expr_data/live/coordinator-lifecycle"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f"shutdown-{time.time_ns()}.json").write_text(json.dumps(dict(
                reason=f"Explicit backend shutdown exceeded {SHUTDOWN_GRACE_SECONDS}s cooperative grace",
                coordinator_pid=self._process.pid, active_profile_id=self.active_profile_id,
                generation=self.generation, settings_version=self.version)) + "\n")
            self._process.terminate()
            self._process.join(timeout=2)
            if self._process.is_alive():
                self._process.kill()
                self._process.join(timeout=2)
        self.thread.join(timeout=2)
        self.history_store.close()
        self.inspection_store.close()
        self.commands.close()
        self.results.close()
