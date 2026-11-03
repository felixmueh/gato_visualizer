"""Known-answer comparison maths and the actual bounded CPU job path."""
import json
import math
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gato_visualizer.plotting import (
    Channel, ComparisonRun, ComparisonView, EpisodeView, InspectionContext, Registry,
    lines, plot_comparison, series,
)
from gato_visualizer.plotting.comparison import signal_rms
from gato_visualizer.plotting.fixtures import example_comparison
from history_store import HistoryStore
from plot_service import PlotService
from plot_sources import SourceReader, comparison_source
from tests.test_plot_service import fixture_scene

ROOT = Path(__file__).resolve().parents[1]


def registry():
    return Registry().load_directory(ROOT/'plotters')


class ComparisonMathTests(unittest.TestCase):
    def setUp(self):
        self.registry = registry()
        self.assertEqual(self.registry.errors, [])
        self.view = example_comparison()

    def values(self, identity, data=None, **inputs):
        return [s['y'][0] for s in self.registry.evaluate(identity, data or self.view, inputs)['series']]

    def test_tracking_uses_own_reference_offsets_and_common_prefix(self):
        self.assertEqual(self.view.bounds, (0, 2))
        self.assertEqual(self.view.common_bounds, (0, 1))
        spec = self.registry.evaluate('comparison.tracking_error', self.view)
        self.assertEqual(spec['x'], dict(identity='session_time', label='Session time', unit='s', clock='session:fixture'))
        self.assertEqual(spec['series'][0]['x'], [0, .5, 1, 2])
        self.assertEqual(spec['series'][1]['y'], [0, 500, 1000, 1500, 2000])
        values = self.values('comparison.tracking_summary')
        self.assertAlmostEqual(values[0], 1000/math.sqrt(3))
        self.assertAlmostEqual(values[1], 2000/math.sqrt(3))
        self.assertEqual(self.values('comparison.tracking_summary', metric='peak'), [1000, 2000])
        summary = self.registry.evaluate('comparison.tracking_summary', self.view)
        self.assertIn('recorded span 2 s', summary['series'][0]['hover'][0])
        self.assertIn('recorded span 1 s', summary['series'][1]['hover'][0])

    def test_weighted_metric_ignores_sample_density_and_clips_boundary_pairs(self):
        expected = math.sqrt((.25**2+.25*.75+.75**2)/3)
        context = InspectionContext(analysis_range='window', visible_window=(.25, .75), clock='session:window')
        view = ComparisonView(self.view.runs, context)
        self.assertEqual(view.common_bounds, (.25, .75))
        actual = self.values('comparison.tracking_summary', view)
        self.assertAlmostEqual(actual[0], expected*1000)
        self.assertAlmostEqual(actual[1], expected*2000)
        self.assertEqual(signal_rms([(0, 0), (.1, .1), (.2, .2), (1, 1)], (0, 1)), (math.sqrt(1/3), 1))

    def test_smoothness_has_independent_known_values_and_missing_is_not_zero(self):
        self.assertEqual(self.values('comparison.smoothness', metric='command_tv_rate'), [1, 2])
        self.assertEqual(self.values('comparison.smoothness', metric='acceleration_rms'), [1, 2])
        values = self.values('comparison.smoothness', metric='velocity_rms')
        self.assertAlmostEqual(values[0], 1/math.sqrt(3))
        self.assertAlmostEqual(values[1], 2/math.sqrt(3))
        missing = example_comparison(missing=True)
        self.assertIsNone(self.values('comparison.smoothness', missing)[1])
        self.assertIsNone(self.values('comparison.tracking_summary', missing)[1])

    def test_generic_channels_discover_nested_recorded_values_without_matrices_or_solver(self):
        controls = self.registry.catalog('comparison', self.view)
        channel = next(c for c in controls if c['id'] == 'comparison.channel')['inputs']['channel']
        self.assertEqual(channel['type'], 'choice')
        self.assertEqual(channel['default'], 'states.q.0')
        self.assertIn(dict(value='states.q.0', label='states.q.0 (rad)'), channel['choices'])
        spec = self.registry.evaluate('comparison.channel', self.view, dict(channel='states.sensor.temperature_c'))
        self.assertEqual(spec['series'][0]['y'], [20, 20.5, 21, 22])
        self.assertEqual(spec['series'][1]['x'], [0, .25, .5, .75, 1])
        raw = dict(states=[dict(sim_time_s=0, enabled=True, text='5', q=[[1, 2]], scalar=3), dict(sim_time_s=1, scalar=4)])
        run = ComparisonRun('custom', 'Custom', EpisodeView(raw))
        custom = ComparisonView((run, run))
        keys = [c['value'] for c in custom.channels]
        self.assertIn('states.scalar', keys)
        for absent in ('states.enabled', 'states.text', 'states.q.0.0'):
            self.assertNotIn(absent, keys)
        with self.assertRaisesRegex(ValueError, 'invalid value'):
            self.registry.evaluate('comparison.channel', self.view, dict(channel='solver.current_state'))

    def test_explicit_missing_samples_break_curves_and_summary_integrals(self):
        raw = dict(states=[dict(sim_time_s=t, q=[v], distance_m=v) for t, v in [(0, 0), (.5, None), (1, 1)]])
        run = ComparisonRun('gap', 'Gap', EpisodeView(raw))
        view = ComparisonView((run, self.view.runs[1]))
        spec = self.registry.evaluate('comparison.channel', view, dict(channel='states.q.0'))
        self.assertEqual(spec['series'][0]['y'], [0, None, 1])
        self.assertIsNone(self.values('comparison.tracking_summary', view)[0])
        self.assertEqual(signal_rms([(0, 0), (.5, None), (1, 1)], (0, 1)), (None, 0))

    def test_external_comparison_function_receives_immutable_views_and_dynamic_channel(self):
        @plot_comparison(id='custom.compare', title='Custom', inputs={'channel': Channel()})
        def compare(data: ComparisonView, channel=''):
            self.assertIsInstance(data.runs[0].episode, EpisodeView)
            with self.assertRaises(TypeError):
                data.runs[0].episode.raw['states'][0]['q'] = (9,)
            return lines('Custom', [series(run.label, *zip(*run.channel(channel))) for run in data.runs], identity='session_time')
        self.registry.register(compare)
        spec = self.registry.evaluate('custom.compare', self.view, {})
        self.assertEqual(spec['series'][0]['y'], [0, .5, 1, 2])
        self.assertEqual(spec['x']['clock'], 'session:fixture')
        with self.assertRaisesRegex(ValueError, 'comparison context'):
            self.registry.evaluate('custom.compare', self.view.runs[0].episode)

    def test_nonoverlapping_or_unavailable_runs_stay_unavailable(self):
        run = self.view.runs[1]
        shifted = ComparisonRun(run.key, run.label, run.episode, 10, run.color)
        spec = self.registry.evaluate('comparison.smoothness', ComparisonView((self.view.runs[0], shifted)))
        self.assertEqual(spec['kind'], 'unavailable')
        empty = ComparisonView(())
        self.assertTrue(all(not item['available'] for item in self.registry.catalog('comparison', empty)))
        self.assertEqual(self.registry.evaluate('comparison.channel', empty)['kind'], 'unavailable')

    def test_timed_reference_and_interval_channels_never_extrapolate_outside_support(self):
        raw = dict(states=[dict(sim_time_s=t, ee_xyz=[t, 0, 0], target_xyz=[0, 0, 0]) for t in (0, .5, 1)],
                   intervals=[dict(start_time_s=0, end_time_s=.5, solve_wall_s=.01)],
                   scene=dict(retained_replay=dict(reference=dict(time_s=[.25, .75]))))
        run = ComparisonRun('limited', 'Limited', EpisodeView(raw))
        view = ComparisonView((run, self.view.runs[1]))
        curve = self.registry.evaluate('comparison.tracking_error', view)['series'][0]
        self.assertEqual(curve['y'], [None, 500, None])
        outside = ComparisonView((run, run), InspectionContext(analysis_range='window', visible_window=(5, 6)))
        result = self.registry.evaluate('comparison.channel', outside, dict(channel='intervals.solve_wall_s'))
        self.assertEqual(result['kind'], 'unavailable')

    def effort_run(self, key, span, commands, offset=0, **extra):
        width = extra.pop('joints', 2)
        raw = dict(states=[dict(sim_time_s=t, q=[0]*width) for t in span],
                   controls=[dict(sim_time_s=t, torque_nm=u) for t, u in commands],
                   joint_names=[f'joint_{j}' for j in range(width)], **extra)
        return ComparisonRun(key, key, EpisodeView(raw), offset, '#6fa8ff')

    def test_control_effort_integrates_uneven_commands_squared_norm_with_terminal_hold(self):
        a = self.effort_run('A', (0, 2), [(0, [1, 2]), (.5, [3, 0]), (1.5, [0, 2])])
        b = self.effort_run('B', (0, 2), [(0, [2, 0]), (.25, [1, 0]), (1.75, [3, 4])])
        data = ComparisonView((a, b))
        spec = self.registry.evaluate('comparison.control_effort', data)
        self.assertEqual(spec['x']['identity'], 'session_time')
        self.assertEqual(spec['y']['unit'], 'Nm²·s')
        self.assertEqual(spec['series'][0]['x'], [0, .5, 1.5, 2])
        self.assertEqual(spec['series'][0]['y'], [0, 2.5, 11.5, 13.5])
        self.assertEqual(spec['series'][1]['y'], [0, 1, 2.5, 8.75])
        self.assertEqual(self.values('comparison.control_effort', data, view='total'), [13.5, 8.75])
        self.assertIn('valid 2/2 s', spec['series'][0]['hover'][-1])
        self.assertIn('not mechanical work', ' '.join(spec['notes']))

    def test_control_effort_common_window_and_offsets_use_pre_window_held_command(self):
        a = self.effort_run('A', (10, 13), [(10, [1]), (11, [2]), (12.5, [3])], offset=-10, joints=1)
        b = self.effort_run('B', (20, 22), [(20, [4]), (21.5, [2])], offset=-19, joints=1)
        data = ComparisonView((a, b), InspectionContext(analysis_range='window', visible_window=(1.25, 2.75)))
        self.assertEqual(data.common_bounds, (1.25, 2.75))
        spec = self.registry.evaluate('comparison.control_effort', data)
        self.assertEqual(spec['series'][0]['x'], [1.25, 2.5, 2.75])
        self.assertEqual(spec['series'][0]['y'], [0, 5, 7.25])
        self.assertEqual(spec['series'][1]['y'], [0, 20, 21])
        self.assertEqual(self.values('comparison.control_effort', data, view='total'), [7.25, 21])
        entire = self.registry.evaluate('comparison.control_effort', ComparisonView((a, b)))
        self.assertEqual(entire['series'][0]['x'][0], 1)
        self.assertEqual(entire['series'][0]['x'][-1], 3)

    def test_control_effort_missing_samples_break_support_and_report_partial_coverage(self):
        for bad in (None, [math.nan, 1], [math.inf, 1], [1]):
            with self.subTest(missing=bad):
                a = self.effort_run('Gap', (0, 4), [(0, [2, 0]), (1, bad), (2, [3, 0]), (3, bad)])
                b = self.effort_run('Full', (0, 4), [(0, [1, 0])])
                data = ComparisonView((a, b))
                spec = self.registry.evaluate('comparison.control_effort', data)
                self.assertEqual(spec['series'][0]['y'], [0, 4, None, 4, 13, None, None])
                self.assertIn('valid 2/4 s', spec['series'][0]['hover'][4])
                bars = self.registry.evaluate('comparison.control_effort', data, dict(view='total'))
                self.assertEqual([s['y'][0] for s in bars['series']], [13, 4])
                self.assertIn('valid 2/4 s', bars['series'][0]['hover'][0])

    def test_control_effort_does_not_substitute_requested_predicted_or_state_torque(self):
        a = self.effort_run('Late', (0, 2), [(.5, [2, 0])])
        raw = dict(states=[dict(sim_time_s=t, q=[0, 0], torque_nm=[99, 99]) for t in (0, 2)],
                   torque_samples=[dict(sim_time_s=0, requested_torque_nm=[50, 50], planned_torque_nm=[60, 60])],
                   plans=[dict(sim_time_s=0, torque_nm=[[100, 100]])], joint_names=['j1', 'j2'])
        b = ComparisonRun('missing', 'Missing', EpisodeView(raw))
        data = ComparisonView((a, b))
        bars = self.registry.evaluate('comparison.control_effort', data, dict(view='total'))
        self.assertEqual([s['y'][0] for s in bars['series']], [6, None])
        self.assertIn('valid 1.5/2 s', bars['series'][0]['hover'][0])
        self.assertIn('valid 0/2 s', bars['series'][1]['hover'][0])
        spec = self.registry.evaluate('comparison.control_effort', data)
        self.assertEqual(len(spec['series']), 1)
        self.assertIsNone(spec['series'][0]['y'][0])

    def test_control_effort_zero_is_valid_and_hold_stops_at_shorter_episode(self):
        a = self.effort_run('Zero', (0, 10), [(0, [0, 0])])
        b = self.effort_run('Short', (0, 1), [(0, [2, 0])])
        data = ComparisonView((a, b))
        self.assertEqual(self.values('comparison.control_effort', data, view='total'), [0, 4])
        spec = self.registry.evaluate('comparison.control_effort', data)
        self.assertEqual(spec['series'][0]['x'], [0, 1])
        self.assertEqual(spec['series'][0]['y'], [0, 0])
        self.assertIn('recorded span 10 s', spec['series'][0]['hover'][-1])

    def test_control_effort_duplicate_updates_use_final_value_and_invalid_clock_breaks_support(self):
        a = self.effort_run('Updates', (0, 2), [(0, [1, 0]), (1, [5, 0]), (1, [2, 0])])
        b = self.effort_run('Bad clock', (0, 2), [(0, [9, 0]), (None, [50, 0]), (1, [3, 0])])
        data = ComparisonView((a, b))
        self.assertEqual(self.values('comparison.control_effort', data, view='total'), [5, 9])
        spec = self.registry.evaluate('comparison.control_effort', data)
        self.assertIn('valid 1/2 s', spec['series'][1]['hover'][-1])

    def test_control_effort_no_common_interval_or_no_applied_data_is_unavailable(self):
        a = self.effort_run('A', (0, 1), [])
        b = self.effort_run('B', (0, 1), [])
        self.assertEqual(self.registry.evaluate('comparison.control_effort', ComparisonView((a, b)))['kind'], 'unavailable')
        c = self.effort_run('Later', (2, 3), [(2, [1, 1])])
        self.assertEqual(self.registry.evaluate('comparison.control_effort', ComparisonView((a, c)))['kind'], 'unavailable')


class ComparisonSourceTests(unittest.TestCase):
    def test_comparison_lookups_reuse_immutable_records_and_discovered_channels(self):
        reader = SourceReader(default_scene=fixture_scene())
        descriptor = dict(kind='replay', revision='recorded', comparison=True)
        captured = reader.read(descriptor)
        item = dict(key='one', label='One', color='#6fa8ff', offset_s=0,
                    source=dict(kind='replay', id='default'), descriptor=descriptor)
        with patch('gato_visualizer.plotting.comparison._leaves', side_effect=AssertionError('rescanned cached samples')):
            for _ in range(2):
                view, context = comparison_source(reader, dict(kind='comparison', runs=[item]), dict(context='comparison'))
                self.assertIs(view.runs[0].episode.raw['states'], captured['states'])
                self.assertTrue(context['channels'])

    def test_size_accounting_does_not_recurse_per_numeric_cell(self):
        import plot_sources
        original = plot_sources._retained_bytes
        with patch('plot_sources._retained_bytes', wraps=original) as counted:
            size = counted(tuple([.25]*100000))
        self.assertGreater(size, 100000*8)
        self.assertLess(counted.call_count, 5)

    def test_comparison_reads_all_execution_and_plan_stats_without_prediction_geometry(self):
        import numpy as np
        from replay_format import Replay, Prediction
        from replay_library import _signature
        plans = tuple(Prediction(f'p{i}', f'Plan {i}', 20+i*.01, np.array([0., .1]),
                      np.zeros((2, 7)), None, dict(wall_s=.001+i*.0001, custom=i)) for i in range(50))
        replay = Replay({}, np.array([20., 21., 22.]), np.ones((3, 7)), None, plans)
        scene = fixture_scene(); scene['trajectories'] = scene['trajectories'][:1]
        def only_execution(captured, *args):
            self.assertEqual(captured.predictions, ())
            return scene
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'run.npz'; path.write_bytes(b'fixture')
            reader = SourceReader(folder, fixture_scene())
            with patch('replay_format.load_replay', return_value=replay), patch('server.replay_scene', side_effect=only_execution):
                raw = reader.read(dict(kind='replay', path=str(path), revision='a', signature=list(_signature(path)), comparison=True))
            self.assertEqual(len(raw['states']), 3)
            self.assertEqual(len(raw['plans']), 50)
            self.assertEqual(raw['plans'][-1]['stats']['custom'], 49)
            self.assertEqual(raw['recorded_prediction_count'], 50)
            self.assertIn('plans.stats.wall_s', raw['numeric_channel_paths'])
            self.assertEqual(len(replay.predictions), 50)
            self.assertEqual(path.read_bytes(), b'fixture')

    def test_replay_cache_reuses_multiple_revisions_and_evicts_with_explicit_bounds(self):
        reader = SourceReader(default_scene=fixture_scene())
        a = reader.read(dict(kind='replay', revision='a'))
        b = reader.read(dict(kind='replay', revision='b'))
        self.assertIs(a, reader.read(dict(kind='replay', revision='a')))
        self.assertEqual(len(reader.replay_cache), 2)
        with patch('plot_sources.MAX_REPLAY_CACHE_ITEMS', 2):
            reader.read(dict(kind='replay', revision='c'))
        self.assertNotIn((None, 'b'), reader.replay_cache)
        self.assertGreater(reader.replay_cache_bytes, 0)
        with patch('plot_sources.MAX_REPLAY_CACHE_BYTES', 1):
            reader.read(dict(kind='replay', revision='oversize'))
        self.assertNotIn((None, 'oversize'), reader.replay_cache)


class ComparisonWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.config = self.folder/'viewer.json'; self.config.write_text('{}')
        self.service = PlotService(self.folder, self.config, fixture_scene(), timeout_s=5)

    def tearDown(self):
        self.service.close()
        self.temporary.cleanup()

    def wait_job(self, identifier):
        deadline = time.monotonic()+7
        while time.monotonic() < deadline:
            result = self.service.job(identifier)
            if result['state'] in ('complete', 'failed', 'superseded'):
                self.assertNotEqual(result['state'], 'failed', result)
                return result
            time.sleep(.01)
        self.fail('Comparison CPU job did not finish')

    def request(self):
        return dict(context='comparison', sources=[
            dict(key='a', label='First', color='#b48cff', offset_s=0, source=dict(kind='replay', id='default')),
            dict(key='b', label='Later', color='#6fa8ff', offset_s=.5, source=dict(kind='replay', id='default'))],
            client_id='test-comparison', range=dict(mode='window', start_s=.5, end_s=1.5))

    def test_actual_worker_multisource_catalog_and_evaluation_keep_old_episode_path(self):
        body = self.request()
        result = self.wait_job(self.service.submit(body, catalog=True)['job_id'])
        self.assertEqual(result['state'], 'complete')
        self.assertEqual(result['context']['bounds'], [.5, 1.5])
        self.assertEqual(result['context']['common_bounds'], [.5, 1.5])
        self.assertEqual(result['context']['usable_runs'], 2)
        self.assertTrue(all(run['episode_available'] for run in result['context']['runs']))
        definition = next(d for d in result['catalog'] if d['id'] == 'comparison.channel')
        self.assertIn('states.q.0', [v['value'] for v in definition['inputs']['channel']['choices']])
        body['plots'] = [dict(instance_id='joint', plot_id='comparison.channel', inputs=dict(channel='states.q.0')),
                         dict(instance_id='summary', plot_id='comparison.smoothness', inputs={})]
        result = self.wait_job(self.service.submit(body)['job_id'])
        self.assertEqual(result['results'][0]['spec']['x']['clock'], 'session:test-comparison')
        self.assertEqual(result['results'][0]['spec']['series'][1]['x'], [.5, 1.5])
        self.assertIsNone(result['results'][1]['spec']['series'][0]['y'][0])
        single = dict(context='episode', source=dict(kind='replay', id='default'), plots=[dict(instance_id='old', plot_id='episode.summary')])
        result = self.wait_job(self.service.submit(single)['job_id'])
        self.assertEqual(result['results'][0]['spec']['kind'], 'table')

    def test_prediction_source_is_not_passed_off_as_recorded_episode(self):
        body = self.request(); body['sources'][1]['source']['trajectory_index'] = 1
        result = self.wait_job(self.service.submit(body, catalog=True)['job_id'])
        self.assertEqual(result['context']['usable_runs'], 1)
        self.assertFalse(result['context']['runs'][1]['episode_available'])
        self.assertIn('prediction horizon', result['context']['runs'][1]['error'])

    def test_validation_rejects_uploads_unknown_selectors_phase_and_bad_offsets(self):
        for field, value in [('offset_s', float('nan')), ('color', 'red'), ('source', dict(kind='inspection', id='x'))]:
            body = self.request(); body['sources'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.service.submit(body)
        for change in [dict(source={}), dict(sources=[dict(data=[1, 2])]), dict(alignment=dict(mode='task_phase'))]:
            with self.assertRaises(ValueError):
                self.service.submit(dict(self.request(), **change))
        body = self.request(); body['sources'][1]['key'] = 'a'
        with self.assertRaisesRegex(ValueError, 'unique'):
            self.service.submit(body)

    def test_live_growth_refreshes_committed_prefix_and_generation_invalidates_comparison(self):
        store = HistoryStore(self.folder/'history')
        try:
            store.append([dict(type='segment', sim_time_s=0, context=dict(task={})),
                          dict(type='state', sim_time_s=0, q=[0]), dict(type='state', sim_time_s=1, q=[1])])
            self.service.live = SimpleNamespace(history_store=store, condition=threading.RLock(), latest={}, generation=0)
            body = self.request(); body.pop('range'); body['sources'][0]['source'] = dict(kind='live', generation=0)
            first = self.wait_job(self.service.submit(body, catalog=True)['job_id'])
            self.assertEqual(first['context']['runs'][0]['bounds'], [0, 1])
            store.append([dict(type='state', sim_time_s=3, q=[3])])
            second = self.wait_job(self.service.submit(body, catalog=True)['job_id'])
            self.assertEqual(second['context']['runs'][0]['bounds'], [0, 3])
            self.service.live.generation = 1
            self.assertEqual(self.service.job(second['job_id'])['state'], 'superseded')
        finally:
            store.close()


if __name__ == '__main__':
    unittest.main()
