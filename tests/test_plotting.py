"""CPU-only author examples: structure validation AND independent known answers."""
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from gato_visualizer.plotting import (
    Boolean, Choice, EpisodeView, InspectionContext, Joint, Number, Registry,
    SolveView, lines, plot_episode, series, validate_spec,
)
from gato_visualizer.plotting.check import check_expectation, preview_html
from gato_visualizer.plotting.fixtures import example_episode, example_solve
from gato_visualizer.plotting.metrics import histogram, interval_coverage

ROOT = Path(__file__).resolve().parents[1]


def standard_registry():
    return Registry().load_directory(ROOT / 'plotters')


def value(spec, label):
    return next(row['value'] for row in spec['rows'] if row['label'] == label)


class StandardPlotNumericTests(unittest.TestCase):
    def setUp(self):
        self.registry = standard_registry()
        self.assertEqual(self.registry.errors, [])
        self.episode = example_episode()
        self.solve = example_solve()

    def plot(self, identity, data=None, **inputs):
        return self.registry.evaluate(identity, data or self.episode, inputs)

    def test_timing_preserves_nonzero_origin_budgets_and_gaps(self):
        spec = self.plot('episode.timing')
        self.assertEqual(spec['x']['identity'], 'episode_time')
        self.assertEqual(spec['series'][0]['x'], [10., 10.1, 10.2, 10.3])
        self.assertEqual(spec['series'][0]['y'], [20., 60., 10., None])
        self.assertEqual(spec['series'][1]['y'], [50., 50., 50., None])
        physics = self.plot('episode.timing', component='physics')
        self.assertEqual(physics['series'][0]['y'], [10., 20., 110., None])
        combined = self.plot('episode.timing', component='combined')
        self.assertEqual(combined['series'][0]['y'], [40., 90., 120., None])
        separated = EpisodeView(dict(states=[dict(sim_time_s=10.), dict(sim_time_s=13.)], intervals=[
            dict(start_time_s=10., end_time_s=11., solve_wall_s=.1),
            dict(start_time_s=12., end_time_s=13., solve_wall_s=.2)]))
        curves = self.plot('episode.timing', separated)['series'][0]
        self.assertEqual(curves['x'], [10., 11., 12., 13.])
        self.assertEqual(curves['y'], [100., None, 200., None])

    def test_iterations_use_retained_counts_not_configured_caps(self):
        spec = self.plot('episode.iterations')
        self.assertEqual(spec['series'][0]['x'], [10., 10.2])
        self.assertEqual([s['y'] for s in spec['series']], [[2., 1.], [5., 2.], [3., 1.]])

    def test_orientation_error_uses_degrees_and_preserves_missing_samples(self):
        episode = EpisodeView(dict(states=[
            dict(sim_time_s=0., orientation_error_rad=math.pi / 2),
            dict(sim_time_s=1.),
            dict(sim_time_s=2., orientation_error_rad=0.),
        ]))
        spec = self.plot('episode.orientation_error', episode)
        self.assertEqual(spec['series'][0]['y'], [90., None, 0.])
        self.assertEqual(spec['y']['unit'], 'deg')
        self.assertEqual(self.plot('episode.orientation_error')['kind'], 'unavailable')
    def test_mpc_frequency_uses_request_spacing_and_requested_to_guide(self):
        episode = EpisodeView(dict(states=[dict(sim_time_s=10.), dict(sim_time_s=10.01)],
            plans=[dict(request_time_s=t, sim_time_s=t, plan_origin_time_s=t+.05, stats=dict(step_wall_s=.001))
                   for t in (10., 10.002, 10.006, 10.01)],
            segment=dict(settings=dict(execution=dict(to_hz=250.)))))
        spec = self.plot('episode.mpc_frequency', episode)
        self.assertEqual(spec['x']['identity'], 'episode_time')
        self.assertEqual(spec['y']['unit'], 'Hz')
        self.assertEqual(spec['series'][0]['x'], [10., 10.002, 10.006, 10.01])
        for actual, expected in zip(spec['series'][0]['y'][:-1], [500., 250., 250.]):
            self.assertAlmostEqual(actual, expected)
        self.assertIsNone(spec['series'][0]['y'][-1])
        self.assertEqual(spec['guides'], [dict(axis='y', value=250., label='Requested TO')])
        window = EpisodeView(episode.raw, InspectionContext(analysis_range='window', visible_window=(10.001, 10.005)))
        clipped = self.plot('episode.mpc_frequency', window)['series'][0]
        self.assertEqual(clipped['x'], [10.001, 10.002, 10.005])
        self.assertAlmostEqual(clipped['y'][0], 500.)
        self.assertAlmostEqual(clipped['y'][1], 250.)

    def test_mpc_frequency_excludes_previews_duplicates_and_missing_request_times(self):
        episode = EpisodeView(dict(states=[dict(sim_time_s=0.), dict(sim_time_s=.01)], plans=[
            dict(request_time_s=0.), dict(request_time_s=.001, origin='preview'),
            dict(request_time_s=.002), dict(request_time_s=.002), dict(sim_time_s=.003),
            dict(request_time_s=float('nan'))], segment=dict(settings=dict(execution=dict(to_hz=0.)))))
        spec = self.plot('episode.mpc_frequency', episode)
        self.assertEqual(spec['series'][0]['x'], [0., .002])
        self.assertEqual(spec['series'][0]['y'], [500., None])
        self.assertEqual(spec['guides'], [])
        single = EpisodeView(dict(plans=[dict(request_time_s=0.)]))
        self.assertEqual(self.plot('episode.mpc_frequency', single)['kind'], 'unavailable')
        missing = EpisodeView(dict(plans=[dict(sim_time_s=0.), dict(sim_time_s=.01)]))
        self.assertEqual(self.plot('episode.mpc_frequency', missing)['kind'], 'unavailable')

    def test_tracking_error_derivation(self):
        spec = self.plot('episode.tracking_error')
        for actual, expected in zip(spec['series'][0]['y'], [300., 200., 100., 0.]):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(spec['y']['unit'], 'mm')

    def test_joint_positions_velocities_torques_and_historical_bounds(self):
        q = self.plot('episode.joint')
        self.assertEqual(q['series'][0]['y'], [0., .1, .2, .30000000000000004])
        self.assertEqual([g['value'] for g in q['guides']], [-1., 1.])
        self.assertEqual(self.plot('episode.joint', quantity='qd')['series'][0]['y'], [0., .5, 1., 1.5])
        torque = self.plot('episode.joint', joint='arm_right_2_joint', quantity='torque_nm')
        self.assertEqual(torque['series'][0]['y'], [-1., -1., -1., -1.])
        self.assertEqual(torque['series'][0]['style'], 'step')
        self.assertEqual([g['value'] for g in torque['guides']], [-5., 5.])
        self.assertEqual(self.plot('episode.joint', show_bounds=False)['guides'], [])
        self.assertEqual([(g['label'], g.get('style')) for g in q['guides']], [('URDF lower', 'hard'), ('URDF upper', 'hard')])

    def test_joint_plot_labels_mpc_bounds_beside_urdf_limits(self):
        from gato_visualizer.plotting import EpisodeView
        raw = dict(self.episode.raw, mpc_bounds=dict(lower_position_rad=[-.9, -1.9], upper_position_rad=[.9, 1.9]))
        spec = self.registry.evaluate('episode.joint', EpisodeView(raw), {})
        self.assertEqual([(g['label'], g['value']) for g in spec['guides']],
                         [('URDF lower', -1.), ('URDF upper', 1.), ('MPC lower', -.9), ('MPC upper', .9)])
        self.assertEqual(spec['guides'][0]['style'], 'hard')
        self.assertNotIn('style', spec['guides'][2])

    def test_histogram_counts_actual_samples_and_last_edge(self):
        spec = self.plot('episode.timing_histogram', bins=2)
        self.assertEqual(spec['series'][0]['x'], [22.5, 47.5])
        self.assertEqual(spec['series'][0]['y'], [2, 1])
        self.assertEqual(spec['series'][0]['bin_edges'], [10., 35., 60.])
        self.assertEqual(spec['x']['identity'], 'wall_time')
        x, counts, edges = histogram([2, 2, None, math.nan], 2)
        self.assertEqual(sum(counts), 2)
        self.assertEqual(len(edges), 3)
        self.assertEqual(histogram([], 2), ([], [], []))
        with self.assertRaisesRegex(ValueError, 'integer'):
            self.plot('episode.timing_histogram', bins=1.5)

    def test_episode_aggregates_have_independent_known_answers(self):
        spec = self.plot('episode.summary')
        self.assertAlmostEqual(value(spec, 'Analysis duration'), .3)
        self.assertEqual(value(spec, 'Retained states'), 4)
        self.assertEqual(value(spec, 'Recorded controller solves'), 2)
        self.assertEqual(value(spec, 'MPC wall median'), 20.)
        self.assertEqual(value(spec, 'MPC wall p95'), 56.)
        self.assertAlmostEqual(value(spec, 'Recorded EE path length'), .3)
        self.assertAlmostEqual(value(spec, 'Final target error'), 0.)
        self.assertAlmostEqual(value(spec, 'MPC over-budget share'), 100/3)
        self.assertAlmostEqual(value(spec, 'Physics over-budget share'), 100/3)
        self.assertAlmostEqual(value(spec, 'Combined-only over-budget share'), 0.)

    def test_ranges_and_clock_apply_to_values_and_aggregates(self):
        context = InspectionContext(analysis_range='through_cursor', episode_cursor_s=10.15, clock='live:7')
        data = EpisodeView(self.episode.raw, context)
        self.assertEqual(data.time_s, (10., 10.1))
        self.assertEqual(data.plans[0]['seq'], 1)
        self.assertEqual(len(data.plans), 1)
        spec = self.plot('episode.summary', data)
        self.assertEqual(value(spec, 'Retained states'), 2)
        self.assertAlmostEqual(value(spec, 'Recorded EE path length'), .1)
        self.assertAlmostEqual(value(spec, 'Analysis duration'), .15)
        self.assertEqual(self.plot('episode.joint', data)['x']['clock'], 'live:7')
        visible = EpisodeView(self.episode.raw, InspectionContext(analysis_range='visible', visible_window=(10.1, 10.2)))
        self.assertEqual(visible.time_s, (10.1, 10.2))
        self.assertEqual(value(self.plot('episode.summary', visible), 'Retained states'), 2)
        # Aggregate windows: either bound may be open; an open end follows the history tip.
        open_end = EpisodeView(self.episode.raw, InspectionContext(analysis_range='window', visible_window=(10.1, None)))
        self.assertEqual(open_end.time_s, (10.1, 10.2, 10.3))
        open_start = EpisodeView(self.episode.raw, InspectionContext(analysis_range='window', visible_window=(None, 10.15)))
        self.assertEqual(open_start.time_s, (10., 10.1))
        self.assertAlmostEqual(value(self.plot('episode.summary', open_start), 'Analysis duration'), .15)
        unbounded = EpisodeView(self.episode.raw, InspectionContext(analysis_range='window', visible_window=(None, None)))
        self.assertEqual(unbounded.time_s, self.episode.time_s)
        # Cached bounds are reused rather than scanning every state for every state.
        self.assertIs(data.bounds, data.bounds)
        self.assertEqual(example_episode().time_s, (10., 10.1, 10.2, 10.3))

    def test_prediction_profiles_use_horizon_offsets_and_native_joints(self):
        spec = self.plot('solve.prediction_joint', self.solve)
        self.assertEqual(spec['x']['identity'], 'prediction_time')
        self.assertNotIn('clock', spec['x'])
        self.assertEqual(spec['series'][0]['x'], [0., .1, .2])
        self.assertEqual(spec['series'][0]['y'], [0., .1, .2])
        self.assertEqual(self.plot('solve.prediction_joint', self.solve, quantity='qd')['series'][0]['y'], [1., 1., 0.])
        torque = self.plot('solve.prediction_joint', self.solve, quantity='torque_nm')
        self.assertEqual(torque['series'][0]['x'], [0., .1, .2])
        self.assertEqual(torque['series'][0]['y'], [2., 4., None])

    def test_traces_only_actual_recorded_indices(self):
        spec = self.plot('solve.iteration_trace', self.solve)
        self.assertEqual(spec['x']['identity'], 'sqp_iteration')
        self.assertEqual(spec['series'][0]['x'], [1, 2])
        self.assertEqual(spec['series'][0]['y'], [7., 3.])
        self.assertEqual(self.plot('solve.iteration_trace', self.solve, metric='pcg_iters')['series'][0]['y'], [3., 2.])
        self.assertEqual(self.plot('solve.iteration_trace', self.solve, metric='step_size')['series'][0]['y'], [1., .5])

    def test_solve_summary_known_values(self):
        spec = self.plot('solve.summary', self.solve)
        self.assertEqual(value(spec, 'Prediction duration'), .2)
        self.assertEqual(value(spec, 'Predicted EE path length'), .2)
        self.assertEqual(value(spec, 'Peak predicted joint speed'), 1.)
        self.assertEqual(value(spec, 'Peak predicted actuator torque'), 4.)
        self.assertEqual(value(spec, 'Solver reported solve time'), 4.)
        self.assertEqual(value(spec, 'Initial merit'), 12.)
        self.assertEqual(value(spec, 'Final merit'), 3.)

    def test_missing_telemetry_and_missing_iteration_never_fall_back(self):
        missing = example_episode(missing=True)
        self.assertEqual(self.plot('episode.tracking_error', missing)['kind'], 'unavailable')
        self.assertEqual(self.plot('episode.joint', missing, quantity='qd')['kind'], 'unavailable')
        for selected in (0, 'seed', 1, 9):
            solve = example_solve(context=InspectionContext(sqp_iteration=selected))
            self.assertIsNone(solve.prediction)
            self.assertEqual(self.plot('solve.prediction_joint', solve)['kind'], 'unavailable')
        solve = example_solve(missing=True)
        self.assertEqual(self.plot('solve.iteration_trace', solve)['kind'], 'unavailable')
        self.assertIsNone(value(self.plot('solve.summary', solve), 'Peak predicted joint speed'))
        self.assertIsNone(solve.solver)
        attached = object()
        self.assertIs(SolveView(solve.raw, solver=attached).solver, attached)

    def test_coverage_unions_overlap_and_distinguishes_combined_only(self):
        intervals = [dict(start_time_s=0., end_time_s=1., to_budget_s=.1, solve_wall_s=.2),
                     dict(start_time_s=.5, end_time_s=1.5, total_wall_s=2., physics_wall_s=.2)]
        covered = interval_coverage(intervals)
        self.assertEqual(covered['covered_s'], 1.5)
        self.assertEqual(covered['mpc'], 1.)
        self.assertEqual(covered['combined_only'], .5)
        self.assertEqual(covered['physics'], 0.)

    def test_asap_has_no_deadline_including_old_records_with_spurious_red_flags(self):
        interval = dict(start_time_s=0., end_time_s=.004, to_budget_s=.004,
                        solve_wall_s=.006, physics_wall_s=.001, total_wall_s=.007,
                        severity='red', to_back_to_back=True)
        covered = interval_coverage([interval])
        self.assertEqual(covered['mpc'], 0.)
        self.assertAlmostEqual(covered['combined_only'], .004)
        interval['physics_wall_s'] = .008
        self.assertAlmostEqual(interval_coverage([interval])['physics'], .004)


class FreezeTests(unittest.TestCase):
    def test_fast_paths_freeze_like_the_plain_recursion(self):
        import numpy as np
        from types import MappingProxyType
        from gato_visualizer.plotting.views import freeze

        def plain(value):
            if isinstance(value, MappingProxyType):
                return value
            if isinstance(value, dict):
                return MappingProxyType({str(k): plain(v) for k, v in value.items()})
            if hasattr(value, "tolist"):
                return plain(value.tolist())
            if isinstance(value, (list, tuple)):
                return tuple(plain(v) for v in value)
            return value

        value = dict(rows=[[1., 2], [3, None]], empty=[], nested=[[]], numpy=np.arange(6.).reshape(3, 2),
                     scalars=[np.float64(1.5), True, "x"], mixed=[[1, [2]], (3,), dict(a=[1])],
                     records=[dict(q=[.1, .2], t=np.float32(1))])
        frozen = freeze(value)
        self.assertEqual(frozen, plain(value))
        for key in value:
            self.assertEqual([type(v) for v in frozen[key]], [type(v) for v in plain(value)[key]], key)
        self.assertIs(type(frozen["scalars"][0]), float)  # NumPy scalars become Python numbers


class AuthorContractTests(unittest.TestCase):
    def test_decorators_preserve_callable_and_broad_read_only_access(self):
        def function(data, scale=1.):
            return lines('Extra captured data', [series('Experiment', [0], [data.raw['extra']['value']*scale])])
        decorated = plot_episode(id='custom', inputs={'scale': Number(1., 'Scale', '', 0, 10)}, requires=('not_captured',))(function)
        self.assertIs(decorated, function)
        data = EpisodeView({'extra': {'value': 7}, 'states': []})
        registry = Registry(); registry.register(function)
        self.assertFalse(registry.catalog('episode', data)[0]['available'])
        # Availability hints do not remove access or prevent direct invocation.
        self.assertEqual(registry.evaluate('custom', data, {'scale': 2})['series'][0]['y'], [14])
        with self.assertRaises(TypeError):
            data.raw['extra']['value'] = 2
        self.assertEqual(data.raw['extra']['value'], 7)
        self.assertIs(EpisodeView(data.raw).raw, data.raw)
        with self.assertRaisesRegex(ValueError, 'unknown inputs'):
            registry.evaluate('custom', data, {'host_cursor': 0})
        with self.assertRaises(ValueError):
            registry.evaluate('custom', data, {'scale': math.nan})

    def test_discovery_isolates_bad_module_and_duplicate_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            source = "from gato_visualizer.plotting import plot_episode, table\n@plot_episode(id='same')\ndef custom(data): return table('ok', [])\n"
            (path/'a.py').write_text(source)
            (path/'b.py').write_text('raise RuntimeError("broken module")')
            (path/'c.py').write_text(source)
            registry = Registry().load_directory(path)
            self.assertEqual(len(registry.definitions), 1)
            self.assertEqual(len(registry.errors), 2)
            self.assertIn('duplicate', registry.errors[1]['error'])
            self.assertEqual(registry.evaluate('same', example_episode())['kind'], 'table')
            self.assertEqual(Registry().load_directory(path/'absent').catalog('episode'), [])

    def test_validator_checks_axes_lengths_finite_nulls_and_arbitrary_code_fields(self):
        good = lines('Measured', [series('Value', [0., 1.], [1., None])])
        self.assertEqual(validate_spec(good), good)
        for edit, message in [({'version': 3}, 'version'), ({'kind': 'html'}, 'kind'),
                              ({'html': '<script/>'}, 'unsupported fields'),
                              ({'x': {'identity': 'time', 'label': '', 'unit': ''}}, 'axis')]:
            with self.subTest(edit=edit), self.assertRaisesRegex(ValueError, message):
                validate_spec(dict(good, **edit))
        for x, y, message in [([0], [1, 2], 'length'), ([math.inf], [1], 'finite'),
                              ([0], [math.nan], 'finite'), ([0], [True], 'finite')]:
            with self.assertRaisesRegex(ValueError, message):
                validate_spec(lines('Bad', [series('bad', x, y)]))
        json.dumps(validate_spec(good), allow_nan=False)

    def test_cli_returns_nonzero_on_numerical_failure_and_saves_shared_preview(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            renderer = path/'renderer.js'
            renderer.write_text('export function renderPlot(container,spec){container.textContent=spec.title;}')
            command = [sys.executable, '-m', 'gato_visualizer.plotting.check', '--fixture', 'episode', '--plot', 'episode.timing',
                       '--output', str(path), '--renderer', str(renderer), '--expect']
            good = subprocess.run(command + ['series.0.y.0=20'], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertTrue((path/'episode.timing.json').is_file())
            preview = (path/'episode.timing.html').read_text()
            self.assertIn('data:text/javascript;base64,', preview)
            self.assertIn('renderPlot(document.getElementById', preview)
            bad = subprocess.run(command + ['series.0.y.0=999'], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)
            self.assertIn('expected 999, got 20', bad.stderr)
            escaped = preview_html(dict(version=1, kind='unavailable', title='</script><b>', message='</script>'), renderer)
            self.assertNotIn('</script><b>', escaped)


if __name__ == '__main__':
    unittest.main()
