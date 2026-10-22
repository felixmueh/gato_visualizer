"""CPU FK and recording compatibility for application-defined TCP frames."""
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

import numpy as np
import pinocchio as pin

from live_presentation import LiveRenderer, snapshot
from replay_format import load_replay
from server import JOINT_NAMES, RobotKinematics, load_scene, replay_scene

from tiago_mpc_source import MPC_ROOT, replay_exporter

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
        reduced_dir = models / "tiago_right"
        reduced_dir.mkdir()
        self.reduced = reduced_dir / "tiago_right_arm.urdf"
        tree = ET.parse(MPC_ROOT / "models/tiago_right/tiago_right_arm.urdf")
        # A nontrivial test TCP ensures production code reads the URDF origin
        # rather than copying TIAGo's current grasp offset into the viewer.
        ET.SubElement(tree.getroot(), "link", name="test_grasp_link")
        joint = ET.SubElement(tree.getroot(), "joint", name="test_grasp_joint", type="fixed")
        ET.SubElement(joint, "parent", link="arm_right_tool_link")
        ET.SubElement(joint, "child", link="test_grasp_link")
        ET.SubElement(joint, "origin", xyz="0.01 -0.02 0.13", rpy="0.1 0.2 -0.3")
        tree.write(self.reduced)
        self.q = np.array([[-.39, -1.73, -.38, -2.35, 0, -1.21, .04],
                           [-.25, -1.6, -.5, -2.1, .1, -1., -.1]])
        self.path = tools.save_replay(self.root / "replay.npz", time_s=[0, .03], q=self.q,
                                      joint_names=JOINT_NAMES, model_urdf=self.full, time_basis="simulation")

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

    def test_selected_tcp_matches_reduced_model_and_preserves_legacy_flange(self):
        for frame in ("arm_right_tool_joint", "test_grasp_joint"):
            with self.subTest(frame=frame):
                kinematics = RobotKinematics(self.full, end_effector_frame=frame)
                np.testing.assert_allclose(kinematics.ee_positions(self.q), self.expected(frame), atol=1e-10)
        with self.assertRaisesRegex(ValueError, "Missing fixed end-effector"):
            RobotKinematics(self.full, end_effector_frame="missing")

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

    def test_legacy_run_summary_selects_tcp_explicitly(self):
        run = self.root / "run"
        run.mkdir()
        np.savez(run / "trajectory.npz", time_s=[0, .03], state=np.c_[self.q, np.zeros((2, 7))])
        summary = dict(joint_names=JOINT_NAMES, target_m=[.1, .2, .3], dt_s=.03, N=2)
        for frame in ("arm_right_tool_joint", "test_grasp_joint"):
            if frame == "test_grasp_joint":
                summary["end_effector_frame"] = frame
            (run / "summary.json").write_text(json.dumps(summary))
            scene, _, _ = load_scene(self.root, run)
            self.assertEqual(scene["end_effector_frame"], frame)
            np.testing.assert_allclose(scene["trajectories"][0]["ee_xyz"], self.expected(frame), atol=1e-10)

    def test_live_renderer_uses_the_frame_in_compute_snapshots(self):
        renderer = LiveRenderer(self.root)
        for frame in ("arm_right_tool_joint", "test_grasp_joint"):
            target = self.expected(frame)[0]
            state = snapshot(dict(type="state", _x=np.r_[self.q[0], np.zeros(7)],
                                  end_effector_frame=frame, target_xyz=target.tolist(), task_kind="reach",
                                  _position_tol=.05, _speed_tol=1.))
            rendered = renderer((None, state, []))[0]
            np.testing.assert_allclose(rendered["ee_xyz"], target, atol=1e-10)
            self.assertLess(rendered["distance_m"], 1e-10)
            self.assertTrue(rendered["arrived"])
            self.assertEqual(rendered["end_effector_frame"], frame)
