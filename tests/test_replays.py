"""Portable replay data, recursive catalog, original-byte upload and HTTP checks."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

import numpy as np

from replay_format import JOINT_NAMES, ReplayError, load_replay
from replay_library import ReplayLibrary, UploadConflict
from server import RobotKinematics, load_scene, make_server, replay_scene

ROOT = Path(__file__).resolve().parents[1]
MPC_ROOT = ROOT.parent / "tiago_mpc"
MODEL = MPC_ROOT / "models/tiago_pro/tiago_pro.urdf"
spec = importlib.util.spec_from_file_location("tiago_experiment_tools", MPC_ROOT / "experiments/tools.py")
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)


@unittest.skipUnless(MODEL.is_file(), "Sibling canonical TIAGo model is not available")
class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_scene, cls.robot_xml, cls.meshes = load_scene(MPC_ROOT)

    def setUp(self):
        parent = ROOT / "_expr_data/tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.folder = Path(self.temporary.name)
        self.q = np.array([[-.39, -1.73, -.38, -2.35, 0, -1.21, .04],
                           [-.37, -1.71, -.4, -2.32, 0, -1.2, .04]])
        self.time = np.array([0, .03])
        self.path = self.export(self.folder / "example.npz")

    def tearDown(self):
        self.temporary.cleanup()

    def export(self, path, **overrides):
        arguments = dict(time_s=self.time, q=self.q, joint_names=JOINT_NAMES,
                         model_urdf=MODEL, time_basis="simulation")
        arguments.update(overrides)
        return tools.save_replay(path, **arguments)

    def rewritten(self, **changes):
        with np.load(self.path, allow_pickle=False) as archive:
            arrays = {name: archive[name] for name in archive.files}
        metadata = json.loads(str(arrays["metadata_json"].item()))
        metadata.update(changes.pop("metadata", {}))
        arrays.update(changes)
        arrays["metadata_json"] = np.asarray(json.dumps(metadata))
        stream = io.BytesIO()
        np.savez_compressed(stream, **arrays)
        return stream

    def library(self):
        return ReplayLibrary(ingest_directory=self.folder / "ingest", upload_directory=self.folder / "uploads",
                             model_urdf=MODEL, default_scene=self.base_scene,
                             scene_builder=lambda replay, path: replay_scene(replay, path, MPC_ROOT, self.base_scene))

    def test_export_roundtrip_ordering_predictions_and_producer_has_no_viewer_dependency(self):
        q = self.q[:, ::-1]
        provenance = dict(source_directory="original/run", source_model_sha256="historical-identity",
                          outcome=dict(status="timeout", limits_pass=True))
        path = self.export(self.path, q=q, joint_names=iter(reversed(JOINT_NAMES)),
                           provenance=provenance, label="Laptop run", reference_xyz_m=[.3, -.2, .5], reference_frame="base_footprint",
                           plans=[dict(origin_time_s=.03, time_s=[0, .01, .02],
                                       q=np.repeat(q[:1], 3, axis=0), stats=dict(sqp_iters=5),
                                       reference_xyz_m=None)])
        replay = load_replay(path, model_urdf=MODEL)
        np.testing.assert_array_equal(replay.q, self.q)
        np.testing.assert_array_equal(replay.time_s, self.time)
        np.testing.assert_array_equal(replay.predictions[0].q, np.repeat(self.q[:1], 3, axis=0))
        self.assertEqual(replay.predictions[0].origin_time_s, .03)
        self.assertEqual(replay.metadata["time_basis"], "simulation")
        self.assertEqual(replay.metadata["provenance"], provenance)
        scene = replay_scene(replay, path, MPC_ROOT, self.base_scene)
        self.assertEqual(scene["source"]["provenance"], provenance)
        for invalid in ([], dict(nonfinite=float("nan"))):
            with self.subTest(provenance=invalid), self.assertRaises(ValueError):
                self.export(self.path, provenance=invalid)
        source = (MPC_ROOT / "experiments/tools.py").read_text()
        self.assertNotIn("from replay_format", source)
        self.assertNotIn("import pinocchio", source)
        self.assertNotIn("import gato", source)

    def test_invalid_samples_names_identity_and_reference_are_rejected_without_repair(self):
        cases = [dict(time_s=[0, 0]), dict(time_s=[.03, .01]), dict(q=np.full((2, 7), np.nan)),
                 dict(metadata=dict(joint_names=["unknown"]*7)),
                 dict(metadata=dict(model_sha256="outdated")),
                 dict(metadata=dict(time_basis="solver")), dict(metadata=dict(provenance=[])), dict(reference_xyz_m=[0, 0, 0]),
                 dict(metadata=dict(fixed_joints={"arm_right_1_joint": 0})),
                 dict(metadata=dict(fixed_joints={"unknown": 0})),
                 dict(metadata=dict(predictions=[dict(time_key="time_s", q_key="q")]))]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ReplayError):
                load_replay(self.rewritten(**changes), model_urdf=MODEL)
        # Finite historical joint-limit violations remain source evidence.
        replay = load_replay(self.rewritten(q=np.full((2, 7), 10.0)), model_urdf=MODEL)
        self.assertEqual(replay.q[0, 0], 10)
        with self.assertRaises(ValueError):
            self.export(self.path, time_s=np.array([3, 1], dtype=np.uint64))

    def test_moving_reference_and_fixed_torso_use_full_root_fk(self):
        path = self.export(self.path, time_basis="wall", fixed_joints=dict(torso_lift_joint=.15),
                           reference_frame="torso_lift_link", reference_time_s=[0, .03],
                           reference_xyz_m=[[.2, -.1, .3], [.3, -.2, .4]],
                           plans=[dict(origin_time_s=.015, time_s=[0, .015], q=self.q)])
        replay = load_replay(path, model_urdf=MODEL)
        scene = replay_scene(replay, path, MPC_ROOT, self.base_scene)
        kin = RobotKinematics(MODEL, fixed_joints=dict(torso_lift_joint=.15))
        recorded, plan = scene["trajectories"]
        np.testing.assert_allclose(recorded["ee_xyz"], kin.ee_positions(self.q), atol=1e-12)
        expected = np.array([kin.target_to_world(row) for row in replay.reference.xyz])
        np.testing.assert_allclose(recorded["reference_xyz"], expected, atol=1e-12)
        np.testing.assert_allclose(plan["reference_xyz"], [expected.mean(axis=0), expected[-1]], atol=1e-12)
        self.assertEqual(scene["fixed_joints"]["torso_lift_joint"], .15)
        self.assertEqual(recorded["metadata"]["time_basis"], "wall")
        self.assertEqual(plan["metadata"]["recorded_start_s"], .015)
        self.assertEqual(self.base_scene["fixed_joints"]["torso_lift_joint"], 0)

    def test_object_arrays_and_lying_npy_headers_are_rejected_before_allocation(self):
        with self.assertRaisesRegex(ReplayError, "Object/pickle"):
            load_replay(self.rewritten(q=np.array([[object()]], dtype=object)), model_urdf=MODEL)
        header = io.BytesIO()
        np.lib.format.write_array_header_1_0(header, dict(descr="<f8", fortran_order=False, shape=(10**12,)))
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as packed:
            packed.writestr("time_s.npy", header.getvalue())
        archive.seek(0)
        with self.assertRaisesRegex(ReplayError, "limit|header size"):
            load_replay(archive, model_urdf=MODEL)

    def test_recursive_catalog_errors_recover_after_file_changes_and_snapshot_stays_loaded(self):
        library = self.library()
        ingest = library.ingest_directory / "group/subfolder"
        ingest.mkdir(parents=True)
        replay_path = ingest / "reach.npz"
        shutil.copyfile(self.path, replay_path)
        broken = ingest / "partial.npz"
        broken.write_bytes(b"unfinished write")
        (ingest / ".hidden.npz").write_bytes(b"ignored")
        (ingest / "temporary.npz.tmp").write_bytes(b"ignored")
        first = library.catalog()
        self.assertEqual(len(first["items"]), 3)
        ready = next(item for item in first["items"] if item["name"] == "group/subfolder/reach")
        error = next(item for item in first["items"] if item["name"] == "group/subfolder/partial")
        self.assertEqual(error["status"], "error")
        snapshot = library.scene(ready["id"])
        self.assertEqual(first, library.catalog())
        shutil.copyfile(self.path, broken)
        self.export(replay_path, q=self.q+.01)
        second = library.catalog()
        self.assertGreater(second["revision"], first["revision"])
        changed = next(item for item in second["items"] if item["id"] == ready["id"])
        self.assertNotEqual(changed["revision"], ready["revision"])
        self.assertTrue(all(item["status"] == "ready" for item in second["items"]))
        np.testing.assert_array_equal(snapshot["trajectories"][0]["q"], self.q)
        np.testing.assert_array_equal(library.scene(ready["id"])["trajectories"][0]["q"], self.q+.01)

    def test_upload_preserves_bytes_refuses_collisions_invalid_paths_and_symlinks(self):
        library = self.library()
        raw = self.path.read_bytes()
        item = library.upload("folder/reach.npz", raw)
        self.assertEqual((library.upload_directory / "folder/reach.npz").read_bytes(), raw)
        self.assertEqual(item["status"], "ready")
        with self.assertRaises(UploadConflict):
            library.upload("folder/reach.npz", raw)
        for relative in ("../outside.npz", "/absolute.npz", "a/../escape.npz", "a\\escape.npz", ".hidden.npz", "a//b.npz"):
            with self.subTest(relative=relative), self.assertRaises(ReplayError):
                library.upload(relative, raw)
        outside = self.folder / "outside"
        outside.mkdir()
        (library.upload_directory / "linked").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ReplayError):
            library.upload("linked/escape.npz", raw)
        self.assertEqual(list(outside.iterdir()), [])
        with self.assertRaises(ReplayError):
            library.upload("invalid.npz", b"invalid")
        self.assertFalse((library.upload_directory / "invalid.npz").exists())

    def test_no_legacy_recording_bootstraps_without_fabricated_trajectory(self):
        fresh = self.folder / "fresh-checkout"
        (fresh / "models").mkdir(parents=True)
        (fresh / "models/tiago_pro").symlink_to(MODEL.parent, target_is_directory=True)
        scene, _, _ = load_scene(fresh)
        self.assertTrue(scene["source"]["bootstrap"])
        self.assertEqual(scene["trajectories"], [])
        self.assertTrue(all(name in scene["fixed_joints"] for name in JOINT_NAMES))
        library = ReplayLibrary(ingest_directory=self.folder / "ingest", upload_directory=self.folder / "uploads",
                                model_urdf=MODEL, default_scene=scene,
                                scene_builder=lambda replay, path: replay_scene(replay, path, MPC_ROOT, scene))
        self.assertEqual(library.catalog()["items"][0]["name"], "Starting pose")
        uploaded = library.upload("reach.npz", self.path.read_bytes())
        selected = library.scene(uploaded["id"])
        self.assertFalse(any(name in selected["fixed_joints"] for name in JOINT_NAMES))
        np.testing.assert_array_equal(selected["trajectories"][0]["q"], self.q)
        with self.assertRaises(ValueError):
            load_scene(fresh, self.folder / "missing-explicit-recording")

    def test_http_catalog_upload_scene_and_errors(self):
        library = self.library()
        server = make_server(self.base_scene, self.robot_xml, self.meshes, port=0, replays=library)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base+"/api/replays") as response:
                self.assertEqual(json.load(response)["items"][0]["id"], "default")
            request = Request(base+"/api/replays/upload?"+urlencode(dict(path="laptop/test.npz")),
                              data=self.path.read_bytes(), headers={"Content-Type": "application/octet-stream"})
            with urlopen(request) as response:
                uploaded = json.load(response)
            self.assertTrue(uploaded["accepted"])
            with urlopen(base+"/api/replays/scene?"+urlencode(dict(id=uploaded["id"]))) as response:
                selected = json.load(response)
            np.testing.assert_array_equal(selected["trajectories"][0]["q"], self.q)
            self.assertIsNone(selected["trajectories"][0]["target_xyz"])
            with urlopen(base+"/api/replays/scene?id=default") as response:
                self.assertEqual(json.load(response), self.base_scene)
            with self.assertRaises(HTTPError) as conflict:
                urlopen(request)
            self.assertEqual(conflict.exception.code, 409)
            self.assertFalse(json.load(conflict.exception)["accepted"])
            with self.assertRaises(HTTPError) as missing:
                urlopen(base+"/api/replays/scene?id=absent")
            self.assertEqual(missing.exception.code, 404)
            request.add_header("Origin", "https://unrelated.example")
            with self.assertRaises(HTTPError) as forbidden:
                urlopen(request)
            self.assertEqual(forbidden.exception.code, 403)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
