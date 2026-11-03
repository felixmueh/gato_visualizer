"""CPU FK and recording compatibility for application-defined TCP frames."""
from dataclasses import replace
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import numpy as np
import pinocchio as pin

from live_presentation import LiveRenderer, snapshot
from replay_format import load_replay
from server import JOINT_NAMES, RobotKinematics, replay_scene

from tiago_mpc_source import MPC_ROOT, arm_urdf, replay_exporter

ROOT = Path(__file__).resolve().parents[1]
tools = replay_exporter()


class EndEffectorTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / "_expr_data/tests"
        folder.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=folder)
        self.root = Path(self.temporary.name)
        models = self.root / "models"
        models.mkdir()
        (models / "tiago_pro").symlink_to(MPC_ROOT / "models/tiago_pro", target_is_directory=True)
        self.full = models / "tiago_pro/tiago_pro.urdf"
        self.reduced = self.root / "tiago_right_arm.urdf"
        tree = ET.parse(arm_urdf())
        # A nontrivial test TCP ensures production code reads the URDF origin
        # rather than copying TIAGo's current grasp offset into the viewer.
        ET.SubElement(tree.getroot(), "link", name="test_grasp_link")
        joint = ET.SubElement(tree.getroot(), "joint", name="test_grasp_joint", type="fixed")
        ET.SubElement(joint, "parent", link="arm_right_tool_link")
        ET.SubElement(joint, "child", link="test_grasp_link")
        ET.SubElement(joint, "origin", xyz="0.01 -0.02 0.13", rpy="0.1 0.2 -0.3")
        tree.write(self.reduced)
        # The viewer asks the checkout of the full URDF for its reduced arm.
        derived = patch("live_mpc.import_tiago", return_value=SimpleNamespace(arm_urdf=lambda: self.reduced))
        derived.start()
        self.addCleanup(derived.stop)
        self.q = np.array([[-.39, -1.73, -.38, -2.35, 0, -1.21, .04],
                           [-.25, -1.6, -.5, -2.1, .1, -1., -.1]])
        self.path = tools.save_replay(self.root / "replay.npz", time_s=[0, .03], q=self.q,
                                      joint_names=JOINT_NAMES, model_urdf=self.full, time_basis="simulation",
                                      end_effector_frame=tools.FLANGE_FRAME)

    def tearDown(self):
        self.temporary.cleanup()

    def expected(self, frame):
        kinematics = RobotKinematics(self.full)
        model = pin.buildModelFromUrdf(str(self.reduced))
        data = model.createData()
        frame_id = model.getFrameId(frame)
        points = []
        for q in self.q:
            pin.forwardKinematics(model, data, q)
            pin.updateFramePlacements(model, data)
            points.append(kinematics.world_from_torso.act(data.oMf[frame_id].translation))
        return np.asarray(points)

    def test_orientation_uses_selected_tcp_and_roundtrips_reference_frame(self):
        kinematics = RobotKinematics(self.full, end_effector_frame='test_grasp_joint')
        model = pin.buildModelFromUrdf(str(self.reduced))
        data = model.createData()
        frame_id = model.getFrameId('test_grasp_joint')
        expected = []
        for q in self.q:
            pin.forwardKinematics(model, data, q)
            pin.updateFramePlacements(model, data)
            expected.append(kinematics.world_from_torso.rotation @ data.oMf[frame_id].rotation)
        for actual, target in zip(kinematics.ee_rotvecs(self.q), expected):
            np.testing.assert_allclose(pin.exp3(actual), target, atol=1e-10)
        rotation = np.array([.3, -.2, .1])
        torso = kinematics.rotation_to_torso(rotation)
        np.testing.assert_allclose(pin.exp3(kinematics.rotation_to_world(torso)),
                                   pin.exp3(rotation), atol=1e-10)

    def test_selected_tcp_matches_reduced_model_and_preserves_legacy_flange(self):
        for frame in ("arm_right_tool_joint", "test_grasp_joint"):
            with self.subTest(frame=frame):
                kinematics = RobotKinematics(self.full, end_effector_frame=frame)
                np.testing.assert_allclose(kinematics.ee_positions(self.q), self.expected(frame), atol=1e-10)
        with self.assertRaisesRegex(ValueError, "Missing fixed end-effector"):
            RobotKinematics(self.full, end_effector_frame="missing")

    def test_adapter_reference_preserves_world_goal_and_clears_removed_orientation(self):
        from solver_adapter import SimulatorAdapter
        adapter = SimulatorAdapter.__new__(SimulatorAdapter)
        adapter.kinematics = RobotKinematics(self.full, end_effector_frame='test_grasp_joint')
        adapter.default_target = np.array([.3, -.2, .5])
        adapter.figure8_start_world = np.zeros(3)
        task = dict(kind='reach', target_offset_m=[0., 0., 0.], orientation_rad=[.2, -.3, .1])
        adapter.configure_task(3, .03, task)
        world = adapter.kinematics.rotation_to_world(adapter.reference[0, 3:])
        np.testing.assert_allclose(pin.exp3(world), pin.exp3(np.array(task['orientation_rad'])), atol=1e-7)
        adapter.configure_task(3, .03, dict(task, orientation_rad=None))
        self.assertTrue(np.isnan(adapter.reference[:, 3:]).all())
        self.assertTrue(np.isfinite(adapter.reference[:, :3]).all())

    def test_live_orientation_error_uses_segment_goal_without_changing_arrival(self):
        from live_presentation import render_state
        kinematics = RobotKinematics(self.full, end_effector_frame='test_grasp_joint')
        q = self.q[0]
        actual = kinematics.ee_rotvecs(q[None])[0]
        goal = pin.log3(pin.exp3(actual) @ pin.exp3(np.array([0., 0., .4])))
        state = snapshot(dict(type='state', _x=np.r_[q, np.zeros(7)],
                              target_xyz=kinematics.ee_positions(q[None])[0].tolist()))
        context = dict(task=dict(kind='reach', orientation_rad=goal.tolist()),
                       position_tol_m=.05, speed_l1_tol_rad_s=1.)
        rendered = render_state(state, kinematics, context)
        self.assertAlmostEqual(rendered['orientation_error_rad'], .4)
        self.assertTrue(rendered['arrived'])

    def test_replay_metadata_selects_tcp_and_missing_metadata_stays_flange(self):
        replay = load_replay(self.path, model_urdf=self.full)
        base = dict(fixed_joints={}, source={}, end_effector_frame="test_grasp_joint")
        legacy = replace(replay, metadata={key: value for key, value in replay.metadata.items()
                                           if key != "end_effector_frame"})
        for frame in ("arm_right_tool_joint", "test_grasp_joint"):
            selected = legacy if frame == "arm_right_tool_joint" else replace(
                replay, metadata={**replay.metadata, "end_effector_frame": frame})
            scene = replay_scene(selected, self.path, self.root, base)
            self.assertEqual(scene["end_effector_frame"], frame)
            np.testing.assert_allclose(scene["trajectories"][0]["ee_xyz"], self.expected(frame), atol=1e-10)

    def test_live_renderer_uses_the_frame_in_compute_snapshots(self):
        renderer = LiveRenderer(self.root)
        for frame in ("arm_right_tool_joint", "test_grasp_joint"):
            target = self.expected(frame)[0]
            state = snapshot(dict(type="state", _x=np.r_[self.q[0], np.zeros(7)], target_xyz=target.tolist()))
            context = dict(end_effector_frame=frame, task=dict(kind="reach"), position_tol_m=.05, speed_l1_tol_rad_s=1.)
            rendered = renderer((None, state, []), context)[0]
            np.testing.assert_allclose(rendered["ee_xyz"], target, atol=1e-10)
            self.assertLess(rendered["distance_m"], 1e-10)
            self.assertTrue(rendered["arrived"])
            self.assertEqual(renderer.kinematics.end_effector_frame, frame)
