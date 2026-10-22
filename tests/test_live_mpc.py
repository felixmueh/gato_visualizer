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
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from live_mpc import GPULocks, LiveService, MPCAdapter, figure8_reference, FIGURE8_DEFAULT_TASK, REACH_DEFAULT_TASK, parameter_specs, validate_settings
from server import make_server
from live_presentation import LatestPresentation, mutable, render_plan, render_state, snapshot

ROOT = Path(__file__).resolve().parents[1]
MPC_ROOT = ROOT.parent / "tiago_mpc_vis_baseline"


class SettingsTests(unittest.TestCase):
    def setUp(self):
        config = json.loads((MPC_ROOT / "configs/reaching.json").read_text())
        self.config = {k: v for k, v in config.items() if k in ("N", "dt_s", "solver_params", "controller", "limit_bounds")}
        self.task = deepcopy(REACH_DEFAULT_TASK)
        self.schema = dict(parameters=parameter_specs(self.config, [16, 32]))

    def test_complete_config_and_runtime_choices(self):
        config, task = validate_settings(self.config, self.task, self.schema)
        self.assertEqual(config, self.config)
        self.assertIsNot(config, self.config)
        specs = {s["path"]: s for s in self.schema["parameters"]}
        self.assertEqual(specs["controller.warm_start"]["choices"], ["shift", "hold"])
        self.assertEqual(specs["controller.admm_linsys"]["choices"], ["pcg", "bdsv_factor", "auto"])
        self.assertTrue(specs["solver_params.exact_hessian"]["disabled"])
        self.assertTrue(specs["solver_params.linsys"]["disabled"])

    def test_nonfinite_limits_unknown_fields_and_unbuilt_n_rejected(self):
        cases = [("N", 128), ("N", True), ("N", 32.5), ("dt_s", float("nan")),
                 ("dt_s", -1), ("solver_params.max_sqp_iters", 100001),
                 ("solver_params.exact_hessian", True), ("solver_params.linsys", "qdldl"),
                 ("controller.warm_start", "repeat"), ("controller.limits_kw.rho", float("inf")),
                 ("limit_bounds.velocity_fraction", 0)]
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
        adapter = MPCAdapter.__new__(MPCAdapter)
        adapter.simulator_joint_dynamics = None
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


class AdapterTelemetryTests(unittest.TestCase):
    def adapter(self):
        adapter = MPCAdapter.__new__(MPCAdapter)
        adapter.simulator_joint_dynamics = None
        adapter.reach = SimpleNamespace(Q_START_RAD=np.zeros(7), POSITION_TOL_M=.05,
                                        EE_FRAME="arm_right_tool_joint",
                                        SPEED_L1_TOL_RAD_S=1, SIM_DT_S=.005,
                                        rk4=lambda model, data, q, v, u, h: (q+v*h, v+u*h))
        adapter.kinematics = SimpleNamespace(ee_positions=lambda q: np.zeros((len(q), 3)),
                                             target_to_world=lambda target: target,
                                             world_from_torso=SimpleNamespace(actInv=lambda point: point))
        stats = SimpleNamespace(sqp_iters=[1], pcg_iters=[2], admm_iters=[3], admm_linsys_iters=[4])
        step = SimpleNamespace(u=np.arange(7), solve=SimpleNamespace(
            xu=np.arange(35), stats=stats, solve_time_us=10), row_viol=[0])
        adapter.controller = SimpleNamespace(reset=lambda x: None, step=lambda x, r: step)
        adapter.signs = np.array([1, 1, 1, 1, 1, -1, 1])
        adapter.state_signs = np.tile(adapter.signs, 2)
        adapter.model = adapter.data = None
        adapter.target = np.zeros(3)
        adapter.default_target = np.array([.4, -.3, 1.2])
        adapter.figure8_start_world = np.array([.3, -.4, 1.1])
        adapter.task_anchors = snapshot(dict(reach=adapter.default_target.tolist(),
                                             figure8=adapter.figure8_start_world.tolist()))
        adapter.task = dict(kind="reach", target_offset_m=[0, 0, 0])
        adapter.reference = np.zeros((2, 6))
        adapter.N, adapter.dt = 2, .01
        adapter.joint_limits = dict(source="Test configured bounds")
        adapter.restarted = False
        adapter.reset_state()
        return adapter

    def test_task_anchors_are_public_immutable_and_independent_of_task_edits(self):
        adapter = self.adapter()
        expected = dict(reach=[.4, -.3, 1.2], figure8=[.3, -.4, 1.1])
        initial_plan = adapter.solve_snapshot("preview", 1)
        self.assertEqual(mutable(initial_plan["task_anchors"]), expected)
        self.assertEqual(adapter.state_event()["task_anchors"], expected)
        with self.assertRaises(TypeError):
            initial_plan["task_anchors"]["reach"][0] = 99
        adapter.target += [.15, .2, .2]
        adapter.x[:7] += .1
        self.assertEqual(adapter.solve("preview", 2)["task_anchors"], expected)
        adapter.task = {**FIGURE8_DEFAULT_TASK, "target_offset_m": [.1, -.2, .3],
                        "width_m": .4, "height_m": .3, "orientation_xyzw": [1., 0., 0., 0.]}
        adapter.t = 3.
        transformed = adapter.solve("preview", 3)
        self.assertEqual(transformed["task_anchors"], expected)
        self.assertEqual(adapter.state_event()["task_anchors"], expected)
        self.assertEqual(mutable(initial_plan["task_anchors"]), expected)

    def test_reset_restarts_plan_count_and_preview_does_not_claim_applied_torque(self):
        adapter = self.adapter()
        self.assertEqual(adapter.solve("preview", 1)["seq"], 1)
        self.assertIsNone(adapter.state_event()["torque_nm"])
        adapter.advance()
        applied = adapter.state_event()["torque_nm"]
        np.testing.assert_array_equal(applied, np.arange(7)*adapter.signs)
        # A preview/controller reset is another plan, not a new episode.
        self.assertEqual(adapter.solve("preview", 2)["seq"], 2)
        self.assertEqual(adapter.state_event()["torque_nm"], applied)
        adapter.reset_state(reset_controller=False)
        self.assertEqual(adapter.t, 0)
        self.assertIsNone(adapter.state_event()["torque_nm"])
        plan = adapter.solve("preview", 3)
        self.assertEqual(plan["seq"], 1)
        self.assertEqual(len(plan["torque_nm"]), 1)
        self.assertEqual(plan["torque_end_time_s"], .01)
        self.assertEqual(plan["torque_kind"], "predicted")

    def test_capture_retains_problem_inputs_and_only_exposed_sqp_metrics(self):
        adapter = self.adapter()
        step = adapter.controller.step(None, None)
        step.solve.stats.initial_merit = np.array([12.])
        step.solve.stats.final_merit = np.array([8.])
        step.solve.stats.min_merit = np.array([[8.], [float("nan")]])
        step.solve.stats.step_size = np.array([[1.], [-1.]])
        adapter.problem_configuration = dict(N=2, solver_params=dict(max_sqp_iters=3))
        adapter.x[:] = np.arange(14)
        adapter.reference[:] = 3.
        captured = adapter.solve_snapshot("play", 7)
        adapter.x[:] = 0
        adapter.reference[:] = 9
        adapter.problem_configuration["solver_params"]["max_sqp_iters"] = 99
        step.solve.stats.initial_merit[:] = 99
        rendered = render_plan(captured, adapter.kinematics)
        self.assertEqual(rendered["initial_state"]["q"], list(range(7)))
        self.assertEqual(rendered["initial_state"]["qd"], list(range(7,14)))
        self.assertEqual(rendered["problem_configuration"]["solver_params"]["max_sqp_iters"], 3)
        self.assertEqual(rendered["reference_native"][0], [3.]*6)
        self.assertEqual(rendered["diagnostics"]["initial_merit"], [12.])
        self.assertIsNone(rendered["diagnostics"]["min_merit"][1][0])
        self.assertNotIn("iterations", rendered)
        self.assertNotIn("checkpoint", rendered)
        json.dumps(rendered, allow_nan=False)

    def test_presentation_snapshots_survive_control_progress_and_settings_mutation(self):
        adapter = self.adapter()
        plan = adapter.solve_snapshot("play", 3)
        state = adapter.state_snapshot(.9, 3)
        expected_plan = render_plan(plan, adapter.kinematics)
        expected_state = render_state(state, adapter.kinematics)
        adapter.advance()
        adapter.last_xu[:] = -123
        adapter.reference[:] = 123
        adapter.signs[:] = -1
        adapter.joint_limits["source"] = "New settings"
        adapter.reset_state(reset_controller=False)
        self.assertEqual(render_plan(plan, adapter.kinematics), expected_plan)
        self.assertEqual(render_state(state, adapter.kinematics), expected_state)
        with self.assertRaises(ValueError):
            plan["_xu"][0] = 0
        with self.assertRaises(TypeError):
            plan["joint_limits"]["source"] = "Mutation"


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
