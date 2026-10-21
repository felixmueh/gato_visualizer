"""Visualizer-owned multirate execution; no browser, CUDA or scheduling policy imports.

The adapter supplies the existing tiago_mpc controller and RK4 plant. All event
clocks below are simulation clocks; solver latency never advances the plant.
"""
from __future__ import annotations
from copy import deepcopy
import math
import time
import numpy as np

DEFAULT_EXECUTION = dict(simulation_hz=1000., control_hz=100., to_hz=100.,
                         calculation="on_play", duration_s=10., continue_at_end=False)


def validate_execution(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_EXECUTION):
        raise ValueError("execution requires simulation_hz, control_hz, to_hz, calculation, duration_s and continue_at_end")
    value = deepcopy(value)
    for field, lo, hi in (("simulation_hz", 1, 100000), ("control_hz", .01, 100000),
                           ("to_hz", .01, 100000), ("duration_s", .001, 120)):
        number = value[field]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or not lo <= number <= hi:
            raise ValueError(f"{field} must be finite within [{lo}, {hi}]")
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


def interval_record(start, end, budget, solve_wall, physics_wall, total_wall, **extra):
    span = max(end-start, 1e-15)
    severity = "red" if solve_wall > budget else "yellow" if max(physics_wall, total_wall) > span else "none"
    return dict(type="interval", start_time_s=start, end_time_s=end,
                to_budget_s=budget, solve_wall_s=solve_wall, physics_wall_s=physics_wall,
                total_wall_s=total_wall, mpc_ratio=solve_wall/budget,
                physics_ratio=physics_wall/span, total_ratio=total_wall/span,
                severity=severity, **extra)


class MultirateSession:
    """Advance one TO interval at a time, retaining every physics endpoint.

    Integer tick counters avoid cumulative clock drift and permit noninteger
    rate ratios. A coincident boundary solves first, then updates control.
    Last nonterminal torque is held on plan exhaustion, explicitly marked.
    """
    def __init__(self, adapter, execution, version=0, clock=time.perf_counter):
        self.adapter = adapter
        self.execution = validate_execution(execution)
        self.version, self.clock = version, clock
        self.origin = float(adapter.t)
        self.sim_tick = self.control_tick = self.to_tick = 0
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

    def _tick_time(self, tick, rate):
        return self.origin+tick/self.execution[rate]

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
        if self.plan is not None:
            state["plan_seq"] = self.plan["seq"]
        return state

    def initial_state(self):
        return self._state()

    def chunk_end(self, window_s=.1):
        """A bounded chunk ends on a physics grid, adding no artificial steps."""
        rate = self.execution["simulation_hz"]
        tick = max(self.sim_tick+1,
                   int(math.ceil((self.adapter.t-self.origin+window_s)*rate-1e-9)))
        return self.origin+tick/rate

    def _solve(self):
        started = self.clock()
        from live_presentation import mutable
        held_control = None if self.controls is None else self.adapter.u.copy()
        plan = mutable(self.adapter.solve_snapshot("play", self.version))
        # MPCAdapter stores step.u for its legacy fixed-loop API. The visualizer
        # must hold the currently applied command until its next CONTROL tick.
        if held_control is not None:
            self.adapter.u = held_control
        wall = self.clock()-started
        # Nonterminal packed stages: [q7, v7, u7]. Terminal is [q7,v7].
        xu = np.asarray(plan["_xu"]).reshape(-1)
        count = int(plan["N"])-1
        if count < 1 or len(xu) != count*21+14:
            raise ValueError("Unexpected plan layout: expected N-1 controls and a state-only terminal knot")
        self.controls = xu[:count*21].reshape(count, 21)[:, 14:21].astype(float)*np.asarray(plan["_signs"])
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
        while a.t < interval_end-1e-12:
            if cancelled():
                return []
            if a.t >= self._tick_time(self.control_tick, "control_hz")-1e-12:
                elapsed = max(0., a.t-self.plan_origin)
                index = int(math.floor(elapsed/a.dt+1e-9))
                self.horizon_exhausted = index >= len(self.controls)
                index = min(index, len(self.controls)-1)
                a.u = self.controls[index].copy()
                # State torque is the command held over the following interval.
                # Endpoint states record the torque that produced that endpoint.
                self.control_updates += 1
                self.control_tick += 1
                records.append(dict(type="control", sim_time_s=float(a.t), torque_nm=a.u.tolist(),
                                    plan_seq=self.plan["seq"], plan_elapsed_s=elapsed,
                                    horizon_exhausted=self.horizon_exhausted, plan_exhausted=self.horizon_exhausted,
                                    solver_profile=self.plan.get("solver_profile", {}).get("profile"),
                                    solver_process_epoch=self.plan.get("solver_profile", {}).get("process_epoch")))
            while self._tick_time(self.sim_tick, "simulation_hz") <= a.t+1e-12:
                self.sim_tick += 1
            until = min(interval_end, self._tick_time(self.sim_tick, "simulation_hz"),
                        self._tick_time(self.control_tick, "control_hz"))
            h = until-a.t
            if h <= 0:
                raise RuntimeError("Multirate scheduler failed to advance")
            physics_start = self.clock()
            q, v = a.reach.rk4(a.model, a.data, a.x[:7], a.x[7:], a.u, h)
            a.x = np.r_[q, v]
            if not np.isfinite(a.x).all():
                raise FloatingPointError("Nonfinite simulated state")
            a.t = until
            a.applied_torque = a.u.copy()
            self.steps += 1
            physics_wall += self.clock()-physics_start
            snapshot_started = self.clock()
            records.append(self._state())
            snapshot_wall += self.clock()-snapshot_started
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
        if at_to_boundary or emit_partial:
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
                   plan_exhausted=self.horizon_exhausted)
        self.interval_start = float(self.adapter.t)
        self.pending_solve_wall = self.pending_physics_wall = self.pending_total_wall = 0.
        self.pending_solver_reported = 0.
        return record
