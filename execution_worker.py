"""Persistent simulation coordinator; owns plant clocks and history reporting.

SimulatorAdapter calls a separate solver child that owns controller/CUDA state.
This process holds the GPU leases; neither owner runs in the HTTP process.
Every controller.reset here is a reseed: mpc.warmup in the child (GATO's warm-up
solve unless MpcParams.warmup is off), never a plan or part of an interval's timing.
"""
from __future__ import annotations
from copy import deepcopy
import queue
import time
import traceback
import numpy as np

from execution_session import DEFAULT_EXECUTION, MultirateSession
from presentation_settings import DEFAULT_PRESENTATION, validate_presentation

MAX_STATES = 250000
RECORD_INTERVAL_S = 1 / DEFAULT_PRESENTATION["report_hz"]
MAX_PACKET_RECORDS = 256


class CompletedRecords:
    """Batch detached, committed records outside numerical timing boundaries.

    The wall deadline is opportunistic; commands and terminal statuses flush
    immediately. Reports are split into bounded IPC packets without changing the cadence.
    Publication deliberately ignores revision changes, like committed intervals
    did before batching; the receiver owns generation rejection.
    """
    def __init__(self, emit, clock=time.monotonic, report_hz=DEFAULT_PRESENTATION["report_hz"]):
        self.emit, self.clock = emit, clock
        self.records = []
        self.identity = None
        self.last_flush = clock()
        self.set_report_hz(report_hz)

    def set_report_hz(self, report_hz):
        self.interval = 1 / validate_presentation(dict(DEFAULT_PRESENTATION, report_hz=report_hz))["report_hz"]

    def flush(self, complete=False):
        if not self.records:
            return
        generation, token = self.identity
        records, self.records = self.records, []
        for offset in range(0, len(records), MAX_PACKET_RECORDS):
            last = offset + MAX_PACKET_RECORDS >= len(records)
            self.emit(dict(kind="records", generation=generation, token=token,
                           records=records[offset:offset+MAX_PACKET_RECORDS],
                           report_end=last, complete=complete and last))
        self.last_flush = self.clock()

    def append(self, records, generation, token, complete=False):
        identity = (generation, token)
        if self.identity != identity:
            self.flush()
            self.identity = identity
        self.records.extend(records)
        if complete or self.clock()-self.last_flush >= self.interval:
            self.flush(complete=complete)


def estimated_states(execution, duration=None):
    """Recorded states, safely overestimated (MultirateSession's recording rule):
    every command tick plus the end of every call (TO boundaries, the job end);
    summing the tick counts overestimates when the grids coincide."""
    span = execution["duration_s"] if duration is None else duration
    return 2+int(np.ceil(span*(execution["control_hz"]+execution["to_hz"])))


def worker_main(mpc_root, commands, results, revision, shutdown, adapter_factory=None, schema_factory=None, solver_profile=None, report_hz=DEFAULT_PRESENTATION["report_hz"]):
    from live_mpc import build_schema, GPULocks
    from live_presentation import mutable
    from solver_adapter import SimulatorAdapter
    locks = GPULocks(mpc_root)
    adapter = session = None
    generation = version = 0
    token = 0
    config = task = execution = None
    job = None
    need_config = True
    initialized_generation = None
    initial_time = 0.
    history_complete = False
    generation_start = dict(kind="current")
    state_count = 0
    last_busy = 0.
    next_progress = 0.
    last_metrics = dict(calculation_rtf=0., mpc_hz=0., control_hz=0., simulation_hz=0.)

    def current(expected=None):
        return not shutdown.is_set() and (expected is None or revision.value == expected)

    def emit(message, expected=None):
        while current(expected):
            try:
                results.put(message, timeout=.1)
                return True
            except queue.Full:
                pass
        return False

    def status(state, message, *, flush_records=True, **extra):
        if flush_records:
            completed.flush()
        if config is None:
            return
        elapsed = max(0., (adapter.t if adapter else 0.)-initial_time)
        cost = session.compute_wall if session else 0.
        wall = max(time.monotonic()-job["wall"], 1e-12) if job else 0.
        job_elapsed = max(0., (adapter.t if adapter else 0.)-job["sim"]) if job else elapsed
        if job and session and wall:
            last_metrics.update(calculation_rtf=job_elapsed/wall,
                                mpc_hz=(session.solves-job.get("solves", 0))/wall,
                                control_hz=(session.control_updates-job.get("controls", 0))/wall,
                                simulation_hz=(session.steps-job.get("steps", 0))/wall)
        job_active_override = extra.pop("job_active_override", job is not None)
        event = dict(type="status", state=state, message=message,
                     generation=generation, settings_version=version, N=config["N"], dt_s=config["dt_s"],
                     calculation=execution["calculation"], job_active=job_active_override,
                     history_end_s=float(adapter.t) if adapter else 0.,
                     requested_end_s=job["end"] if job else None,
                     progress=(min(1., job_elapsed/max(job["end"]-job["sim"], 1e-12))
                               if job and job["end"] is not None else None),
                     compute_rtf=elapsed/cost if cost else 0., **last_metrics, **extra)
        emit(dict(kind="events", generation=generation, token=token, events=[event],
                  progress=not flush_records), token)

    completed = CompletedRecords(emit, clock=time.monotonic, report_hz=report_hz)

    def apply_anchor(anchor):
        nonlocal session
        if anchor is not None:
            adapter.x = np.r_[anchor["q"], anchor["qd"]].astype(float)
            adapter.t = float(anchor["sim_time_s"])
            adapter.applied_torque = None
        adapter.sequence = 0
        session = None

    def ensure_adapter():
        nonlocal adapter, need_config
        if adapter is None:
            adapter = (adapter_factory or SimulatorAdapter)(mpc_root)
            adapter.gpu_locks = locks
            if adapter_factory is None:
                adapter.select_profile(solver_profile, schema)
        if need_config:
            if initialized_generation != generation and generation_start.get("kind") == "reset":
                # Configuring seeds the controller from the current state. A
                # failed run's tip may be beyond the solver's float32 range,
                # so Reset discards it before, not after, reconfiguring.
                adapter.reset_state()
            adapter.configure(config, task)
            need_config = False

    def initialize_history():
        nonlocal session, initialized_generation, initial_time, state_count, history_complete
        if initialized_generation == generation:
            return
        if generation_start.get("kind") == "reset":
            adapter.reset_state()
            apply_anchor(None)
        else:
            apply_anchor(generation_start.get("anchor"))
        adapter.controller.reset(adapter.x)
        history_complete = False
        initial_time = float(adapter.t)
        session = MultirateSession(adapter, execution, version)
        # The segment's constant context, once, before its first state.
        emit(dict(kind="records", generation=generation, token=token,
                  records=[adapter.segment_header(version, execution), session.initial_state()], complete=False), token)
        initialized_generation = generation
        state_count = 1

    try:
        if schema_factory is not None:
            schema = schema_factory(mpc_root)
        else:
            # The fixed simulator imports only Python model/plant helpers.
            # Binary loading/ABI discovery stays in an independent interpreter.
            from source_runtime import probe_selection
            schema = build_schema(probe_selection({key: solver_profile[key] for key in ("mpc_root", "python", "cache")}),
                                  mpc_root)
        config = deepcopy(schema["defaults"]["config"])
        task = deepcopy(schema["defaults"]["task"])
        execution = deepcopy(schema["defaults"].get("execution", DEFAULT_EXECUTION))
        emit(dict(kind="ready", schema=schema))
        pending = None
        while not shutdown.is_set():
            try:
                command = pending or (commands.get_nowait() if job else commands.get(timeout=.1))
                pending = None
            except queue.Empty:
                command = None
            committed = None
            try:
                if command is not None:
                    kind = command["type"]
                    if kind == "refresh_compiled":
                        # A Build added modules for the active solver: no revision,
                        # job, lock or controller change (ProcessLiveService.refresh_compiled).
                        available = {key: command[key] for key in ("available_N", "available_N_by_friction")}
                        if adapter is None:  # the startup profile, selected with schema later
                            schema.update(deepcopy(available))
                        elif getattr(adapter, "profile_schema", None) is not None:
                            adapter.profile_schema = dict(adapter.profile_schema, **deepcopy(available))
                        continue
                    if kind == "set_report_hz":
                        completed.set_report_hz(command["report_hz"])
                        next_progress = time.monotonic() + completed.interval
                        # Presentation preferences never touch revision, jobs,
                        # GPU locks, controller configuration or history epochs.
                        continue
                    incoming_token = command.get("token", revision.value)
                    if incoming_token != revision.value:
                        continue
                    completed.flush()
                    token = incoming_token
                    if kind == "shutdown":
                        break
                    generation = command.get("generation", generation)
                    generation_start = command.get("generation_start", generation_start)
                    incoming_version = command.get("settings_version", version)
                    if incoming_version != version and "config" in command:
                        config, task = deepcopy(command["config"]), deepcopy(command["task"])
                        execution = deepcopy(command["execution"])
                        need_config = True
                    version = incoming_version
                    if kind == "switch_solver_profile":
                        job = None
                        session = None
                        # Finish the old invocation before replacing its process;
                        # the revision has already cancelled its publication.
                        while not locks.acquire() and current(token):
                            shutdown.wait(.05)
                        if not current(token):
                            continue
                        saved_state = None
                        replaced_child = False
                        try:
                            if adapter is None:
                                adapter = (adapter_factory or SimulatorAdapter)(mpc_root)
                            adapter.gpu_locks = locks
                            saved_state = (adapter.x.copy(), adapter.t, adapter.applied_torque, adapter.sequence)
                            profile_schema = adapter.preflight_profile(command["profile"], config, task)
                            anchor = command.get("anchor")
                            if anchor is not None:
                                apply_anchor(anchor)
                            adapter.applied_torque = None
                            replaced_child = True
                            adapter.select_profile(command["profile"], profile_schema)
                            need_config = True
                            ensure_adapter()
                            # Stage reset and first state before committing the
                            # new generation. A failed child/reset leaves the
                            # previous history descriptor and bytes untouched.
                            adapter.sequence = 0
                            adapter.controller.reset(adapter.x)
                            staged_session = MultirateSession(adapter, execution, version)
                            first_records = [adapter.segment_header(version, execution), staged_session.initial_state()]
                            generation = command["target_generation"]
                            initialized_generation = generation
                            generation_start = dict(kind="current")
                            session = staged_session
                            initial_time, state_count = float(adapter.t), 1
                            history_complete = False
                            emit(dict(kind="profile_activated", token=token, generation=generation,
                                profile=command["profile"], schema=adapter.profile_schema), token)
                            emit(dict(kind="records", generation=generation, token=token,
                                records=first_records, complete=False), token)
                            status("paused", "Solver profile selected; simulator state retained", complete=False)
                        except Exception as exc:
                            if replaced_child and adapter is not None and hasattr(adapter, "close_solver"):
                                adapter.close_solver()
                            if saved_state is not None:
                                adapter.x, adapter.t, adapter.applied_torque, adapter.sequence = saved_state
                            need_config = True
                            emit(dict(kind="profile_failed", token=token, generation=generation,
                                profile=command["profile"], message=str(exc),
                                active_profile_id=None if replaced_child else command.get("previous_profile_id")), token)
                            status("paused", f"Solver switch failed: {exc}; history retained", complete=history_complete)
                        finally:
                            locks.release()
                        continue
                    if kind == "inspection_pause":
                        # No revision invalidation, rollback, reset, or plant step.
                        # A completed batch remains committed; private controller
                        # and multirate session remain ready for the next Play.
                        job = None
                        locks.release()
                        status("paused", "Live calculation paused for solve inspection",
                               inspection_pause_id=command["inspection_id"],
                               job_active_override=False, complete=history_complete)
                        continue
                    if kind in ("pause", "cancel"):
                        if kind == "cancel" or execution["calculation"] == "on_play":
                            job = None
                            locks.release()
                            if session is not None:
                                interval = session.flush_interval()
                                if interval is not None:
                                    emit(dict(kind="records", generation=generation, token=token,
                                              records=[interval], complete=False), token)
                            status("paused", "Calculation paused; existing history retained",
                                   complete=history_complete and initialized_generation == generation)
                        continue
                    if kind == "set_settings":
                        config, task = deepcopy(command["config"]), deepcopy(command["task"])
                        execution = deepcopy(command["execution"])
                        need_config = True
                        initialized_generation = None
                        job = None
                    elif kind in ("reset", "precalculate"):
                        initialized_generation = None
                        job = None
                    # Wait for shared GPU locks cooperatively. A newer setting can
                    # supersede this work without ever constructing CUDA buffers.
                    while not locks.acquire() and current(token):
                        if time.monotonic()-last_busy > 1:
                            status("gpu_busy", "Experiment GPU locks are held; waiting without solving")
                            last_busy = time.monotonic()
                        shutdown.wait(.05)
                    if not current(token):
                        continue
                    ensure_adapter()
                    if not current(token):
                        continue
                    if kind == "preview" and command.get("anchor") is not None:
                        # Inspect a scrubbed state without branching or moving
                        # the authoritative history tip. Preview never starts
                        # automatic closed-loop calculation.
                        initialize_history()
                        saved = (adapter.x.copy(), adapter.t,
                                 None if adapter.applied_torque is None else adapter.applied_torque.copy())
                        anchor = command["anchor"]
                        adapter.x = np.r_[anchor["q"], anchor["qd"]].astype(float)
                        adapter.t = float(anchor["sim_time_s"])
                        try:
                            plan = mutable(adapter.solve_snapshot("preview", version))
                        finally:
                            adapter.x, adapter.t, adapter.applied_torque = saved
                            adapter.controller.reset(adapter.x)
                        job = None
                        session = None
                        if current(token):
                            emit(dict(kind="events", generation=generation, token=token, events=[plan]), token)
                            status("paused", "Prediction inspected at displayed state; history retained")
                        locks.release()
                        continue
                    initialize_history()
                    if kind in ("set_settings", "reset", "preview"):
                        plan = mutable(adapter.solve_snapshot("preview", version))
                        if not current(token):
                            continue
                        if kind in ("set_settings", "reset"):
                            history_complete = not (kind == "set_settings" and execution["calculation"] == "automatic")
                        emit(dict(kind="records", generation=generation, token=token,
                                  records=[plan], complete=history_complete), token)
                        session = None  # Preview is not the controller's first Play step.
                        if kind == "set_settings" and execution["calculation"] == "automatic":
                            job = dict(paced=False, end=adapter.t+execution["duration_s"],
                                       wall=time.monotonic(), sim=adapter.t, solves=0, controls=0, steps=0)
                        else:
                            job = None
                            status("paused", "Preview ready; history uses simulation timestamps", complete=history_complete)
                            locks.release()
                    elif kind in ("play", "precalculate"):
                        if kind == "play" and job is not None:
                            # A repeated Play request must not restart pacing,
                            # controller state or the active recording.
                            status("playing" if job["paced"] else "calculating", "Calculation is already running", complete=False)
                            continue
                        if session is None:
                            adapter.controller.reset(adapter.x)
                            session = MultirateSession(adapter, execution, version)
                        paced = kind == "play" and execution["calculation"] == "on_play"
                        job = dict(paced=paced, end=None if paced else adapter.t+execution["duration_s"],
                                   wall=time.monotonic(), sim=adapter.t, solves=0, controls=0, steps=0)
                    if job:
                        history_complete = False
                        if session is None:
                            adapter.controller.reset(adapter.x)
                            session = MultirateSession(adapter, execution, version)
                            job["wall"] = time.monotonic()  # the reseed's warm-up is no calculation
                        job.update(solves=session.solves, controls=session.control_updates, steps=session.steps)
                        status("playing" if job["paced"] else "calculating", "Computing closed-loop MPC motion", complete=False)
                if job is None or not current(token):
                    continue
                if job["paced"]:
                    due = job["wall"]+(adapter.t-job["sim"])
                    # Waits remain interruptible and outside execution timings.
                    remaining = due-time.monotonic()
                    if remaining > 0:
                        try:
                            pending = commands.get(timeout=min(remaining, .05))
                        except queue.Empty:
                            pass
                        continue
                # Keep a committed native snapshot: cancellation during a physics
                # interval must never move the authoritative tip invisibly.
                committed = (adapter.x.copy(), adapter.t, adapter.sequence,
                             None if adapter.applied_torque is None else adapter.applied_torque.copy())
                # Keep numerical batches bounded even for very slow TO rates.
                # This does not change the nominal TO/control grids.
                batch_end = min(job["end"] if job["end"] is not None else float("inf"), session.chunk_end(.1))
                batch = session.advance_interval(batch_end, cancelled=lambda: not current(token),
                            emit_partial=job["end"] is not None and batch_end >= job["end"]-1e-12)
                if not current(token):
                    completed.flush()
                    adapter.x, adapter.t, adapter.sequence, adapter.applied_torque = committed
                    interval = session.flush_interval()
                    if interval is not None:
                        emit(dict(kind="records", generation=generation, token=token,
                                  records=[interval], complete=False))
                    adapter.controller.reset(adapter.x)
                    session = None
                    job = None
                    continue
                state_count += sum(record["type"] == "state" for record in batch)
                complete = (job["end"] is not None and adapter.t >= job["end"]-1e-12)
                capacity = not job["paced"] and state_count >= MAX_STATES
                # The numerical interval is committed now. Finish delivering
                # all bounded chunks even if Pause arrives during IPC; a newer
                # generation discards them at the receiver. This prevents a
                # partially published interval from moving the native tip back.
                completed.append(batch, generation, token, complete=complete)
                severity = next((r["severity"] for r in reversed(batch) if r["type"] == "interval"), "none")
                breach = next((r for r in batch if r["type"] == "breach"), None)
                if breach is not None:
                    # Stop on limit breach: the session ended at the breaching tick and
                    # stays ready, so Play continues from there (Felix, 2026-10-23).
                    history_complete = complete
                    status("paused", breach["message"], complete=complete, severity=severity,
                           breach=dict(sim_time_s=breach["sim_time_s"], breaches=breach["breaches"]),
                           job_active_override=False)
                    job = None
                    locks.release()
                elif complete or capacity:
                    history_complete = complete
                    status("paused", "History capacity reached; requested duration was not completed" if capacity and not complete else "Precalculation complete",
                           complete=complete, severity=severity, capacity_reached=capacity, job_active_override=False)
                    job = None
                    locks.release()
                else:
                    # Every interval is retained for lossless history. Progress
                    # is latest-value UI telemetry, not another 100+ Hz stream
                    # that can back up the same bounded results queue.
                    now = time.monotonic()
                    if now >= next_progress and not completed.records:
                        status("playing" if job["paced"] else "calculating", "Computing closed-loop MPC motion",
                               complete=False, severity=severity, flush_records=False)
                        next_progress = now + completed.interval
            except Exception as exc:
                completed.flush()
                if committed is not None:
                    adapter.x, adapter.t, adapter.sequence, adapter.applied_torque = committed
                history_complete = False
                job = None
                session = None
                need_config = True
                locks.release()
                emit(dict(kind="failure", generation=generation, token=token,
                          message=str(exc), detail=traceback.format_exc()), token)
                status("error", str(exc), complete=False)
    except BaseException as exc:
        completed.flush()
        emit(dict(kind="failure", generation=generation, token=token,
                  message=str(exc), detail=traceback.format_exc()))
    finally:
        completed.flush()
        if adapter is not None:
            # Destruction may release CUDA allocations, so it shares the same
            # experiment window as creation/solving.
            while not locks.acquire():
                time.sleep(.05)
            if hasattr(adapter, "close_solver"):
                adapter.close_solver()
            adapter = None
        locks.release()
