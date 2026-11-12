"""CPU-only coverage of the solver child around tiago_mpc's Mpc, compact replies
and the context the coordinator retains. A fake Mpc stands in for the GPU."""
from contextlib import contextmanager
from copy import deepcopy
import importlib
import os
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from live_mpc import FIGURE8_DEFAULT_TASK, PLANT_DEFAULTS
from live_presentation import mutable, render_plan, snapshot
from solver_adapter import SimulatorAdapter
from solver_process import receive_message, send_lease, send_message, wire_value, reference_to_wire
from solver_worker import serve
from tests.tiago_mpc_source import MPC_ROOT, live_probe, start_pose

def float32_finite(x):
    with np.errstate(over="ignore"):
        return bool(np.isfinite(np.asarray(x, dtype=np.float32)).all())


class FakeSolver:
    lib = SimpleNamespace(ITERATION_CAPTURE_AVAILABLE=False, NATIVE_SOURCE_ID="fake")

    def __init__(self, n):
        self.n = n

    def solve(self, x, reference):
        pass

    def get_row_groups(self):
        return [dict(kind=i, n_rows=7, lo=np.full(7, -2.+i), hi=np.full(7, 2.-i/2),
                     active=[127]*self.n) for i in range(3)]


class FakeMpc:
    """tiago_mpc.mpc.Mpc's interface; plans are native, as Mpc.result returns them."""
    instances = []

    def __init__(self, params, binary):
        self.params, self.N, self.dt = params, params.N, params.dt_s
        self.resets, self.warmups, self.step, self._plan = [], [], None, None
        self.controller = SimpleNamespace(reset=self.reset, solver=FakeSolver(params.N))
        FakeMpc.instances.append(self)

    def reset(self, x):
        if not float32_finite(x):
            raise ValueError("reset x0 must be finite")
        self.resets.append(np.array(x))

    def warmup(self, state, reference):
        if self.params.warmup:
            self.reset(np.r_[state.q, state.qd])
            self.warmups.append((state.t, np.array(reference)))

    def request(self, state, reference, updates=None):
        from tiago_mpc.interfaces import Plan
        x = np.r_[state.q, state.qd]
        if not float32_finite(x):
            raise FloatingPointError("Nonfinite torque or predicted trajectory")
        self.reference = reference
        self.requested_state = state
        stats = dict(solve_time_us=1500., wall_s=.002, iterations=1, budget_hit=False, sqp=2, pcg=7,
                     zero_pcg_rows=0, admm=3, admm_linsys=1, admm_linsys_mode="pcg", row_viol=np.array([0., 1e-3]))
        self.step = SimpleNamespace(solve=SimpleNamespace(stats=SimpleNamespace(
            final_merit=1.5, step_size=np.array([1., np.nan]))))
        self._plan = Plan(state.t, self.dt, np.tile(x, (self.N, 1)),
                          np.arange(7*(self.N-1), dtype=float).reshape(self.N-1, 7), stats,
                          measured_t=getattr(state, "measured_t", state.t))

    def result(self, block=False):
        plan, self._plan = self._plan, None
        return plan

    def close(self):
        self.closed = True
        self.controller = self.step = self._plan = None


@contextmanager
def fake_gpu():
    """The real tiago_mpc.mpc on the CPU, with Mpc (the GPU part) replaced."""
    with tempfile.TemporaryDirectory() as cache:
        live_probe()  # puts the selected tiago_mpc on sys.path
        module = importlib.import_module("tiago_mpc.mpc")
        FakeMpc.instances.clear()
        with patch.multiple(module, Mpc=FakeMpc, find_binary=lambda params: Path(__file__)), \
                patch.dict(os.environ, GATO_CACHE_DIR=cache), patch("traceback.print_exc"):
            yield


class Remote:
    """SolverProcess.request over a socket pair to serve() in a thread."""
    epoch = "test-epoch"

    def __init__(self):
        self.sender, receiver = socket.socketpair()
        self.sequence, self.replies = 0, []
        self.thread = threading.Thread(target=serve, args=(receiver, MPC_ROOT))
        self.thread.start()
        self.receiver = receiver

    def raw(self, operation, **payload):
        self.sequence += 1
        send_lease(self.sender, [])
        send_message(self.sender, dict(protocol=1, epoch=self.epoch, request_id=self.sequence,
                                       operation=operation, payload=payload), array_buffers=operation == "solve")
        return receive_message(self.sender)

    def request(self, operation, *, timeout=None, **payload):
        response = self.raw(operation, **payload)
        if not response["ok"]:
            raise ValueError(response["error"])
        self.replies.append((operation, response["result"]))
        return response["result"]

    def close(self):
        self.raw("close")
        self.thread.join(timeout=3)
        self.sender.close()
        self.receiver.close()


def config(**changes):
    from native_cost import cost_weights, serialized_cost
    defaults = live_probe()["defaults"]
    defaults["cost"] = serialized_cost(4, cost_weights(defaults["cost"]))
    return {**defaults, "N": 4, "plant": dict(deepcopy(PLANT_DEFAULTS), start_pose_rad=start_pose()["default"]),
            **changes}


class BoundaryTests(unittest.TestCase):
    def test_native_session_rejects_internally_consistent_but_wrong_solver_replies(self):
        from execution_session import DEFAULT_EXECUTION
        from native_session import NativeSession
        from tests.test_execution import FakeAdapter
        malformed = (
            dict(N=4), dict(dt_s=.04), dict(plan_origin_time_s=1.), dict(measured_time_s=1.),
            dict(_states=np.zeros((2,14)), _torques=np.zeros((1,7))),
            dict(_states=np.zeros((3,12)), _torques=np.zeros((2,6))),
        )
        for changes in malformed:
            with self.subTest(fields=list(changes)):
                adapter = FakeAdapter()
                original = adapter.solve_snapshot
                def solve(*args, **kwargs):
                    return dict(original(*args, **kwargs), **changes)
                adapter.solve_snapshot = solve
                session = NativeSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0.))
                try:
                    with self.assertRaisesRegex(ValueError, 'Solver reply|Unexpected plan layout'):
                        session.advance_interval(.002)
                    self.assertEqual(session.control_updates, 0)
                    np.testing.assert_array_equal(adapter.x, np.zeros(14))
                finally:
                    session.close()

    def test_native_session_runs_the_real_rpc_adapter_with_observed_and_predicted_initial_states(self):
        from execution_session import DEFAULT_EXECUTION
        from native_session import NativeSession
        for compensation in (False, True):
            with self.subTest(compensation=compensation), fake_gpu():
                remote = Remote()
                adapter = SimulatorAdapter(MPC_ROOT)
                adapter.remote, adapter.profile = remote, dict(id='native-session')
                adapter.profile_schema = dict(available_N_by_friction=dict(off=[4], on=[]),
                                              source_settings=live_probe().get('source_settings', {}))
                session = None
                try:
                    remote.request('bootstrap')
                    execution = dict(DEFAULT_EXECUTION, to_hz=500., solve_latency_s=.002,
                                     latency_compensation=compensation)
                    adapter.configure(config(), dict(kind='reach', target_offset_m=[0., 0., 0.]),
                                      execution=execution)
                    session = NativeSession(adapter, execution)
                    records = []
                    while session.progress.t < .1-1e-12:
                        records.extend(session.advance_interval(.1))
                    plans = [r for r in records if r['type']=='plan']
                    commands = [r for r in records if r['type']=='control']
                    self.assertEqual(len(plans), 49)
                    self.assertEqual(len(commands), 49)
                    self.assertTrue(all(r['available_time_s'] >= r['request_time_s'] for r in plans))
                    self.assertEqual(plans[0]['initial_state']['measured_time_s'], 0.)
                    self.assertEqual(plans[0]['initial_state']['time_s'], .002 if compensation else 0.)
                    self.assertTrue(np.isfinite(adapter.x).all())
                    # Deferred formatting still produces the complete historical payload.
                    rendered = render_plan(plans[-1], adapter.kinematics)
                    self.assertEqual(rendered['diagnostics']['step_size'], [1., None])
                finally:
                    if session is not None:
                        session.close()
                    remote.close()

    def test_binary_telemetry_preserves_unavailable_values_without_admitting_invalid_control_arrays(self):
        sender, receiver = socket.socketpair()
        try:
            message = dict(result=dict(plan=dict(diagnostics=dict(trace=np.array([1., np.nan, np.inf])))))
            send_message(sender, message, array_buffers=True)
            received = receive_message(receiver)
            np.testing.assert_array_equal(received['result']['plan']['diagnostics']['trace'], [1., np.nan, np.inf])
            with self.assertRaisesRegex(ValueError, 'Nonfinite solver RPC array'):
                send_message(sender, dict(result=dict(plan=dict(_torques=np.array([[np.nan]*7])))),
                             array_buffers=True)
        finally:
            sender.close()
            receiver.close()

    def test_json_encoder_preserves_nested_arrays_and_rejects_nonfinite(self):
        sender, receiver = socket.socketpair()
        try:
            message = snapshot(dict(array=np.arange(12, dtype=np.float32).reshape(2, 6),
                                    scalar=np.int64(3), nested=[dict(value=np.float64(.125))]))
            send_message(sender, message)
            self.assertEqual(receive_message(receiver), wire_value(message))
            for invalid in (np.array([np.nan]), np.float32(np.inf)):
                with self.assertRaises(ValueError):
                    send_message(sender, dict(invalid=invalid))
            with patch("solver_process.MAX_MESSAGE_BYTES", 1), self.assertRaises(ValueError):
                send_message(sender, dict(value=1))
        finally:
            sender.close()
            receiver.close()

    def test_child_configures_mpc_params_and_recovers_after_a_rejected_state(self):
        from tiago_mpc.tiago import GRASP_FRAME
        with fake_gpu():
            remote = Remote()
            try:
                self.assertEqual(remote.request("bootstrap")["contract"]["joint_names"][0], "arm_right_1_joint")
                params = {key: value for key, value in config().items() if key != "plant"}
                configured = remote.request("configure", params=params)
                self.assertEqual(configured["configuration"], params)
                self.assertEqual(configured["configuration"]["type"], "MpcParams")
                self.assertEqual(configured["configuration"]["solver"]["type"], "SolverSettings")
                self.assertEqual(configured["configuration"]["admm"]["type"], "AdmmLimits")
                self.assertNotIn("ee_frame", configured["configuration"])
                self.assertEqual(configured["model_identity"]["end_effector_frame"], GRASP_FRAME)
                self.assertIsNone(configured["prediction_friction"])
                # Installed rows are reported in native coordinates.
                self.assertEqual(configured["constraint_bounds_native"][0]["lo"][5], -2.)
                self.assertEqual(configured["mpc_bounds"]["limit_bounds"],
                                 {key: params[key] for key in ("joint_margin_rad", "velocity_fraction", "effort_fraction")})
                rejected = remote.raw("solve", state=np.full(14, 1e300), time_s=.01,
                                      reference=np.zeros((4, 6)), origin="play", settings_version=1)
                self.assertEqual(rejected["error"], "The state is beyond the solver's range (the plant became unstable); press Reset")
                self.assertTrue(remote.raw("configure", params=params)["ok"])
                capped = remote.request("configure", params=params, max_sqp_iters=17)
                self.assertEqual(capped["configuration"]["solver"]["max_sqp_iters"], 17)
                self.assertEqual(FakeMpc.instances[-1].params.solver.max_sqp_iters, 17)
                self.assertFalse(hasattr(FakeMpc.instances[-1].params, "ee_frame"))
                removed = remote.raw("configure", params=dict(params, ee_frame="arm_right_tool_joint"))
                self.assertIn("ee_frame", removed["error"])
                untagged = remote.raw("configure", params={key: value for key, value in params.items() if key != "type"})
                self.assertIn("tagged MpcParams", untagged["error"])
                friction_config = remote.request("configure", params=dict(params, friction=live_probe()["friction"]))
                from tiago_mpc.dynamics import Friction, Tanh
                from tiago_mpc.record import to_dict
                self.assertIsInstance(FakeMpc.instances[-1].params.friction, Friction)
                self.assertIsInstance(FakeMpc.instances[-1].params.friction_law, Tanh)
                self.assertEqual(friction_config["prediction_friction"], live_probe()["friction"])
                self.assertEqual(friction_config["prediction_friction_law"], params["friction_law"])
                self.assertEqual(friction_config["armature"], list(params["armature"]))  # the source's default
                self.assertEqual(friction_config["configuration"], to_dict(FakeMpc.instances[-1].params))
                self.assertEqual(friction_config["resolved"], to_dict(FakeMpc.instances[-1].params))  # the MPC's own
                predicted = remote.request("solve", state=np.zeros(14), time_s=.026,
                    measured_time_s=.02, reference=np.zeros((4, 6)), origin="play", settings_version=1)["plan"]
                self.assertEqual(type(FakeMpc.instances[-1].requested_state).__name__, "Prediction")
                self.assertEqual(FakeMpc.instances[-1].requested_state.measured_t, .02)
                self.assertEqual(predicted["plan_origin_time_s"], .026)
                self.assertEqual(predicted["measured_time_s"], .02)
                self.assertEqual(predicted["initial_state"]["time_s"], .026)
                self.assertEqual(predicted["initial_state"]["measured_time_s"], .02)
                with patch("tiago_mpc.mpc.find_binary", lambda params: None):
                    missing = remote.raw("configure", params=params)
                self.assertRegex(missing["error"], "Not compiled: N=4 without predictor friction.*Build")
            finally:
                remote.close()
            self.assertFalse(remote.thread.is_alive())

    def test_compact_reply_becomes_a_full_immutable_simulator_plan(self):
        from tiago_mpc.laws import FrictionFeedforward
        from tiago_mpc.record import to_dict
        with fake_gpu():
            remote = Remote()
            simulator = SimulatorAdapter(MPC_ROOT)
            try:
                schema = dict(available_N_by_friction=dict(off=[4], on=[]), source_settings=live_probe().get("source_settings", {}))
                simulator.remote, simulator.profile, simulator.profile_schema = remote, dict(id="different-predictor"), schema
                remote.request("bootstrap")
                simulator.configure(config(), deepcopy(FIGURE8_DEFAULT_TASK))
                mpc = FakeMpc.instances[-1]
                np.testing.assert_array_equal(mpc.resets[-1], simulator.x)
                simulator.x = np.arange(14, dtype=float)/10
                simulator.t = 2.
                captured = simulator.solve_snapshot("play", 7)
                header = simulator.segment_header(7, dict(control_hz=500.))
                dynamic = remote.replies[-1][1]["plan"]
                # The constant context is in the segment header, never in the child's reply or the plan.
                for name in ("task_path_xyz", "task_anchors", "joint_limits", "problem_configuration",
                             "constraint_bounds_native", "model_identity", "solver_profile"):
                    self.assertNotIn(name, dynamic)
                    self.assertNotIn(name, captured)
                    self.assertIn(name, header["context"])
                context = header["context"]
                self.assertEqual(context["solver_profile"]["profile"]["id"], "different-predictor")
                self.assertTrue(context["solver_profile"]["physical_model_differs"])
                self.assertTrue(context["solver_profile"]["friction_differs"])
                self.assertEqual(context["simulator_identity"]["friction_law"]["type"], "StickSlip")
                self.assertEqual(context["settings"], dict(config=config(), task=FIGURE8_DEFAULT_TASK,
                                                           source_settings=simulator.source_settings,
                                                           execution=dict(control_hz=500.)))
                self.assertEqual(context["effective_settings"]["params"], context["problem_configuration"])
                self.assertEqual(context["effective_settings"]["law"], to_dict(FrictionFeedforward()))
                self.assertEqual(context["source"], simulator.model_identity["source"])
                # Native Plan arrays cross unchanged; the plan's stats keep the plotters' keys.
                np.testing.assert_array_equal(captured["_states"], np.tile(simulator.x, (4, 1)))
                np.testing.assert_array_equal(captured["_torques"], np.arange(21.).reshape(3, 7))
                self.assertEqual(mutable(captured["stats"]), dict(
                    sqp_iters=2, pcg_iters=7, admm_iters=3, admm_linsys_iters=1, admm_linsys_mode="pcg",
                    zero_pcg_rows=0, budget_hit=False, solve_time_ms=1.5, step_wall_s=.002,
                    row_violation=[0., 1e-3], controller_restarted=True))
                self.assertEqual(captured['diagnostics']['final_merit'], 1.5)
                np.testing.assert_array_equal(captured['diagnostics']['step_size'], [1., np.nan])
                np.testing.assert_array_equal(mpc.reference, simulator.reference)
                self.assertEqual(mpc.reference.dtype, np.float32)
                expected = render_plan(captured, simulator.kinematics)
                self.assertEqual(expected['diagnostics'], dict(final_merit=1.5, step_size=[1., None]))
                self.assertNotIn('_native_stats', expected)
                self.assertEqual(expected["torque_nm"], np.arange(21.).reshape(3, 7).tolist())
                from inspection_problem import captured_problem
                problem = captured_problem(dict(context, **expected))
                self.assertEqual(problem["reference_native"], reference_to_wire(simulator.reference))
                self.assertEqual(context["task_anchors"], mutable(simulator.task_anchors))
                self.assertEqual(context["task_path_xyz"], simulator.task_path_xyz)
                self.assertFalse(simulator.solve_snapshot("play", 8)["stats"]["controller_restarted"])
                # Public records may be edited without changing future solves;
                # retained snapshots survive later reconfiguration.
                public = mutable(captured)
                public["stats"]["sqp_iters"] = -1
                context["solver_profile"]["profile"]["id"] = "edited-record"
                simulator.reference[:] = 99
                simulator.profile["id"] = "new-profile"
                simulator.configure(config(solver=dict(config()["solver"], max_sqp_iters=9),
                                           plant=dict(config()["plant"], integrator="euler", friction=True,
                                                      coulomb_law="tanh")), deepcopy(FIGURE8_DEFAULT_TASK))
                self.assertEqual(render_plan(captured, simulator.kinematics), expected)
                newer = simulator.segment_header(9, {})["context"]
                self.assertEqual(newer["problem_configuration"]["solver"]["max_sqp_iters"], 9)
                self.assertEqual(newer["solver_profile"]["profile"]["id"], "new-profile")
                self.assertTrue(newer["solver_profile"]["physical_model_differs"])
                self.assertTrue(newer["settings"]["config"]["plant"]["friction"])
                self.assertEqual(header["context"]["solver_profile"]["profile"]["id"], "edited-record")
                plant = newer["simulator_identity"]
                self.assertEqual((plant["integrator"], plant["coulomb_law"], plant["friction_law"]["width_rad_s"]),
                                 ("euler", "tanh", .03))
                from tiago_mpc.dynamics import Tanh
                self.assertIsInstance(simulator.new_plant(.001).config.friction_law, Tanh)
                with self.assertRaises(TypeError):
                    captured["stats"]["sqp_iters"] = -2
                with self.assertRaises(ValueError):
                    captured["_states"][0, 0] = 1
                with self.assertRaisesRegex(ValueError, "Not compiled: N=4 with predictor friction"):
                    simulator.configure(config(friction=live_probe()["friction"]), deepcopy(FIGURE8_DEFAULT_TASK))
            finally:
                remote.close()
        self.assertFalse(remote.thread.is_alive())

    def test_every_reseed_warms_up_from_its_state_with_the_reference_then(self):
        with fake_gpu():
            remote = Remote()
            simulator = SimulatorAdapter(MPC_ROOT)
            try:
                schema = dict(available_N_by_friction=dict(off=[4], on=[]), source_settings=live_probe().get("source_settings", {}))
                simulator.remote, simulator.profile, simulator.profile_schema = remote, dict(id="p"), schema
                remote.request("bootstrap")
                simulator.configure(config(), deepcopy(FIGURE8_DEFAULT_TASK))
                mpc = FakeMpc.instances[-1]
                self.assertEqual(len(mpc.warmups), 1)  # configuring reseeds from the start state
                self.assertEqual(mpc.warmups[0][0], 0.)
                simulator.x, simulator.t = np.arange(14, dtype=float)/10, 2.
                self.assertEqual(simulator.controller.reset(simulator.x)["warmup"], True)
                t, reference = mpc.warmups[-1]
                self.assertEqual(t, 2.)
                # The figure-eight window from the reseed's time, as the next request gets it.
                np.testing.assert_array_equal(reference, simulator.reference)
                np.testing.assert_array_equal(mpc.resets[-1], simulator.x)
                # The same reseed again, with no solve in between, changes nothing.
                self.assertTrue(simulator.controller.reset(simulator.x)["skipped"])
                plan = simulator.solve_snapshot("preview", 1)  # the preview's own reseed is that one
                self.assertEqual(len(mpc.warmups), 2)
                self.assertTrue(plan["stats"]["controller_restarted"])
                simulator.solve_snapshot("preview", 2)  # after a solve, a preview warms up again
                self.assertEqual(len(mpc.warmups), 3)
                simulator.configure(config(warmup=False), deepcopy(FIGURE8_DEFAULT_TASK))
                mpc = FakeMpc.instances[-1]
                self.assertEqual(simulator.controller.reset(simulator.x + 1)["warmup"], False)
                self.assertEqual(mpc.warmups, [])  # warm-up off: the plain controller reset
                np.testing.assert_array_equal(mpc.resets[-1], simulator.x + 1)
            finally:
                remote.close()

    def test_a_state_beyond_float32_asks_for_reset_instead_of_a_nonfinite_x0(self):
        with fake_gpu():
            remote = Remote()
            simulator = SimulatorAdapter(MPC_ROOT)
            try:
                schema = dict(available_N_by_friction=dict(off=[4], on=[]), source_settings=live_probe().get("source_settings", {}))
                simulator.remote, simulator.profile, simulator.profile_schema = remote, dict(id="p"), schema
                remote.request("bootstrap")
                simulator.configure(config(), deepcopy(FIGURE8_DEFAULT_TASK))
                for value in (1e39, -4e38):  # finite in float64 after a blow-up, beyond float32
                    simulator.x = np.r_[np.zeros(7), np.full(7, value)]
                    with self.subTest(value=value):
                        with self.assertRaisesRegex(ValueError, "beyond the solver's range.*press Reset"):
                            simulator.controller.reset(simulator.x)
            finally:
                remote.close()

    def test_simulated_plant_starts_at_the_state_and_time_and_never_rewinds(self):
        from tiago_mpc.clock import VirtualClock
        from tiago_mpc.sim import SimConfig
        live_probe()
        simulator = SimulatorAdapter(MPC_ROOT)
        simulator.x, simulator.t = np.r_[simulator.tiago.Q_START, np.full(7, .1)], 3.
        plant = simulator.new_plant(.001)
        np.testing.assert_array_equal(plant.q, simulator.x[:7])
        np.testing.assert_array_equal(plant.qd, simulator.x[7:])
        self.assertIsInstance(plant.clock, VirtualClock)
        self.assertEqual(plant.clock.now(), 3.)
        self.assertIsInstance(plant.config, SimConfig)
        self.assertEqual((plant.t, plant.config.substep, plant.config.friction), (3., .001, None))
        self.assertEqual(plant.config.q, tuple(simulator.x[:7]))
        self.assertEqual(plant.config.qd, tuple(simulator.x[7:]))
        plant.apply(np.zeros(7))
        plant.advance(3.001)
        self.assertEqual(plant.t, 3.001)
        with self.assertRaises(ValueError):
            plant.clock.reach(-1.)
        # Reset/rollback gets a new clock, rather than rewinding the old plant.
        simulator.t = .5
        rollback = simulator.new_plant(.001)
        self.assertIsNot(rollback.clock, plant.clock)
        self.assertEqual((rollback.t, rollback.clock.now()), (.5, .5))
        self.assertEqual(plant.clock.now(), 3.001)

    def test_double_compensation_is_rejected_before_plant_build_or_start(self):
        import tiago_mpc as tm
        from tiago_mpc.record import to_dict
        simulator = SimulatorAdapter(MPC_ROOT)
        friction = tm.urdf_friction()
        physical = tm.SimConfig(friction=friction, friction_law=tm.StickSlip(), integrator="euler",
                                armature=tm.ARMATURE_KG_M2)
        ff = tm.FrictionFeedforward(friction, evaluation=tm.Tanh(.071))
        for predictor, law, error in (
                (friction, ff, "predictor friction=None.*double compensation"),
                (tm.Friction((.1,)*7, (.2,)*7), ff, "double compensation"),
                (None, tm.FrictionFeedforward(friction, ff), "cannot wrap another")):
            captured = dict(module=None, effective=dict(plant=to_dict(physical), law=to_dict(law)))
            simulator.effective_settings["params"] = dict(friction=to_dict(predictor))
            with self.subTest(predictor=predictor, law=law), \
                    patch("worktree_settings.resolve_simulation", return_value=(physical, law, captured)), \
                    patch.object(tm.SimConfig, "build") as build, self.assertRaisesRegex(ValueError, error):
                simulator.new_plant(.001)
            build.assert_not_called()
        # Physical passive forces and predictor friction are independent models;
        # only an external compensation law conflicts with internal compensation.
        for predictor, law in ((None, ff), (friction, tm.SampleKnot()), (friction, tm.PlanFeedback())):
            captured = dict(module=None, effective=dict(plant=to_dict(physical), law=to_dict(law)))
            simulator.effective_settings["params"] = dict(friction=to_dict(predictor))
            with self.subTest(predictor=predictor, law=law), \
                    patch("worktree_settings.resolve_simulation", return_value=(physical, law, captured)):
                self.assertEqual(simulator._resolved_plant(.001), physical)
                self.assertEqual(simulator.law, law)

    def test_model_mismatch_includes_separate_physical_law_and_armature(self):
        import tiago_mpc as tm
        from tiago_mpc.record import to_dict
        simulator = SimulatorAdapter(MPC_ROOT)
        friction = tm.urdf_friction()
        physical = tm.SimConfig(friction=friction, friction_law=tm.Tanh(.071), integrator="euler",
                                armature=tm.ARMATURE_KG_M2)
        law = tm.SampleKnot()
        captured = dict(module=None, effective=dict(plant=to_dict(physical), law=to_dict(law)))
        predictor = dict(prediction_friction=to_dict(friction), model_identity=simulator.model_identity,
                         configuration=dict(friction_law=to_dict(tm.Tanh(.071)), armature=list(tm.ARMATURE_KG_M2)))
        simulator.profile_identity = dict(predictor=predictor)
        with patch("worktree_settings.resolve_simulation", return_value=(physical, law, captured)):
            simulator._resolved_plant(.001)
            self.assertFalse(simulator.profile_identity["physical_model_differs"])
            predictor["configuration"]["friction_law"] = to_dict(tm.StickSlip())
            simulator._resolved_plant(.001)
            self.assertTrue(simulator.profile_identity["friction_differs"])
            predictor["configuration"]["friction_law"] = to_dict(tm.Tanh(.071))
            predictor["configuration"]["armature"] = [0.]*7
            simulator._resolved_plant(.001)
            self.assertFalse(simulator.profile_identity["friction_differs"])
            self.assertTrue(simulator.profile_identity["armature_differs"])
            self.assertTrue(simulator.profile_identity["physical_model_differs"])
