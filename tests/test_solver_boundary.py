"""CPU-only regression coverage of compact solver replies and retained context."""
from copy import deepcopy
from pathlib import Path
import socket
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from live_mpc import FIGURE8_DEFAULT_TASK
from live_presentation import mutable, render_plan, snapshot
from solver_adapter import SimulatorAdapter, RemoteController
from solver_process import (native_plan, receive_message, send_lease, send_message,
                            wire_value)
from solver_worker import serve
from tests import test_live_mpc


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

    def test_worker_compact_reply_restores_full_immutable_simulator_plan(self):
        numerical = test_live_mpc.AdapterTelemetryTests().adapter()
        numerical.model_identity = dict(full_urdf_sha256="predictor", gpu_urdf_sha256="gpu")
        numerical.problem_configuration = dict(N=2, dt_s=.01, solver_params=dict(max_sqp_iters=1),
                                               controller=dict(warm_start="shift"))
        numerical.joint_limits = dict(lower_position_rad=[-2.]*7, upper_position_rad=[2.]*7,
                                      velocity_rad_s=[3.]*7, effort_nm=[4.]*7)
        numerical.constraint_bounds_native = [dict(kind=i, n_rows=7, lo=[-2.]*7, hi=[2.]*7,
                                                   active=[True, True]) for i in range(3)]
        numerical.solver = SimpleNamespace(lib=SimpleNamespace(__file__=__file__), solve=lambda: None)
        numerical.configure = lambda path, task: numerical.configure_task(numerical.problem_configuration, task)
        sender, receiver = socket.socketpair()
        replies = []

        class Remote:
            epoch = "test-epoch"
            sequence = 0

            def request(self, operation, *, timeout=None, **payload):
                self.sequence += 1
                send_lease(sender, [])
                send_message(sender, dict(protocol=1, epoch=self.epoch, request_id=self.sequence,
                                          operation=operation, payload=payload))
                response = receive_message(sender)
                if not response["ok"]:
                    raise AssertionError(response["error"])
                replies.append((operation, response["result"]))
                return response["result"]

        simulator = SimulatorAdapter.__new__(SimulatorAdapter)
        simulator.__dict__.update(numerical.__dict__)
        del simulator.configure
        simulator.remote = Remote()
        simulator.profile_schema = dict(available_N=[2])
        simulator.profile = dict(id="different-predictor")
        simulator.simulator_identity = dict(full_urdf_sha256="simulator", gpu_urdf_sha256="gpu")
        simulator.contract = dict(coordinates="native")
        simulator.signs, simulator.state_signs = np.ones(7), np.ones(14)
        simulator.controller = RemoteController(simulator)
        # Deliberately different simulator geometry: predictor geometry may
        # never replace these anchors or the simulator's exact reference.
        simulator.figure8_start_world = numerical.figure8_start_world + 1.
        simulator.task_anchors = snapshot(dict(figure8=simulator.figure8_start_world.tolist()))

        thread = threading.Thread(target=serve, args=(receiver, Path(__file__).parent))
        loader = SimpleNamespace(load_configuration=lambda path: (None, None, numerical.problem_configuration))
        with patch("live_mpc.MPCAdapter", return_value=numerical), \
             patch("live_mpc.build_schema", return_value={}), \
             patch("solver_worker.model_contract", return_value={}), \
             patch("solver_adapter.importlib.import_module", return_value=loader):
            thread.start()
            try:
                simulator.remote.request("bootstrap")
                simulator.configure(Path(__file__), deepcopy(FIGURE8_DEFAULT_TASK))
                simulator.x = np.arange(14, dtype=float)/10
                simulator.t = 2.
                captured = simulator.solve_snapshot("play", 7)
                dynamic = replies[-1][1]["plan"]
                for name in ("task_path_xyz", "task_anchors", "joint_limits", "problem_configuration",
                             "constraint_bounds_native", "model_identity", "solver_profile"):
                    self.assertNotIn(name, dynamic)
                    self.assertIn(name, captured)
                self.assertEqual(captured["solver_profile"]["profile"]["id"], "different-predictor")
                self.assertTrue(captured["solver_profile"]["physical_model_differs"])
                # All dynamic solver output matches the complete legacy API,
                # including both terminal joint-6 state components.
                numerical.restarted = True
                complete = native_plan(numerical.solve_snapshot("play", 7, reference=simulator.reference))
                for key in ("_xu", "_reference", "initial_state", "stats", "diagnostics"):
                    self.assertEqual(wire_value(captured[key]), wire_value(complete[key]))
                np.testing.assert_array_equal(simulator.u, np.arange(7)*numerical.signs)
                np.testing.assert_array_equal(captured["_signs"], np.ones(7))
                expected = render_plan(captured, simulator.kinematics)
                from inspection_problem import captured_problem
                problem = captured_problem(expected)
                self.assertEqual(problem["reference_native"], simulator.reference.tolist())
                self.assertEqual(expected["task_anchors"], mutable(simulator.task_anchors))
                self.assertEqual(expected["task_path_xyz"], simulator.task_path_xyz)
                # Public records may be edited without changing future solves;
                # retained snapshots survive mutable source/profile/config edits.
                public = mutable(captured)
                public["solver_profile"]["profile"]["id"] = "edited-record"
                simulator.last_xu[:] = -99
                simulator.reference[:] = 99
                simulator.profile["id"] = "new-profile"
                numerical.problem_configuration["solver_params"]["max_sqp_iters"] = 9
                numerical.constraint_bounds_native[0]["lo"][0] = -99
                simulator.configure(Path(__file__), deepcopy(FIGURE8_DEFAULT_TASK))
                self.assertEqual(render_plan(captured, simulator.kinematics), expected)
                newer = simulator.solve_snapshot("play", 8)
                self.assertEqual(newer["problem_configuration"]["solver_params"]["max_sqp_iters"], 9)
                self.assertEqual(newer["solver_profile"]["profile"]["id"], "new-profile")
                with self.assertRaises(TypeError):
                    captured["solver_profile"]["profile"]["id"] = "mutated"
                with self.assertRaises(ValueError):
                    captured["_xu"][0] = 1
            finally:
                simulator.remote.request("close")
                thread.join(timeout=3)
                sender.close()
                receiver.close()
        self.assertFalse(thread.is_alive())
