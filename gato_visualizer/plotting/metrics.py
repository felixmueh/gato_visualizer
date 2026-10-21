"""Small reusable numerical helpers; absent measurements stay absent."""
from __future__ import annotations
from collections.abc import Mapping
import math
from .views import finite, number


def quantile(values, fraction):
    values = sorted(float(v) for v in values if finite(v))
    if not values:
        return None
    position = (len(values) - 1) * fraction
    lo, hi = math.floor(position), math.ceil(position)
    return values[lo] + (values[hi] - values[lo]) * (position - lo)


def histogram(values, bins=10):
    """Return explicit bin centres/counts/edges; include the maximum in the last bin."""
    values = [float(v) for v in values if finite(v)]
    if not isinstance(bins, int) or bins < 1:
        raise ValueError('bins must be a positive integer')
    if not values:
        return [], [], []
    lo, hi = min(values), max(values)
    if hi == lo:
        width = max(abs(lo) * .1, 1.)
        lo, hi = lo - width / 2, hi + width / 2
    width = (hi - lo) / bins
    counts = [0] * bins
    for value in values:
        counts[min(bins - 1, max(0, int((value - lo) / width)))] += 1
    return [lo + (i + .5) * width for i in range(bins)], counts, [lo + i * width for i in range(bins + 1)]


def distance(state):
    if finite(state.get('distance_m')):
        return float(state['distance_m'])
    actual, target = state.get('ee_xyz'), state.get('target_xyz')
    if actual is not None and target is not None and len(actual) == len(target) == 3 and all(finite(v) for v in (*actual, *target)):
        return math.dist(actual, target)
    return None


def path_length(points):
    total, count = 0., 0
    for a, b in zip(points, points[1:]):
        if a is not None and b is not None and len(a) == len(b) == 3 and all(finite(v) for v in (*a, *b)):
            total += math.dist(a, b)
            count += 1
    return total if count else None


def peak(rows):
    values = [abs(v) for row in rows if row is not None for v in row if finite(v)]
    return max(values) if values else None


def interval_severity(interval):
    budget = interval.get('to_budget_s', interval.get('budget_s'))
    mpc = interval.get('solve_wall_s', interval.get('mpc_wall_s'))
    physics = interval.get('physics_wall_s', interval.get('simulation_wall_s'))
    total = interval.get('total_wall_s')
    span = interval.get('end_time_s', 0) - interval.get('start_time_s', 0)
    if finite(mpc) and finite(budget) and mpc > budget:
        return 'mpc'
    if finite(physics) and physics > span:
        return 'physics'
    if finite(total) and total > span:
        return 'combined_only'
    return 'normal'


def interval_coverage(intervals, bounds=None):
    """Union coverage by severity; MPC takes priority over physics/combined overlap."""
    events = []
    for item in intervals:
        start, end = item.get('start_time_s'), item.get('end_time_s')
        if not finite(start) or not finite(end):
            continue
        if bounds:
            start, end = max(start, bounds[0]), min(end, bounds[1])
        if end > start:
            severity = interval_severity(item)
            events.extend([(start, severity, 1), (end, severity, -1)])
    durations = dict(mpc=0., physics=0., combined_only=0., normal=0.)
    active = dict.fromkeys(durations, 0)
    previous = None
    for timestamp, severity, delta in sorted(events):
        if previous is not None:
            winner = next((key for key in active if active[key]), None)
            if winner:
                durations[winner] += timestamp - previous
        active[severity] += delta
        previous = timestamp
    durations['covered_s'] = sum(durations.values())
    return durations


def joint_value(record, key, joint):
    values = record.get(key)
    if key == 'qd' and values is None:
        values = record.get('qd_rad_s')
    return number(values[joint]) if values is not None and len(values) > joint else None


def bound_values(limits: Mapping, quantity: str, joint: int):
    """Native historical bounds only; never infer current robot limits."""
    aliases = {'q': (('q_min', 'lower', 'lower_position_rad'), ('q_max', 'upper', 'upper_position_rad')),
               'qd': (('qd_min',), ('qd_max', 'velocity', 'velocity_rad_s')),
               'torque_nm': (('torque_min', 'u_min'), ('torque_max', 'u_max', 'effort', 'effort_nm'))}
    result = []
    for side, keys in enumerate(aliases[quantity]):
        value = next((limits[k] for k in keys if limits.get(k) is not None), None)
        if value is not None and len(value) > joint:
            result.append(('Lower bound' if side == 0 else 'Upper bound', number(value[joint])))
    if quantity != 'q' and len(result) == 1 and result[0][0] == 'Upper bound':
        result.insert(0, ('Lower bound', -result[0][1] if result[0][1] is not None else None))
    return result
