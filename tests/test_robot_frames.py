"""CPU-only checks for local grasp origins and their display-frame use."""
from pathlib import Path
import tempfile
import unittest

import numpy as np

from robot_frames import fixed_frame_spec
from server import RobotKinematics
from tests.tiago_mpc_source import MPC_ROOT, arm_urdf


class FixedFrameTests(unittest.TestCase):
    def spec(self, joint, frame="grasp"):
        with tempfile.TemporaryDirectory() as folder:
            urdf = Path(folder) / "arm.urdf"
            urdf.write_text(f'<robot name="test">{joint}</robot>')
            return fixed_frame_spec(urdf, frame)

    def test_reads_local_origin_and_defaults_missing_origin_to_identity(self):
        self.assertEqual(self.spec('<joint name="grasp" type="fixed"><parent link="tool"/> '
                                   '<origin xyz="0.01 -0.02 0.14" rpy="0.1 -0.2 0.3"/></joint>'),
                         dict(frame="grasp", parent_link="tool", xyz=[.01, -.02, .14], rpy=[.1, -.2, .3]))
        self.assertEqual(self.spec('<joint name="grasp" type="fixed"><parent link="tool"/></joint>'),
                         dict(frame="grasp", parent_link="tool", xyz=[0., 0., 0.], rpy=[0., 0., 0.]))

    def test_missing_or_nonfixed_frame_and_invalid_origins_are_rejected(self):
        for joint in ('', '<joint name="grasp" type="revolute"><parent link="tool"/></joint>'):
            with self.subTest(joint=joint), self.assertRaisesRegex(ValueError, "Missing fixed end-effector frame"):
                self.spec(joint)
        with self.assertRaisesRegex(ValueError, "parent link"):
            self.spec('<joint name="grasp" type="fixed"/>')
        for attr in ('xyz="0 1"', 'xyz="0 nan 1"', 'rpy="0 0 inf"', 'rpy="bad 0 0"'):
            with self.subTest(attr=attr), self.assertRaisesRegex(ValueError, "three finite values"):
                self.spec(f'<joint name="grasp" type="fixed"><parent link="tool"/><origin {attr}/></joint>')

    def test_grasp_offset_on_full_robot_matches_reduced_fk(self):
        from live_mpc import import_tiago
        tiago = import_tiago(MPC_ROOT)
        reduced = arm_urdf()
        grasp = fixed_frame_spec(reduced, tiago.GRASP_FRAME)
        full = RobotKinematics(tiago.FULL_URDF, end_effector_frame=tiago.GRASP_FRAME,
                               reduced_urdf=reduced)
        self.assertEqual(full.model.frames[full.ee_frame].name, grasp["parent_link"])
        np.testing.assert_array_equal(full.ee_offset.translation, grasp["xyz"])
        q = np.asarray([tiago.Q_START, tiago.Q_REACH,
                        np.asarray(tiago.Q_START) + [0., .1, -.1, .1, 0., .2, 0.]])
        expected = np.asarray([full.target_to_world(tiago.fk(pose)) for pose in q])
        np.testing.assert_allclose(full.ee_positions(q), expected, atol=1e-10, rtol=0)


if __name__ == "__main__":
    unittest.main()
