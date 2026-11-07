"""Portable replay data, recursive catalog, original-byte upload and HTTP checks."""
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from unittest.mock import patch
import zipfile

import numpy as np

from replay_format import JOINT_NAMES, ReplayError, load_replay, model_sha256
from replay_library import ReplayLibrary, UploadConflict
from server import RobotKinematics, load_scene, make_server, replay_scene

from tiago_mpc_source import MODEL, MPC_ROOT, REPLAY_EXPORTER, replay_exporter, start_pose

ROOT = Path(__file__).resolve().parents[1]
tools = replay_exporter()


@unittest.skipUnless(MODEL.is_file(), "Sibling canonical TIAGo model is not available")
class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_scene, cls.robot_xml, cls.meshes = load_scene(MPC_ROOT, start_pose()["default"])

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
                         model_urdf=MODEL, time_basis="simulation", end_effector_frame=tools.FLANGE_FRAME)
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

    def test_orientation_reference_roundtrip_preserves_missing_targets(self):
        path = self.export(self.path, reference_xyz_m=[[.3, -.2, .5]] * 2,
                           reference_time_s=self.time, reference_frame='torso_lift_link',
                           reference_rotvec_rad=[[0., .2, -.3], [np.nan] * 3])
        replay = load_replay(path, model_urdf=MODEL)
        np.testing.assert_allclose(replay.reference.rotvec[0], [0., .2, -.3])
        self.assertTrue(np.isnan(replay.reference.rotvec[1]).all())
        scene = replay_scene(replay, path, MPC_ROOT, self.base_scene)
        errors = scene['trajectories'][0]['orientation_error_rad']
        self.assertIsInstance(errors[0], float)
        self.assertIsNone(errors[1])
        json.dumps(scene, allow_nan=False)

    def test_replay_rejects_partial_or_infinite_orientation_rows(self):
        for row in ([0., np.nan, 0.], [np.inf] * 3):
            with self.subTest(row=row):
                data = self.rewritten(reference_xyz_m=np.array([.3, -.2, .5]),
                                      reference_rotvec_rad=np.array(row),
                                      metadata=dict(reference_frame='base_footprint'))
                with self.assertRaisesRegex(ReplayError, 'each orientation'):
                    load_replay(data, model_urdf=MODEL)

    def test_current_run_record_export_preserves_native_typed_params(self):
        from dataclasses import replace
        from live_mpc import import_tiago
        import_tiago(MPC_ROOT)
        import tiago_mpc as tm
        from experiments.reach import Reach
        params = replace(tm.TIAGO, N=3, friction=tm.urdf_friction(), friction_law=tm.Tanh(.03))
        record = tm.RunRecord(self.folder / 'native-run', params=params, task=Reach(),
                              plant=tm.SimConfig(), settings=tm.VirtualTimeSettings.ideal(),
                              loop="run_virtual_time", law=tm.SampleKnot(), compensation=None,
                              safety=tm.ExecutionSafety(), effort_handling=tm.EffortClip())
        states = np.repeat(np.r_[tm.Q_START, np.zeros(7)][None, :], 3, axis=0)
        prediction = tm.Plan(0., params.dt_s, states, np.zeros((2, 7)), measured_t=0.)
        record.solve_completed(tm.SolveCompleted(0., tm.State(0., tm.Q_START, np.zeros(7)),
                                                np.zeros((3, 6)), None, prediction))
        for i, t in enumerate([0., .002]):
            record(tm.Tick(t, tm.State(t, tm.Q_START, np.zeros(7)), np.zeros(7), prediction,
                           i == 0, i == 0))
        path = tools.export_replay(record)
        replay = load_replay(path, model_urdf=MODEL)
        serialized = replay.metadata['provenance']['params']
        self.assertEqual(serialized, tm.to_dict(params))
        self.assertNotIn('law', serialized['friction'])
        self.assertEqual(serialized['friction_law']['type'], 'Tanh')
        self.assertEqual(tm.from_dict(serialized), params)
        self.assertEqual(len(replay.predictions), 1)
        scene = replay_scene(replay, path, MPC_ROOT, self.base_scene)
        self.assertEqual(scene['mpc_bounds']['limit_bounds']['joint_margin_rad'], params.joint_margin_rad)

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
        source = REPLAY_EXPORTER.read_text()
        self.assertNotIn("from replay_format", source)
        self.assertNotIn("import pinocchio", source)
        self.assertNotIn("import gato", source)

    def test_plot_reader_real_npz_preserves_optional_data_and_elapsed_clock(self):
        from plot_sources import SourceReader, inspect_source
        from replay_library import _signature
        limits = dict(lower_position_rad=[-2]*7, upper_position_rad=[2]*7,
                      velocity_rad_s=[1]*7, effort_nm=[12]*7, source="Recorded limits")
        for telemetry in (False, True):
            extra = dict(qd_rad_s=np.ones((2,7)), torque_nm=np.ones((1,7)),
                         torque_time_s=[20.], joint_limits=limits) if telemetry else {}
            path = self.export(self.path, time_s=[20., 20.03], reference_xyz_m=[.3,-.2,.5], reference_frame="base_footprint",
                plans=[dict(id="saved", origin_time_s=20.02, time_s=[0,.01], q=self.q,
                            stats=dict(sqp_iters=3))], **extra)
            descriptor = dict(kind="replay", path=str(path), signature=list(_signature(path)),
                              revision=str(telemetry))
            raw = SourceReader(MPC_ROOT, self.base_scene).read(descriptor)
            self.assertAlmostEqual(raw["states"][1]["sim_time_s"], .03)
            self.assertEqual(raw["states"][0]["recorded_time_s"], 20)
            self.assertEqual("qd_rad_s" in raw["states"][0], telemetry)
            self.assertEqual(bool(raw["joint_limits"]), telemetry)
            if telemetry:
                self.assertEqual(raw["torque_samples"][0]["sim_time_s"], 0)
            plan, info = inspect_source(raw, dict(trajectory_index=1), dict(cursor_s=0))
            self.assertAlmostEqual(plan["sim_time_s"], .02)
            self.assertEqual(plan["stats"]["sqp_iters"], 3)
            self.assertEqual(info["selected_solve"]["iterations"], [])

    def test_optional_telemetry_ordering_interval_timing_and_historical_limits(self):
        order = np.arange(7)[::-1]
        velocity = np.arange(14).reshape(2, 7) / 10
        torque = np.arange(7)[None, :] - 3
        limits = dict(lower_position_rad=[-2]*7, upper_position_rad=[2]*7,
                      velocity_rad_s=list(range(1, 8)), effort_nm=list(range(10, 17)),
                      source="Recorded historical protocol")
        path = self.export(self.path, q=self.q[:, order], joint_names=list(reversed(JOINT_NAMES)),
            qd_rad_s=velocity[:, order], torque_nm=torque[:, order], torque_time_s=[0],
            joint_limits={key: (np.asarray(value)[order].tolist() if key != "source" else value)
                          for key, value in limits.items()},
            plans=[dict(origin_time_s=0, time_s=self.time, q=self.q[:, order],
                        qd_rad_s=velocity[:, order], torque_nm=torque[:, order], torque_time_s=[0])])
        replay = load_replay(path, model_urdf=MODEL)
        np.testing.assert_array_equal(replay.qd_rad_s, velocity)
        np.testing.assert_array_equal(replay.torque_nm, torque)
        np.testing.assert_array_equal(replay.torque_time_s, [0])
        self.assertEqual(replay.joint_limits, limits)
        np.testing.assert_array_equal(replay.predictions[0].qd_rad_s, velocity)
        scene = replay_scene(replay, path, MPC_ROOT, self.base_scene)
        recorded, plan = scene["trajectories"]
        self.assertEqual(scene["joint_limits"], limits)
        self.assertEqual(recorded["torque_kind"], "applied")
        self.assertNotIn("torque_end_time_s", recorded)
        self.assertEqual(plan["torque_kind"], "predicted")
        self.assertEqual(plan["torque_end_time_s"], .03)
        np.testing.assert_array_equal(plan["torque_nm"], torque)
        # Position-only archives retain genuinely unavailable telemetry.
        replay = load_replay(self.export(self.path), model_urdf=MODEL)
        self.assertIsNone(replay.qd_rad_s)
        self.assertIsNone(replay.torque_nm)
        fallback = replay_scene(replay, self.path, MPC_ROOT, self.base_scene)
        self.assertNotIn("qd_rad_s", fallback["trajectories"][0])
        self.assertEqual(fallback["joint_limits"]["source"], "Canonical display URDF limits")

    def test_optional_telemetry_rejects_wrong_shape_nonfinite_and_invalid_timestamps(self):
        for changes in (dict(qd_rad_s=np.zeros((1, 7))), dict(qd_rad_s=np.full((2, 7), np.nan)),
                        dict(torque_nm=np.zeros((1, 7))), dict(torque_time_s=[0]),
                        dict(torque_nm=np.zeros((2, 7)), torque_time_s=[0, .04]),
                        dict(torque_nm=np.zeros((2, 7)), torque_time_s=[0, 0]),
                        dict(metadata=dict(joint_limits=dict(lower_position_rad=[0]*7)))):
            with self.subTest(changes=changes), self.assertRaises(ReplayError):
                load_replay(self.rewritten(**changes), model_urdf=MODEL)
        for changes in (dict(qd_rad_s=np.zeros((1, 7))), dict(torque_time_s=[0]),
                        dict(torque_nm=np.zeros((1, 7))),
                        dict(torque_nm=np.zeros((1, 7)), torque_time_s=[.04]),
                        dict(joint_limits=dict(lower_position_rad=[0]*7))):
            with self.subTest(export=changes), self.assertRaises(ValueError):
                self.export(self.path, **changes)

    def test_invalid_samples_names_identity_and_reference_are_rejected_without_repair(self):
        cases = [dict(time_s=[0, 0]), dict(time_s=[.03, .01]), dict(q=np.full((2, 7), np.nan)),
                 dict(metadata=dict(joint_names=["unknown"]*7)),
                 dict(metadata=dict(model_sha256=None)),
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

    def test_different_model_file_loads_with_warning_but_incompatible_joints_fail(self):
        warning = dict(recorded_model_sha256="outdated", current_model_sha256=model_sha256(MODEL))
        self.assertIsNone(load_replay(self.path, model_urdf=MODEL).model_warning)
        replay = load_replay(self.rewritten(metadata=dict(model_sha256="outdated")), model_urdf=MODEL)
        self.assertEqual(replay.model_warning, warning)
        scene = replay_scene(replay, self.path, MPC_ROOT, self.base_scene)
        self.assertEqual(scene["source"]["full_urdf_sha256"], "outdated")
        self.assertEqual(scene["source"]["model_warning"], warning)
        # A different model file never excuses incompatible joints or frames.
        for changes in (dict(joint_names=["unknown"]*7), dict(fixed_joints={"unknown": 0})):
            with self.subTest(changes=changes), self.assertRaises(ReplayError):
                load_replay(self.rewritten(metadata=dict(model_sha256="outdated", **changes)), model_urdf=MODEL)
        ingest = self.folder / "ingest"
        ingest.mkdir()
        (ingest / "older_model.npz").write_bytes(self.rewritten(metadata=dict(model_sha256="outdated")).getvalue())
        library = self.library()
        item = next(item for item in library.catalog()["items"] if item["name"] == "older_model")
        self.assertEqual((item["status"], item["model_warning"]), ("ready", warning))
        self.assertEqual(library.scene(item["id"])["source"]["model_warning"], warning)

    def test_moving_reference_and_fixed_torso_use_full_root_fk(self):
        path = self.export(self.path, time_basis="wall", fixed_joints=dict(torso_lift_joint=.15),
                           reference_frame="torso_lift_link", reference_time_s=[0, .03],
                           reference_xyz_m=[[.2, -.1, .3], [.3, -.2, .4]],
                           plans=[dict(origin_time_s=.015, time_s=[0, .015], q=self.q)])
        replay = load_replay(path, model_urdf=MODEL)
        scene = replay_scene(replay, path, MPC_ROOT, self.base_scene)
        kin = RobotKinematics(MODEL, fixed_joints=dict(torso_lift_joint=.15),
                              end_effector_frame=replay.metadata["end_effector_frame"])
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

    def test_recorded_mpc_params_give_bounds_on_the_displayed_limits(self):
        params = dict(joint_margin_rad=.1, velocity_fraction=.8, effort_fraction=.85)
        path = self.export(self.path, provenance=dict(params=params))
        scene = replay_scene(load_replay(path, model_urdf=MODEL), path, MPC_ROOT, self.base_scene)
        limits = scene["joint_limits"]
        self.assertEqual(limits["source"], "Canonical display URDF limits")
        self.assertEqual(scene["mpc_bounds"]["upper_position_rad"], [v - .1 for v in limits["upper_position_rad"]])
        self.assertEqual(scene["mpc_bounds"]["effort_nm"], [.85 * v for v in limits["effort_nm"]])
        self.assertNotIn("mpc_bounds", replay_scene(load_replay(self.export(self.path), model_urdf=MODEL),
                                                    self.path, MPC_ROOT, self.base_scene))

    def test_figure_eight_sized_replay_loads_and_array_count_has_its_own_limit(self):
        # A default figure eight records 2400 plans with five arrays each; 1100
        # plans already exceed the former 1024-plan and 4096-array limits.
        plan = dict(time_s=[0, .01], q=self.q, qd_rad_s=np.zeros((2, 7)),
                    torque_nm=np.zeros((1, 7)), torque_time_s=[0])
        path = self.export(self.folder / "figure8.npz",
                           plans=[dict(plan, origin_time_s=i * .01) for i in range(1100)])
        self.assertEqual(len(load_replay(path, model_urdf=MODEL).predictions), 1100)
        with patch("replay_format.MAX_ARRAYS", 100), self.assertRaisesRegex(ReplayError, "100 array limit"):
            load_replay(path, model_urdf=MODEL)

    def test_recursive_catalog_errors_recover_after_file_changes_and_snapshot_stays_loaded(self):
        library = self.library()
        changes = []
        library.listeners.append(changes.append)  # the current replay (Run again results follow it)
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
        library.scene("default")
        self.assertEqual(changes, [(ready["id"], ready["revision"]), (ready["id"], changed["revision"]),
                                   ("default", "default")])
        self.assertEqual(library.current, ("default", "default"))

    def test_catalog_newest_first_across_ingest_and_upload_without_changing_identity(self):
        library = self.library()
        library.ingest_directory.mkdir()
        library.upload_directory.mkdir()
        older = library.ingest_directory / "z-older.npz"
        newer = library.upload_directory / "a-newer.npz"
        shutil.copyfile(self.path, older)
        shutil.copyfile(self.path, newer)
        os.utime(older, ns=(1_700_000_000_000_000_000,)*2)
        os.utime(newer, ns=(1_700_000_001_000_000_000,)*2)
        first = library.catalog()
        self.assertEqual([item["name"] for item in first["items"][:2]], ["a-newer", "z-older"])
        self.assertEqual(first["items"][-1]["id"], "default")
        older_id = first["items"][1]["id"]
        os.utime(older, ns=(1_700_000_002_000_000_000,)*2)
        second = library.catalog()
        self.assertEqual(second["items"][0]["id"], older_id)
        self.assertGreater(second["revision"], first["revision"])

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

    def test_start_pose_scene_has_no_fabricated_trajectory(self):
        fresh = self.folder / "fresh-checkout"
        (fresh / "models").mkdir(parents=True)
        (fresh / "models/tiago_pro").symlink_to(MODEL.parent, target_is_directory=True)
        scene, _, _ = load_scene(fresh, start_pose()["default"])
        self.assertTrue(scene["source"]["bootstrap"])
        self.assertEqual(scene["trajectories"], [])
        self.assertTrue(all(name in scene["fixed_joints"] for name in JOINT_NAMES))
        library = ReplayLibrary(ingest_directory=self.folder / "ingest", upload_directory=self.folder / "uploads",
                                model_urdf=MODEL, default_scene=scene,
                                scene_builder=lambda replay, path: replay_scene(replay, path, MPC_ROOT, scene))
        self.assertEqual(library.catalog()["items"][0]["name"], "Start pose")
        uploaded = library.upload("reach.npz", self.path.read_bytes())
        selected = library.scene(uploaded["id"])
        self.assertFalse(any(name in selected["fixed_joints"] for name in JOINT_NAMES))
        np.testing.assert_array_equal(selected["trajectories"][0]["q"], self.q)

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
