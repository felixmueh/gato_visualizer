"""Read-only multi-episode views and retained numeric channel discovery.

Offsets place episodes on session seconds; they never rewrite recorded clocks.
The generic channel accessor reads timed records, not arbitrary solver objects.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import cached_property
import math

from .views import EpisodeView, InspectionContext, finite, freeze

BUCKETS = ('states', 'torque_samples', 'controls', 'intervals', 'plans')
MAX_CHANNELS = 2048


def timestamp(record, bucket):
    """Use the record's own clock, including interval start and plan input time."""
    value = record.get('sim_time_s', record.get('start_time_s') if bucket == 'intervals' else None)
    return float(value) if finite(value) else None


def _leaves(value, prefix='', depth=0):
    if depth > 6:
        return
    if finite(value):
        yield prefix
    elif isinstance(value, Mapping):
        for key, item in value.items():
            if isinstance(key, str) and '.' not in key:
                yield from _leaves(item, f'{prefix}.{key}' if prefix else key, depth+1)
    elif isinstance(value, (tuple, list)) and len(value) <= 128:
        # Numeric vectors are channels; prediction matrices are not timed samples.
        for index, item in enumerate(value):
            if finite(item):
                yield f'{prefix}.{index}'


def _get(record, path):
    for part in path:
        if isinstance(record, Mapping):
            record = record.get(part)
        elif isinstance(record, (tuple, list)) and part.isdigit() and int(part) < len(record):
            record = record[int(part)]
        else:
            return None
    return float(record) if finite(record) else None


def record_channel_paths(bucket, record):
    if timestamp(record, bucket) is not None:
        return {f'{bucket}.{leaf}' for leaf in _leaves(record)}
    return set()


def discover_channel_paths(raw):
    found = set()
    for bucket in BUCKETS:
        for record in raw.get(bucket, ()):
            found.update(record_channel_paths(bucket, record))
    return tuple(sorted(found)[:MAX_CHANNELS])


def channel_unit(path):
    parts = path.split('.')
    names = set(parts[1:])
    if names & {'q', 'q_rad'}:
        return 'rad'
    if names & {'qd', 'qd_rad_s'}:
        return 'rad/s'
    if names & {'ee_xyz', 'target_xyz', 'distance_m', 'position_error_m'}:
        return 'm'
    for part in reversed(parts):
        for suffix, unit in (('_rad_s', 'rad/s'), ('_nm', 'Nm'), ('_s', 's'), ('_rad', 'rad'), ('_m', 'm')):
            if part.endswith(suffix):
                return unit
    return ''


def intersect(bounds, window):
    if bounds is None:
        return None
    lo = max(bounds[0], window[0]) if window and window[0] is not None else bounds[0]
    hi = min(bounds[1], window[1]) if window and window[1] is not None else bounds[1]
    return (lo, hi) if lo <= hi else None


@dataclass(frozen=True)
class ComparisonRun:
    key: str
    label: str
    episode: EpisodeView
    offset_s: float = 0.
    color: str = '#6fa8ff'
    source: Mapping = field(default_factory=dict)
    error: str | None = None

    def __post_init__(self):
        object.__setattr__(self, 'source', freeze(self.source))

    @cached_property
    def bounds(self):
        bounds = EpisodeView(self.episode.raw).bounds
        return None if bounds is None else tuple(t+self.offset_s for t in bounds)

    @property
    def metadata(self):
        raw = self.episode.raw
        scene = raw.get('scene', {})
        return raw.get('segment', scene.get('retained_replay', {}).get('metadata', {}))

    def channel(self, key):
        bucket, _, tail = key.partition('.')
        if bucket not in BUCKETS or not tail:
            return ()
        values = []
        for record in self.episode.raw.get(bucket, ()):
            time = timestamp(record, bucket)
            if time is not None:
                values.append((time+self.offset_s, _get(record, tail.split('.'))))
        return tuple(values)


@dataclass(frozen=True)
class ComparisonView:
    runs: tuple[ComparisonRun, ...]
    context: InspectionContext = field(default_factory=lambda: InspectionContext(clock='session:comparison'))

    def __post_init__(self):
        object.__setattr__(self, 'runs', tuple(self.runs))

    @cached_property
    def available_runs(self):
        return tuple(run for run in self.runs if run.bounds is not None and not run.error)

    @cached_property
    def window(self):
        if self.context.analysis_range == 'through_cursor':
            return None, self.context.episode_cursor_s
        return self.context.visible_window if self.context.analysis_range in ('window', 'visible') else None

    @cached_property
    def bounds(self):
        spans = [run.bounds for run in self.available_runs]
        return intersect((min(b[0] for b in spans), max(b[1] for b in spans)), self.window) if spans else None

    @cached_property
    def common_bounds(self):
        spans = [run.bounds for run in self.available_runs]
        return intersect((max(b[0] for b in spans), min(b[1] for b in spans)), self.window) if len(spans) >= 2 else None

    def run_bounds(self, run):
        return intersect(run.bounds, self.window)

    @cached_property
    def channels(self):
        found = {}
        for run in self.available_runs:
            run_keys = run.episode.raw.get('numeric_channel_paths')
            if run_keys is None:
                run_keys = discover_channel_paths(run.episode.raw)
            for key in run_keys:
                if key not in found:
                    if len(found) >= MAX_CHANNELS:
                        continue
                    unit = channel_unit(key)
                    found[key] = dict(value=key, label=key+(f' ({unit})' if unit else ''), unit=unit, runs=[])
                found[key]['runs'].append(run.key)
        return tuple(found[key] for key in sorted(found))

    def has(self, path):
        if path == 'runs':
            return len(self.available_runs) >= 2
        return sum(run.episode.has(path) for run in self.available_runs) >= 2


def clipped_segments(samples, bounds):
    """Consecutive valid pairs, clipped linearly; nulls break the signal.

    No extrapolation or position-derived velocity. Repeated/nonincreasing clocks
    do not create integration intervals. Each pair remains tied to real samples.
    """
    if bounds is None:
        return
    for (t0, y0), (t1, y1) in zip(samples, samples[1:]):
        if y0 is None or y1 is None or t1 <= t0:
            continue
        lo, hi = max(t0, bounds[0]), min(t1, bounds[1])
        if hi <= lo:
            continue
        slope = (y1-y0)/(t1-t0)
        yield lo, hi, y0+slope*(lo-t0), y0+slope*(hi-t0)


def signal_rms(samples, bounds):
    """Exact integral of squared piecewise-linear scalar samples / valid time."""
    duration = square = 0.
    for lo, hi, a, b in clipped_segments(samples, bounds):
        duration += hi-lo
        square += (hi-lo)*(a*a+a*b+b*b)/3
    return (math.sqrt(max(0., square/duration)) if duration else None), duration
