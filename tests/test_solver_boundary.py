"""CPU-only coverage of the solver child around tiago_mpc's Mpc, compact replies
and the context the coordinator retains. A fake Mpc stands in for the GPU."""
from contextlib import contextmanager
from copy import deepcopy
import importlib
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from live_mpc import FIGURE8_DEFAULT_TASK
from live_presentation import mutable, render_plan, snapshot
from solver_adapter import SimulatorAdapter
from solver_process import receive_message, send_lease, send_message, wire_value
from solver_worker import serve
from tests.tiago_mpc_source import MPC_ROOT, live_probe

SIGNS = np.array([1., 1., 1., 1., 1., -1., 1.])


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
        # GPU coordinates: joint 6's position box is mirrored.
        return [dict(kind=i, n_rows=7, lo=np.full(7, -2.+i)*SIGNS, hi=np.full(7, 2.-i/2)*SIGNS,
                     active=[127]*self.n) for i in range(3)]


class FakeMpc:
    """tiago_mpc.mpc.Mpc's interface; plans are native, as Mpc.result returns them."""
    instances = []

    def __init__(self, params, binary):
        self.params, self.N, self.dt, self.signs = params, params.N, params.dt_s, SIGNS
        self.resets, self.step, self._plan = [], None, None
        self.controller = SimpleNamespace(reset=self.reset, solver=FakeSolver(params.N))
        FakeMpc.instances.append(self)

    def reset(self, x):
        if not float32_finite(x):
            raise ValueError("reset x0 must be finite")
        self.resets.append(np.array(x))

    def request(self, state, reference, updates=None):
        from tiago_mpc.plan import Plan
        x = np.r_[state.q, state.qd]
        if not float32_finite(x):
            raise FloatingPointError("Nonfinite torque or predicted trajectory")
        self.reference = reference
        stats = dict(solve_time_us=1500., wall_s=.002, iterations=1, budget_hit=False, sqp=2, pcg=7,
                     zero_pcg_rows=0, admm=3, admm_linsys=1, admm_linsys_mode="pcg", row_viol=np.array([0., 1e-3]))
        self.step = SimpleNamespace(solve=SimpleNamespace(stats=SimpleNamespace(
            final_merit=1.5, step_size=np.array([1., np.nan]))))
        self._plan = Plan(state.t, self.dt, np.tile(x, (self.N, 1)),
                          np.arange(7*(self.N-1), dtype=float).reshape(self.N-1, 7), stats)

    def result(self, block=False):
        plan, self._plan = self._plan, None
        return plan


@contextmanager
def fake_gpu():
    """The real tiago_mpc.mpc on the CPU, with Mpc (the GPU part) replaced."""
    with tempfile.TemporaryDirectory() as cache:
        live_probe()  # puts the selected tiago_mpc on sys.path
        module = importlib.import_module("tiago_mpc.mpc")
        FakeMpc.instances.clear()
        with patch.multiple(module, Mpc=FakeMpc, find_binary=lambda params: Path(__file__),
                            cache_root=lambda: Path(cache)), patch("traceback.print_exc"):
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
    return {**live_probe()["defaults"], "N": 4, "plant": dict(friction=False), **changes}


class BoundaryTests(unittest.TestCase):
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
        with fake_gpu():
            remote = Remote()
            try:
                self.assertEqual(remote.request("bootstrap")["contract"]["joint_names"][0], "arm_right_1_joint")
                params = {key: value for key, value in config().items() if key != "plant"}
                configured = remote.request("configure", params=params)
                self.assertEqual(configured["configuration"], params)
                self.assertIsNone(configured["prediction_friction"])
                # Installed rows are reported in native coordinates.
                self.assertEqual(configured["constraint_bounds_native"][0]["lo"][5], -2.)
                self.assertEqual(configured["mpc_bounds"]["limit_bounds"], dict(
                    joint_margin_rad=.1, velocity_fraction=.8, effort_fraction=.85))
                rejected = remote.raw("solve", state=np.full(14, 1e300), time_s=.01,
                                      reference=np.zeros((4, 6)), origin="play", settings_version=1)
                self.assertEqual(rejected["error"], "Nonfinite torque or predicted trajectory")
                self.assertTrue(remote.raw("configure", params=params)["ok"])
                capped = remote.request("configure", params=params, max_sqp_iters=17)
                self.assertEqual(capped["configuration"]["solver"]["max_sqp_iters"], 17)
                self.assertEqual(FakeMpc.instances[-1].params.solver.max_sqp_iters, 17)
                missing = remote.raw("configure", params=dict(params, friction=live_probe()["friction"]))
                self.assertTrue(missing["ok"], missing.get("error"))
                with patch("tiago_mpc.mpc.find_binary", lambda params: None):
                    missing = remote.raw("configure", params=params)
                self.assertRegex(missing["error"], "Not compiled: N=4 without predictor friction.*Build")
            finally:
                remote.close()
            self.assertFalse(remote.thread.is_alive())

    def test_compact_reply_becomes_a_full_immutable_simulator_plan(self):
        with fake_gpu():
            remote = Remote()
            simulator = SimulatorAdapter(MPC_ROOT)
            try:
                schema = dict(available_N_by_friction=dict(off=[4], on=[]))
                simulator.remote, simulator.profile, simulator.profile_schema = remote, dict(id="different-predictor"), schema
                remote.request("bootstrap")
                simulator.configure(config(), deepcopy(FIGURE8_DEFAULT_TASK))
                mpc = FakeMpc.instances[-1]
                np.testing.assert_array_equal(mpc.resets[-1], simulator.x*np.tile(SIGNS, 2))
                simulator.x = np.arange(14, dtype=float)/10
                simulator.t = 2.
                captured = simulator.solve_snapshot("play", 7)
                dynamic = remote.replies[-1][1]["plan"]
                for name in ("task_path_xyz", "task_anchors", "joint_limits", "problem_configuration",
                             "constraint_bounds_native", "model_identity", "solver_profile"):
                    self.assertNotIn(name, dynamic)
                    self.assertIn(name, captured)
                self.assertEqual(captured["solver_profile"]["profile"]["id"], "different-predictor")
                self.assertFalse(captured["solver_profile"]["physical_model_differs"])
                # Native Plan arrays cross unchanged; the plan's stats keep the plotters' keys.
                np.testing.assert_array_equal(captured["_states"], np.tile(simulator.x, (4, 1)))
                np.testing.assert_array_equal(captured["_torques"], np.arange(21.).reshape(3, 7))
                self.assertEqual(mutable(captured["stats"]), dict(
                    sqp_iters=2, pcg_iters=7, admm_iters=3, admm_linsys_iters=1, admm_linsys_mode="pcg",
                    zero_pcg_rows=0, budget_hit=False, solve_time_ms=1.5, step_wall_s=.002,
                    row_violation=[0., 1e-3], controller_restarted=True))
                self.assertEqual(mutable(captured["diagnostics"]), dict(final_merit=1.5, step_size=[1., None]))
                np.testing.assert_array_equal(mpc.reference, simulator.reference)
                self.assertEqual(mpc.reference.dtype, np.float32)
                expected = render_plan(captured, simulator.kinematics)
                self.assertEqual(expected["torque_nm"], np.arange(21.).reshape(3, 7).tolist())
                from inspection_problem import captured_problem
                problem = captured_problem(expected)
                self.assertEqual(problem["reference_native"], simulator.reference.tolist())
                self.assertEqual(expected["task_anchors"], mutable(simulator.task_anchors))
                self.assertEqual(expected["task_path_xyz"], simulator.task_path_xyz)
                self.assertFalse(simulator.solve_snapshot("play", 8)["stats"]["controller_restarted"])
                # Public records may be edited without changing future solves;
                # retained snapshots survive later reconfiguration.
                public = mutable(captured)
                public["solver_profile"]["profile"]["id"] = "edited-record"
                simulator.reference[:] = 99
                simulator.profile["id"] = "new-profile"
                simulator.configure(config(solver=dict(config()["solver"], max_sqp_iters=9),
                                           plant=dict(friction=True)), deepcopy(FIGURE8_DEFAULT_TASK))
                self.assertEqual(render_plan(captured, simulator.kinematics), expected)
                newer = simulator.solve_snapshot("play", 9)
                self.assertEqual(newer["problem_configuration"]["solver"]["max_sqp_iters"], 9)
                self.assertEqual(newer["solver_profile"]["profile"]["id"], "new-profile")
                self.assertTrue(newer["solver_profile"]["physical_model_differs"])
                self.assertIsNone(simulator.plant_friction.width_rad_s)  # the plant's hard sign
                with self.assertRaises(TypeError):
                    captured["solver_profile"]["profile"]["id"] = "mutated"
                with self.assertRaises(ValueError):
                    captured["_states"][0, 0] = 1
                with self.assertRaisesRegex(ValueError, "Not compiled: N=4 with predictor friction"):
                    simulator.configure(config(friction=live_probe()["friction"]), deepcopy(FIGURE8_DEFAULT_TASK))
            finally:
                remote.close()
        self.assertFalse(remote.thread.is_alive())

    def test_simulated_plant_starts_at_the_state_and_time_and_never_rewinds(self):
        live_probe()
        simulator = SimulatorAdapter(MPC_ROOT)
        simulator.x, simulator.t = np.r_[simulator.tiago.Q_START, np.full(7, .1)], 3.
        plant = simulator.new_plant(.001)
        np.testing.assert_array_equal(plant.q, simulator.x[:7])
        self.assertEqual((plant.t, plant.substep, plant.friction), (3., .001, None))
        plant.apply(np.zeros(7))
        plant.advance(3.001)
        self.assertEqual(plant.t, 3.001)
        with self.assertRaises(ValueError):
            plant.clock.advance(-1.)
