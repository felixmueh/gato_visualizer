"""Ordinary Python functions with discoverable metadata and isolated imports."""
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
import importlib.util
import inspect
import math
import sys
import uuid


@dataclass(frozen=True)
class Number:
    default: float = 0.0
    label: str = ''
    unit: str = ''
    minimum: float | None = None
    maximum: float | None = None


@dataclass(frozen=True)
class Joint:
    """Stable native joint name; direct functions may also accept an index."""
    default: str = 'arm_right_1_joint'
    label: str = 'Joint'
    count: int = 7
    unit: str = ''


@dataclass(frozen=True)
class Boolean:
    default: bool = False
    label: str = ''
    unit: str = ''


@dataclass(frozen=True)
class Choice:
    """One of ``choices``; optional display ``labels`` in the same order.

    ``disabled_when`` maps an option to the other inputs' values that exclude
    it, e.g. ``{'all': {'quantity': 'all'}}``: the browser disables that option
    and evaluation rejects the combination.
    """
    choices: tuple = ()
    default: Any = None
    label: str = ''
    unit: str = ''
    labels: tuple = ()
    disabled_when: Mapping = field(default_factory=dict)


def _decorate(scope, *, id=None, title=None, description='', requires=(), optional=(), inputs=None):
    def apply(function):
        controls = dict(inputs or {})
        # Typed defaults are a convenient author shorthand; the wrapper is never replaced.
        for name, param in inspect.signature(function).parameters.items():
            if isinstance(param.default, (Number, Joint, Boolean, Choice)):
                controls.setdefault(name, param.default)
        function.__plot_definition__ = dict(id=id or function.__name__, title=title or function.__name__.replace('_', ' ').title(),
                                            description=description, scope=scope, requires=tuple(requires), optional=tuple(optional), inputs=controls)
        return function
    return apply


def plot_episode(function=None, **metadata):
    """Annotate an episode plot, preserving the original callable and signature."""
    decorate = _decorate('episode', **metadata)
    return decorate(function) if function is not None else decorate


def plot_solve(function=None, **metadata):
    """Annotate a Solve plot. Requirements are availability hints, not permissions."""
    decorate = _decorate('solve', **metadata)
    return decorate(function) if function is not None else decorate


def _input_dict(control):
    from dataclasses import asdict
    result = asdict(control)
    result['type'] = type(control).__name__.lower()
    if isinstance(control, Joint):
        result['choices'] = [f'arm_right_{i}_joint' for i in range(1, control.count + 1)]
        result.pop('count', None)
    if isinstance(control, Choice):
        result['choices'] = ([dict(value=value, label=label) for value, label in zip(control.choices, control.labels)]
                             if control.labels else list(control.choices))
        result.pop('labels', None)
        if control.disabled_when:
            result['disabled_when'] = {str(k): dict(v) for k, v in control.disabled_when.items()}
        else:
            result.pop('disabled_when', None)
    if 'minimum' in result:
        result['min'] = result.pop('minimum')
    if 'maximum' in result:
        result['max'] = result.pop('maximum')
    return result


def _checked_input(name, control, value):
    if isinstance(control, Boolean):
        valid = isinstance(value, bool)
    elif isinstance(control, Choice):
        valid = value in control.choices
    elif isinstance(control, Joint):
        valid = isinstance(value, str) and value in [f'arm_right_{i}_joint' for i in range(1, control.count + 1)]
    elif isinstance(control, Number):
        valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        valid = valid and (control.minimum is None or value >= control.minimum) and (control.maximum is None or value <= control.maximum)
    else:
        raise ValueError(f'{name}: unsupported input definition')
    if not valid:
        raise ValueError(f'{name}: invalid value {value!r}')
    return value


class Registry:
    """Process-local plot catalog. Plugin code is trusted local Python, not sandboxed."""
    def __init__(self):
        self.definitions: dict[str, dict] = {}
        self.errors: list[dict[str, str]] = []

    def register(self, function: Callable, source='local'):
        metadata = dict(getattr(function, '__plot_definition__', {}))
        if not metadata:
            raise ValueError('function has no @plot_episode/@plot_solve metadata')
        identity = metadata['id']
        if identity in self.definitions:
            raise ValueError(f'duplicate plot id {identity!r}; existing source {self.definitions[identity]["source"]}')
        metadata.update(function=function, source=str(source))
        self.definitions[identity] = metadata
        return function

    def load_directory(self, directory: str | Path):
        """Load .py files independently. Missing directories are harmless."""
        path = Path(directory)
        if not path.is_dir():
            return self
        for filename in sorted(path.glob('*.py')):
            if not filename.name.startswith('_'):
                self.load_file(filename)
        return self

    def load_file(self, filename: str | Path):
        filename = Path(filename)
        module_name = f'_visualizer_plot_{uuid.uuid4().hex}'
        try:
            spec = importlib.util.spec_from_file_location(module_name, filename)
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
            seen = set()
            for value in vars(module).values():
                if callable(value) and hasattr(value, '__plot_definition__') and id(value) not in seen:
                    seen.add(id(value))
                    try:
                        self.register(value, filename)
                    except Exception as error:
                        self.errors.append(dict(source=str(filename), error=f'{type(error).__name__}: {error}'))
        except Exception as error:
            self.errors.append(dict(source=str(filename), error=f'{type(error).__name__}: {error}'))
        finally:
            sys.modules.pop(module_name, None)
        return self

    def catalog(self, scope: str, view=None) -> list[dict]:
        result = []
        for metadata in self.definitions.values():
            if metadata['scope'] != scope:
                continue
            item = {key: value for key, value in metadata.items() if key not in ('function', 'inputs')}
            item['inputs'] = {key: _input_dict(value) for key, value in metadata['inputs'].items()}
            item['missing'] = [path for path in metadata['requires'] if view is not None and not view.has(path)]
            item['available'] = not item['missing']
            result.append(item)
        return result

    def evaluate(self, plot_id: str, view, parameters: Mapping | None = None) -> dict:
        from .spec import validate_spec
        from .views import EpisodeView, SolveView
        definition = self.definitions[plot_id]
        expected = EpisodeView if definition['scope'] == 'episode' else SolveView
        if not isinstance(view, expected):
            raise ValueError(f'{plot_id} requires {definition["scope"]} context')
        controls, supplied = definition['inputs'], dict(parameters or {})
        unknown = supplied.keys() - controls.keys()
        if unknown:
            raise ValueError(f'unknown inputs: {", ".join(sorted(unknown))}')
        values = {name: _checked_input(name, control, supplied.get(name, control.default)) for name, control in controls.items()}
        for name, control in controls.items():
            for other in (control.disabled_when.get(values[name], {}) if isinstance(control, Choice) else {}).items():
                if values.get(other[0]) == other[1]:
                    raise ValueError(f'{name}={values[name]!r} is unavailable with {other[0]}={other[1]!r}')
        result = definition['function'](view, **values)
        result = validate_spec(result)
        if result.get('x', {}).get('identity') == 'episode_time':
            result['x']['clock'] = view.context.clock
        return result
