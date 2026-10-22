"""Read-only captured data, independent of GATO, NumPy and CUDA."""
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any
from functools import cached_property
import math


def freeze(value: Any) -> Any:
    # Host-owned cached records are already recursively detached and immutable.
    if isinstance(value, MappingProxyType):
        return value
    if isinstance(value, Mapping):
        return MappingProxyType({str(k): freeze(v) for k, v in value.items()})
    if hasattr(value, 'tolist'):
        return freeze(value.tolist())
    if isinstance(value, (list, tuple)):
        return tuple(freeze(v) for v in value)
    return value


def joint_index(joint: str | int, names=()) -> int:
    """Resolve a stable native joint name (or explicit direct-call index)."""
    if isinstance(joint, int) and not isinstance(joint, bool) and joint >= 0:
        return joint
    names = tuple(names) or tuple(f'arm_right_{i}_joint' for i in range(1, 8))
    try:
        return names.index(joint)
    except ValueError:
        raise ValueError(f'unknown native joint {joint!r}') from None


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def number(value: Any) -> float | None:
    return float(value) if finite(value) else None


@dataclass(frozen=True)
class InspectionContext:
    """Host selection, separate from a plot's user inputs. Times are episode seconds."""
    episode_cursor_s: float | None = None
    analysis_range: str = 'entire'
    # ``window`` bounds may be None on either side: an unbounded end follows
    # the retained history (Live growth), an unbounded start its first sample.
    visible_window: tuple[float | None, float | None] | None = None
    selected_solve_id: str | int | None = None
    sqp_iteration: int | str | None = None
    clock: str = 'episode_time'


@dataclass(frozen=True)
class SolveView:
    """Complete captured Solve; solver is only an explicitly attached local handle.

    A handle is mutable and is not a historical optimizer checkpoint. Ordinary
    recorded and backend contexts leave it None. Missing selected-iteration
    predictions stay missing; they never alias the final result.
    """
    raw: Mapping[str, Any]
    context: InspectionContext = field(default_factory=InspectionContext)
    solver: Any = None

    def __post_init__(self):
        object.__setattr__(self, 'raw', freeze(self.raw))

    @property
    def identity(self):
        return self.raw.get('id', self.raw.get('seq'))

    @property
    def stats(self) -> Mapping[str, Any]:
        return self.raw.get('stats', {})

    @property
    def iterations(self) -> tuple:
        return self.raw.get('iterations', ())

    @property
    def iteration_trace(self):
        """Optional read-only binary trace handle; never materialized by freeze."""
        return self.raw.get('iteration_trace')

    @property
    def prediction(self) -> Mapping[str, Any] | None:
        selected = self.context.sqp_iteration
        trace = self.raw.get('iteration_trace')
        if trace is not None:
            return freeze(trace.prediction(selected))
        if selected is None:
            return self.raw.get('prediction', self.raw) if ('prediction' in self.raw or 'q' in self.raw) else None
        if selected in ('seed', 0):
            return self.raw.get('seed')
        for item in self.iterations:
            if item.get('index') == selected:
                return item.get('prediction')
        return None

    @property
    def horizon_time_s(self) -> tuple:
        prediction = self.prediction or {}
        explicit = prediction.get('knot_time_s', prediction.get('time_s'))
        if explicit is not None:
            return tuple(explicit)
        count, dt = prediction.get('N', self.raw.get('N')), prediction.get('dt_s', self.raw.get('dt_s'))
        return tuple(i * dt for i in range(count)) if isinstance(count, int) and finite(dt) else ()

    @property
    def q(self) -> tuple:
        return (self.prediction or {}).get('q', ())

    @property
    def qd(self) -> tuple:
        prediction = self.prediction or {}
        return prediction.get('qd_rad_s', prediction.get('qd', ()))

    @property
    def torque_nm(self) -> tuple:
        return (self.prediction or {}).get('torque_nm', ())

    @property
    def diagnostics(self) -> Mapping[str, Any]:
        return self.raw.get('diagnostics', {})

    @property
    def joint_names(self) -> tuple[str, ...]:
        return self.raw.get('joint_names', tuple(f'arm_right_{i}_joint' for i in range(1, 8)))

    def has(self, path: str) -> bool:
        value: Any = self.prediction if path == 'prediction' else self.raw
        if path != 'prediction':
            for part in path.split('.'):
                value = value.get(part) if isinstance(value, Mapping) else None
        return value is not None and value != () and value != {}


@dataclass(frozen=True)
class EpisodeView:
    """An MPC episode with all retained fields and bounded analysis helpers."""
    raw: Mapping[str, Any]
    context: InspectionContext = field(default_factory=InspectionContext)
    solver: Any = None

    def __post_init__(self):
        object.__setattr__(self, 'raw', freeze(self.raw))

    @property
    def all_states(self) -> tuple:
        return self.raw.get('states', ())

    @cached_property
    def bounds(self) -> tuple[float, float] | None:
        times = [s.get('sim_time_s') for s in self.all_states if finite(s.get('sim_time_s'))]
        if not times:
            return None
        lo, hi = min(times), max(times)
        if self.context.analysis_range == 'through_cursor' and finite(self.context.episode_cursor_s):
            hi = min(hi, self.context.episode_cursor_s)
        elif self.context.analysis_range in ('window', 'visible_window', 'visible') and self.context.visible_window:
            start, end = self.context.visible_window
            lo, hi = max(lo, start) if finite(start) else lo, min(hi, end) if finite(end) else hi
        return lo, hi

    def in_range(self, timestamp: Any) -> bool:
        bounds = self.bounds
        return finite(timestamp) and (bounds is None or bounds[0] <= timestamp <= bounds[1])

    @cached_property
    def states(self) -> tuple:
        return tuple(s for s in self.all_states if self.in_range(s.get('sim_time_s')))

    @cached_property
    def plans(self) -> tuple:
        return tuple(s for s in self.raw.get('plans', ()) if self.in_range(s.get('sim_time_s')))

    @cached_property
    def intervals(self) -> tuple:
        bounds = self.bounds
        return tuple(s for s in self.raw.get('intervals', ()) if bounds is None or
                     (s.get('end_time_s', -math.inf) > bounds[0] and s.get('start_time_s', math.inf) < bounds[1]))

    @property
    def selected_solve(self) -> SolveView | None:
        for plan in self.raw.get('plans', ()):
            if plan.get('id', plan.get('seq')) == self.context.selected_solve_id:
                return SolveView(plan, self.context)
        return None

    @property
    def time_s(self) -> tuple:
        return tuple(state['sim_time_s'] for state in self.states)

    @property
    def q(self) -> tuple:
        return tuple(state.get('q') for state in self.states)

    @property
    def qd(self) -> tuple:
        return tuple(state.get('qd', state.get('qd_rad_s')) for state in self.states)

    @property
    def joint_names(self) -> tuple[str, ...]:
        return self.raw.get('joint_names', tuple(f'arm_right_{i}_joint' for i in range(1, 8)))

    def has(self, path: str) -> bool:
        if path in ('states', 'plans', 'intervals'):
            return bool(getattr(self, path))
        parts = path.split('.')
        if parts[0] in ('states', 'plans', 'intervals'):
            return any(_has(item, parts[1:]) for item in getattr(self, parts[0]))
        return _has(self.raw, parts)


def _has(value, parts):
    for part in parts:
        value = value.get(part) if isinstance(value, Mapping) else None
    return value is not None and value != () and value != {}


Episode = EpisodeView
Solve = SolveView
