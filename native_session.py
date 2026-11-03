"""Retained native virtual-time invocation and its buffered visualizer observations.

The native package owns every numerical decision. Detached batches and committed
snapshots pass to the owner without parking for ordinary reporting. Explicit
pause/end boundaries quiesce the solver and retain the native invocation.
"""
from __future__ import annotations

from copy import deepcopy
from collections import deque
from dataclasses import dataclass
import math
import threading
import time
from types import SimpleNamespace

import numpy as np


@dataclass(frozen=True)
class Progress:
    t: float
    x: np.ndarray
    sequence: int
    u: np.ndarray
    applied_torque: np.ndarray | None
    solves: int
    control_updates: int
    steps: int
    compute_wall: float
    interval: tuple


class _SnapshotMpc:
    """The existing solver adapter behind tiago_mpc's request/result protocol."""
    def __init__(self, session):
        self.session, self.adapter = session, session.adapter
        self.N, self.dt = self.adapter.N, self.adapter.dt
        configuration = getattr(self.adapter, "problem_configuration", None)
        # The selected predictor may come from a different checkout. The native
        # loop only needs its friction availability for composition checks.
        self.params = SimpleNamespace(friction=(configuration or {}).get("friction"))
        self.pending = self.record = None

    def warmup(self, state, reference):
        self.adapter.warmup(state, reference)

    def request(self, state, reference, updates=None):
        from tiago_mpc.interfaces import Plan
        from live_presentation import mutable
        if self.pending is not None:
            raise RuntimeError("An MPC request is already pending")
        if updates:
            raise ValueError("Live task updates must be resolved in the selected solver settings")
        started = self.session.clock()
        self.record = self.adapter.solve_snapshot("play", self.session.version,
                                                  initial=state, reference=reference)
        self.record = mutable(self.record)
        self.record["controller_wall_s"] = self.session.clock()-started
        if (self.record.get("N") != self.N or self.record.get("dt_s") != self.dt):
            raise ValueError("Solver reply does not match the configured N and knot interval")
        if (np.shape(self.record["_states"]) != (self.N, 14) or
                np.shape(self.record["_torques"]) != (self.N-1, 7)):
            raise ValueError("Unexpected plan layout: expected N states and N-1 seven-joint controls")
        origin = self.record.get("plan_origin_time_s", self.record.get("sim_time_s"))
        measured = self.record.get("measured_time_s", origin)
        if origin != state.t or measured != getattr(state, "measured_t", state.t):
            raise ValueError("Solver reply does not match the requested origin and measurement time")
        stats = self.record.get("_native_stats")
        if stats is None:
            # Synthetic adapters use the same captured record contract as preview.
            recorded = self.record["stats"]
            stats = dict(wall_s=recorded["step_wall_s"], solve_time_us=recorded["solve_time_ms"]*1000)
        self.pending = Plan(state.t, self.dt, self.record["_states"], self.record["_torques"],
                            dict(stats), measured_t=getattr(state, "measured_t", state.t))

    def result(self, block=False):
        plan, self.pending = self.pending, None
        return plan

    def close(self):
        pass  # The coordinator owns the persistent solver child.


class _BufferedMpc:
    """Nonblocking requests and native plans; recording is consumed separately."""
    def __init__(self, session):
        self.session, self.adapter = session, session.adapter
        self.remote = self.adapter.remote
        self.target_world_at = getattr(session,'target_world_at',self.adapter.target_world_at)
        self.N, self.dt = self.adapter.N, self.adapter.dt
        self.params = SimpleNamespace(friction=self.adapter.problem_configuration.get("friction"))
        self.record = None
        self.published = True
        self.remote.start_stream(self.N, self.dt, recording=getattr(self.adapter, "record_solves", True),
            max_sqp_iters=self.adapter.problem_configuration.get('solver',{}).get('max_sqp_iters',5))

    def warmup(self, state, reference):
        self.adapter.warmup(state, reference)

    def request(self, state, reference, updates=None):
        if updates:
            raise ValueError("Live task updates belong in the selected solver configuration")
        self.remote.submit_stream(state, reference)

    def result(self, block=False):
        result = self.remote.result_stream(block)
        if result is None:
            return None
        plan, locator = result
        self.adapter.sequence += 1
        self.record = dict(type="plan", origin="play", settings_version=self.session.version,
            seq=self.adapter.sequence, N=self.N, dt_s=self.dt,
            plan_origin_time_s=plan.t0, measured_time_s=plan.measured_t,
            target_xyz=self.target_world_at(plan.t0), _numerical=True,
            controller_wall_s=plan.stats["controller_wall_s"])
        if locator is not None:
            self.record["_recording"] = locator
        else:
            self.record.update(_states=plan.states, _torques=plan.torques, _native_stats=plan.stats)
        self.published = False
        return plan

    def close(self):
        from solver_exchange import discard_records
        if self.record is not None and not self.published:
            discard_records([self.record])
        self.remote.end_stream()


class _Task:
    def __init__(self, adapter, origin):
        self.adapter, self.origin = adapter, origin

    def at(self, t, n, dt):
        return self.adapter.task_reference(self.origin+t), None

    def done(self, state, t):
        # Arrival is a recorded diagnostic; Live continues until its owner stops it.
        return False


class _ObservedPlant:
    """Observe native substeps without changing the integration grid."""
    def __init__(self, session, plant):
        self.session, self.plant = session, plant
        self.run_state = plant.run_state
        if not hasattr(plant, "step_callback"):
            raise ValueError("Simulator source lacks shared-loop physics step observations")
        plant.step_callback = self._step

    def _step(self, state):
        from tiago_mpc.interfaces import Event
        s = self.session
        s.steps += 1
        if not np.isfinite(state.q).all() or not np.isfinite(state.qd).all():
            raise FloatingPointError("Nonfinite simulated state")
        breaches = s.watch.state(state.q, state.qd) if s.watch else []
        if not breaches:
            return ()
        return (Event(state.t, "limit_breach", s._breach_message(state.t, breaches),
                      dict(breaches=breaches, q=state.q.tolist(), qd=state.qd.tolist())),)

    def start(self, clock):
        self.plant.start(clock)

    def state(self):
        return self.plant.state()

    def apply(self, command):
        self.plant.apply(command)
        self.session.adapter.u = np.array(command, copy=True)
        self.session.adapter.applied_torque = np.array(command, copy=True)

    def take_events(self):
        return self.plant.take_events()

    def advance(self, t):
        s = self.session
        started = s.clock()
        self.plant.advance(t)
        wall = s.clock()-started
        s._physics_since_boundary += wall

    def stop(self):
        self.plant.stop()

    def close(self):
        self.plant.close()


class NativeSession:
    """Own one retained native invocation and its committed-record handoff.

    The numerical thread owns the adapter, plant, counters and pending records
    while running. The coordinator reads only immutable ``progress`` snapshots
    until pause parks that invocation or close joins it. The condition gates
    those lifecycle boundaries and transfers two bounded batches; reporting
    never substitutes another invocation or mutates numerical state.
    """
    def __init__(self, adapter, execution, version=0, clock=time.perf_counter):
        from execution_session import LimitWatch, breach_message, validate_execution
        from tiago_mpc.laws import EffortClip, SampleKnot
        from tiago_mpc.loops import VirtualTimeSettings
        from tiago_mpc.prediction import LatencyCompensation
        from tiago_mpc.record import to_dict

        self.adapter, self.execution, self.version, self.clock = adapter, validate_execution(execution), version, clock
        self.origin = float(adapter.t)
        self._reach_target = (np.array(adapter.target_world_at(self.origin),copy=True)
                              if callable(getattr(adapter,'target_world_at',None)) and
                              getattr(adapter,'task',{}).get('kind','reach')=='reach' else None)
        self.plant = adapter.new_plant(1/self.execution["simulation_hz"])
        self._breach_message = breach_message
        handling = getattr(adapter, "limit_handling", None)
        self.watch = None if handling is None else LimitWatch(**handling, x=adapter.x)
        self.law = getattr(adapter, "law", None) or SampleKnot()
        effort_handling = (EffortClip(effort=tuple(self.watch.effort))
                           if self.watch and self.watch.clip else None)
        latency = self.execution["solve_latency_s"]
        compensation = (LatencyCompensation(latency_s="previous" if latency == "measured" else latency)
                        if self.execution["latency_compensation"] else None)
        self.settings = VirtualTimeSettings(
            command_period=1/self.execution["control_hz"],
            update_period=1/self.execution["to_hz"] if self.execution["to_hz"] else 0.,
            solve_latency_s=latency, compensation=compensation,
            max_plan_age_s=self.execution["max_plan_age_s"], effort_handling=effort_handling)
        if hasattr(adapter, "effective_settings"):
            adapter.effective_settings.update(law=to_dict(self.law),
                                              effort_handling=to_dict(self.settings.effort_handling),
                                              compensation=to_dict(self.settings.compensation))
        self.initial_command = (None if adapter.applied_torque is None else np.array(adapter.applied_torque, copy=True))
        self.startup_command_source = "held_command" if self.initial_command is not None else "position_hold"
        if self.initial_command is None and np.any(np.abs(adapter.x[7:]) > 1e-12):
            self.initial_command = np.zeros(7)
            self.startup_command_source = "zero_effort_moving_anchor"
        if self.initial_command is not None:
            adapter.u = self.initial_command.copy()
            adapter.applied_torque = self.initial_command.copy()
        self.steps = self.control_updates = self.solves = 0
        self.compute_wall = 0.
        self.pending_solve_wall = self.pending_physics_wall = self.pending_total_wall = 0.
        self._physics_since_boundary = 0.
        self.pending_foreground_wall = 0.
        self.pending_solver_reported = self.pending_clipped = 0
        self.interval_start = self.origin
        self.plan = self.pending_plan = self.native_plan = None
        self.plan_origin = self.origin
        self.horizon_exhausted = False
        self.outcome = None
        self._finished = False
        # Shared lifecycle gate: the coordinator requests time/pause/cancel;
        # the native thread acknowledges a parked boundary and publishes batches.
        self._condition = threading.Condition()
        self._cancel = threading.Event()
        self._cancelled = lambda: False
        self._thread = None
        self._parked = False
        self._allowed_until = self.origin
        # Uncommitted observations stay with the native thread. Publication
        # transfers each list and its snapshot; consumed batches belong to the
        # coordinator and are forwarded to ingestion/history exactly once.
        self._records = []
        self._plans = {}
        self._error = None
        self._breached = False
        self._last_state_time = self.origin
        self._compute_started = None
        self._mpc = None  # Recording an initial state does not construct a solver.
        self._batches = deque()
        self._pause_requested = False
        self._emit_partial = True
        self._publish_at = self.origin
        self.progress = self._snapshot()

    @property
    def finished(self):
        return self._finished and not self._batches and self._error is None

    def _snapshot(self):
        a = self.adapter
        def owned(value):
            if value is None:
                return None
            value = np.array(value, copy=True)
            value.flags.writeable = False
            return value
        return Progress(a.t, owned(a.x), a.sequence, owned(a.u), owned(a.applied_torque),
                        self.solves, self.control_updates, self.steps, self.compute_wall,
                        (self.interval_start, self.pending_solve_wall, self.pending_physics_wall,
                         self.pending_total_wall, self.pending_foreground_wall,
                         self.pending_solver_reported, self.pending_clipped))

    def _restore_progress(self):
        """Only after joining: discard unpublished state along with its records."""
        a, p = self.adapter, self.progress
        a.t, a.x, a.sequence, a.u = p.t, p.x.copy(), p.sequence, p.u.copy()
        a.applied_torque = None if p.applied_torque is None else p.applied_torque.copy()
        self.solves, self.control_updates, self.steps, self.compute_wall = (
            p.solves, p.control_updates, p.steps, p.compute_wall)
        (self.interval_start, self.pending_solve_wall, self.pending_physics_wall,
         self.pending_total_wall, self.pending_foreground_wall,
         self.pending_solver_reported, self.pending_clipped) = p.interval
        self._physics_since_boundary = 0.

    def _window(self):
        from solver_exchange import SLOTS
        rate = self.execution['control_hz']
        return max(min(.01, (SLOTS//4-1)/rate), 1/rate)

    def _publish(self):
        """Transfer owned observations; bounded capacity is the only report wait."""
        if not self._records:
            return
        with self._condition:
            while len(self._batches) >= 2 and not self._stopping():
                self._condition.wait(timeout=.05)
            if self._stopping():
                return
            records, self._records = self._records, []
            self._batches.append((records, self._snapshot()))
            self._condition.notify_all()

    def _quiesce_at(self, state):
        return self._pause_requested or self._breached or state.t >= self._allowed_until-1e-12

    def target_world_at(self, timestamp):
        return self._reach_target if self._reach_target is not None else self.adapter.target_world_at(timestamp)

    def _state(self):
        from live_presentation import mutable
        a = self.adapter
        if isinstance(self._mpc, _BufferedMpc):
            # These arrays are owned, replaced at the next boundary/application,
            # and never mutated. Conversion belongs to the consumer process.
            record = dict(type='state', sim_time_s=a.t, _x=a.x, torque_nm=a.applied_torque,
                          target_xyz=self.target_world_at(a.t), settings_version=self.version, _numerical=True)
        else:
            record = (a.state_record(self.version) if hasattr(a, "state_record")
                      else mutable(a.state_snapshot(self.version)))
        record.update(control_updates=self.control_updates, horizon_exhausted=self.horizon_exhausted,
                      plan_exhausted=self.horizon_exhausted)
        if self.plan is not None:
            record["plan_seq"] = self.plan["seq"]
        return record

    def initial_state(self):
        return dict(self._state(), startup_command_source=self.startup_command_source)

    def chunk_end(self, window_s=.1):
        rate = self.execution["control_hz"]
        tick = math.ceil((self.progress.t-self.origin+window_s)*rate-1e-9)
        return self.origin+max(tick, math.floor((self.progress.t-self.origin)*rate)+1)/rate

    def _stopping(self):
        return self._cancel.is_set() or self._cancelled()

    def _stop_timing(self):
        if self._compute_started is not None:
            elapsed = max(0., self.clock()-self._compute_started)
            self.pending_total_wall += elapsed
            self.compute_wall += elapsed
            self._compute_started = None
        self.pending_physics_wall += self._physics_since_boundary
        self._physics_since_boundary = 0.

    def _start_timing(self):
        self._compute_started = self.clock()

    def _before_tick(self, state):
        a = self.adapter
        a.t, a.x = float(state.t), np.concatenate((state.q,state.qd))
        if state.t > self._last_state_time+1e-12:
            self._records.append(self._state())
            self._last_state_time = state.t
        self._stop_timing()
        # Pause may arrive after the native loop's nonblocking result poll.
        # Never park until that loop has collected the pending solve. Its
        # post-Tick quiescence check then revisits this same boundary.
        pending = isinstance(self._mpc, _BufferedMpc) and self._mpc.remote.stream_pending
        if not self._stopping() and (not self._quiesce_at(state) or pending):
            if state.t >= self._publish_at-1e-12:
                self._publish()
                self._publish_at = state.t+self._window()
            self._start_timing()
            return
        if self._emit_partial or self._breached or self._pause_requested:
            interval = self.flush_interval()
            if interval is not None:
                self._records.append(interval)
        with self._condition:
            self._publish()
            while not self._stopping() and self._quiesce_at(state):
                self._parked = True
                self._condition.notify_all()
                self._condition.wait(timeout=.05)
            self._parked = False
        if not self._stopping():
            self._publish_at = state.t+self._window()
            self._start_timing()

    def _message(self, message):
        from tiago_mpc.interfaces import Event, SolveCompleted, Tick
        if isinstance(message, SolveCompleted):
            at = float(message.request_time_s)
            interval = self.flush_interval(at)
            if interval is not None:
                self._records.append(interval)
            buffered = isinstance(self._mpc,_BufferedMpc)
            record = self._mpc.record if buffered else dict(self._mpc.record)
            if not buffered:
                record.update(request_time_s=at, sim_time_s=at)
                record.update(_reference=message.reference, _states=message.plan.states,
                              _torques=message.plan.torques,
                              initial_state=dict(q=message.initial.q.tolist(), qd=message.initial.qd.tolist(),
                                  time_s=message.initial.t,
                                  measured_time_s=getattr(message.initial, "measured_t", message.initial.t)))
            elif "_recording" not in record:
                record["_reference"] = message.reference
            if buffered:
                self._mpc.published = True
            latency = (message.plan.stats["wall_s"] if self.execution["solve_latency_s"] == "measured"
                       else self.execution["solve_latency_s"])
            if buffered:
                record['_schedule']=(at,latency,self.origin,self.execution['control_hz'],message.plan.stats['wall_s'])
            else:
                available = at+latency
                activation = max(available, message.plan.t0)
                rate = self.execution["control_hz"]
                record.update(available_time_s=available, solve_latency_s=latency,
                              scheduled_activation_time_s=self.origin+math.ceil((activation-self.origin-1e-9)*rate)/rate,
                              latency_overrun=bool(0 < latency < message.plan.stats["wall_s"]))
            # Retain the Plan too: otherwise Python can reuse a freed object's
            # id while an older cache entry with that id is still present.
            self._plans[id(message.plan)] = (message.plan, record)
            while len(self._plans) > 3:
                self._plans.pop(next(iter(self._plans)))
            self.pending_plan = record
            self.solves += 1
            self.pending_solve_wall += message.plan.stats.get("controller_wall_s", max(message.wall_s, message.plan.stats["wall_s"]))
            self.pending_foreground_wall += message.wall_s
            self.pending_solver_reported += message.plan.stats.get("solve_time_us", 0.)/1e6
            self._records.append(record)
        elif isinstance(message, Tick):
            if message.command is not None:
                record = self._plans[id(message.plan)][1]
                self.plan, self.native_plan, self.pending_plan = record, message.plan, None
                self.plan_origin = message.plan.t0
                self.control_updates += 1
                clipped = message.clipped
                self.pending_clipped += clipped
                elapsed = max(0., message.t-message.plan.t0)
                knot = message.plan.index(elapsed)
                command = np.asarray(message.command)
                requested = np.asarray(message.requested_command)
                buffered = isinstance(self._mpc, _BufferedMpc)
                if buffered:
                    self._records.append(dict(type='control',sim_time_s=message.t,_numerical=True,
                        _control=(self.adapter.applied_torque,message.plan.torques[knot],requested.copy(),
                                  record['seq'],elapsed,message.new,clipped)))
                else:
                    self._records.append(dict(type="control", sim_time_s=message.t,
                    torque_nm=command if buffered else command.tolist(),
                    mpc_torque_nm=message.plan.torques[knot] if buffered else message.plan.torques[knot].tolist(),
                    requested_torque_nm=requested if buffered else requested.tolist(),
                    law_sample_time_s=message.t, plan_seq=record["seq"], plan_elapsed_s=elapsed,
                    plan_activated=message.new, horizon_exhausted=False, plan_exhausted=False,
                    **(dict(_numerical=True) if buffered else {}),
                    **(dict(planned_torque_nm=requested.tolist()) if message.clipped else {})))
                breaches = self.watch.torque(command) if self.watch else []
                if breaches:
                    self._records.append(dict(type="breach", sim_time_s=message.t, breaches=breaches,
                                              message=self._breach_message(message.t, breaches)))
                    self._breached = True  # Native loop quiesces before entering its callback gate.
        elif isinstance(message, Event):
            if message.kind == "limit_breach":
                data = message.data
                if message.t > self._last_state_time+1e-12:
                    self._records.append(dict(type="state", sim_time_s=message.t,
                        _x=np.r_[data["q"], data["qd"]], settings_version=self.version,
                        torque_nm=self.adapter.applied_torque.tolist(),
                        target_xyz=self.adapter.target_world_at(message.t).tolist(),
                        control_updates=self.control_updates, horizon_exhausted=False, plan_exhausted=False,
                        **(dict(plan_seq=self.plan["seq"]) if self.plan else {})))
                    self._last_state_time = message.t
                self._records.append(dict(type="breach", sim_time_s=message.t, breaches=data["breaches"],
                                          message=message.message))
                self._breached = True
            elif message.kind == "command_rejected":
                self._records.append(dict(type="command_rejected", sim_time_s=message.t,
                                          message=message.message, **message.data))
            else:
                self._records.append(dict(type="event", sim_time_s=message.t, event_kind=message.kind,
                                          message=message.message, data=deepcopy(message.data)))

    def _run(self):
        from tiago_mpc.loops import run_virtual_time
        try:
            self._mpc = (_BufferedMpc(self) if callable(getattr(getattr(self.adapter, "remote", None), "start_stream", None))
                         else _SnapshotMpc(self))
            self.outcome = run_virtual_time(_ObservedPlant(self, self.plant), self._mpc,
                _Task(self.adapter, self.origin), self.law,
                settings=self.settings, duration=None,
                start_time_s=self.origin, initial_command=self.initial_command,
                message_callbacks=(self._message,), before_tick=self._before_tick,
                quiesce_at=self._quiesce_at,
                cancelled=self._stopping)
        except BaseException as error:
            self._error = error
        finally:
            try:
                if isinstance(self._mpc, _BufferedMpc):
                    self._mpc.close()
            except BaseException as error:
                self._error = self._error or error
            self._stop_timing()
            if not self._stopping() and self._error is None:
                interval = self.flush_interval()
                if interval is not None:
                    self._records.append(interval)
                self._publish()
            with self._condition:
                self._finished = True
                self._parked = True
                self._condition.notify_all()

    def advance_interval(self, end_time=None, cancelled=lambda: False, emit_partial=True):
        """Run towards end_time, returning each bounded batch without stopping.

        During execution only progress is readable by the owner; adapter and
        numerical counters belong to the native thread. Pause before other RPCs.
        """
        if end_time is not None and end_time <= self.progress.t+1e-12:
            return []
        if cancelled():
            self.close()
            return []
        rate = self.execution["control_hz"]
        target = self.progress.t+self._window() if end_time is None else end_time
        target = self.origin+math.ceil((target-self.origin)*rate-1e-9)/rate
        with self._condition:
            self._cancelled = cancelled
            self._emit_partial = emit_partial
            self._allowed_until = target
            if self._thread is None or self._parked and not self._batches and not self._finished:
                self._pause_requested = self._breached = self._parked = False
            if self._thread is None:
                self._publish_at = self.origin+self._window()
                self._thread = threading.Thread(target=self._run, name="native-execution", daemon=True)
                self._thread.start()
            self._condition.notify_all()
            while not self._batches and not self._parked and not self._finished:
                self._condition.wait(timeout=.05)
            if cancelled():
                self._cancel.set()
                self._condition.notify_all()
                return []
            if self._batches:
                records, self.progress = self._batches.popleft()
                self._condition.notify_all()
                return records
            if self._error is not None:
                raise self._error
            return []

    def pause(self):
        """Drain committed batches and wait for an idle retained invocation."""
        records = []
        committed = self.progress
        with self._condition:
            self._pause_requested = True
            self._condition.notify_all()
            while True:
                while self._batches:
                    batch, self.progress = self._batches.popleft()
                    records.extend(batch)
                    self._condition.notify_all()
                if self._thread is None or self._parked or self._finished:
                    break
                self._condition.wait(timeout=.05)
            if self._error is not None:
                from solver_exchange import discard_records
                discard_records(records)
                self.progress = committed
                raise self._error
        return records

    def flush_interval(self, at=None):
        from execution_session import interval_record
        owner = threading.current_thread() is not self._thread
        if owner and self._thread is not None and not self._parked and not self._finished:
            raise RuntimeError('Pause the numerical invocation before flushing its interval')
        at = float(self.adapter.t if at is None else at)
        if at <= self.interval_start+1e-12:
            return None
        total = self.pending_total_wall
        period = 1/self.execution["to_hz"] if self.execution["to_hz"] else None
        result = interval_record(self.interval_start, at, period, self.pending_solve_wall,
            self.pending_physics_wall, total, solver_reported_s=self.pending_solver_reported,
            clipped_commands=self.pending_clipped, partial=period is not None and at-self.interval_start < period-1e-9,
            controller_foreground_wall_s=self.pending_foreground_wall,
            to_back_to_back=self.execution["to_hz"] == 0, horizon_exhausted=self.horizon_exhausted,
            plan_exhausted=self.horizon_exhausted)
        self.interval_start = at
        self.pending_solve_wall = self.pending_physics_wall = self.pending_total_wall = 0.
        self.pending_foreground_wall = 0.
        self.pending_solver_reported = self.pending_clipped = 0
        if owner:
            self.progress = self._snapshot()
        return result

    def close(self):
        """Cancel and wake, release queued captures, then join and discard the tail.

        Releasing captures before joining unblocks a producer under backpressure.
        Buffered MPC shutdown runs in the numerical thread's finally block;
        the coordinator restores only the last snapshot it accepted.
        """
        self._cancel.set()
        from solver_exchange import discard_records
        with self._condition:
            records = list(self._records)
            for batch, _ in self._batches:
                records.extend(batch)
            self._batches.clear()
            self._condition.notify_all()
        discard_records(records)
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join()  # Native solves finish cooperatively; no arbitrary RPC deadline.
        with self._condition:
            records, self._records = self._records, []
        discard_records(records)
        self._restore_progress()
