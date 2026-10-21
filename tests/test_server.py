"""Adapter checks against the retained canonical recording, without GPU work."""
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen
import xml.etree.ElementTree as ET

import numpy as np
import pinocchio as pin

from server import DEFAULT_RUN, JOINT_NAMES, RobotKinematics, SourceError, decode_prediction, load_scene, make_server

MPC_ROOT = Path(__file__).resolve().parents[2] / "tiago_mpc"


class PredictionTests(unittest.TestCase):
    def test_gpu_signs_and_terminal_block(self):
        # Two complete blocks and a terminal state, deliberately distinct values.
        packed = np.arange(56, dtype=float)[None, :]
        signs = np.array([1, 1, 1, 1, 1, -1, 1])
        q = decode_prediction(packed, signs, 3)
        np.testing.assert_array_equal(q, np.array([np.arange(7), np.arange(21, 28),
                                                 np.arange(42, 49)]) * signs)
        self.assertEqual(q[-1, 5], -47)

    def test_bad_packed_shape_signs_and_nonfinite_rejected(self):
        for packed, signs in [(np.zeros(42), np.ones(7)),
                              (np.zeros(35), np.zeros(7)),
                              (np.full(35, np.nan), np.ones(7))]:
            with self.subTest(packed_size=packed.size, signs=signs):
                with self.assertRaises(SourceError):
                    decode_prediction(packed, signs, 2)


@unittest.skipUnless((MPC_ROOT / DEFAULT_RUN / "trajectory.npz").is_file(),
                     "Canonical sibling tiago_mpc recording is not available")
class CanonicalSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scene, cls.robot_xml, cls.meshes = load_scene(MPC_ROOT)

    def test_native_recorded_state_and_gpu_prediction(self):
        recorded, predicted = self.scene["trajectories"][:2]
        with np.load(MPC_ROOT / DEFAULT_RUN / "trajectory.npz") as archive:
            np.testing.assert_array_equal(recorded["q"], archive["state"][:, :7])
            np.testing.assert_array_equal(recorded["time_s"], archive["time_s"])
        with np.load(MPC_ROOT / DEFAULT_RUN / "plan_0000.npz") as archive:
            np.testing.assert_array_equal(predicted["q"],
                                          decode_prediction(archive["xu"], archive["signs"], 32))
        self.assertLess(recorded["q"][0][5], 0)
        self.assertLess(predicted["q"][0][5], 0)
        self.assertEqual(len(self.scene["trajectories"]), 6)
        self.assertEqual(self.scene["world_frame"], "base_footprint")

    def test_full_and_reduced_fk_agree_after_torso_transform(self):
        full = RobotKinematics(MPC_ROOT / "models/tiago_pro/tiago_pro.urdf")
        reduced = pin.buildModelFromUrdf(str(MPC_ROOT / "models/tiago_right/tiago_right_arm.urdf"))
        data = reduced.createData()
        fid = reduced.getFrameId("arm_right_tool_joint")
        rows = np.asarray(self.scene["trajectories"][0]["q"])[[0, 50, -1]]
        expected = []
        for q in rows:
            pin.forwardKinematics(reduced, data, q)
            pin.updateFramePlacements(reduced, data)
            expected.append(full.world_from_torso.act(data.oMf[fid].translation))
        np.testing.assert_allclose(full.ee_positions(rows), expected, atol=1e-10)
        target_local = json.loads((MPC_ROOT / DEFAULT_RUN / "summary.json").read_text())["target_m"]
        np.testing.assert_allclose(self.scene["trajectories"][0]["target_xyz"],
                                   full.world_from_torso.act(np.asarray(target_local)), atol=1e-12)

    def test_mesh_uris_are_all_allowlisted(self):
        tree = ET.fromstring(self.robot_xml)
        urls = {mesh.get("filename") for mesh in tree.iter("mesh")}
        self.assertEqual(urls, set(self.meshes))
        self.assertTrue(all(p.is_file() for p in self.meshes.values()))
        self.assertEqual(len(urls), 35)
        self.assertEqual(self.scene["fixed_joints"]["torso_lift_joint"], 0)

    def test_source_failures_do_not_make_up_trajectories(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            with self.assertRaisesRegex(SourceError, "Canonical full robot model is missing"):
                load_scene(folder, MPC_ROOT / DEFAULT_RUN)
            shutil.copy(MPC_ROOT / DEFAULT_RUN / "summary.json", folder / "summary.json")
            np.savez(folder / "trajectory.npz", time_s=[0, 0], state=np.zeros((2, 14)))
            with self.assertRaisesRegex(SourceError, "strictly increasing"):
                load_scene(MPC_ROOT, folder)
            np.savez(folder / "trajectory.npz", time_s=[0, 1], state=np.zeros((2, 7)))
            with self.assertRaisesRegex(SourceError, "expected shape"):
                load_scene(MPC_ROOT, folder)
            np.savez(folder / "trajectory.npz", time_s=[0, 1], state=np.full((2, 14), np.nan))
            with self.assertRaisesRegex(SourceError, "nonfinite"):
                load_scene(MPC_ROOT, folder)

    def test_http_routes_and_path_allowlist(self):
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary) / "dist"
            dist.mkdir()
            (dist / "index.html").write_text("<h1>TIAGo</h1>")
            (Path(temporary) / "private.txt").write_text("must remain inaccessible")
            server = make_server(self.scene, self.robot_xml, self.meshes, port=0, dist=dist)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/api/scene") as response:
                    self.assertEqual(json.load(response)["joint_names"], JOINT_NAMES)
                with urlopen(base + "/api/health") as response:
                    self.assertEqual(json.load(response)["status"], "ok")
                with urlopen(base + "/") as response:
                    self.assertIn(b"TIAGo", response.read())
                with urlopen(base + "/assets/robot.urdf") as response:
                    self.assertIn(b"/assets/meshes/", response.read())
                mesh_url = next(iter(self.meshes))
                with urlopen(base + mesh_url) as response:
                    self.assertEqual(len(response.read()), self.meshes[mesh_url].stat().st_size)
                for path in ["/assets/meshes/missing.stl", "/assets/meshes/../robot.urdf",
                             "/%2e%2e/private.txt", "/api/source", "/server.py",
                             "/assets/meshes/%2fetc%2fpasswd", "/..%5cprivate.txt"]:
                    with self.subTest(path=path):
                        with self.assertRaises(HTTPError) as error:
                            urlopen(base + path)
                        self.assertEqual(error.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
