"""Execution settings and observations for the shared native virtual-time loop."""
from __future__ import annotations
from copy import deepcopy
import math
import numpy as np

# Commands at 500 Hz, as tiago_mpc's experiments (Felix, 2026-10-23).
DEFAULT_EXECUTION = dict(simulation_hz=1000., control_hz=500., to_hz=100.,
                         solve_latency_s="measured", latency_compensation=False, max_plan_age_s=None,
                         calculation="on_play", duration_s=10., continue_at_end=False)


def validate_execution(value):
    if not isinstance(value, dict) or set(value) - set(DEFAULT_EXECUTION) or set(DEFAULT_EXECUTION) - {"solve_latency_s", "latency_compensation", "max_plan_age_s"} - set(value):
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
    age = value["max_plan_age_s"]
    if age is not None and (isinstance(age, bool) or not isinstance(age, (int, float)) or not math.isfinite(age) or age <= 0):
        raise ValueError("max_plan_age_s must be finite positive seconds or null")
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


# Limit handling of the simulated plant (Felix, 2026-10-23). Defaults: clip on, stop on all.
STOP_QUANTITIES = ("position", "velocity", "torque")
UNITS = dict(position="rad", velocity="rad/s", torque="Nm")


class LimitWatch:
    """Limit-breach detection on simulated values, at full rate.

    limits holds the raw URDF limits in native order (lower, upper, velocity,
    effort). Native command-law composition performs clipping when selected.
    A breach is judged on simulated values only: the
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
