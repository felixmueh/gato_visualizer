"""Joint limit use against the physical (URDF / scene) limits.

Utilisation is a fraction of the physical limit: position |q - centre| / half
range, velocity |qd| / limit, torque |tau| / effort. Distance to the bound is
in physical units, positive inside and negative beyond. The tighter MPC bounds
(``raw['joint_limits']`` in Live) are not the reference.

The single Python definition; ``src/limit-use.js`` mirrors it for the 3D tint
and the Joints gauges, and ``tests/fixtures/limit_use_cases.json`` checks that
both agree. ``limit_settings`` is the single seam through which plotters
receive the configurable thresholds: the browser sends its current
presentation settings as the plot request's ``limit_settings``, and the plot
service places them in ``raw['limit_settings']``.
"""
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass
from .views import finite

QUANTITIES = ('position', 'velocity', 'torque')
UNITS = dict(position='rad', velocity='rad/s', torque='Nm')

# Presentation defaults (Felix, 2026-10-22), configurable in Settings > UI.
LIMIT_DEFAULTS = dict(limit_near_percent=90., limit_at_position_rad=.003,
                      limit_at_velocity_rad_s=.01, limit_at_torque_percent=.2)
# Inclusive ranges, shared by the presentation settings and plot requests.
LIMIT_RANGES = dict(limit_near_percent=(1, 100), limit_at_position_rad=(0, .1),
                    limit_at_velocity_rad_s=(0, 1), limit_at_torque_percent=(0, 10))


def validate_limit_settings(value: Mapping | None = None) -> dict:
    """Complete thresholds; omitted fields take their defaults, others must be in range."""
    value = {} if value is None else value
    if not isinstance(value, Mapping) or set(value) - set(LIMIT_DEFAULTS):
        raise ValueError('limit settings accept only ' + ', '.join(LIMIT_DEFAULTS))
    result = {**LIMIT_DEFAULTS, **value}
    for name, (low, high) in LIMIT_RANGES.items():
        if not finite(result[name]) or not low <= result[name] <= high:
            raise ValueError(f'{name} must be finite within [{low}, {high}]')
    return {name: float(result[name]) for name in LIMIT_DEFAULTS}


def limit_settings(raw: Mapping) -> dict:
    """Thresholds for limit states: the defaults, overridden by the request's
    current presentation settings in ``raw['limit_settings']``."""
    result = dict(LIMIT_DEFAULTS)
    supplied = raw.get('limit_settings') if isinstance(raw, Mapping) else None
    if isinstance(supplied, Mapping):
        result.update({key: float(value) for key, value in supplied.items() if key in result and finite(value)})
    return result


def physical_limits(raw: Mapping) -> dict | None:
    """The scene's joint_limits, normalised; None when the source has none."""
    limits = raw.get('scene_joint_limits')
    if not limits and isinstance(raw.get('scene'), Mapping):
        limits = raw['scene'].get('joint_limits')
    if not isinstance(limits, Mapping) or not limits:
        return None
    pick = lambda *keys: next((limits[k] for k in keys if limits.get(k) is not None), None)
    return dict(lower=pick('lower_position_rad', 'q_min', 'lower'), upper=pick('upper_position_rad', 'q_max', 'upper'),
                velocity=pick('velocity_rad_s', 'qd_max', 'velocity'), effort=pick('effort_nm', 'torque_max', 'u_max', 'effort'))


@dataclass(frozen=True)
class LimitUse:
    quantity: str
    fraction: float      # 1.0 is the physical limit
    distance: float      # physical units, positive inside
    bound: str           # 'lower bound', 'upper bound', 'velocity limit', 'effort limit'


def _at(limits, key, joint):
    values = limits.get(key) if limits else None
    return float(values[joint]) if values is not None and len(values) > joint and finite(values[joint]) else None


def limit_use(quantity: str, value, joint: int, limits: Mapping | None) -> LimitUse | None:
    """Limit use of one recorded value, or None without a value or a valid limit."""
    if not finite(value) or limits is None:
        return None
    value = float(value)
    if quantity == 'position':
        lower, upper = _at(limits, 'lower', joint), _at(limits, 'upper', joint)
        if lower is None or upper is None or not upper > lower:
            return None
        centre, half = (upper + lower) / 2, (upper - lower) / 2
        upper_side = value >= centre
        return LimitUse(quantity, abs(value - centre) / half, upper - value if upper_side else value - lower,
                        'upper bound' if upper_side else 'lower bound')
    key, bound = dict(velocity=('velocity', 'velocity limit'), torque=('effort', 'effort limit'))[quantity]
    limit = _at(limits, key, joint)
    if limit is None or not limit > 0:
        return None
    return LimitUse(quantity, abs(value) / limit, limit - abs(value), bound)


def at_tolerance(quantity: str, joint: int, limits: Mapping, settings: Mapping) -> float:
    if quantity == 'position':
        return settings['limit_at_position_rad']
    if quantity == 'velocity':
        return settings['limit_at_velocity_rad_s']
    effort = _at(limits, 'effort', joint)
    return settings['limit_at_torque_percent'] / 100 * effort if effort is not None else 0.


def limit_state(use: LimitUse | None, tolerance: float, settings: Mapping) -> str | None:
    """'beyond', 'at', 'near' or 'inside'; at and beyond take precedence over near."""
    if use is None:
        return None
    if use.distance < -tolerance:
        return 'beyond'
    if abs(use.distance) <= tolerance:
        return 'at'
    return 'near' if use.fraction * 100 >= settings['limit_near_percent'] else 'inside'
