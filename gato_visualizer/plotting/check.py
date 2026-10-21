"""Offline author harness: python -m gato_visualizer.plotting.check --help."""
from __future__ import annotations
import argparse
import base64
import html
import json
from pathlib import Path
import sys

from . import Registry
from .fixtures import example_episode, example_solve

ROOT = Path(__file__).resolve().parents[2]


def preview_html(spec, renderer_path):
    """Embed the app's exact renderer; no second chart implementation or network."""
    renderer = Path(renderer_path).read_text(encoding='utf-8')
    module_url = 'data:text/javascript;base64,' + base64.b64encode(renderer.encode()).decode()
    payload = json.dumps(spec, allow_nan=False).replace('<', '\\u003c')
    return ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            '<title>' + html.escape(spec['title']) + '</title><style>body{font:15px system-ui;background:#141b24;color:#eee;margin:24px}'
            '#plot{max-width:1100px;min-height:300px}svg{width:100%;height:auto}</style><main id="plot"></main>'
            '<script type="module">import {renderPlot} from ' + json.dumps(module_url) + ';\n'
            'renderPlot(document.getElementById("plot"),' + payload + ');</script>')


def check_expectation(spec, expression):
    """Assert an explicit JSON value via a dotted dictionary/list path."""
    path, separator, encoded = expression.partition('=')
    if not separator:
        raise ValueError('--expect needs dotted.path=JSON')
    value = spec
    for component in path.split('.'):
        value = value[int(component)] if isinstance(value, list) else value[component]
    expected = json.loads(encoded)
    if isinstance(expected, (int, float)) and not isinstance(expected, bool) and isinstance(value, (int, float)):
        import math
        passed = math.isclose(value, expected, rel_tol=1e-9, abs_tol=1e-12)
    else:
        passed = value == expected
    if not passed:
        raise AssertionError(f'{path}: expected {expected!r}, got {value!r}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', nargs='?', type=Path, help='Additional plot .py file or directory (bundled plots always loaded)')
    parser.add_argument('--plot', help='Select definition id; defaults to all compatible plots')
    parser.add_argument('--fixture', choices=('episode', 'solve', 'episode-missing', 'solve-missing'), default='episode')
    parser.add_argument('--inputs', default='{}', help='Plot user inputs as a JSON object')
    parser.add_argument('--expect', action='append', default=[], help='Numerical/content assertion, e.g. series.0.y.0=20')
    parser.add_argument('--output', type=Path, default=ROOT / '_expr_data' / 'plot-check')
    parser.add_argument('--renderer', type=Path, default=ROOT / 'src' / 'plot-renderer.js')
    parser.add_argument('--no-preview', action='store_true', help='Save JSON only')
    parser.add_argument('--iteration', help='Solve SQP selection, integer index or seed; default is final')
    args = parser.parse_args(argv)
    failures = 0
    registry = Registry().load_directory(ROOT / 'plotters')
    if args.path:
        if args.path.is_file():
            registry.load_file(args.path)
        else:
            registry.load_directory(args.path)
    for error in registry.errors:
        print(f'IMPORT FAIL {error["source"]}: {error["error"]}', file=sys.stderr)
        failures += 1
    from . import InspectionContext
    iteration = 'seed' if args.iteration == 'seed' else int(args.iteration) if args.iteration is not None else None
    context = InspectionContext(sqp_iteration=iteration)
    scope = args.fixture.split('-')[0]
    view = (example_episode if scope == 'episode' else example_solve)(missing=args.fixture.endswith('-missing'), context=context)
    try:
        inputs = json.loads(args.inputs)
        if not isinstance(inputs, dict):
            raise ValueError('--inputs must be a JSON object')
        definitions = [item for item in registry.catalog(scope, view) if args.plot is None or item['id'] == args.plot]
        if not definitions:
            raise ValueError(f'No {scope} plot matches {args.plot!r}')
        if args.expect and len(definitions) != 1:
            raise ValueError('--expect requires exactly one --plot')
        args.output.mkdir(parents=True, exist_ok=True)
        for definition in definitions:
            identity = definition['id']
            try:
                spec = registry.evaluate(identity, view, inputs)
                for expression in args.expect:
                    check_expectation(spec, expression)
                safe_name = ''.join(c if c.isalnum() or c in '._-' else '_' for c in identity)
                (args.output / f'{safe_name}.json').write_text(json.dumps(spec, indent=2, allow_nan=False) + '\n')
                if not args.no_preview:
                    (args.output / f'{safe_name}.html').write_text(preview_html(spec, args.renderer), encoding='utf-8')
                print(f'PASS {identity}: {spec["kind"]} -> {args.output / safe_name}')
            except Exception as error:
                print(f'FAIL {identity}: {type(error).__name__}: {error}', file=sys.stderr)
                failures += 1
    except Exception as error:
        print(f'FAIL {type(error).__name__}: {error}', file=sys.stderr)
        failures += 1
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
