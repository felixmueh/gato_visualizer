"""CPU-only validation and transport checks; no solver objects are constructed."""
from copy import deepcopy
import fcntl
import json
from pathlib import Path
import tempfile
import threading
import unittest
import numpy as np
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from live_mpc import (GPULocks, POSITION_TOL_M, SPEED_L1_TOL_RAD_S, build_schema, figure8_reference, mpc_bounds_from_rows,
                      FIGURE8_DEFAULT_TASK, REACH_DEFAULT_TASK, validate_settings)
from server import make_server
from live_presentation import LatestPresentation, mutable, render_plan, render_state, snapshot
from solver_adapter import SimulatorAdapter
from tests.tiago_mpc_source import MPC_ROOT, live_probe, start_pose


class SettingsTests(unittest.TestCase):
    def setUp(self):
        probe = live_probe()
        probe["available_N_by_friction"] = dict(off=[16, 32], on=[32])
        self.friction = probe["friction"]
        self.schema = build_schema(probe, MPC_ROOT, start_pose())
        self.config = deepcopy(self.schema["defaults"]["config"])
        self.task = deepcopy(REACH_DEFAULT_TASK)

    def test_schema_is_mpc_params_plus_the_simulated_plant(self):
        config, task = validate_settings(self.config, self.task, self.schema)
        self.assertEqual(config, self.config)
        self.assertIsNot(config, self.config)
        # TIAGO's defaults, without the SQP wall-time limit on the simulation clock
        self.assertEqual({key: value for key, value in config.items() if key != "plant"},
                         dict(live_probe()["defaults"], max_sqp_time_s=None))
        self.assertIsNotNone(live_probe()["defaults"]["max_sqp_time_s"])
        self.assertIs(config["warmup"], True)
        # Loss-free plant, effort clipped, stop on every limit breach (Felix, 2026-10-23)
        # The start pose is the simulator source's Q_START (Felix, 2026-10-23).
        self.assertEqual(config["plant"], dict(friction=False, clip_effort=True,
                                               stop_on_breach=dict(position=True, velocity=True, torque=True),
                                               start_pose_rad=start_pose()["default"]))
        self.assertIsNone(config["friction"])  # loss-free predictor and plant by default
        specs = {s["path"]: s for s in self.schema["parameters"]}
        self.assertEqual(set(specs), {"N", "dt_s", "ee_frame", "warm_start", "reset_rho_each_step", "admm_linsys",
            "joint_margin_rad", "velocity_fraction", "effort_fraction", "friction", "warmup", "max_sqp_time_s",
            "plant.friction", "plant.clip_effort", "plant.stop_on_breach.position", "plant.stop_on_breach.velocity",
            "plant.stop_on_breach.torque", "plant.start_pose_rad", *(f"solver.{key}" for key in config["solver"]), *(f"admm.{key}" for key in config["admm"])})
        self.assertEqual(specs["warm_start"]["choices"], ["shift", "hold"])
        self.assertEqual(specs["admm_linsys"]["choices"], ["pcg", "bdsv_factor", "auto"])
        for fixed in ("solver.exact_hessian", "solver.linsys", "ee_frame"):
            self.assertTrue(specs[fixed]["disabled"], fixed)
        self.assertEqual(specs["N"]["choices"], [16, 32])
        self.assertNotIn("disabled", specs["N"])
        self.assertEqual(specs["friction"]["choices"], [dict(value=None, label="Loss-free"), dict(
            value=self.friction, label="URDF Coulomb + viscous, tanh 0.03 rad/s")])
        self.assertEqual(self.friction["width_rad_s"], .03)
        self.assertEqual({key: specs["max_sqp_time_s"][key] for key in ("kind", "nullable", "min", "max")},
                         dict(kind="float", nullable=True, min=1e-4, max=10))
        self.assertEqual(specs["warmup"]["kind"], "bool")
        self.assertEqual(specs["plant.friction"]["group"], specs["friction"]["group"])
        for path, label in (("plant.clip_effort", "Clip effort"), ("plant.stop_on_breach.position", "Joint limits"),
                            ("plant.stop_on_breach.velocity", "Velocity"), ("plant.stop_on_breach.torque", "Torque")):
            self.assertEqual((specs[path]["kind"], specs[path]["group"], specs[path]["label"]),
                             ("bool", "Limit handling", label))
            self.assertTrue(specs[path]["description"])
        self.assertEqual({specs[f"plant.stop_on_breach.{key}"]["row"] for key in ("position", "velocity", "torque")},
                         {"Stop on breach"})
        validate_settings(dict(self.config, max_sqp_time_s=.05, warmup=False, friction=self.friction), self.task, self.schema)

    def test_the_start_pose_is_seven_positions_within_the_urdf_limits(self):
        spec = next(s for s in self.schema["parameters"] if s["path"] == "plant.start_pose_rad")
        limits = start_pose()
        self.assertEqual((spec["kind"], spec["group"], spec["label"]), ("joints", "Start pose", "Start pose"))
        self.assertEqual((spec["lower"], spec["upper"]), (limits["lower"], limits["upper"]))
        self.assertTrue(spec["description"])
        valid = list(limits["default"])
        valid[3] += .3
        valid[0] = limits["upper"][0]  # the URDF limit itself is allowed
        config = deepcopy(self.config)
        config["plant"]["start_pose_rad"] = valid
        self.assertEqual(validate_settings(config, self.task, self.schema)[0]["plant"]["start_pose_rad"], valid)
        beyond = list(limits["default"])
        beyond[1] = limits["lower"][1] - 1e-6
        for value in (beyond, valid[:6], valid + [0.], [*valid[:6], float("nan")], [*valid[:6], True], None, "q"):
            config["plant"]["start_pose_rad"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "plant.start_pose_rad"):
                validate_settings(config, self.task, self.schema)

    def test_a_new_text_parameter_is_shown_fixed_at_its_default(self):
        probe = live_probe()
        probe["defaults"] = dict(probe["defaults"], integrator="rk4")
        probe["available_N_by_friction"] = dict(off=[32], on=[])
        schema = build_schema(probe, MPC_ROOT, start_pose())
        spec = next(s for s in schema["parameters"] if s["path"] == "integrator")
        self.assertEqual((spec["kind"], spec["choices"], spec["disabled"]), ("choice", ["rk4"], True))
        validate_settings(schema["defaults"]["config"], self.task, schema)

    def test_nonfinite_limits_unknown_fields_and_uncompiled_n_rejected(self):
        cases = [("N", 128), ("N", True), ("N", 32.5), ("dt_s", float("nan")),
                 ("dt_s", -1), ("solver.max_sqp_iters", 100001),
                 ("solver.exact_hessian", True), ("solver.linsys", "qdldl"),
                 ("warm_start", "repeat"), ("admm.rho", float("inf")), ("velocity_fraction", 0),
                 ("ee_frame", "arm_right_tool_joint"), ("max_sqp_time_s", 0), ("warmup", 1), ("warmup", None), ("plant.friction", 1),
                 ("plant.clip_effort", None), ("plant.stop_on_breach.torque", 0),
                 ("friction", dict(self.friction, width_rad_s=.05)), ("friction", True)]
        for path, value in cases:
            config = deepcopy(self.config)
            parts = path.split(".")
            target = config
            for part in parts[:-1]:
                target = target[part]
            target[parts[-1]] = value
            with self.subTest(path=path, value=value), self.assertRaises(ValueError):
                validate_settings(config, self.task, self.schema)
        with self.assertRaises(ValueError):
            validate_settings({**self.config, "save_plan_steps": 1}, self.task, self.schema)
        with self.assertRaises(ValueError):
            validate_settings(self.config, {**self.task, "target_offset_m": [True, 0, 0]}, self.schema)
        with self.assertRaisesRegex(ValueError, "Not compiled: N=64 without predictor friction.*Build"):
            validate_settings(dict(self.config, N=64), self.task, self.schema)
        with self.assertRaisesRegex(ValueError, "Not compiled: N=16 with predictor friction"):
            validate_settings(dict(self.config, N=16, friction=self.friction), self.task, self.schema)


class LimitTests(unittest.TestCase):
    def test_mpc_bounds_are_the_installed_rows_and_asymmetric_rows_stay_absent(self):
        rows = [dict(lo=[-1.]*7, hi=[2.]*7), dict(lo=[-.8]*7, hi=[.8]*7), dict(lo=[-1.]*7, hi=[2.]*7)]
        bounds = mpc_bounds_from_rows(rows, dict(joint_margin_rad=.1, velocity_fraction=.8, effort_fraction=.85))
        self.assertEqual((bounds["lower_position_rad"], bounds["upper_position_rad"]), ([-1.]*7, [2.]*7))
        self.assertEqual(bounds["velocity_rad_s"], [.8]*7)
        self.assertNotIn("effort_nm", bounds)
        self.assertEqual(bounds["limit_bounds"]["effort_fraction"], .85)


class Figure8Tests(SettingsTests):
    def test_shape_clock_extent_and_native_validation(self):
        task = deepcopy(FIGURE8_DEFAULT_TASK)
        self.assertEqual(validate_settings(self.config, task, self.schema)[1], task)
        start = np.array([.4, -.3, 1.2])
        times = np.linspace(0, task["period_s"], 257)
        points = figure8_reference(times, start, task)
        np.testing.assert_allclose(points[0], start, atol=1e-15)
        np.testing.assert_allclose(points[-1], start, atol=1e-15)
        np.testing.assert_allclose(np.ptp(points, axis=0), [.24, .16, 0], atol=1e-14)
        # The plan and same-timestamp state target share exactly the same clock.
        np.testing.assert_array_equal(figure8_reference([3.], start, task)[0], points[32])
        task["target_offset_m"] = [.01, -.02, .03]
        np.testing.assert_allclose(figure8_reference([0], start, task)[0], start+task["target_offset_m"])
        for changes in (dict(period_s=0), dict(width_m=float("nan")), dict(height_m=True),
                        dict(unexpected=1), dict(kind="unknown")):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_settings(self.config, {**task, **changes}, self.schema)

    def test_rotation_moves_geometry_in_world_frame_about_static_start(self):
        start = np.array([.4, -.3, 1.2])
        task = deepcopy(FIGURE8_DEFAULT_TASK)
        task["target_offset_m"] = [.1, .2, .3]
        times = np.linspace(0, task["period_s"], 257)
        original = figure8_reference(times, start, task)
        # 90 degrees around world X rotates the local Y height into world Z.
        task["orientation_xyzw"] = [np.sqrt(.5), 0., 0., np.sqrt(.5)]
        rotated = figure8_reference(times, start, task)
        pivot = start + task["target_offset_m"]
        delta = original - pivot
        expected = pivot + np.column_stack((delta[:, 0], -delta[:, 2], delta[:, 1]))
        np.testing.assert_allclose(rotated, expected, atol=1e-14)
        np.testing.assert_allclose(rotated[0], pivot, atol=1e-15)
        np.testing.assert_allclose(np.ptp(rotated, axis=0), [.24, 0., .16], atol=1e-14)
        legacy = deepcopy(FIGURE8_DEFAULT_TASK)
        del legacy["orientation_xyzw"]
        validate_settings(self.config, legacy, self.schema)
        np.testing.assert_array_equal(figure8_reference(times, start, legacy),
                                      figure8_reference(times, start, FIGURE8_DEFAULT_TASK))
        for invalid in ([0, 0, 0, 0], [0, 0, 0, 2], [True, 0, 0, 0], [0, 0, float("nan"), 1], [0, 0, 1]):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "unit quaternion"):
                validate_settings(self.config, {**task, "orientation_xyzw": invalid}, self.schema)

    def test_tracking_horizon_offsets_and_terminal_reference_remain_aligned(self):
        adapter = SimulatorAdapter.__new__(SimulatorAdapter)
        adapter.task = {**deepcopy(FIGURE8_DEFAULT_TASK), "orientation_xyzw": [0., np.sqrt(.5), 0., np.sqrt(.5)]}
        adapter.figure8_start_world = np.array([.4, -.3, 1.2])
        adapter.t, adapter.N, adapter.dt = 7.2, 4, .03
        translation = np.array([.1, .2, .5])
        adapter.kinematics = SimpleNamespace(world_from_torso=SimpleNamespace(actInv=lambda p:p-translation))
        adapter.reference = np.zeros((4, 6), dtype=np.float32)
        adapter.update_tracking_reference()
        expected = figure8_reference(adapter.t+np.arange(4)*.03, adapter.figure8_start_world, adapter.task)
        np.testing.assert_allclose(adapter.reference[:, :3]+translation, expected, atol=1e-7)
        np.testing.assert_array_equal(adapter.reference[:, 3:], np.zeros((4, 3)))
        np.testing.assert_array_equal(adapter.target_world_at(adapter.t), expected[0])


class LockTests(unittest.TestCase):
    def test_failed_partial_acquisition_releases_previous_locks(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder) / "first", Path(folder) / "second"]
            with paths[1].open("a") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locks = GPULocks(MPC_ROOT)
                locks.paths = paths
                self.assertFalse(locks.acquire())
                self.assertEqual(locks.handles, [])
                with paths[0].open("a") as freed:
                    fcntl.flock(freed, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(locks.acquire())
            self.assertTrue(locks.acquire())
            locks.release()


class FakeRemote:
    """The solver child's compact solve reply: native plan arrays and stats."""
    epoch = "test-epoch"

    def request(self, operation, *, timeout=None, **payload):
        if operation != "solve":
            return None
        x, n = np.asarray(payload["state"]), len(payload["reference"])
        return dict(plan=dict(type="plan", origin=payload["origin"], settings_version=payload["settings_version"],
            initial_state=dict(q=x[:7].tolist(), qd=x[7:].tolist(), time_s=payload["time_s"]),
            sim_time_s=payload["time_s"], N=n, dt_s=.01, _states=np.tile(x, (n, 1)),
            _torques=np.arange(7.)[None].repeat(n-1, 0), stats=dict(sqp_iters=1),
            diagnostics=dict(initial_merit=12.)))


class AdapterTelemetryTests(unittest.TestCase):
    def adapter(self):
        live_probe()
        adapter = SimulatorAdapter(MPC_ROOT)
        adapter.remote, adapter.profile = FakeRemote(), dict(id="simulator")
        adapter.configure_task(2, .01, deepcopy(REACH_DEFAULT_TASK))
        adapter.joint_limits = dict(source="Test configured bounds")
        adapter._segment_context = snapshot(dict(joint_limits=adapter.joint_limits, task_anchors=adapter.task_anchors,
                                                 problem_configuration=dict(N=2, solver=dict(max_sqp_iters=3))))
        adapter.settings = dict(config=dict(N=2), task=deepcopy(adapter.task))
        return adapter

    CONTEXT = dict(task=dict(kind="reach"), position_tol_m=POSITION_TOL_M, speed_l1_tol_rad_s=SPEED_L1_TOL_RAD_S)

    def test_task_anchors_are_public_immutable_and_independent_of_task_edits(self):
        adapter = self.adapter()
        expected = mutable(adapter.task_anchors)
        np.testing.assert_allclose(expected["reach"], adapter.kinematics.target_to_world(
            adapter.tiago.fk(adapter.tiago.Q_REACH)))
        # The anchors are segment context: in the header, not in plans or states.
        header = adapter.segment_header(1, dict(control_hz=500.))
        self.assertEqual(header["context"]["task_anchors"], expected)
        self.assertEqual(header["context"]["settings"]["execution"], dict(control_hz=500.))
        self.assertNotIn("task_anchors", adapter.solve_snapshot("preview", 1))
        self.assertNotIn("task_anchors", adapter.state_snapshot())
        with self.assertRaises(TypeError):
            adapter.task_anchors["reach"][0] = 99
        adapter.configure_task(2, .01, {**FIGURE8_DEFAULT_TASK, "target_offset_m": [.1, -.2, .3],
                                        "width_m": .4, "height_m": .3, "orientation_xyzw": [1., 0., 0., 0.]})
        self.assertEqual(mutable(adapter.task_anchors), expected)
        self.assertEqual(header["context"]["task_anchors"], expected)

    def test_reset_restarts_plan_count_and_preview_does_not_claim_applied_torque(self):
        adapter = self.adapter()
        self.assertEqual(adapter.solve_snapshot("preview", 1)["seq"], 1)
        self.assertIsNone(adapter.state_snapshot()["torque_nm"])
        adapter.applied_torque = np.arange(7.)
        self.assertEqual(adapter.solve_snapshot("preview", 2)["seq"], 2)
        self.assertEqual(adapter.state_snapshot()["torque_nm"], tuple(range(7)))
        adapter.reset_state()
        self.assertEqual(adapter.t, 0)
        np.testing.assert_array_equal(adapter.x, np.r_[adapter.tiago.Q_START, np.zeros(7)])
        self.assertIsNone(adapter.state_snapshot()["torque_nm"])
        plan = render_plan(adapter.solve_snapshot("preview", 3), adapter.kinematics)
        self.assertEqual(plan["seq"], 1)
        self.assertEqual(len(plan["torque_nm"]), 1)
        self.assertEqual(plan["torque_end_time_s"], .01)
        self.assertEqual(plan["torque_kind"], "predicted")
        state = render_state(adapter.state_snapshot(), adapter.kinematics, self.CONTEXT)
        self.assertGreater(state["distance_m"], .05)
        self.assertFalse(state["arrived"])

    def test_presentation_snapshots_survive_control_progress_and_settings_mutation(self):
        adapter = self.adapter()
        adapter.x[:] = np.arange(14)
        plan = adapter.solve_snapshot("play", 3)
        state = adapter.state_snapshot(3)
        expected_plan = render_plan(plan, adapter.kinematics)
        expected_state = render_state(state, adapter.kinematics, self.CONTEXT)
        self.assertEqual(expected_plan["initial_state"]["q"], list(range(7)))
        self.assertNotIn("problem_configuration", expected_plan)  # segment context
        self.assertEqual(expected_plan["diagnostics"]["initial_merit"], 12.)
        adapter.x[:] = 0
        adapter.reference[:] = 123
        adapter.joint_limits["source"] = "New settings"
        adapter.reset_state()
        self.assertEqual(render_plan(plan, adapter.kinematics), expected_plan)
        self.assertEqual(render_state(state, adapter.kinematics, self.CONTEXT), expected_state)
        with self.assertRaises(ValueError):
            plan["_states"][0, 0] = 0
        with self.assertRaises(TypeError):
            plan["initial_state"]["q"] = "Mutation"
        json.dumps(expected_plan, allow_nan=False)


class PresentationTests(unittest.TestCase):
    def test_slow_frames_coalesce_and_command_boundaries_drop_obsolete_work(self):
        for invalidate in (False, True):
            with self.subTest(command_boundary=invalidate):
                entered, release, finished = (threading.Event() for _ in range(3))
                rendered, published = [], []
                def render(frame):
                    rendered.append(frame)
                    if frame == 1:
                        entered.set()
                        if not release.wait(2):
                            raise RuntimeError("Test did not release renderer")
                    return [dict(type="state", sim_time_s=frame, settings_version=int(invalidate))]
                def publish(events):
                    published.extend(events)
                    if events[-1].get("sim_time_s") == 101:
                        finished.set()
                pipeline = LatestPresentation(render, publish)
                try:
                    pipeline.submit(1)
                    self.assertTrue(entered.wait(2))
                    for frame in range(2, 101):
                        pipeline.submit(frame)
                    self.assertEqual(pipeline.pending[1], 100)
                    if invalidate:
                        pipeline.invalidate()
                        self.assertIsNone(pipeline.pending)
                    pipeline.submit(101, urgent=True)
                    release.set()
                    self.assertTrue(finished.wait(2))
                    self.assertEqual(rendered, [1, 101])
                    self.assertEqual([e["sim_time_s"] for e in published],
                                     [101] if invalidate else [1, 101])
                finally:
                    release.set()
                    pipeline.close()


class FakeLive:
    closed = False
    schema = {"available_N": [32]}
    def __init__(self):
        self.commands = []
        self.subscribers = 0
    def command(self, body):
        self.commands.append(body)
        return 3
    def subscribe(self):
        self.subscribers += 1
        return 0, [dict(type="status", state="paused")]
    def read_events(self, cursor, timeout):
        self.closed = True
        return cursor, []
    def unsubscribe(self):
        self.subscribers -= 1


class HTTPTests(unittest.TestCase):
    def test_live_routes_commands_sse_and_cross_origin_guard(self):
        live = FakeLive()
        server = make_server(dict(trajectories=[]), b"<robot/>", {}, port=0, live=live)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base + "/api/live/schema") as response:
                self.assertEqual(json.load(response), live.schema)
            request = Request(base + "/api/live/command", data=b'{"type":"play"}',
                              headers={"Content-Type": "application/json"})
            with urlopen(request) as response:
                self.assertEqual(json.load(response), dict(accepted=True, settings_version=3))
            self.assertEqual(live.commands, [dict(type="play")])
            request.add_header("Origin", "https://unrelated.example")
            with self.assertRaises(HTTPError) as caught:
                urlopen(request)
            self.assertEqual(caught.exception.code, 403)
            with urlopen(base + "/api/live/events") as response:
                self.assertEqual(response.headers["Content-Type"], "text/event-stream")
                self.assertIn(b'"state":"paused"', response.read())
            self.assertEqual(live.subscribers, 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
