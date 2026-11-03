"""Fail clearly when the browser's CPU FK oracle needs regeneration."""
import json
import unittest

import numpy as np

from scripts.grasp_fk_fixture import build_fixture, DESTINATION
from tests.tiago_mpc_source import MPC_ROOT


class GraspFixtureTests(unittest.TestCase):
    def test_fixture_matches_selected_tiago_mpc(self):
        saved = json.loads(DESTINATION.read_text())
        fresh = build_fixture(MPC_ROOT)
        message = 'Grasp FK fixture is stale: rerun scripts/grasp_fk_fixture.py with the selected tiago_mpc interpreter'
        for key in ('full_urdf_sha256', 'frame', 'root_frame', 'grasp', 'seed', 'joint_names'):
            self.assertEqual(saved[key], fresh[key], f'{message} ({key})')
        self.assertEqual(len(saved['poses']), 80, message)
        self.assertEqual(len(saved['poses']), len(fresh['poses']), message)
        for old, new in zip(saved['poses'], fresh['poses']):
            self.assertEqual(old['label'], new['label'], message)
            for key in ('q', 'grasp_torso_m', 'grasp_world_m', 'jacobian_torso',
                        'rotation_torso', 'angular_jacobian_torso', 'rotvec_world'):
                np.testing.assert_allclose(old[key], new[key], rtol=0, atol=1e-9,
                                           err_msg=f'{message} ({old["label"]}, {key})')


if __name__ == '__main__':
    unittest.main()
