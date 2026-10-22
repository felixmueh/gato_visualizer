"""Joint limit use plot: options, Worst selection, missing data and torque clocks."""
from pathlib import Path
import unittest

from gato_visualizer.plotting import EpisodeView, InspectionContext, Registry, validate_spec
from gato_visualizer.plotting.fixtures import example_episode
from gato_visualizer.plotting.limit_use import limit_settings, limit_state, limit_use, physical_limits

ROOT = Path(__file__).resolve().parents[1]
PLOT = 'episode.joint_limit_use'
LIMITS = dict(lower_position_rad=[-1., -2.], upper_position_rad=[1., 2.], velocity_rad_s=[2., 2.], effort_nm=[5., 5.])


def episode(states, torque_samples=None, **extra):
    raw = dict(states=states, scene_joint_limits=LIMITS, **extra)
    if torque_samples is not None:
        raw['torque_samples'] = torque_samples
    return EpisodeView(raw)


class LimitUseHelperTests(unittest.TestCase):
    def test_utilisation_and_signed_distance(self):
        limits = physical_limits(dict(scene_joint_limits=LIMITS))
        use = limit_use('position', .97, 0, limits)
        self.assertAlmostEqual(use.fraction, .97)
        self.assertAlmostEqual(use.distance, .03)
        self.assertEqual(use.bound, 'upper bound')
        self.assertEqual(limit_use('position', -1.5, 1, limits).bound, 'lower bound')
        beyond = limit_use('velocity', -2.5, 0, limits)
        self.assertAlmostEqual(beyond.fraction, 1.25)
        self.assertAlmostEqual(beyond.distance, -.5)
        self.assertAlmostEqual(limit_use('torque', -4., 1, limits).fraction, .8)
        self.assertIsNone(limit_use('torque', None, 0, limits))
        settings = limit_settings({})
        self.assertEqual(limit_state(limit_use('position', .998, 0, limits), .003, settings), 'at')
        self.assertEqual(limit_state(limit_use('position', 1.01, 0, limits), .003, settings), 'beyond')
        self.assertEqual(limit_state(limit_use('position', .95, 0, limits), .003, settings), 'near')
        self.assertEqual(limit_state(limit_use('position', .5, 0, limits), .003, settings), 'inside')

    def test_physical_limits_ignore_mpc_bounds(self):
        self.assertIsNone(physical_limits(dict(joint_limits=LIMITS)))
        scene = physical_limits(dict(scene=dict(joint_limits=LIMITS)))
        self.assertEqual(scene['effort'], [5., 5.])


class LimitUsePlotTests(unittest.TestCase):
    def setUp(self):
        self.registry = Registry().load_directory(ROOT / 'plotters')
        self.assertEqual(self.registry.errors, [])

    def plot(self, data=None, **inputs):
        return self.registry.evaluate(PLOT, data or example_episode(), inputs)

    def test_catalog_options_and_all_by_all_rejection(self):
        item = next(item for item in self.registry.catalog('episode') if item['id'] == PLOT)
        joint, quantity = item['inputs']['joint'], item['inputs']['quantity']
        self.assertEqual([c['label'] for c in joint['choices']], ['All', 'Worst', *(f'J{i}' for i in range(1, 8))])
        self.assertEqual([c['label'] for c in quantity['choices']], ['All', 'Worst', 'Torque', 'Velocity', 'Position'])
        self.assertEqual((joint['default'], quantity['default']), ('worst', 'all'))
        self.assertEqual(joint['disabled_when'], {'all': {'quantity': 'all'}})
        self.assertEqual(quantity['disabled_when'], {'all': {'joint': 'all'}})
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.plot(joint='all', quantity='all')
        fn = self.registry.definitions[PLOT]['function']
        with self.assertRaisesRegex(ValueError, 'both be All'):
            fn(example_episode(), joint='all', quantity='all')

    def test_default_worst_joint_by_quantity(self):
        spec = self.plot()
        self.assertEqual([s['label'] for s in spec['series']], ['Position', 'Velocity', 'Torque'])
        position, velocity, torque = (s['y'] for s in spec['series'])
        for got, expected in zip(position, [25, 25, 25, 30]):
            self.assertAlmostEqual(got, expected)
        self.assertEqual(velocity, [0, 25, 50, 75])
        self.assertEqual(torque, [20, 40, 60, 80])
        # The binding joint changes from J2 (|.5| of half range 2) to J1 (.3 of 1).
        self.assertEqual(spec['series'][0]['hover'][0], 'J2 position 25 % · 1.5 rad from upper bound')
        self.assertEqual(spec['series'][0]['hover'][3], 'J1 position 30 % · 0.7 rad from upper bound')
        self.assertTrue(spec['series'][2]['color'].startswith('var(--limit-torque'))
        self.assertEqual(spec['series'][2]['style'], 'step')
        self.assertEqual(spec['y'], dict(label='Limit use', unit='%', span=[0, 105]))
        self.assertEqual(spec['guides'], [dict(axis='y', value=100, label='limit', style='hard')])
        self.assertEqual([(b['tone'], b['start'], b['end']) for b in spec['bands']], [('near', 90., 100), ('beyond', 100, None)])
        self.assertEqual(spec['x']['identity'], 'episode_time')

    def test_worst_quantity_names_binding_quantity(self):
        spec = self.plot(quantity='worst')
        (line,) = spec['series']
        self.assertEqual(line['label'], 'Worst')
        self.assertEqual(line['y'], [25, 40, 60, 80])
        self.assertEqual(line['hover'][0], 'J2 position 25 % · 1.5 rad from upper bound')
        self.assertEqual(line['hover'][1], 'J1 torque 40 % · 3 Nm from effort limit')
        single = self.plot(joint='arm_right_1_joint', quantity='worst')['series'][0]
        self.assertEqual(single['y'], [20, 40, 60, 80])
        self.assertEqual(single['label'], 'Worst')

    def test_all_joints_single_quantity_and_per_joint_worst(self):
        spec = self.plot(joint='all', quantity='torque')
        self.assertEqual([s['label'] for s in spec['series']], ['J1', 'J2'])  # J3..J7 have no data
        self.assertEqual(spec['series'][1]['y'], [20, 20, 20, 20])
        self.assertNotIn('color', spec['series'][0])  # joint lines use the default palette
        per_joint = self.plot(joint='all', quantity='worst')
        self.assertEqual(per_joint['series'][0]['y'], [20, 40, 60, 80])
        self.assertEqual(per_joint['title'], 'Joint limit use · all joints · worst quantity')

    def test_missing_quantities_are_absent_not_zero(self):
        spec = self.plot(example_episode(missing=True))
        labels = [s['label'] for s in spec['series']]
        self.assertEqual(labels, ['Position', 'Velocity: not recorded', 'Torque: not recorded'])
        self.assertEqual(spec['series'][1]['y'], [])
        worst = self.plot(example_episode(missing=True), quantity='worst')['series'][0]
        self.assertEqual(worst['label'], 'Worst of position')
        self.assertEqual(self.plot(example_episode(missing=True), quantity='torque')['kind'], 'unavailable')
        no_limits = EpisodeView(dict(states=[dict(sim_time_s=0., q=[0.])], joint_limits=LIMITS))
        self.assertEqual(self.plot(no_limits)['kind'], 'unavailable')

    def test_torque_uses_its_own_clock_and_is_held(self):
        states = [dict(sim_time_s=t, q=[0., 0.], qd=[0., 0.]) for t in (0., .1, .2)]
        torque = [dict(sim_time_s=.05, torque_nm=[4.5, 0.]), dict(sim_time_s=.15, torque_nm=[1., 0.])]
        data = episode(states, torque)
        spec = self.plot(data, joint='arm_right_1_joint', quantity='torque')
        self.assertEqual(spec['series'][0]['x'], [.05, .15])
        self.assertEqual(spec['series'][0]['y'], [90, 20])
        worst = self.plot(data, joint='arm_right_1_joint', quantity='worst')['series'][0]
        # Union of state and torque timestamps; torque holds until its next sample.
        self.assertEqual(worst['x'], [0., .05, .1, .15, .2])
        self.assertEqual(worst['y'], [0, 90, 90, 20, 0])
        self.assertTrue(worst['hover'][2].startswith('J1 torque 90 %'))

    def test_beyond_and_at_wording_and_range(self):
        states = [dict(sim_time_s=0., q=[1.02, 0.]), dict(sim_time_s=1., q=[.999, 0.]), dict(sim_time_s=2., q=[.5, 0.])]
        spec = self.plot(episode(states), joint='arm_right_1_joint', quantity='position')
        hover = spec['series'][0]['hover']
        self.assertEqual(hover[0], 'J1 position 102 % · 0.02 rad beyond upper bound')
        self.assertEqual(hover[1], 'J1 position 100 % · at upper bound')
        ranged = EpisodeView(dict(states=states, scene_joint_limits=LIMITS),
                             InspectionContext(analysis_range='window', visible_window=(.5, None)))
        self.assertEqual(self.plot(ranged, joint='arm_right_1_joint', quantity='position')['series'][0]['x'], [1., 2.])

    def test_near_band_follows_settings_seam(self):
        states = [dict(sim_time_s=0., q=[0., 0.])]
        spec = self.plot(episode(states, limit_settings=dict(limit_near_percent=80)), quantity='position')
        self.assertEqual(spec['bands'][0]['start'], 80.)

    def test_display_reduction_keeps_hover_aligned(self):
        from plot_service import reduce_spec
        states = [dict(sim_time_s=i * .01, q=[(i % 50) / 50, 0.]) for i in range(2000)]
        spec = self.plot(episode(states), joint='arm_right_1_joint', quantity='position')
        reduced = reduce_spec(spec, pixels=100)['series'][0]
        self.assertLess(len(reduced['x']), 2000)
        self.assertEqual(len(reduced['hover']), len(reduced['x']))
        for x, y, text in zip(reduced['x'], reduced['y'], reduced['hover']):
            self.assertTrue(text.startswith(f'J1 position {y:.0f} %'), (x, y, text))


if __name__ == '__main__':
    unittest.main()
