"""The optional orientation goal of a reach, end to end without a GPU: settings, the
reference rows that reach tiago_mpc, their RPC and history encoding, presentation,
freezes, replays and plots."""
from copy import deepcopy
import math
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import pinocchio as pin

from live_mpc import (REACH_DEFAULT_TASK, FIGURE8_DEFAULT_TASK,
                      build_schema, orientation_goal, solver_params, validate_settings)
from live_presentation import render_plan, render_state, rotation_angle
from solver_process import reference_from_wire, reference_to_wire
from tests.tiago_mpc_source import MODEL, MPC_ROOT, live_probe, replay_exporter, start_pose

ROOT = Path(__file__).resolve().parents[1]
GOAL = [0., 0., .5]  # world rotation vector: half a radian about z


def has_orientation_cost():
    return "cost" in live_probe()["defaults"]


def exports_orientations():
    """Whether the selected tiago_mpc's save_replay takes reference orientations."""
    import inspect
    return "reference_rotvec_rad" in inspect.signature(replay_exporter().save_replay).parameters


class ReferenceEncodingTests(unittest.TestCase):
    def test_a_nan_orientation_travels_as_null_and_returns_as_nan(self):
        rows = np.array([[.1, .2, .3, np.nan, np.nan, np.nan], [.1, .2, .3, 0., 0., .5]], dtype=np.float32)
        wire = reference_to_wire(rows)
        self.assertEqual(wire[0][3:], [None] * 3)
        np.testing.assert_allclose(wire[1], [.1, .2, .3, 0., 0., .5], rtol=1e-6)
        decoded = reference_from_wire(wire, 2)
        self.assertEqual(decoded.dtype, np.float32)
        np.testing.assert_array_equal(np.isnan(decoded), np.isnan(rows))
        np.testing.assert_array_equal(decoded[1], rows[1])

    def test_positions_must_be_finite_and_an_orientation_complete(self):
        for rows, n in (([[None, 0, 0, None, None, None]], 1), ([[0, 0, 0, None, 0, 0]], 1),
                        ([[0, 0, 0, 0, 0, 0]], 2), ([[0, 0, 0, 0, 0]], 1)):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                reference_from_wire(rows, n)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        if not has_orientation_cost():
            self.skipTest("The selected tiago_mpc has no orientation cost")
        probe = deepcopy(live_probe())
        probe["available_N_by_friction"] = dict(off=[16, 32], on=[32])
        self.schema = build_schema(probe, MPC_ROOT, start_pose())
        self.config = deepcopy(self.schema["defaults"]["config"])
        self.task = deepcopy(REACH_DEFAULT_TASK)

    def test_native_menu_and_editable_default_weights_are_retained_with_an_optional_goal(self):
        self.assertEqual(self.config["cost_weights"]["orientation"], 1.)
        self.assertEqual(self.config["cost_weights"]["terminal_orientation"], 8.)
        self.assertIsNone(self.task["orientation_rad"])
        self.config["cost_weights"].update(orientation=1., terminal_orientation=8.)
        off = solver_params(self.config, self.task)
        on = solver_params(self.config, {**self.task, "orientation_rad": GOAL})
        self.assertEqual(off, on)  # the NaN target disables absent orientations
        self.assertNotIn("plant", off)
        self.assertNotIn("cost_weights", off)
        self.assertEqual(off["cost"]["orientation"]["weight"][-1], [8.] * 3)
        self.assertIsNone(orientation_goal({**FIGURE8_DEFAULT_TASK, "orientation_rad": GOAL}))
        specs = {spec["path"]: spec for spec in self.schema["parameters"]}
        for key in ("orientation", "terminal_orientation"):
            spec = specs[f"cost_weights.{key}"]
            self.assertNotIn("enabled_with", spec)
            self.assertFalse(spec.get("disabled", False))
            self.assertEqual(spec["effect"], "runtime")
            self.assertEqual(spec["group"], "Costs")
        self.assertIsNone(self.schema["tasks"][0]["defaults"]["orientation_rad"])

    def test_source_orientation_weights_are_preserved(self):
        from native_cost import cost_weights, serialized_cost
        for running, terminal in ((2., 11.), (0., 7.), (3., 0.)):
            with self.subTest(running=running, terminal=terminal):
                probe = deepcopy(live_probe())
                weights = cost_weights(probe["defaults"]["cost"])
                weights.update(orientation=running, terminal_orientation=terminal)
                probe["defaults"]["cost"] = serialized_cost(probe["defaults"]["N"], weights)
                schema = build_schema(probe, MPC_ROOT, start_pose())
                self.assertEqual(schema["defaults"]["config"]["cost_weights"], weights)
                self.assertEqual(schema["defaults"]["config"]["cost"], probe["defaults"]["cost"])

    def test_a_reach_goal_is_validated_and_needs_the_sources_orientation_cost(self):
        validate_settings(self.config, {**self.task, "orientation_rad": GOAL}, self.schema)
        validate_settings(self.config, {**self.task, "orientation_rad": [0, 0, math.pi]}, self.schema)
        for invalid in ([0, 0], [0, 0, float("nan")], [True, 0, 0], [0, 0, 3.2], "z", 0):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "orientation_rad"):
                validate_settings(self.config, {**self.task, "orientation_rad": invalid}, self.schema)
        missing = {key: value for key, value in self.task.items() if key != "orientation_rad"}
        with self.assertRaisesRegex(ValueError, "complete reach"):
            validate_settings(self.config, missing, self.schema)
        with self.assertRaisesRegex(ValueError, "complete reach"):  # figure eights have no goal
            validate_settings(self.config, {**FIGURE8_DEFAULT_TASK, "orientation_rad": GOAL}, self.schema)



class AdapterTests(unittest.TestCase):
    def adapter(self):
        from solver_adapter import SimulatorAdapter
        live_probe()
        adapter = SimulatorAdapter(MPC_ROOT)
        return adapter

    def test_reference_rows_hold_the_goal_in_the_torso_frame_and_nan_without_one(self):
        adapter = self.adapter()
        adapter.configure_task(3, .01, {**REACH_DEFAULT_TASK, "orientation_rad": GOAL})
        rows = adapter.task_reference()
        self.assertEqual(rows.shape, (3, 6))
        for row in rows:  # back in the world frame, each knot's orientation is the goal
            np.testing.assert_allclose(adapter.kinematics.rotation_to_world(row[3:].astype(float)), GOAL, atol=1e-6)
        np.testing.assert_allclose(adapter.kinematics.target_to_world(rows[0, :3].astype(float)),
                                   adapter.target_world_at(0.), atol=1e-6)
        adapter.configure_task(3, .01, deepcopy(REACH_DEFAULT_TASK))
        self.assertTrue(np.isnan(adapter.task_reference()[:, 3:]).all())
        self.assertEqual(reference_to_wire(adapter.task_reference())[0][3:], [None] * 3)
        # States carry no goal: it is constant per segment and lives in its header's task.
        self.assertNotIn("target_rotvec", adapter.state_snapshot())
        figure8 = self.adapter()
        figure8.configure_task(3, .01, deepcopy(FIGURE8_DEFAULT_TASK))
        self.assertTrue(np.isnan(figure8.task_reference(.4)[:, 3:]).all())

    def test_states_report_the_angle_to_the_segment_goal_and_plans_keep_the_native_rows(self):
        adapter = self.adapter()
        adapter.configure_task(2, .01, {**REACH_DEFAULT_TASK, "orientation_rad": GOAL})
        context = dict(task={**REACH_DEFAULT_TASK, "orientation_rad": GOAL}, position_tol_m=.05, speed_l1_tol_rad_s=1.)
        state = render_state(adapter.state_snapshot(), adapter.kinematics, context)
        actual = adapter.kinematics.ee_rotvecs(np.asarray(state["q"])[None])[0]
        self.assertAlmostEqual(state["orientation_error_rad"], rotation_angle(GOAL, actual))
        expected = np.linalg.norm(pin.log3(pin.exp3(np.array(GOAL)).T @ pin.exp3(actual)))
        self.assertAlmostEqual(state["orientation_error_rad"], expected)
        plain = render_state(adapter.state_snapshot(), adapter.kinematics, dict(context, task=REACH_DEFAULT_TASK))
        self.assertNotIn("orientation_error_rad", plain)
        n = 2
        plan = render_plan(dict(type="plan", N=n, dt_s=.01, _states=np.tile(adapter.x, (n, 1)),
                                _torques=np.zeros((n - 1, 7)), _reference=np.r_[adapter.task_reference()]),
                           adapter.kinematics)
        self.assertEqual(plan["reference_native"], reference_to_wire(adapter.task_reference()))
        adapter.configure_task(2, .01, deepcopy(REACH_DEFAULT_TASK))
        plan = render_plan(dict(type="plan", N=n, dt_s=.01, _states=np.tile(adapter.x, (n, 1)),
                                _torques=np.zeros((n - 1, 7)), _reference=adapter.task_reference().copy()),
                           adapter.kinematics)
        self.assertEqual(plan["reference_native"][0][3:], [None] * 3)  # JSON has no NaN

    def test_the_angle_is_tiago_mpcs_own_orientation_error(self):
        adapter = self.adapter()
        if not hasattr(adapter.tiago, "orientation_error"):
            self.skipTest("The selected tiago_mpc has no orientation_error")
        adapter.configure_task(2, .01, {**REACH_DEFAULT_TASK, "orientation_rad": GOAL})
        context = dict(task={**REACH_DEFAULT_TASK, "orientation_rad": GOAL}, position_tol_m=.05, speed_l1_tol_rad_s=1.)
        state = render_state(adapter.state_snapshot(), adapter.kinematics, context)  # in tiago_mpc's torso frame:
        self.assertAlmostEqual(state["orientation_error_rad"],
                               adapter.tiago.orientation_error(state["q"], adapter.kinematics.rotation_to_torso(GOAL)), places=6)


class RunAgainTests(unittest.TestCase):
    def test_a_captured_problem_accepts_rows_without_and_with_a_goal_but_never_a_partial_one(self):
        from inspection_problem import captured_problem
        from tests.test_solve_inspections import plan
        for orientation in ([None] * 3, [0., 0., .5]):
            captured = dict(plan(), reference_native=[[.1, .2, .3, *orientation]] * 3)
            self.assertEqual(captured_problem(captured)["reference_native"], captured["reference_native"])
        with self.assertRaisesRegex(ValueError, "exact native reference"):
            captured_problem(dict(plan(), reference_native=[[.1, .2, .3, None, 0., 0.]] * 3))

    def test_a_cold_orientation_solve_keeps_native_state_and_the_recorded_goal(self):
        from inspection_problem import captured_problem
        from inspection_worker import inspect_solve
        from tests.test_solve_inspections import groups, plan, trace

        class Solver:
            lib = SimpleNamespace(ITERATION_CAPTURE_AVAILABLE=True)
            def get_row_groups(self): return groups()
            def set_row_group_bounds(self, group, low, high): pass
            def set_row_group_mask(self, group, mask): pass
            def set_cost_menu(self, menu): self.menu = menu
            def reset_dual(self): pass
            def reset_rho(self): pass
            def solve(self, state, reference, *, capture_iterations, budget_s):
                self.inputs = state.copy(), reference.copy()
                return SimpleNamespace(iteration_trace=trace(), solve_time_us=1234, stats=SimpleNamespace())

        captured = plan()
        captured["reference_native"] = [[.1, .2, .3, *GOAL], [.1, .2, .3, *([None] * 3)], [.1, .2, .3, *GOAL]]
        from native_cost import native_params, serialized_cost, cost_weights
        data = dict(live_probe()["defaults"], N=3)
        weights = dict(cost_weights(data["cost"]), orientation=1., terminal_orientation=8.)
        data["cost"] = serialized_cost(3, weights)
        params = native_params(data)
        solver = Solver()
        session = SimpleNamespace(mpc=SimpleNamespace(N=3, dt=params.dt_s, params=params,
            controller=SimpleNamespace(solver=solver, admm_linsys="pcg")), model_identity={},
            configuration=captured["problem_configuration"], tiago=SimpleNamespace(GRASP_FRAME="tool"))
        with patch("inspection_worker.snapshot_models", return_value={}), \
                patch("inspection_worker.write_artifact", side_effect=lambda folder, trace, metadata: metadata):
            result = inspect_solve(session, dict(id="orientation", problem=captured_problem(captured),
                artifact_directory="unused", original={}, actual_solver_profile={}, sqp_iters=3))
        np.testing.assert_allclose(solver.inputs[0][0], captured["initial_state"]["q"] + captured["initial_state"]["qd"])
        np.testing.assert_array_equal(solver.inputs[1].reshape(3, 6)[:, 3:], 0.)
        np.testing.assert_allclose(solver.menu.orientation.target, pin.exp3(np.array(GOAL)))
        np.testing.assert_array_equal(solver.menu.orientation.weight[1], 0.)
        self.assertEqual(result["reference_native"], captured["reference_native"])
        self.assertEqual(result["signs"], [1.] * 7)


@unittest.skipUnless(MODEL.is_file(), "Sibling canonical TIAGo model is not available")
class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not exports_orientations():
            raise unittest.SkipTest("The selected tiago_mpc's save_replay takes no reference orientations")
        from server import load_scene
        cls.base_scene, _, _ = load_scene(MPC_ROOT, start_pose()["default"])
        cls.tools = replay_exporter()

    def setUp(self):
        parent = ROOT / "_expr_data/tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.folder = Path(self.temporary.name)
        self.q = np.array([[-.39, -1.73, -.38, -2.35, 0, -1.21, .04], [-.37, -1.71, -.4, -2.32, 0, -1.2, .04],
                           [-.35, -1.70, -.42, -2.3, .1, -1.2, .05]])
        self.time = np.array([0., .03, .06])

    def tearDown(self):
        self.temporary.cleanup()

    def export(self, name, **overrides):
        arguments = dict(time_s=self.time, q=self.q, joint_names=list(self.tools.RIGHT_ARM_JOINTS), model_urdf=MODEL,
                         time_basis="simulation", end_effector_frame=self.tools.GRASP_FRAME,
                         reference_xyz_m=np.tile([.5, -.3, .9], (3, 1)), reference_time_s=self.time,
                         reference_frame="base_footprint")
        arguments.update(overrides)
        return self.tools.save_replay(self.folder / name, **arguments)

    def test_the_reader_keeps_each_samples_orientation_and_none_rows(self):
        from replay_format import ReplayError, load_replay
        rotation = np.array([GOAL, [np.nan] * 3, GOAL])
        replay = load_replay(self.export("oriented.npz", reference_rotvec_rad=rotation), model_urdf=MODEL)
        np.testing.assert_array_equal(np.isnan(replay.reference.rotvec), np.isnan(rotation))
        np.testing.assert_array_equal(replay.reference.rotvec[0], GOAL)
        self.assertIsNone(load_replay(self.export("plain.npz"), model_urdf=MODEL).reference.rotvec)
        static = load_replay(self.export("static.npz", reference_xyz_m=np.array([.5, -.3, .9]), reference_time_s=None,
                                         reference_rotvec_rad=np.array(GOAL)), model_urdf=MODEL)
        np.testing.assert_array_equal(static.reference.rotvec, GOAL)
        with self.assertRaisesRegex(ValueError, "orientations"):  # the producer refuses a partial row
            self.export("partial.npz", reference_rotvec_rad=np.array([GOAL, [0., np.nan, 0.], GOAL]))
        with self.assertRaisesRegex(ValueError, "orientations require reference positions"):
            self.export("alone.npz", reference_xyz_m=None, reference_time_s=None, reference_frame=None,
                        reference_rotvec_rad=np.array([GOAL] * 3))
        path = self.export("valid.npz", reference_rotvec_rad=rotation)
        with np.load(path, allow_pickle=False) as archive:
            arrays = {name: archive[name] for name in archive.files}
        for name, value in (("short", rotation[:2]), ("partial", np.array([GOAL, [0., np.nan, 0.], GOAL]))):
            np.savez_compressed(self.folder / f"{name}.npz", **{**arrays, "reference_rotvec_rad": value})
            with self.subTest(name=name), self.assertRaisesRegex(ReplayError, "reference_rotvec_rad"):
                load_replay(self.folder / f"{name}.npz", model_urdf=MODEL)

    def test_tracks_and_plots_get_world_orientations_and_held_errors(self):
        from replay_format import load_replay
        from server import RobotKinematics, replay_motion, replay_scene
        from plot_sources import scene_records
        kinematics = RobotKinematics(MODEL, end_effector_frame=self.tools.GRASP_FRAME)
        torso_goal = kinematics.rotation_to_torso(GOAL)
        rotation = np.array([torso_goal, [np.nan] * 3, torso_goal])
        path = self.export("torso.npz", reference_xyz_m=np.tile(kinematics.world_from_torso.actInv(np.array([.5, -.3, .9])), (3, 1)),
                           reference_frame="torso_lift_link", reference_rotvec_rad=rotation)
        replay = load_replay(path, model_urdf=MODEL)
        motion = replay_motion(replay, path, MPC_ROOT, self.base_scene)
        np.testing.assert_allclose(motion["reference_rotvec"][0], GOAL, atol=1e-9)  # converted to the world frame
        self.assertIsNone(motion["reference_rotvec"][1])
        np.testing.assert_allclose(motion["ee_rotvec"], kinematics.ee_rotvecs(self.q), atol=1e-12)
        scene = replay_scene(replay, path, MPC_ROOT, self.base_scene)
        errors = scene["trajectories"][0]["orientation_error_rad"]
        actual = kinematics.ee_rotvecs(self.q)
        self.assertAlmostEqual(errors[0], rotation_angle(GOAL, actual[0]))
        self.assertIsNone(errors[1])  # that sample has no target
        self.assertAlmostEqual(errors[2], rotation_angle(GOAL, actual[2]))
        states = scene_records(scene)["states"]
        self.assertEqual([state.get("orientation_error_rad") for state in states], [errors[0], None, errors[2]])
        plain = load_replay(self.export("plain.npz"), model_urdf=MODEL)
        self.assertNotIn("reference_rotvec", replay_motion(plain, path, MPC_ROOT, self.base_scene))
        self.assertNotIn("orientation_error_rad", replay_scene(plain, path, MPC_ROOT, self.base_scene)["trajectories"][0])

    def test_a_static_orientation_reference_holds_for_the_whole_recording(self):
        from replay_format import load_replay
        from server import replay_motion, replay_scene
        path = self.export("static.npz", reference_xyz_m=np.array([.5, -.3, .9]), reference_time_s=None,
                           reference_rotvec_rad=np.array(GOAL))
        replay = load_replay(path, model_urdf=MODEL)
        motion = replay_motion(replay, path, MPC_ROOT, self.base_scene)
        self.assertEqual(len(motion["reference_rotvec"]), len(motion["reference_time_s"]))
        errors = replay_scene(replay, path, MPC_ROOT, self.base_scene)["trajectories"][0]["orientation_error_rad"]
        self.assertTrue(all(error is not None for error in errors))

    def test_a_freeze_records_the_segment_goal_at_every_state(self):
        from live_freeze import export_freeze
        from replay_format import load_replay
        from server import load_scene
        from tests.test_live_freeze import fixture_records
        records = fixture_records(self.base_scene)
        records[0]["context"]["settings"]["task"] = {**REACH_DEFAULT_TASK, "orientation_rad": GOAL}
        path = export_freeze(self.folder / "freeze.npz", records, mpc_root=MPC_ROOT, model_urdf=MODEL,
                             save_replay=self.tools.save_replay, generation=7, complete=True,
                             fixed_joints=self.base_scene["fixed_joints"], world_frame="base_footprint", label="Frozen")
        replay = load_replay(path, model_urdf=MODEL)
        np.testing.assert_array_equal(replay.reference.rotvec, np.tile(GOAL, (3, 1)))
        records[0]["context"]["settings"]["task"] = deepcopy(REACH_DEFAULT_TASK)
        plain = export_freeze(self.folder / "plain.npz", records, mpc_root=MPC_ROOT, model_urdf=MODEL,
                              save_replay=self.tools.save_replay, generation=7, complete=True,
                              fixed_joints=self.base_scene["fixed_joints"], world_frame="base_footprint", label="Frozen")
        self.assertIsNone(load_replay(plain, model_urdf=MODEL).reference.rotvec)


class PlotTests(unittest.TestCase):
    def test_the_orientation_error_plot_and_summary_use_degrees_and_only_runs_with_a_goal(self):
        from gato_visualizer.plotting import EpisodeView, Registry
        registry = Registry().load_directory(ROOT / "plotters")
        plot = lambda identity, states: registry.evaluate(identity, EpisodeView(dict(states=states)), {})
        states = [dict(type="state", sim_time_s=t, ee_xyz=[0, 0, 0], target_xyz=[0, 0, .01], orientation_error_rad=e)
                  for t, e in ((0., .5), (.1, .25), (.2, math.pi / 180))]
        spec = plot("episode.orientation_error", states)
        np.testing.assert_allclose(spec["series"][0]["y"], [.5 * 180 / math.pi, .25 * 180 / math.pi, 1.])
        rows = {row["label"]: row["value"] for row in plot("episode.summary", states)["rows"]}
        self.assertAlmostEqual(rows["Final orientation error"], 1.)
        self.assertAlmostEqual(rows["Minimum orientation error"], 1.)
        plain = [{key: value for key, value in state.items() if key != "orientation_error_rad"} for state in states]
        self.assertEqual(plot("episode.orientation_error", plain)["kind"], "unavailable")
        self.assertNotIn("Final orientation error", [row["label"] for row in plot("episode.summary", plain)["rows"]])


if __name__ == "__main__":
    unittest.main()
