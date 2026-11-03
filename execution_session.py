"""Visualizer-owned multirate execution; no browser or CUDA imports.

The adapter supplies the solver and tiago_mpc's SimPlant. All event clocks below
are simulation clocks. Requests use tiago_mpc's Schedule; a solved plan waits for
its declared/measured availability while commands continue from the old plan.
"""
from __future__ import annotations
from copy import deepcopy
import math
import time
import numpy as np

# Commands at 500 Hz, as tiago_mpc's experiments (Felix, 2026-10-23).
DEFAULT_EXECUTION = dict(simulation_hz=1000., control_hz=500., to_hz=100.,
                         solve_latency_s="measured", latency_compensation=False,
                         calculation="on_play", duration_s=10., continue_at_end=False)


def validate_execution(value):
    if not isinstance(value, dict) or set(value) - set(DEFAULT_EXECUTION) or set(DEFAULT_EXECUTION) - {"solve_latency_s", "latency_compensation"} - set(value):
        raise ValueError("execution requires simulation_hz, control_hz, to_hz, solve_latency_s, calculation, duration_s and continue_at_end")
    # Existing saved browser settings acquire the new realistic default.
    value = dict(DEFAULT_EXECUTION, **deepcopy(value))
    for field, lo, hi in (("simulation_hz", 1, 100000), ("control_hz", .01, 100000),
                           ("to_hz", 0, 100000), ("duration_s", .001, 120)):
        number = value[field]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or not lo <= number <= hi:
            raise ValueError(f"{field} must be finite within [{lo}, {hi}]")
    if not value["simulation_hz"] >= value["control_hz"] >= value["to_hz"]:
        raise ValueError("Rates require Simulation Hz >= Control Hz >= TO Hz")
    latency = value["solve_latency_s"]
    if latency != "measured" and (isinstance(latency, bool) or not isinstance(latency, (int, float)) or not math.isfinite(latency) or latency < 0):
        raise ValueError("solve_latency_s must be 'measured' or finite nonnegative seconds")
    if value["calculation"] not in ("on_play", "manual", "automatic"):
        raise ValueError("Unknown calculation mode")
    if not isinstance(value["latency_compensation"], bool):
        raise ValueError("latency_compensation must be a boolean")
    if not isinstance(value["continue_at_end"], bool):
        raise ValueError("continue_at_end must be a boolean")
    return value


def validate_anchor(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"sim_time_s", "q", "qd"}:
        raise ValueError("anchor requires sim_time_s, q and qd")
    t = value["sim_time_s"]
    if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0:
        raise ValueError("anchor sim_time_s must be finite and nonnegative")
    result = {"sim_time_s": float(t)}
    for field in ("q", "qd"):
        raw = value[field]
        if not isinstance(raw, list) or len(raw) != 7 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in raw):
            raise ValueError(f"anchor {field} requires seven finite native coordinates")
        result[field] = list(raw)
    return result


def hold_last(torques, dt, offset_s):
    """The visualizer's control law: the knot torque due offset_s after the plan's
    state (zero-order hold, as tiago_mpc's sample_knot); past the last knot it holds
    the last torque, where sample_knot raises. Returns the torque and whether the
    plan is exhausted."""
    k = math.floor(max(0., offset_s) / dt + 1e-9)
    return torques[min(k, len(torques) - 1)], k >= len(torques)


def sample_command(torques, dt, origin, t, x, *, law=None, plan=None, held=None, sampled_at=None):
    """Pure command selection, including the viewer's final total-command hold.

    Return MPC torque, requested total torque, exhaustion, and the updated local
    law hold. Forecasting supplies its own hold; it never changes execution state.
    Effort clipping is the separate pure LimitWatch.command operation.
    """
    mpc_torque, exhausted = hold_last(torques, dt, max(0., t-origin))
    if law is None:
        return mpc_torque, mpc_torque, exhausted, held, sampled_at
    from tiago_mpc.interfaces import State
    final = origin+(len(torques)-1)*dt
    if not exhausted or sampled_at is None or sampled_at < final-1e-9:
        sampled_at = final if exhausted else t
        held = np.asarray(law(plan, sampled_at, State(t, x[:7], x[7:])), dtype=float)
        if held.shape != (7,) or not np.isfinite(held).all():
            raise ValueError("Execution law must return seven finite native torques")
    return mpc_torque, held.copy(), exhausted, held, sampled_at


# Limit handling of the simulated plant (Felix, 2026-10-23). Defaults: clip on, stop on all.
STOP_QUANTITIES = ("position", "velocity", "torque")
UNITS = dict(position="rad", velocity="rad/s", torque="Nm")


class LimitWatch:
    """Effort clipping and limit-breach detection on simulated values, at full rate.

    limits holds the raw URDF limits in native order (lower, upper, velocity,
    effort). With clip on, each command is clipped to ± the effort limit before
    it reaches the plant. A breach is judged on simulated values only: the
    position and velocity at every physics endpoint, the applied (clipped)
    torque at every command; breaches at one tick are ordered by relative excess,
    largest first. A quantity of a joint breaches when it starts to
    be beyond its limit and re-arms once it is back within it, so a value that
    stays beyond stops once. A value already beyond at the session's start
    (an anchor, a settings change) is armed only once back within.
    """
    def __init__(self, limits, clip_effort, stop_on_breach, x):
        self.lower, self.upper, self.velocity, self.effort = (
            np.asarray(limits[key], dtype=float) for key in ("lower", "upper", "velocity", "effort"))
        self.clip, self.stop_on = bool(clip_effort), dict(stop_on_breach)
        x = np.asarray(x, dtype=float)
        self.armed = dict(position=~self._beyond_position(x[:7]), velocity=~(np.abs(x[7:]) > self.velocity),
                          torque=np.ones(7, dtype=bool))

    def _beyond_position(self, q):
        return (q < self.lower) | (q > self.upper)

    def command(self, planned):
        """The torque applied to the plant, and whether clipping changed it."""
        if not self.clip:
            return planned, False
        applied = np.clip(planned, -self.effort, self.effort)
        return applied, bool(np.any(applied != planned))

    def _check(self, quantity, beyond, values, limits, scale):
        """Breaches that start now, with their excess relative to scale (for ordering)."""
        started = beyond & self.armed[quantity]
        self.armed[quantity] = ~beyond
        if not self.stop_on[quantity]:
            return []
        return [(abs(values[i]-limits[i])/scale[i],
                 dict(joint_index=int(i), quantity=quantity, value=float(values[i]), limit=float(limits[i])))
                for i in np.flatnonzero(started)]

    @staticmethod
    def _worst_first(found):
        return [breach for _, breach in sorted(found, key=lambda item: -item[0])]

    def torque(self, applied):
        applied = np.asarray(applied, dtype=float)
        return self._worst_first(self._check("torque", np.abs(applied) > self.effort, applied,
                                             np.copysign(self.effort, applied), self.effort))

    def state(self, q, qd):
        """Breaches at a physics endpoint, the largest excess first: relative to the
        joint's range for position, to the limit for velocity."""
        q, qd = np.asarray(q, dtype=float), np.asarray(qd, dtype=float)
        bound = np.where(q < self.lower, self.lower, self.upper)
        return self._worst_first(
            self._check("position", self._beyond_position(q), q, bound, self.upper-self.lower) +
            self._check("velocity", np.abs(qd) > self.velocity, qd, np.copysign(self.velocity, qd), self.velocity))


def breach_message(t, breaches):
    """One line naming the first (largest) breach: joint, quantity, value and limit."""
    first = breaches[0]
    unit, joint = UNITS[first["quantity"]], first["joint_index"]+1
    kind = dict(position="joint limit", velocity="velocity limit", torque="effort limit")[first["quantity"]]
    more = f" (+{len(breaches)-1} more)" if len(breaches) > 1 else ""
    return (f"Limit breach at {t:.3f} s: joint {joint} {first['quantity']} {first['value']:.4g} {unit} "
            f"beyond its {kind} {first['limit']:.4g} {unit}{more}")


def interval_record(start, end, budget, solve_wall, physics_wall, total_wall, **extra):
    span = max(end-start, 1e-15)
    if extra.get("to_back_to_back"):
        budget = None  # Throughput mode has no optimizer deadline.
    severity = "red" if budget is not None and solve_wall > budget else "yellow" if max(physics_wall, total_wall) > span else "none"
    return dict(type="interval", start_time_s=start, end_time_s=end,
                to_budget_s=budget, solve_wall_s=solve_wall, physics_wall_s=physics_wall,
                total_wall_s=total_wall, mpc_ratio=None if budget is None else solve_wall/budget,
                mpc_realtime_ratio=solve_wall/span,
                physics_ratio=physics_wall/span, total_ratio=total_wall/span,
                severity=severity, **extra)


class MultirateSession:
    """Advance to the next eligible TO request, recording control events.

    Integer tick counters avoid cumulative clock drift and permit noninteger
    rate ratios. At command ticks, activate an available plan, then request if no
    solve is pending and Schedule is due, then command the active plan. As in
    run_virtual_time, plan age starts at its input state, never at activation.
    Last nonterminal torque is held on plan exhaustion, explicitly marked. The
    plant starts at the adapter's state; whoever moves that state replaces the session.

    Recording follows the control events (Felix, 2026-10-23): every command, every
    plan and interval, and the state at every command tick and at the end of each
    call (TO boundaries, chunk and job ends), plus a breaching tick. Physics steps
    in between are simulated but not recorded; everything the session computes
    (breaches, exhaustion, counters, clipping) sees every step.
    """
    def __init__(self, adapter, execution, version=0, clock=time.perf_counter):
        self.adapter = adapter
        self.execution = validate_execution(execution)
        self.version, self.clock = version, clock
        # Import after the selected adapter has loaded its source; never choose
        # another checkout merely by importing the HTTP bridge.
        from tiago_mpc.loops import Schedule
        self.due = Schedule(1/self.execution["to_hz"] if self.execution["to_hz"] else 0.)
        self.origin = float(adapter.t)
        self.sim_tick = self.control_tick = 0
        self.plant = adapter.new_plant(1/self.execution["simulation_hz"])
        self.forecast_data = None
        self.previous_latency_s = .005  # LatencyCompensation.initial_latency_s
        if self.execution["latency_compensation"]:
            from tiago_mpc.prediction import LatencyCompensation
            self.previous_latency_s = LatencyCompensation().initial_latency_s
            self.forecast_data = self.plant.model.createData()
        self.plan = None
        self.pending_plan = None
        self.activation_pending = False
        self.plan_origin = self.origin
        self.controls = None
        self.native_plan = None
        self.law_command = None
        self.law_sample_time = None
        self.plan_elapsed = 0.
        self.horizon_exhausted = False
        self.steps = self.control_updates = self.solves = 0
        self.compute_wall = 0.
        self.interval_start = self.origin
        self.pending_solve_wall = self.pending_physics_wall = self.pending_total_wall = 0.
        self.pending_solver_reported = 0.
        self.pending_clipped = 0
        self.interval_end = self.origin
        self.has_command = getattr(adapter, "applied_torque", None) is not None
        self.startup_command_source = "held_command" if self.has_command else "position_hold"
        if self.has_command:
            adapter.u = np.array(adapter.applied_torque, dtype=float)
        elif getattr(adapter, "x", None) is not None and np.any(np.abs(adapter.x[7:]) > 1e-12):
            # Anchors carry q/qd/time, not an actuator checkpoint. Do not freeze a
            # moving anchor while awaiting its first plan: explicitly use zero effort.
            adapter.u = np.zeros(7)
            adapter.applied_torque = adapter.u.copy()
            self.has_command = True
            self.startup_command_source = "zero_effort_moving_anchor"
        if self.has_command:
            self.plant.apply(adapter.u)
        handling = getattr(adapter, "limit_handling", None)
        self.watch = None if handling is None else LimitWatch(**handling, x=adapter.x)

    def _tick_time(self, tick, rate):
        return self.origin+tick/self.execution[rate]

    def _state(self):
        # Native adapters detach directly into IPC-ready state records. Keep
        # the immutable-snapshot conversion for adapters without that contract.
        record = getattr(self.adapter, "state_record", None)
        if record is not None:
            state = record(self.version)
        else:
            from live_presentation import mutable
            state = mutable(self.adapter.state_snapshot(self.version))
        state["horizon_exhausted"] = self.horizon_exhausted
        state["plan_exhausted"] = self.horizon_exhausted
        state["control_updates"] = self.control_updates
        if self.plan is not None:
            state["plan_seq"] = self.plan["seq"]
        return state

    def initial_state(self):
        return dict(self._state(), startup_command_source=self.startup_command_source)

    def chunk_end(self, window_s=.1):
        """A bounded chunk ends on a command tick, where integration splits and a
        state is recorded anyway: no artificial step, no extra recorded state."""
        rate, elapsed = self.execution["control_hz"], self.adapter.t-self.origin
        tick = max(math.floor(elapsed*rate+1e-9)+1, int(math.ceil((elapsed+window_s)*rate-1e-9)))
        return self.origin+tick/rate

    def _forecast_initial_state(self):
        """Future initial condition under the commands execution would send.

        The latest simulated observation is exact at the request tick. Use the
        actual simulated physics with separate Pinocchio data, and a local copy
        of the law's hold. No robot lease or terminal-plan stop policy applies.
        """
        from tiago_mpc.interfaces import Prediction
        from tiago_mpc.dynamics import plant_euler, plant_rk4
        from gato.common import rk4
        a = self.adapter
        delay = (self.previous_latency_s if self.execution["solve_latency_s"] == "measured"
                 else self.execution["solve_latency_s"])
        at, t = self._command_at_or_after(float(a.t)+delay), float(a.t)
        x = np.array(a.x, dtype=float, copy=True)
        held = a.u.copy() if self.has_command else None
        command = None if self.law_command is None else self.law_command.copy()
        sampled = self.law_sample_time
        control_tick, sim_tick = self.control_tick, self.sim_tick
        config, model, data = self.plant.config, self.plant.model, self.forecast_data
        while t < at-1e-12:
            if t >= self._tick_time(control_tick, "control_hz")-1e-12:
                if self.plan is not None:
                    _, requested, _, command, sampled = sample_command(
                        self.controls, a.dt, self.plan_origin, t, x, law=getattr(a, "law", None),
                        plan=self.native_plan, held=command, sampled_at=sampled)
                    held = self.watch.command(requested)[0] if self.watch else requested
                control_tick += 1
            if held is None:  # onboard position hold before the first command
                break
            while self._tick_time(sim_tick, "simulation_hz") <= t+1e-12:
                sim_tick += 1
            until = min(at, self._tick_time(control_tick, "control_hz"),
                        self._tick_time(sim_tick, "simulation_hz"))
            h = until-t
            if config.integrator == "euler":
                q, qd = plant_euler(model, data, x[:7], x[7:], held, h,
                                    config.friction, config.friction_law)
            elif config.friction is not None:
                q, qd = plant_rk4(model, data, x[:7], x[7:], held, h,
                                  config.friction, config.friction_law)
            else:
                q, qd = rk4(model, data, x[:7], x[7:], held, h)
            x, t = np.r_[q, qd], until
        return Prediction(at, x[:7], x[7:], measured_t=float(a.t))

    def _solve(self):
        started = self.clock()
        from live_presentation import mutable
        initial = self._forecast_initial_state() if self.execution["latency_compensation"] else None
        plan = mutable(self.adapter.solve_snapshot("play", self.version, initial=initial)
                       if initial is not None else self.adapter.solve_snapshot("play", self.version))
        wall = self.clock()-started
        # Native knot torques: N-1 controls, none after the terminal state.
        controls = np.asarray(plan["_torques"], dtype=float)
        if controls.ndim != 2 or controls.shape[1] != 7 or len(controls) != int(plan["N"])-1:
            raise ValueError("Unexpected plan layout: expected N-1 controls and a state-only terminal knot")
        took = plan["stats"]["step_wall_s"]  # native Plan.stats['wall_s'], not RPC or CUDA timing
        if not isinstance(took, (int, float)) or not math.isfinite(took) or took < 0:
            raise ValueError("Plan wall time must be finite nonnegative seconds")
        latency = took if self.execution["solve_latency_s"] == "measured" else self.execution["solve_latency_s"]
        requested = float(self.adapter.t)
        available = requested + latency
        plan.update(request_time_s=requested, available_time_s=available,
                    scheduled_activation_time_s=self._command_at_or_after(max(available, plan.get("plan_origin_time_s", requested))),
                    solve_latency_s=latency, latency_overrun=bool(0 < latency < took))
        self.previous_latency_s = float(took)
        self.pending_plan = plan
        plan["controller_wall_s"] = wall
        self.solves += 1
        return plan, wall

    def _command_at_or_after(self, t):
        # Same 1 ns availability tolerance as run_virtual_time.
        return self.origin + math.ceil((t-self.origin-1e-9)*self.execution["control_hz"])/self.execution["control_hz"]

    def _activate(self):
        if self.pending_plan is not None and self.adapter.t >= max(self.pending_plan["available_time_s"],
                self.pending_plan.get("plan_origin_time_s", self.pending_plan["sim_time_s"]))-1e-9:
            self.plan, self.pending_plan = self.pending_plan, None
            self.plan_origin = float(self.plan.get("plan_origin_time_s", self.plan["sim_time_s"]))
            self.controls = np.asarray(self.plan["_torques"], dtype=float)
            from tiago_mpc.interfaces import Plan
            measured = ({"measured_t": self.plan.get("measured_time_s", self.plan_origin)}
                        if "measured_t" in Plan.__dataclass_fields__ else {})
            self.native_plan = Plan(self.plan_origin, float(self.plan["dt_s"]),
                                    np.asarray(self.plan["_states"]), self.controls, **measured)
            self.law_command = self.law_sample_time = None
            self.activation_pending = True

    def _next_request_time(self):
        earliest = self._tick_time(self.control_tick, "control_hz")
        if self.pending_plan is not None:
            earliest = max(earliest, self.pending_plan["available_time_s"],
                           self.pending_plan.get("plan_origin_time_s", self.pending_plan["sim_time_s"]))
        if self.due.next is not None:
            earliest = max(earliest, self.due.next)
        return self._command_at_or_after(earliest)

    def advance_interval(self, end_time=None, cancelled=lambda: False, emit_partial=True):
        """Return detached plan/state/interval records; stop cooperatively.

        A solve cannot be interrupted safely inside native code. Its result is
        discarded when cancellation arrived during the call, before any plant
        step or history publication.
        """
        a = self.adapter
        start = float(a.t)
        if end_time is not None and end_time <= start+1e-12:
            return []
        started = self.clock()
        records = []
        solve_wall = physics_wall = snapshot_wall = solver_reported = 0.
        if cancelled():
            return []
        interval_end = float("inf") if end_time is None else end_time
        # If a prior chunk ended between command ticks, the existing request
        # boundary still applies. A tick at the start must run before bounding.
        if a.t < self._tick_time(self.control_tick, "control_hz")-1e-12:
            interval_end = min(interval_end, self._next_request_time())
        breaches = []
        while a.t < interval_end-1e-12:
            if cancelled():
                return []
            if a.t >= self._tick_time(self.control_tick, "control_hz")-1e-12:
                self._activate()
                if self.pending_plan is None and self.due(a.t):
                    plan, wall = self._solve()
                    solve_wall += wall
                    solver_reported += plan["stats"]["solve_time_ms"]/1000
                    if cancelled():
                        return []
                    records.append(plan)
                    self._activate()  # declared zero latency takes effect at this tick
                self.control_tick += 1
                self.interval_end = self._next_request_time()
                interval_end = min(interval_end, self.interval_end)
                if self.plan is None:
                    # SimPlant.command remains None until the first plan; no
                    # artificial zero-effort fall while the initial arm is held.
                    continue
                elapsed = max(0., a.t-self.plan_origin)
                mpc_torque, planned, self.horizon_exhausted, self.law_command, self.law_sample_time = sample_command(
                    self.controls, a.dt, self.plan_origin, float(a.t), a.x, law=getattr(a, "law", None),
                    plan=self.native_plan, held=self.law_command, sampled_at=self.law_sample_time)
                torque, clipped = self.watch.command(planned) if self.watch else (planned, False)
                a.u = torque.copy()
                self.pending_clipped += clipped
                breaches = self.watch.torque(a.u) if self.watch else []
                # State torque is the command held over the following interval.
                # Endpoint states record the torque that produced that endpoint.
                self.control_updates += 1
                self.has_command = True
                # Every command is recorded; the state at its tick already is.
                records.append(dict(type="control", sim_time_s=float(a.t), torque_nm=a.u.tolist(),
                                    mpc_torque_nm=mpc_torque.tolist(), requested_torque_nm=planned.tolist(),
                                    law_sample_time_s=self.law_sample_time,
                                    plan_seq=self.plan["seq"], plan_elapsed_s=elapsed,
                                    plan_activated=self.activation_pending,
                                    horizon_exhausted=self.horizon_exhausted, plan_exhausted=self.horizon_exhausted,
                                    **(dict(planned_torque_nm=planned.tolist()) if clipped else {})))
                self.activation_pending = False
                if breaches:
                    break  # Stop before integrating: the breaching command is held from here.
            while self._tick_time(self.sim_tick, "simulation_hz") <= a.t+1e-12:
                self.sim_tick += 1
            command_time = self._tick_time(self.control_tick, "control_hz")
            until = min(interval_end, self._tick_time(self.sim_tick, "simulation_hz"), command_time)
            h = until-a.t
            if h <= 0:
                raise RuntimeError("Multirate scheduler failed to advance")
            physics_start = self.clock()
            if self.has_command:
                self.plant.apply(a.u)
            self.plant.advance(until)
            a.x = np.r_[self.plant.q, self.plant.qd]
            if not np.isfinite(a.x).all():
                raise FloatingPointError("Nonfinite simulated state")
            a.t = until
            if self.has_command:
                a.applied_torque = a.u.copy()
            self.steps += 1
            breaches = self.watch.state(a.x[:7], a.x[7:]) if self.watch else []
            physics_wall += self.clock()-physics_start
            # The state at the next command tick, at the end of the call, or at a breach.
            if until >= interval_end-1e-12 or until >= command_time-1e-12 or breaches:
                snapshot_started = self.clock()
                records.append(self._state())
                snapshot_wall += self.clock()-snapshot_started
            if breaches:
                break
        if breaches:
            records.append(dict(type="breach", sim_time_s=float(a.t), breaches=breaches,
                                message=breach_message(float(a.t), breaches)))
        # Copying history/serialization/FK/IPC and pacing do not count as plant
        # execution cost. Measured overhead is scheduler + numerical execution.
        elapsed_wall = self.clock()-started
        # Snapshot assembly is deliberately measured separately below by
        # accumulating numerical/scheduler spans rather than display work.
        total_wall = max(solve_wall+physics_wall, elapsed_wall-snapshot_wall)
        self.compute_wall += total_wall
        self.pending_solve_wall += solve_wall
        self.pending_physics_wall += physics_wall
        self.pending_total_wall += total_wall
        self.pending_solver_reported += solver_reported
        at_to_boundary = a.t >= self.interval_end-1e-12
        # A breach ends the call where it happened, like a pause: its partial interval is final.
        if at_to_boundary or emit_partial or breaches:
            interval = self.flush_interval()
            if interval is not None:
                records.append(interval)
        return records

    def flush_interval(self):
        """Finalize committed timing at a TO boundary, end, or explicit pause."""
        if self.adapter.t <= self.interval_start+1e-12:
            return None
        record = interval_record(self.interval_start, float(self.adapter.t),
                   1/self.execution["to_hz"] if self.execution["to_hz"] else None,
                   self.pending_solve_wall,
                   self.pending_physics_wall, self.pending_total_wall,
                   solver_reported_s=self.pending_solver_reported,
                   partial=self.adapter.t < self.interval_end-1e-12,
                   to_back_to_back=self.execution["to_hz"] == 0,
                   horizon_exhausted=self.horizon_exhausted,
                   plan_exhausted=self.horizon_exhausted, clipped_commands=self.pending_clipped)
        self.interval_start = float(self.adapter.t)
        self.pending_solve_wall = self.pending_physics_wall = self.pending_total_wall = 0.
        self.pending_solver_reported = 0.
        self.pending_clipped = 0
        return record
