"""Start-pose scene, kinematics and HTTP checks against the canonical model, without GPU work."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

import numpy as np
import pinocchio as pin

from server import JOINT_NAMES, RobotKinematics, SourceError, decode_prediction, decode_prediction_telemetry, load_scene, make_server

from tiago_mpc_source import MPC_ROOT, arm_urdf, start_pose


class OrientationReferenceTests(unittest.TestCase):
    def test_orientation_error_holds_targets_and_preserves_absent_rows(self):
        from replay_format import Reference
        from server import orientation_errors
        reference = Reference(xyz=np.zeros((3, 3)), time_s=np.array([1., 2., 3.]),
                              frame='base_footprint',
                              rotvec=np.array([[0., 0., np.pi / 2], [np.nan] * 3, [0., 0., 0.]]))
        kinematics = SimpleNamespace(ee_rotvecs=lambda q: np.zeros((len(q), 3)))
        errors = orientation_errors(reference, kinematics, np.array([1., 1.5, 2., 3.]),
                                    np.zeros((4, 7)))
        np.testing.assert_allclose(errors[:2], [np.pi / 2] * 2)
        self.assertIsNone(errors[2])
        self.assertEqual(errors[3], 0.)

    def test_reference_wire_preserves_absent_orientation_and_rejects_invalid_rows(self):
        from solver_process import reference_from_wire, reference_to_wire
        reference = np.array([[1., 2., 3., np.nan, np.nan, np.nan],
                              [4., 5., 6., 0., .2, .3]])
        wire = reference_to_wire(reference)
        self.assertEqual(wire[0][3:], [None] * 3)
        json.dumps(wire, allow_nan=False)
        np.testing.assert_allclose(reference_from_wire(wire, 2), reference, rtol=1e-6)
        for invalid in ([[1., 2., 3., None, 0., None]], [[1., 2., 3., np.inf, np.inf, np.inf]],
                        [[None, 2., 3., 0., 0., 0.]]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                reference_from_wire(invalid, 1)
        with self.assertRaises(ValueError):
            reference_to_wire([[1., 2., 3., np.inf, np.inf, np.inf]])


class PredictionTests(unittest.TestCase):
    def test_gpu_signs_and_terminal_block(self):
        # Two complete blocks and a terminal state, deliberately distinct values.
        packed = np.arange(56, dtype=float)[None, :]
        signs = np.array([1, 1, 1, 1, 1, -1, 1])
        q = decode_prediction(packed, signs, 3)
        np.testing.assert_array_equal(q, np.array([np.arange(7), np.arange(21, 28),
                                                 np.arange(42, 49)]) * signs)
        self.assertEqual(q[-1, 5], -47)
        positions, velocity, torque = decode_prediction_telemetry(packed, signs, 3)
        np.testing.assert_array_equal(positions, q)
        np.testing.assert_array_equal(velocity, np.array([np.arange(7, 14), np.arange(28, 35),
                                                        np.arange(49, 56)]) * signs)
        np.testing.assert_array_equal(torque, np.array([np.arange(14, 21), np.arange(35, 42)]) * signs)
        self.assertEqual(torque.shape, (2, 7))  # no invented terminal control

    def test_bad_packed_shape_signs_and_nonfinite_rejected(self):
        for packed, signs in [(np.zeros(42), np.ones(7)),
                              (np.zeros(35), np.zeros(7)),
                              (np.full(35, np.nan), np.ones(7))]:
            with self.subTest(packed_size=packed.size, signs=signs):
                with self.assertRaises(SourceError):
                    decode_prediction(packed, signs, 2)


@unittest.skipUnless((MPC_ROOT / "models/tiago_pro/tiago_pro.urdf").is_file(),
                     "Canonical sibling tiago_mpc model is not available")
class CanonicalSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scene, cls.robot_xml, cls.meshes = load_scene(MPC_ROOT)

    def test_start_pose_scene_has_no_trajectories(self):
        self.assertTrue(self.scene["source"]["bootstrap"])
        self.assertEqual(self.scene["trajectories"], [])
        self.assertEqual(self.scene["world_frame"], "base_footprint")
        # The arm stands at Live's default start pose, tiago_mpc's Q_START (no hard-coded copy).
        from live_mpc import import_tiago
        self.assertEqual([self.scene["fixed_joints"][name] for name in JOINT_NAMES],
                         import_tiago(MPC_ROOT).Q_START.tolist())
        with self.assertRaisesRegex(SourceError, "one position per right-arm joint"):
            load_scene(MPC_ROOT, [0.] * 6)
        with tempfile.TemporaryDirectory() as empty, \
                self.assertRaisesRegex(SourceError, "Canonical full robot model is missing"):
            load_scene(empty, start_pose()["default"])

    def test_lfs_pointer_mesh_is_a_source_error(self):
        with tempfile.TemporaryDirectory() as folder:
            models = Path(folder) / "models/tiago_pro"
            (models / "meshes").mkdir(parents=True)
            urdf = models / "tiago_pro.urdf"
            urdf.write_bytes((MPC_ROOT / "models/tiago_pro/tiago_pro.urdf").read_bytes())
            for mesh in ET.parse(urdf).iter("mesh"):
                (models / "meshes" / Path(mesh.get("filename")).name).write_text(
                    "version https://git-lfs.github.com/spec/v1\n")
            with self.assertRaisesRegex(SourceError, "Git LFS pointer"):
                load_scene(folder, start_pose()["default"])

    def test_full_and_reduced_fk_agree_after_torso_transform(self):
        full = RobotKinematics(MPC_ROOT / "models/tiago_pro/tiago_pro.urdf")
        reduced = pin.buildModelFromUrdf(str(arm_urdf()))
        data = reduced.createData()
        fid = reduced.getFrameId("arm_right_tool_joint")
        rows = np.array([[-.39, -1.73, -.38, -2.35, 0, -1.21, .04],
                         [-.2, -1.5, -.5, -2.1, .3, -1., -.2],
                         [.1, -1.2, -.7, -1.8, .6, -.7, -.4]])
        expected = []
        for q in rows:
            pin.forwardKinematics(reduced, data, q)
            pin.updateFramePlacements(reduced, data)
            expected.append(full.world_from_torso.act(data.oMf[fid].translation))
        np.testing.assert_allclose(full.ee_positions(rows), expected, atol=1e-10)

    def test_mesh_uris_are_all_allowlisted(self):
        tree = ET.fromstring(self.robot_xml)
        urls = {mesh.get("filename") for mesh in tree.iter("mesh")}
        self.assertEqual(urls, set(self.meshes))
        self.assertTrue(all(p.is_file() for p in self.meshes.values()))
        self.assertEqual(len(urls), 35)
        # Live's body: the display posture, or a collision source's body posture.
        from live_mpc import body_joints
        self.assertEqual(self.scene["fixed_joints"]["torso_lift_joint"], body_joints(MPC_ROOT).get("torso_lift_joint", 0))

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


class ReplayOnlyApiTests(unittest.TestCase):
    def test_live_routes_report_the_reason_as_json(self):
        server = make_server(dict(trajectories=[]), b"<robot/>", {}, port=0,
                             live_error="Live is off: the server runs with --replay-only")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            for method, path, status in [("GET", "/api/live/schema", 503), ("GET", "/api/live/settings", 503),
                                         ("GET", "/api/live/history?generation=0", 503),
                                         ("GET", "/api/live/events", 503), ("POST", "/api/live/command", 503),
                                         ("GET", "/api/solver-profiles", 503), ("POST", "/api/solver-profiles/activate", 503),
                                         ("POST", "/api/solve-inspections", 503), ("GET", "/api/unknown", 404),
                                         ("POST", "/api/unknown", 404)]:
                with self.subTest(method=method, path=path):
                    request = Request(base + path, b"{}" if method == "POST" else None,
                                      {"Content-Type": "application/json"}, method=method)
                    with self.assertRaises(HTTPError) as error:
                        urlopen(request)
                    self.assertEqual(error.exception.code, status)
                    body = json.load(error.exception)
                    self.assertIn("replay-only" if status == 503 else "Unknown", body["error"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
