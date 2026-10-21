"""Spawned numerical worker. No CUDA/controller object enters the HTTP process."""
from __future__ import annotations
from copy import deepcopy
from pathlib import Path
import json
import queue
import time
import traceback
import numpy as np

from execution_session import DEFAULT_EXECUTION, MultirateSession

MAX_STATES = 250000


def estimated_states(execution, duration=None):
    # Integration splits at physics, control and TO grids; summing tick counts
    # safely overestimates endpoints even when grids coincide.
    span = execution["duration_s"] if duration is None else duration
    return 1+int(np.ceil(span*(execution["simulation_hz"]+execution["control_hz"]+execution["to_hz"])))


def worker_main(mpc_root, commands, results, revision, shutdown, adapter_factory=None, schema_factory=None, solver_profile=None):
    from live_mpc import build_schema, GPULocks, ROOT
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

    def status(state, message, **extra):
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
        emit(dict(kind="events", generation=generation, token=token, events=[event]), token)

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
            if adapter_factory is None:
                adapter.select_profile(solver_profile)
        if need_config:
            folder = ROOT / "_expr_data/live/configs"
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f"config-{time.time_ns()}-v{version}.json"
            path.write_text(json.dumps(config, indent=2, allow_nan=False)+"\n")
            adapter.configure(path, task)
            need_config = False

    def initialize_history():
        nonlocal session, initialized_generation, initial_time, state_count, history_complete
        if initialized_generation == generation:
            return
        if generation_start.get("kind") == "reset":
            adapter.reset_state(reset_controller=False)
            apply_anchor(None)
        else:
            apply_anchor(generation_start.get("anchor"))
        adapter.controller.reset(adapter.x*adapter.state_signs)
        adapter.restarted = True
        history_complete = False
        initial_time = float(adapter.t)
        session = MultirateSession(adapter, execution, version)
        emit(dict(kind="records", generation=generation, token=token,
                  records=[session.initial_state()], complete=False), token)
        initialized_generation = generation
        state_count = 1

    try:
        if schema_factory is not None:
            schema = schema_factory(mpc_root)
        else:
            # The fixed simulator imports only Python model/plant helpers.
            # Binary loading/ABI discovery stays in an independent interpreter.
            from source_runtime import probe_selection
            selection = {key: solver_profile[key] for key in ("mpc_root", "python", "cache")}
            discovered = probe_selection(selection)
            schema = build_schema(mpc_root, available_n=discovered["available_N"])
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
                    token = command.get("token", revision.value)
                    if token != revision.value:
                        continue
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
                        try:
                            if adapter is None:
                                adapter = (adapter_factory or SimulatorAdapter)(mpc_root)
                            saved_state = (adapter.x.copy(), adapter.t, adapter.applied_torque, adapter.sequence)
                            anchor = command.get("anchor")
                            if anchor is not None:
                                apply_anchor(anchor)
                            adapter.select_profile(command["profile"])
                            need_config = True
                            ensure_adapter()
                            # Stage reset and first state before committing the
                            # new generation. A failed child/reset leaves the
                            # previous history descriptor and bytes untouched.
                            adapter.sequence = 0
                            adapter.controller.reset(adapter.x * adapter.state_signs)
                            staged_session = MultirateSession(adapter, execution, version)
                            first_state = staged_session.initial_state()
                            generation = command["target_generation"]
                            initialized_generation = generation
                            generation_start = dict(kind="current")
                            session = staged_session
                            initial_time, state_count = float(adapter.t), 1
                            history_complete = False
                            emit(dict(kind="profile_activated", token=token, generation=generation,
                                profile=command["profile"], schema=adapter.profile_schema), token)
                            emit(dict(kind="records", generation=generation, token=token,
                                records=[first_state], complete=False), token)
                            status("paused", "Solver profile selected; simulator state retained", complete=False)
                        except Exception as exc:
                            if adapter is not None and hasattr(adapter, "close_solver"):
                                adapter.close_solver()
                            if saved_state is not None:
                                adapter.x, adapter.t, adapter.applied_torque, adapter.sequence = saved_state
                            need_config = True
                            emit(dict(kind="profile_failed", token=token, generation=generation,
                                profile=command["profile"], message=str(exc)), token)
                            status("paused", f"Solver switch failed: {exc}; history retained", complete=history_complete)
                        finally:
                            locks.release()
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
                            adapter.controller.reset(adapter.x*adapter.state_signs)
                            adapter.restarted = True
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
                            adapter.controller.reset(adapter.x*adapter.state_signs)
                            adapter.restarted = True
                            session = MultirateSession(adapter, execution, version)
                        paced = kind == "play" and execution["calculation"] == "on_play"
                        job = dict(paced=paced, end=None if paced else adapter.t+execution["duration_s"],
                                   wall=time.monotonic(), sim=adapter.t, solves=0, controls=0, steps=0)
                    if job:
                        history_complete = False
                        if session is None:
                            adapter.controller.reset(adapter.x*adapter.state_signs)
                            adapter.restarted = True
                            session = MultirateSession(adapter, execution, version)
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
                    adapter.x, adapter.t, adapter.sequence, adapter.applied_torque = committed
                    interval = session.flush_interval()
                    if interval is not None:
                        emit(dict(kind="records", generation=generation, token=token,
                                  records=[interval], complete=False))
                    adapter.controller.reset(adapter.x*adapter.state_signs)
                    adapter.restarted = True
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
                for offset in range(0, len(batch), 256):
                    last_chunk = offset+256 >= len(batch)
                    emit(dict(kind="records", generation=generation, token=token,
                              records=batch[offset:offset+256], complete=complete and last_chunk))
                severity = next((r["severity"] for r in reversed(batch) if r["type"] == "interval"), "none")
                if complete or capacity:
                    history_complete = complete
                    status("paused", "History capacity reached; requested duration was not completed" if capacity and not complete else "Precalculation complete",
                           complete=complete, severity=severity, capacity_reached=capacity, job_active_override=False)
                    job = None
                    locks.release()
                else:
                    status("playing" if job["paced"] else "calculating", "Computing closed-loop MPC motion",
                           complete=False, severity=severity)
            except Exception as exc:
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
        emit(dict(kind="failure", generation=generation, token=token,
                  message=str(exc), detail=traceback.format_exc()))
    finally:
        if adapter is not None:
            # Destruction may release CUDA allocations, so it shares the same
            # experiment window as creation/solving.
            while not locks.acquire():
                time.sleep(.05)
            if hasattr(adapter, "close_solver"):
                adapter.close_solver()
            adapter.controller = None
            adapter.solver = None
            adapter = None
        locks.release()
