"""PlotSpec v1 constructors and strict JSON/shape validation."""
from __future__ import annotations
from typing import Any, Literal, TypedDict
import json
import math
from .views import finite


class Axis(TypedDict, total=False):
    identity: Literal['episode_time', 'sqp_iteration', 'prediction_time', 'wall_time', 'numeric', 'category']
    label: str
    unit: str
    clock: str


class Series(TypedDict, total=False):
    label: str
    x: list[float]
    y: list[float | None]
    style: Literal['line', 'step', 'bar']
    color: str
    bin_edges: list[float]
    hover: list[str | None]


class PlotSpec(TypedDict, total=False):
    version: int
    kind: Literal['lines', 'bars', 'table', 'spans', 'unavailable']
    title: str
    x: Axis
    y: dict[str, str]
    series: list[Series]
    rows: list[dict[str, Any]]
    notes: list[str]
    guides: list[dict[str, Any]]
    spans: list[dict[str, Any]]
    bands: list[dict[str, Any]]
    message: str


def lines(title, series, *, identity='episode_time', x_label='Episode time', x_unit='s', y_label='', unit='', guides=(), notes=(), kind='lines') -> PlotSpec:
    return dict(version=1, kind=kind, title=title, x=dict(identity=identity, label=x_label, unit=x_unit),
                y=dict(label=y_label, unit=unit), series=list(series), guides=list(guides), notes=list(notes))


def series(label, x, y, *, style='line', color=None) -> Series:
    result = dict(label=label, x=list(x), y=list(y), style=style)
    if color is not None:
        result['color'] = color
    return result


def table(title, rows, *, notes=()) -> PlotSpec:
    return dict(version=1, kind='table', title=title, rows=list(rows), notes=list(notes))


def unavailable(title, message) -> PlotSpec:
    return dict(version=1, kind='unavailable', title=title, message=message, notes=[])


def validate_spec(spec: Any) -> PlotSpec:
    """Validate shape and finite JSON values; gaps must be explicit nulls.

    Return a detached plain JSON dict. No HTML, JavaScript, callbacks or custom
    objects are accepted. This establishes structure, not metric correctness.
    """
    def require(test, message):
        if not test:
            raise ValueError(f'PlotSpec: {message}')
    require(isinstance(spec, dict), 'expected a dictionary')
    allowed = {'version', 'kind', 'title', 'x', 'y', 'series', 'rows', 'notes', 'guides', 'spans', 'bands', 'message'}
    require(not spec.keys() - allowed, f'unsupported fields {sorted(spec.keys() - allowed)}')
    require(spec.get('version') == 1, 'version must be 1')
    kind = spec.get('kind')
    require(kind in ('lines', 'bars', 'table', 'spans', 'unavailable'), 'unsupported kind')
    require(isinstance(spec.get('title'), str), 'title must be text')
    require(isinstance(spec.get('notes', []), list) and all(isinstance(x, str) for x in spec.get('notes', [])), 'notes must be strings')
    if kind in ('lines', 'bars', 'spans'):
        axis = spec.get('x', {})
        require(isinstance(axis, dict) and axis.get('identity') in ('episode_time', 'sqp_iteration', 'prediction_time', 'wall_time', 'numeric', 'category'), 'invalid x axis identity')
        require(all(isinstance(axis.get(key), str) for key in ('label', 'unit')), 'x label/unit must be text')
    if kind in ('lines', 'bars'):
        axis = spec.get('y', {})
        require(isinstance(axis, dict) and all(isinstance(axis.get(key), str) for key in ('label', 'unit')), 'y label/unit must be text')
        require(isinstance(spec.get('series'), list), 'series must be an array')
        for index, item in enumerate(spec['series']):
            require(isinstance(item, dict) and isinstance(item.get('label'), str), f'series {index} needs label')
            require(not item.keys() - {'label', 'x', 'y', 'style', 'color', 'bin_edges', 'hover'}, f'series {index} has unsupported fields')
            if 'hover' in item:
                require(isinstance(item['hover'], list) and len(item['hover']) == len(item['y']) and
                        all(v is None or isinstance(v, str) for v in item['hover']), f'series {index} hover must be text per sample')
            require(item.get('style', 'line') in ('line', 'step', 'bar'), f'series {index} invalid style')
            require(isinstance(item.get('x'), list) and isinstance(item.get('y'), list), f'series {index} x/y must be arrays')
            require(len(item['x']) == len(item['y']), f'series {index} x/y length mismatch')
            require(all(finite(v) or (spec['x']['identity'] == 'category' and isinstance(v, str)) for v in item['x']), f'series {index} x must be finite')
            require(all(v is None or finite(v) for v in item['y']), f'series {index} y must be finite or null')
            if 'bin_edges' in item:
                edges = item['bin_edges']
                require(kind == 'bars' and isinstance(edges, list) and len(edges) == len(item['y']) + 1, f'series {index} bin edges length mismatch')
                require(all(finite(v) for v in edges) and all(a < b for a, b in zip(edges, edges[1:])), f'series {index} bin edges must be finite and increasing')
        for guide in spec.get('guides', []):
            require(isinstance(guide, dict) and guide.get('axis') == 'y' and finite(guide.get('value')) and isinstance(guide.get('label'), str), 'invalid guide')
            require(guide.get('style', 'dashed') in ('dashed', 'hard'), 'guide style must be dashed or hard')
        for band in spec.get('bands', []):
            require(isinstance(band, dict) and band.get('axis') == 'y' and band.get('tone') in ('near', 'beyond'), 'band needs y axis and tone near/beyond')
            require(all(band.get(key) is None or finite(band.get(key)) for key in ('start', 'end')) and
                    (band.get('start') is None or band.get('end') is None or band['start'] < band['end']), 'band start/end must be ordered numbers or null')
            require(isinstance(band.get('label', ''), str), 'band label must be text')
        span = spec['y'].get('span')
        require(span is None or (isinstance(span, list) and len(span) == 2 and all(finite(v) for v in span) and span[0] < span[1]), 'y span must be [low, high]')
    if kind == 'table':
        require(isinstance(spec.get('rows'), list), 'rows must be an array')
        for row in spec['rows']:
            require(isinstance(row, dict) and isinstance(row.get('label'), str), 'table row needs label')
            require(not row.keys() - {'label', 'value', 'unit', 'note'}, 'unsupported table row field')
            require(row.get('value') is None or isinstance(row.get('value'), (str, bool)) or finite(row.get('value')), 'invalid table value')
            require(all(isinstance(row.get(key, ''), str) for key in ('unit', 'note')), 'row unit/note must be text')
    if kind == 'spans':
        require(isinstance(spec.get('spans'), list), 'spans must be an array')
        for item in spec['spans']:
            require(isinstance(item, dict) and finite(item.get('start')) and finite(item.get('end')) and item['end'] >= item['start'], 'invalid span bounds')
            require(isinstance(item.get('lane'), str) and isinstance(item.get('label'), str), 'span needs lane/label')
    if kind == 'unavailable':
        require(isinstance(spec.get('message'), str), 'unavailable needs message')
    def check_json(value):
        if value is None or isinstance(value, (str, bool)):
            return
        if isinstance(value, (int, float)):
            require(math.isfinite(value), 'nonfinite JSON number; use null')
        elif isinstance(value, list):
            for item in value: check_json(item)
        elif isinstance(value, dict):
            require(all(isinstance(key, str) for key in value), 'JSON object keys must be strings')
            for item in value.values(): check_json(item)
        else:
            require(False, f'unsupported JSON value {type(value).__name__}')
    check_json(spec)
    return json.loads(json.dumps(spec, allow_nan=False))
