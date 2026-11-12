"""Session recording endpoints and producer round trips, without a solver/GPU."""
from copy import deepcopy
from collections import deque
from contextlib import nullcontext
import json
import os
from pathlib import Path
import queue
import shutil
import tempfile
import threading
import unittest
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

import numpy as np

from execution_bridge import LiveFreezeConflict, ProcessLiveService
from history_store import HistoryGenerationError, HistoryStore
from execution_session import DEFAULT_EXECUTION
from live_freeze import committed_records, export_freeze, freeze_arguments
from replay_format import JOINT_NAMES, ReplayError, load_replay
from replay_library import ReplayLibrary
from server import RobotKinematics, load_scene, make_server, replay_motion, replay_scene
from tests.tiago_mpc_source import MODEL, MPC_ROOT, replay_exporter

tools = replay_exporter()
ROOT = Path(__file__).resolve().parents[1]


def fixture_records(scene):
    q = [-.39, -1.73, -.38, -2.35, 0, -1.21, .04]
    context = dict(settings=dict(config=dict(N=3, plant=dict(friction=False)), task=dict(kind="reach"),
                                 execution=dict(control_hz=500)),
                   problem_configuration=dict(N=3, joint_margin_rad=.1),
                   source=dict(commit="fixture-source"), simulator_identity=dict(friction=False),
                   solver_profile=dict(profile=dict(id="test")), model_identity=dict(full_urdf_sha256="fixture-model"),
                   position_tol_m=.02, speed_l1_tol_rad_s=.1, end_effector_frame=scene["end_effector_frame"],
                   joint_limits=scene["joint_limits"])
    return [dict(type="segment", generation=7, sim_time_s=3., context=context),
            dict(type="state", generation=7, sim_time_s=3., q=q, qd=[.1]*7, torque_nm=None, target_xyz=[.3, -.2, .5]),
            dict(type="plan", generation=7, seq=1, origin="play", sim_time_s=3., knot_time_s=[0, .01, .02],
                 q=[q]*3, qd_rad_s=[[.2]*7]*3, torque_nm=[[4.]*7]*2, torque_time_s=[0, .01],
                 stats=dict(sqp_iters=2, duration_s=.001, available=True, detail=dict(nested=1))),
            dict(type="control", generation=7, sim_time_s=3., torque_nm=[2.]*7, planned_torque_nm=[99.]*7),
            dict(type="state", generation=7, sim_time_s=3.01, q=q, qd=[.2]*7, torque_nm=[2.]*7,
                 target_xyz=[.31, -.2, .5]),
            dict(type="plan", generation=7, seq=2, origin="preview", sim_time_s=3.01),
            dict(type="breach", generation=7, sim_time_s=3.02,
                 breaches=[dict(joint="arm_right_2_joint", quantity="velocity", value=3., limit=2.)]),
            dict(type="state", generation=7, sim_time_s=3.02, q=q, qd=[.3]*7, torque_nm=[3.]*7,
                 target_xyz=[.32, -.2, .5]),
            dict(type="interval", generation=7, end_time_s=3.02, mpc_wall_s=.001)]


def fixture_service(store):
    service = ProcessLiveService.__new__(ProcessLiveService)
    service.generation, service.version, service._freeze_epoch = 7, 0, 0
    service.closed = False
    service.mpc_root = MPC_ROOT
    service.condition = threading.Condition()
    service.profile_switch = dict(state="idle")
    service.latest = dict(status=dict(job_active=False, generation=7, settings_version=0))
    service.commands = queue.Queue()
    service.history_store = store
    return service


class LiveFreezeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scene, cls.robot_xml, cls.meshes = load_scene(MPC_ROOT)

    def setUp(self):
        parent = ROOT / "_expr_data/tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.folder = Path(self.temporary.name)
        self.records = fixture_records(self.scene)
        self.store = HistoryStore(self.folder / "history")
        self.store.reset(7)
        self.store.append(self.records)
        self.live = fixture_service(self.store)
        self.library = ReplayLibrary(ingest_directory=self.folder / "ingest", upload_directory=self.folder / "upload",
            freeze_directory=self.folder / "freezes/p999999997", model_urdf=MODEL, default_scene=self.scene,
            scene_builder=lambda replay, path: replay_scene(replay, path, MPC_ROOT, self.scene))

    def tearDown(self):
        self.store.close()
        self.library.close()
        self.temporary.cleanup()

    def export(self, records=None, path=None, **changes):
        arguments = dict(mpc_root=MPC_ROOT, model_urdf=MODEL, generation=7, complete=False,
                         fixed_joints=dict(torso_lift_joint=.12), world_frame=self.scene["world_frame"],
                         label="Freeze B · 12:34:56", frozen_at="2026-10-23T12:34:56+00:00", save_replay=tools.save_replay)
        arguments.update(changes)
        return export_freeze(path or self.folder / "freeze.npz", records or self.records, **arguments)

    def test_roundtrip_preserves_native_state_reference_plans_context_and_applied_torque(self):
        self.assertEqual(self.scene["world_frame"], "base_footprint")
        replay = load_replay(self.export(), model_urdf=MODEL)
        np.testing.assert_array_equal(replay.time_s, [3., 3.01, 3.02])
        np.testing.assert_array_equal(replay.q, [self.records[1]["q"]]*3)
        np.testing.assert_array_equal(replay.qd_rad_s, [[.1]*7, [.2]*7, [.3]*7])
        np.testing.assert_array_equal(replay.torque_time_s, [3.01, 3.02])
        np.testing.assert_array_equal(replay.torque_nm, [[2.]*7, [3.]*7])
        self.assertEqual(replay.reference.frame, "base_footprint")
        np.testing.assert_array_equal(replay.reference.xyz, [[.3,-.2,.5], [.31,-.2,.5], [.32,-.2,.5]])

        self.assertEqual(replay.metadata["fixed_joints"], dict(torso_lift_joint=.12))
        self.assertEqual(replay.joint_limits, self.scene["joint_limits"])
        self.assertEqual(len(replay.predictions), 1)
        plan = replay.predictions[0]
        self.assertEqual(plan.origin_time_s, 3.)
        np.testing.assert_array_equal(plan.time_s, [0, .01, .02])
        np.testing.assert_array_equal(plan.torque_nm, [[4.]*7]*2)
        self.assertEqual(plan.stats, dict(sqp_iters=2, duration_s=.001, available=True))
        provenance = replay.metadata["provenance"]
        self.assertEqual(provenance["params"], self.records[0]["context"]["problem_configuration"])
        live = provenance["live"]
        for key in ("settings", "source", "simulator_identity", "solver_profile", "model_identity",
                    "position_tol_m", "speed_l1_tol_rad_s"):
            self.assertEqual(live[key], self.records[0]["context"][key])
        self.assertEqual(live["breaches"], [self.records[6]])
        self.assertFalse(live["complete"])
        self.assertEqual((live["generation"], live["frozen_at"]), (7, "2026-10-23T12:34:56+00:00"))
        complete = load_replay(self.export(complete=True), model_urdf=MODEL)
        self.assertTrue(complete.metadata["provenance"]["live"]["complete"])

    def test_freeze_preserves_world_orientation_goal(self):
        records = deepcopy(self.records)
        records[0]['context']['settings']['task']['orientation_rad'] = [0., .2, -.3]
        replay = load_replay(self.export(records=records), model_urdf=MODEL)
        self.assertEqual(replay.reference.frame, self.scene['world_frame'])
        np.testing.assert_allclose(replay.reference.rotvec, [[0., .2, -.3]] * 3)
        scene = replay_scene(replay, self.folder / 'freeze.npz', MPC_ROOT, self.scene)
        self.assertEqual(len(scene['trajectories'][0]['orientation_error_rad']), 3)

    def test_freeze_preserves_exact_inputs_for_later_capped_inspection(self):
        from tests.test_solve_inspections import plan as captured_plan
        from inspection_problem import captured_problem
        from plot_sources import scene_records
        source = captured_plan()
        records = deepcopy(self.records)
        context = records[0]['context']
        for key in ('problem_configuration', 'constraint_bounds_native', 'model_identity', 'solver_profile'):
            context[key] = deepcopy(source[key])
        context['settings']['task'] = deepcopy(source['task'])
        records[2]['initial_state'] = deepcopy(source['initial_state'])
        records[2]['reference_native'] = [[.1, .2, .3, None, None, None]] * 3
        replay = load_replay(self.export(records=records), model_urdf=MODEL)
        raw = scene_records(replay_scene(replay, self.folder / 'freeze.npz', MPC_ROOT, self.scene))
        problem = captured_problem(raw['plans'][0])
        self.assertEqual(problem['initial_state'], source['initial_state'])
        self.assertEqual(problem['reference_native'], records[2]['reference_native'])
        self.assertEqual(problem['constraint_bounds_native'], source['constraint_bounds_native'])
        self.assertEqual(problem['problem_configuration'], source['problem_configuration'])

    def test_compensated_freeze_preserves_future_origin_and_actual_request_time_for_plots(self):
        from plot_sources import SourceReader
        from replay_library import _signature
        records = deepcopy(self.records)
        records[2].update(request_time_s=3., plan_origin_time_s=3.006, measured_time_s=3.)
        path = self.export(records=records)
        replay = load_replay(path, model_urdf=MODEL)
        self.assertEqual(replay.predictions[0].origin_time_s, 3.006)
        self.assertEqual(replay.metadata["provenance"]["live"]["plan_timing"]["live-1"],
                         dict(request_time_s=3., plan_origin_time_s=3.006, measured_time_s=3.))
        self.assertNotIn("plan_origin_time_s", replay.predictions[0].stats)
        reader = SourceReader(MPC_ROOT, self.scene)
        for comparison in (False, True):
            raw = reader.read(dict(kind="replay", id="freeze", path=str(path), signature=list(_signature(path)),
                                   comparison=comparison))
            self.assertEqual(raw["plans"][0]["sim_time_s"], 0.)
            self.assertEqual(raw["plans"][0]["recorded_origin_time_s"], 3.006)

    def test_freeze_retains_source_values_and_actual_resolved_models_and_law(self):
        records = deepcopy(self.records)
        header = records[0]["context"]
        header["settings"]["source_settings"] = dict(
            simulation=dict(armature_on=False, armature=[.5]*7, law="both"),
            predictor=dict(armature_on=True, armature=[.5]*7))
        effective = dict(params=dict(armature=[.5]*7), plant=dict(armature=[0.]*7),
                         law=dict(type="ExampleCustomLaw", gain=3.),
                         modules=dict(simulation=dict(path="/source/_visualizer/_settings.py", sha256="a"*64),
                                      predictor=dict(path="/profile/_visualizer/_settings.py", sha256="b"*64)))
        header["effective_settings"] = effective
        replay = load_replay(self.export(records), model_urdf=MODEL)
        live = replay.metadata["provenance"]["live"]
        self.assertEqual(live["settings"]["source_settings"], header["settings"]["source_settings"])
        self.assertEqual(live["effective_settings"], effective)

    def test_delayed_freeze_preserves_request_origin_and_actual_activation_in_optional_stats(self):
        records=deepcopy(self.records)
        records[2].update(request_time_s=3.,available_time_s=3.0055,scheduled_activation_time_s=3.006,
                          solve_latency_s=.0055,latency_overrun=False,controller_wall_s=.008)
        records[3].update(plan_seq=1,sim_time_s=3.006)
        pending=deepcopy(records[2]); pending.update(seq=3,sim_time_s=3.015,request_time_s=3.015,
            available_time_s=3.025,scheduled_activation_time_s=3.026)
        records.insert(-1,pending)
        replay=load_replay(self.export(records=records),model_urdf=MODEL)
        self.assertEqual([p.origin_time_s for p in replay.predictions],[3.,3.015])
        self.assertEqual(replay.predictions[0].stats['activation_time_s'],3.006)
        self.assertIsNone(replay.predictions[1].stats['activation_time_s'])
        np.testing.assert_array_equal(replay.predictions[0].time_s,[0,.01,.02])
        np.testing.assert_array_equal(replay.predictions[0].q,records[2]['q'])

    def test_limits_refused_and_partial_files_removed_without_silent_truncation(self):
        destination = self.folder / "freeze.npz"
        for target, limit, message in (("MAX_TOTAL_SAMPLES", 8, "8 total sample"),
                                       ("MAX_PREDICTIONS", 0, "0 prediction")):
            with self.subTest(limit=target), patch("live_freeze."+target, limit), self.assertRaisesRegex(ReplayError, message):
                self.export(path=destination)
            self.assertFalse(destination.exists())
        with patch("replay_format.MAX_COMPRESSED_BYTES", 20), self.assertRaisesRegex(ReplayError, "64 MiB"):
            self.export(path=destination)
        self.assertFalse(destination.exists())
        with self.assertRaisesRegex(ReplayError, "reference frame"):
            self.export(world_frame="unknown")
        with self.assertRaisesRegex(ReplayError, "segment header"):
            self.export(records=self.records[1:])
        with self.assertRaisesRegex(ReplayError, "generation"):
            self.export(generation=8)

    def test_committed_prefix_excludes_appends_and_remains_readable_after_replacement(self):
        prefix = self.store.open_committed_prefix(7)
        self.store.append([dict(type="state", generation=7, sim_time_s=4., q=[9]*7)])
        self.store.reset(8)
        with prefix["reader"] as reader:
            decoded = list(committed_records(reader, byte_end=prefix["byte_end"], cursor=prefix["cursor"]))
        self.assertEqual(decoded, self.records)

    def test_freeze_checks_generation_job_and_changes_during_export(self):
        destination = self.library.freeze_directory / "run.npz"
        writer = lambda records, complete: self.export(records=list(records), complete=complete, path=destination)
        item = self.live.freeze(7, writer, self.library.add_freeze)
        self.assertEqual(item["source"], "freeze")
        with self.assertRaises(HistoryGenerationError):
            self.live.freeze(6, writer, self.library.add_freeze)
        self.live.latest["status"]["job_active"] = True
        with self.assertRaises(LiveFreezeConflict):
            self.live.freeze(7, writer, self.library.add_freeze)
        self.live.latest["status"]["job_active"] = False
        def changed(records, complete):
            destination = writer(records, complete)
            self.live._freeze_epoch += 1
            return destination
        with self.assertRaises(LiveFreezeConflict):
            self.live.freeze(7, changed, self.library.add_freeze)
        self.assertFalse(destination.exists())

    def test_pending_export_is_hidden_until_accepted_and_failed_publication_does_not_overwrite(self):
        stage = self.library.freeze_directory / ".pending.npz"
        self.export(path=stage)
        self.assertEqual([item["id"] for item in self.library.catalog()["items"]], ["default"])
        item = self.library.add_freeze(stage)
        self.assertEqual(item["path"], "pending.npz")
        self.assertFalse(stage.exists())
        original = (self.library.freeze_directory / "pending.npz").read_bytes()
        self.export(path=stage, label="Collision")
        with self.assertRaises(FileExistsError):
            self.library.add_freeze(stage)
        self.assertEqual((self.library.freeze_directory / "pending.npz").read_bytes(), original)

    def test_breach_at_requested_end_and_explicit_cancel_freeze_as_incomplete(self):
        # The worker reports complete=True when a breach occurs exactly at the
        # requested endpoint. Retain that history meaning, but mark its freeze.
        self.store.complete = True
        self.live.events, self.live.cursor = deque(), 0
        self.live._profile_revision_floor = 0
        self.live.results = queue.Queue()
        self.live.revision = SimpleNamespace(value=0, get_lock=nullcontext)
        self.live._process = SimpleNamespace(is_alive=lambda: False)
        self.live.results.put(dict(kind="events", token=0, generation=7,
            events=[dict(type="status", state="paused", generation=7, complete=True, job_active=False,
                         breach=dict(sim_time_s=3.02, breaches=self.records[6]["breaches"]))]))
        self.live._receive()
        self.assertTrue(self.store.complete)
        captured = []
        def writer(records, complete):
            captured.append(complete)
            return self.export(records=list(records), complete=complete,
                               path=self.library.freeze_directory / "interrupted.npz")
        self.live.freeze(7, writer, self.library.add_freeze)
        self.assertFalse(captured[-1])
        self.live._freeze_interrupted = False
        self.live.latest["status"] = dict(state="paused", generation=7, job_active=False)
        self.live.execution, self.live.config, self.live.task = DEFAULT_EXECUTION, {}, {}
        self.live.next_version = 0
        self.live._generation_start = dict(kind="current")
        self.live._process = SimpleNamespace(is_alive=lambda: True)
        self.live.command(dict(type="cancel"))
        self.live.commands.get_nowait()
        self.live.latest["status"]["bridge_command_epoch"] = self.live._freeze_epoch
        self.live.freeze(7, writer, self.library.add_freeze)
        self.assertFalse(captured[-1])

    def test_consumed_play_command_refuses_stale_idle_status_until_idle_acknowledgement(self):
        self.live.execution, self.live.config, self.live.task = DEFAULT_EXECUTION, {}, {}
        self.live.next_version = 0
        self.live._generation_start = dict(kind="current")
        self.live._process = SimpleNamespace(is_alive=lambda: True)
        self.live.revision = SimpleNamespace(value=0)
        self.live.command(dict(type="play"))
        consumed = self.live.commands.get_nowait()
        self.assertTrue(self.live.commands.empty())
        self.assertEqual(consumed["bridge_command_epoch"], 1)
        writer = lambda records, complete: self.export(records=list(records), complete=complete,
                                                       path=self.library.freeze_directory / "acked.npz")
        with self.assertRaises(LiveFreezeConflict):
            self.live.freeze(7, writer, self.library.add_freeze)
        self.live.latest["status"].update(bridge_command_epoch=1, job_active=True)
        with self.assertRaises(LiveFreezeConflict):
            self.live.freeze(7, writer, self.library.add_freeze)
        self.live.latest["status"]["job_active"] = False
        self.live.latest["status"]["state"] = "gpu_busy"
        with self.assertRaises(LiveFreezeConflict):
            self.live.freeze(7, writer, self.library.add_freeze)
        self.live.latest["status"]["state"] = "paused"
        self.assertEqual(self.live.freeze(7, writer, self.library.add_freeze)["source"], "freeze")

    def test_freeze_catalog_cap_ownership_leftovers_and_shutdown(self):
        source = self.export()
        self.library.freeze_directory.mkdir(parents=True, exist_ok=True)
        for number in range(9):
            path = self.library.freeze_directory / f"freeze-{number}.npz"
            shutil.copyfile(source, path)
            os.utime(path, ns=(1_700_000_000_000_000_000+number,)*2)
            item = self.library.add_freeze(path)
            self.assertEqual(item["source"], "freeze")
        catalog = self.library.catalog()["items"]
        self.assertEqual(len([item for item in catalog if item["source"] == "freeze"]), 8)
        self.assertFalse((self.library.freeze_directory / "freeze-0.npz").exists())
        self.assertEqual(catalog[0]["path"], "freeze-8.npz")
        dead = self.library.freeze_directory.parent / "p999999998"
        dead.mkdir()
        (dead / "old.npz").write_bytes(b"leftover")
        alive = self.library.freeze_directory.parent / f"p{os.getpid()}"
        alive.mkdir()
        (alive / "active.npz").write_bytes(b"alive")
        library2 = ReplayLibrary(ingest_directory=self.folder / "ingest", model_urdf=MODEL,
            default_scene=self.scene, scene_builder=lambda *args: None,
            freeze_directory=self.library.freeze_directory.parent / "p999999996")
        self.assertFalse(dead.exists())
        self.assertTrue((alive / "active.npz").exists())
        library2.close()
        self.library.close()
        self.assertFalse(self.library.freeze_directory.exists())

    def test_motion_has_only_recorded_fk_base_transform_and_revision_cache_without_focus_change(self):
        item = self.library.add_freeze(self.export(path=self.library.freeze_directory / "freeze.npz"))
        self.library.scene("default")
        notifications = []
        self.library.listeners.append(notifications.append)
        with patch("server.RobotKinematics.ee_positions", autospec=True,
                   side_effect=RobotKinematics.ee_positions) as fk:
            motion = self.library.motion(item["id"])
            cached = self.library.motion(item["id"])
            self.assertEqual(fk.call_count, 1)
            self.assertEqual(len(fk.call_args.args[1]), 3)
        self.assertEqual(motion, cached)
        self.assertEqual(motion["plan_count"], 1)
        self.assertEqual(self.library.current, ("default", "default"))
        self.assertEqual(notifications, [])
        kin = RobotKinematics(MODEL, fixed_joints=dict(torso_lift_joint=.12))
        np.testing.assert_allclose(motion["arm_base"], kin.arm_base)
        original = RobotKinematics(MODEL)
        self.assertAlmostEqual(motion["arm_base"][2][3]-original.arm_base[2,3], .12)
        motion["q"][0][0] = 999
        self.assertNotEqual(self.library.motion(item["id"])["q"][0][0], 999)
        self.export(path=self.library.freeze_directory / "freeze.npz", label="Rewritten fixture")
        refreshed = self.library.motion(item["id"])
        self.assertEqual(refreshed["label"], "Rewritten fixture")
        self.assertNotEqual(refreshed["revision"], item["revision"])
        self.assertEqual(self.library.current, ("default", "default"))

    def test_http_motion_freeze_validation_conflicts_and_scene_roundtrip(self):
        server = make_server(self.scene, self.robot_xml, self.meshes, port=0, replays=self.library, live=self.live)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        def freeze(body, **headers):
            return urlopen(Request(base+"/api/live/freeze", data=json.dumps(body).encode(),
                                   headers={"Content-Type": "application/json", **headers}))
        try:
            with freeze(dict(generation=7)) as response:
                result = json.load(response)
            self.assertTrue(result["accepted"])
            item = result["item"]
            with urlopen(base+"/api/replays/motion?id="+item["id"]) as response:
                motion = json.load(response)
            self.assertEqual((motion["id"], motion["revision"]), (item["id"], item["revision"]))
            self.assertEqual(self.library.current, None)
            with urlopen(base+"/api/replays/scene?id="+item["id"]) as response:
                scene = json.load(response)
            self.assertEqual(len(scene["trajectories"]), 2)
            np.testing.assert_array_equal(scene["trajectories"][0]["q"], motion["q"])
            for body, status in ((dict(generation=6), 409), (dict(generation=True), 400),
                                 (dict(generation=7, path="escape"), 400)):
                with self.subTest(body=body), self.assertRaises(HTTPError) as error:
                    freeze(body)
                self.assertEqual(error.exception.code, status)
                self.assertFalse(json.load(error.exception)["accepted"])
            self.live.latest["status"]["job_active"] = True
            with self.assertRaises(HTTPError) as error:
                freeze(dict(generation=7))
            self.assertEqual(error.exception.code, 409)
            with self.assertRaises(HTTPError) as error:
                freeze(dict(generation=7), Origin="https://unrelated.example")
            self.assertEqual(error.exception.code, 403)
            for query, status in (("id=../freeze.npz",404), ("id="+item["id"]+"&path=",400),
                                  ("id="+item["id"]+"&id=other",400), ("",400), ("id=default",404)):
                with self.subTest(query=query), self.assertRaises(HTTPError) as error:
                    urlopen(base+"/api/replays/motion?"+query)
                self.assertEqual(error.exception.code, status)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
