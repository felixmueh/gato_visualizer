"""Shared limit-use definitions: Python and src/limit-use.js agree on a fixture."""
import json
from pathlib import Path
import unittest

from gato_visualizer.plotting.limit_use import (LIMIT_DEFAULTS, at_tolerance, limit_settings, limit_state, limit_use,
                                                physical_limits, validate_limit_settings)

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/limit_use_cases.json').read_text())


class LimitUseTests(unittest.TestCase):
    def test_shared_fixture_cases(self):
        limits = physical_limits(dict(scene_joint_limits=FIXTURE['limits']))
        for case in FIXTURE['cases']:
            with self.subTest(case=case):
                settings = dict(LIMIT_DEFAULTS, **case['settings'])
                use = limit_use(case['quantity'], case['value'], case['joint'], limits)
                state = limit_state(use, at_tolerance(case['quantity'], case['joint'], limits, settings), settings) if use else None
                self.assertEqual(state, case['state'])
                self.assertEqual(None if use is None else use.fraction, case['utilisation'])
                self.assertEqual(None if use is None else use.distance, case['distance'])

    def test_settings_validation_and_seam(self):
        self.assertEqual(validate_limit_settings(), LIMIT_DEFAULTS)
        self.assertEqual(validate_limit_settings(dict(limit_near_percent=80))['limit_at_position_rad'], .003)
        for bad in (dict(limit_near_percent=0), dict(limit_at_velocity_rad_s=True), dict(limit_at_torque_percent=11), dict(unknown=1), [1]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_limit_settings(bad)
        self.assertEqual(limit_settings(dict(limit_settings=dict(limit_near_percent=75)))['limit_near_percent'], 75)


class ReplayMpcBoundsTests(unittest.TestCase):
    def test_recorded_mpc_params_become_mpc_bounds(self):
        from server import provenance_mpc_bounds
        params = dict(N=32, dt_s=.03, joint_margin_rad=.1, velocity_fraction=.8, effort_fraction=.85)
        explicit = provenance_mpc_bounds(dict(params=params), FIXTURE['limits'])
        self.assertEqual(explicit['lower_position_rad'], [v + .1 for v in FIXTURE['limits']['lower_position_rad']])
        self.assertEqual(explicit['upper_position_rad'], [v - .1 for v in FIXTURE['limits']['upper_position_rad']])
        self.assertEqual(explicit['velocity_rad_s'], [.8 * v for v in FIXTURE['limits']['velocity_rad_s']])
        self.assertEqual(explicit['effort_nm'], [.85 * v for v in FIXTURE['limits']['effort_nm']])
        self.assertEqual(explicit['limit_bounds'], dict(joint_margin_rad=.1, velocity_fraction=.8, effort_fraction=.85))
        # Missing or non-numeric values are not inferred.
        partial = provenance_mpc_bounds(dict(params=dict(velocity_fraction=.8, effort_fraction=None)), FIXTURE['limits'])
        self.assertEqual(set(partial) - {'source', 'limit_bounds'}, {'velocity_rad_s'})
        self.assertIsNone(provenance_mpc_bounds(dict(params={}), FIXTURE['limits']))
        self.assertIsNone(provenance_mpc_bounds(None, FIXTURE['limits']))
        self.assertIsNone(provenance_mpc_bounds(dict(params=params), None))
        # The pre-migration configuration shape is no longer read.
        self.assertIsNone(provenance_mpc_bounds(dict(configuration=dict(limit_bounds=params)), FIXTURE['limits']))

if __name__ == '__main__':
    unittest.main()
