"""Visualizer-owned multirate execution; no browser, CUDA or scheduling policy imports.

The adapter supplies the solver and tiago_mpc's SimPlant. All event clocks below
are simulation clocks; solver latency never advances the plant.
"""
from __future__ import annotations
from copy import deepcopy
import math
import time
import numpy as np

# Commands at 500 Hz, as tiago_mpc's experiments (Felix, 2026-10-23). Recording
# every 2nd physics step keeps each command and the state it produced, while the
# history per simulated second stays below the former 1000/100/100 complete record.
DEFAULT_EXECUTION = dict(simulation_hz=1000., control_hz=500., to_hz=100., record_every=2,
                         calculation="on_play", duration_s=10., continue_at_end=False)
MAX_RECORD_EVERY = 1000


def validate_execution(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_EXECUTION):
        raise ValueError("execution requires simulation_hz, control_hz, to_hz, record_every, calculation, duration_s and continue_at_end")
    value = deepcopy(value)
    for field, lo, hi in (("simulation_hz", 1, 100000), ("control_hz", .01, 100000),
                           ("to_hz", .01, 100000), ("duration_s", .001, 120)):
        number = value[field]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or not lo <= number <= hi:
            raise ValueError(f"{field} must be finite within [{lo}, {hi}]")
    every = value["record_every"]
    if (isinstance(every, bool) or not isinstance(every, (int, float)) or not math.isfinite(every)
            or every != int(every) or not 1 <= every <= MAX_RECORD_EVERY):
        raise ValueError(f"record_every must be an integer within [1, {MAX_RECORD_EVERY}]")
    value["record_every"] = int(every)
    if not value["simulation_hz"] >= value["control_hz"] >= value["to_hz"]:
        raise ValueError("Rates require Simulation Hz >= Control Hz >= TO Hz")
    if value["calculation"] not in ("on_play", "manual", "automatic"):
        raise ValueError("Unknown calculation mode")
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


# Limit handling of the simulated plant (Felix, 2026-10-23). Defaults: clip on, stop on all.
STOP_QUANTITIES = ("position", "velocity", "torque")
UNITS = dict(position="rad", velocity="rad/s", torque="Nm")


class LimitWatch:
    """Effort clipping and limit-breach detection on simulated values, at full rate.

    limits holds the raw URDF limits in native order (lower, upper, velocity,
    effort). With clip on, each command is clipped to ± the effort limit before
    it reaches the plant. A breach is judged on simulated values only: the
    position and velocity at every physics endpoint, the applied (clipped)
    torque at every command. A quantity of a joint breaches when it starts to
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

    def _check(self, quantity, beyond, values, limits):
        started = beyond & self.armed[quantity]
        self.armed[quantity] = ~beyond
        if not self.stop_on[quantity]:
            return []
        return [dict(joint_index=int(i), quantity=quantity, value=float(values[i]), limit=float(limits[i]))
                for i in np.flatnonzero(started)]

    def torque(self, applied):
        applied = np.asarray(applied, dtype=float)
        return self._check("torque", np.abs(applied) > self.effort, applied, np.copysign(self.effort, applied))

    def state(self, q, qd):
        q, qd = np.asarray(q, dtype=float), np.asarray(qd, dtype=float)
        bound = np.where(q < self.lower, self.lower, self.upper)
        return (self._check("position", self._beyond_position(q), q, bound) +
                self._check("velocity", np.abs(qd) > self.velocity, qd, np.copysign(self.velocity, qd)))


def breach_message(t, breaches):
    """One line naming the first breach: joint, quantity, value and limit."""
    first = breaches[0]
    unit, joint = UNITS[first["quantity"]], first["joint_index"]+1
    kind = dict(position="joint limit", velocity="velocity limit", torque="effort limit")[first["quantity"]]
    more = f" (+{len(breaches)-1} more)" if len(breaches) > 1 else ""
    return (f"Limit breach at {t:.3f} s: joint {joint} {first['quantity']} {first['value']:.4g} {unit} "
            f"beyond its {kind} {first['limit']:.4g} {unit}{more}")


def interval_record(start, end, budget, solve_wall, physics_wall, total_wall, **extra):
    span = max(end-start, 1e-15)
    severity = "red" if solve_wall > budget else "yellow" if max(physics_wall, total_wall) > span else "none"
    return dict(type="interval", start_time_s=start, end_time_s=end,
                to_budget_s=budget, solve_wall_s=solve_wall, physics_wall_s=physics_wall,
                total_wall_s=total_wall, mpc_ratio=solve_wall/budget,
                physics_ratio=physics_wall/span, total_ratio=total_wall/span,
                severity=severity, **extra)


class MultirateSession:
    """Advance one TO interval at a time, recording physics endpoints and commands.

    Integer tick counters avoid cumulative clock drift and permit noninteger
    rate ratios. A coincident boundary solves first, then updates control.
    Last nonterminal torque is held on plan exhaustion, explicitly marked. The
    plant starts at the adapter's state; whoever moves that state replaces the session.

    record_every only thins what is returned, never what is simulated or solved.
    With 1 every endpoint and command is recorded. With n > 1 a state is recorded
    on every n-th physics tick and at the end of each call (TO boundaries, chunk
    and job ends), a command only at a recorded state's time. Plans and intervals
    are always complete; counters and flags are computed at every step.
    """
    def __init__(self, adapter, execution, version=0, clock=time.perf_counter):
        self.adapter = adapter
        self.execution = validate_execution(execution)
        self.version, self.clock = version, clock
        self.origin = float(adapter.t)
        self.sim_tick = self.control_tick = self.to_tick = 0
        self.plant = adapter.new_plant(1/self.execution["simulation_hz"])
        self.plan = None
        self.plan_origin = self.origin
        self.controls = None
        self.plan_elapsed = 0.
        self.horizon_exhausted = False
        self.steps = self.control_updates = self.solves = 0
        self.compute_wall = 0.
        self.interval_start = self.origin
        self.pending_solve_wall = self.pending_physics_wall = self.pending_total_wall = 0.
        self.pending_solver_reported = 0.
        self.pending_clipped = 0
        # The session starts at the history tip, which is already recorded.
        self.recorded_t = self.origin
        handling = getattr(adapter, "limit_handling", None)
        self.watch = None if handling is None else LimitWatch(**handling, x=adapter.x)

    def _tick_time(self, tick, rate):
        return self.origin+tick/self.execution[rate]

    def _recorded(self, t):
        """Whether t lies on the recording grid: every record_every-th physics tick."""
        every = self.execution["record_every"]
        if every == 1:
            return True
        tick = round((t-self.origin)*self.execution["simulation_hz"])
        return tick % every == 0 and abs(self._tick_time(tick, "simulation_hz")-t) <= 1e-12

    def _state(self):
        # Native adapters detach directly into IPC-ready state records. Keep
        # the immutable-snapshot conversion for adapters without that contract.
        record = getattr(self.adapter, "state_record", None)
        if record is not None:
            state = record(0, self.version)
        else:
            from live_presentation import mutable
            state = mutable(self.adapter.state_snapshot(0, self.version))
        state["horizon_exhausted"] = self.horizon_exhausted
        state["plan_exhausted"] = self.horizon_exhausted
        state["control_updates"] = self.control_updates
        state["record_every"] = self.execution["record_every"]
        if self.plan is not None:
            state["plan_seq"] = self.plan["seq"]
        self.recorded_t = float(self.adapter.t)
        return state

    def initial_state(self):
        return self._state()

    def chunk_end(self, window_s=.1):
        """A bounded chunk ends on the recording grid, a subset of the physics grid,
        adding no artificial steps and no extra recorded state."""
        rate, every = self.execution["simulation_hz"], self.execution["record_every"]
        tick = max(self.sim_tick+1,
                   int(math.ceil((self.adapter.t-self.origin+window_s)*rate-1e-9)))
        return self.origin+(-(-tick//every)*every)/rate

    def _solve(self):
        started = self.clock()
        from live_presentation import mutable
        plan = mutable(self.adapter.solve_snapshot("play", self.version))
        wall = self.clock()-started
        # Native knot torques: N-1 controls, none after the terminal state.
        self.controls = np.asarray(plan["_torques"], dtype=float)
        if self.controls.ndim != 2 or self.controls.shape[1] != 7 or len(self.controls) != int(plan["N"])-1:
            raise ValueError("Unexpected plan layout: expected N-1 controls and a state-only terminal knot")
        self.plan, self.plan_origin = plan, float(self.adapter.t)
        plan["controller_wall_s"] = wall
        self.solves += 1
        return plan, wall

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
        solve_wall = physics_wall = snapshot_wall = 0.
        if cancelled():
            return []
        if self.plan is None or a.t >= self._tick_time(self.to_tick, "to_hz")-1e-12:
            plan, solve_wall = self._solve()
            if cancelled():
                return []
            records.append(plan)
            self.to_tick += 1
        interval_end = self._tick_time(self.to_tick, "to_hz")
        if end_time is not None:
            interval_end = min(interval_end, end_time)
        breaches = []
        while a.t < interval_end-1e-12:
            if cancelled():
                return []
            if a.t >= self._tick_time(self.control_tick, "control_hz")-1e-12:
                elapsed = max(0., a.t-self.plan_origin)
                planned, self.horizon_exhausted = hold_last(self.controls, a.dt, elapsed)
                torque, clipped = self.watch.command(planned) if self.watch else (planned, False)
                a.u = torque.copy()
                self.pending_clipped += clipped
                breaches = self.watch.torque(a.u) if self.watch else []
                # State torque is the command held over the following interval.
                # Endpoint states record the torque that produced that endpoint.
                self.control_updates += 1
                self.control_tick += 1
                # A command is recorded where its state is: at the call's start
                # (a recorded endpoint) or on the recording grid; a breaching one always.
                if a.t <= start+1e-12 or self._recorded(a.t) or breaches:
                    records.append(dict(type="control", sim_time_s=float(a.t), torque_nm=a.u.tolist(),
                                    plan_seq=self.plan["seq"], plan_elapsed_s=elapsed,
                                    horizon_exhausted=self.horizon_exhausted, plan_exhausted=self.horizon_exhausted,
                                    solver_profile=self.plan.get("solver_profile", {}).get("profile"),
                                    solver_process_epoch=self.plan.get("solver_profile", {}).get("process_epoch"),
                                    record_every=self.execution["record_every"],
                                    **(dict(planned_torque_nm=planned.tolist()) if clipped else {})))
                if breaches:
                    # Stop before integrating: the breaching command is held from here.
                    if self.recorded_t != a.t:
                        records.append(self._state())
                    break
            while self._tick_time(self.sim_tick, "simulation_hz") <= a.t+1e-12:
                self.sim_tick += 1
            until = min(interval_end, self._tick_time(self.sim_tick, "simulation_hz"),
                        self._tick_time(self.control_tick, "control_hz"))
            h = until-a.t
            if h <= 0:
                raise RuntimeError("Multirate scheduler failed to advance")
            physics_start = self.clock()
            self.plant.apply(a.u)
            self.plant.advance(until)
            a.x = np.r_[self.plant.q, self.plant.qd]
            if not np.isfinite(a.x).all():
                raise FloatingPointError("Nonfinite simulated state")
            a.t = until
            a.applied_torque = a.u.copy()
            self.steps += 1
            breaches = self.watch.state(a.x[:7], a.x[7:]) if self.watch else []
            physics_wall += self.clock()-physics_start
            if until >= interval_end-1e-12 or self._recorded(until) or breaches:
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
        if solve_wall:
            self.pending_solver_reported += self.plan["stats"]["solve_time_ms"]/1000
        at_to_boundary = a.t >= self._tick_time(self.to_tick, "to_hz")-1e-12
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
                   1/self.execution["to_hz"], self.pending_solve_wall,
                   self.pending_physics_wall, self.pending_total_wall,
                   solver_reported_s=self.pending_solver_reported,
                   partial=self.adapter.t < self._tick_time(self.to_tick, "to_hz")-1e-12,
                   horizon_exhausted=self.horizon_exhausted,
                   plan_exhausted=self.horizon_exhausted, clipped_commands=self.pending_clipped)
        self.interval_start = float(self.adapter.t)
        self.pending_solve_wall = self.pending_physics_wall = self.pending_total_wall = 0.
        self.pending_solver_reported = 0.
        self.pending_clipped = 0
        return record
