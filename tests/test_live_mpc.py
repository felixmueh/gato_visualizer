"""CPU-only validation and transport checks; no solver objects are constructed."""
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import numpy as np
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from live_mpc import (GPULocks, POSITION_TOL_M, SPEED_L1_TOL_RAD_S, build_schema, figure8_reference, mpc_bounds_from_rows,
                      FIGURE8_DEFAULT_TASK, REACH_DEFAULT_TASK, validate_settings)
from server import make_server
from live_presentation import mutable, render_plan, render_state, snapshot
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

    def test_new_predictor_fields_are_checked_until_runtime_effect_is_explicit(self):
        from live_mpc import parameter_specs
        config = dict(dt_s=.02, N=32, future_model_feature=True, collision=None,
                      solver=dict(mu=10., future_solver_feature=True),
                      plant=dict(future_cpu_setting=True))
        effects = {field['path']: field['effect'] for field in parameter_specs(config, [32], self.friction, {})}
        self.assertEqual(effects['dt_s'], 'runtime')
        self.assertEqual(effects['solver.mu'], 'runtime')
        self.assertEqual(effects['N'], 'compiled_model')
        self.assertEqual(effects['future_model_feature'], 'compiled_model')
        self.assertEqual(effects['solver.future_solver_feature'], 'compiled_model')
        self.assertEqual(effects['plant.future_cpu_setting'], 'runtime')

    def test_schema_serves_the_simulator_grasp_origin(self):
        from live_mpc import end_effector_spec, import_tiago
        tiago = import_tiago(MPC_ROOT)
        grasp = self.schema["end_effector"]
        self.assertEqual(grasp, end_effector_spec(tiago))
        self.assertEqual(set(grasp), {"frame", "parent_link", "xyz", "rpy"})
        self.assertEqual(grasp["frame"], tiago.GRASP_FRAME)
        self.assertEqual(grasp["parent_link"], "arm_right_tool_link")
        self.assertEqual(grasp["rpy"], [0., 0., 0.])
        self.assertEqual(len(grasp["xyz"]), 3)
        self.assertTrue(np.isfinite(grasp["xyz"]).all())
        self.assertGreater(grasp["xyz"][2], 0.)

    def test_separate_solver_schema_keeps_simulator_grasp_metadata(self):
        grasp = deepcopy(self.schema["end_effector"])
        probe, pose = live_probe(), start_pose()
        # A solver profile may name another checkout. Its probe does not decide
        # where the display/simulator's grasp handle belongs.
        with patch("live_mpc.import_tiago", side_effect=AssertionError("must retain simulator metadata")), \
                patch("live_mpc.source_identity", return_value={"mpc_root": "/other/solver"}):
            schema = build_schema(probe, "/other/solver", pose, end_effector=grasp)
        self.assertEqual(schema["end_effector"], grasp)
        schema["end_effector"]["xyz"][2] += 1.
        self.assertNotEqual(schema["end_effector"]["xyz"], grasp["xyz"])

    def test_gato_default_is_valid_even_when_the_tiago_preset_is_explicit(self):
        from live_mpc import mpc_params
        from tiago_mpc.record import from_dict
        # Null means follow GATO, independently of TIAGO's explicit rho_u preset.
        # Schema generation must describe that capability, not just its initial value.
        self.assertEqual(self.config["admm"]["rho_u"], .0005)
        for spec in self.schema["parameters"]:
            if not spec.get("gato_default") or spec["kind"] not in ("float", "int"):
                continue
            with self.subTest(path=spec["path"]):
                self.assertTrue(spec["nullable"])
                config = deepcopy(self.config)
                keys = spec["path"].split(".")
                parent = config
                for key in keys[:-1]:
                    parent = parent[key]
                parent[keys[-1]] = None
                valid, _ = validate_settings(config, self.task, self.schema)
                native = from_dict(mpc_params(valid))
                for key in keys:
                    native = getattr(native, key)
                self.assertIsNone(native)
        self.assertEqual(self.schema["defaults"]["config"]["admm"]["rho_u"], .0005)

    def test_schema_is_mpc_params_plus_the_simulated_plant(self):
        config, task = validate_settings(self.config, self.task, self.schema)
        self.assertEqual(config, self.config)
        self.assertIsNot(config, self.config)
        # TIAGO's defaults, without the SQP wall-time limit on the simulation clock
        from native_cost import serialized_cost
        expected = dict(live_probe()["defaults"], max_sqp_time_s=None,
                        cost=serialized_cost(config["N"], config["cost_weights"]))
        self.assertEqual({key: value for key, value in config.items() if key not in ("plant", "cost_weights")},
                         expected)
        self.assertIsNotNone(live_probe()["defaults"]["max_sqp_time_s"])
        self.assertIs(config["warmup"], True)
        # Euler with constraint Coulomb friction is the simulated-plant default;
        # effort clipped, stop on every limit breach, and Q_START at rest.
        self.assertEqual(config["plant"], dict(integrator="euler", friction=True, coulomb_law="constraint",
                                               friction_width_rad_s=.03, clip_effort=True,
                                               stop_on_breach=dict(position=True, velocity=True, torque=True),
                                               start_pose_rad=start_pose()["default"]))
        self.assertIsNone(config["friction"])  # predictor has its own independent default
        specs = {s["path"]: s for s in self.schema["parameters"]}
        self.assertNotIn("ee_frame", config)
        self.assertEqual(set(specs), {"N", "dt_s", "warm_start", "reset_rho_each_step", "admm_linsys",
            "admm_threshold", "linsys", "bdsv_threshold", "reseed_threshold", "joint_margin_rad", "velocity_fraction", "effort_fraction", "friction", "friction_law", "warmup", "max_sqp_time_s",
            *(["armature"] if "armature" in config else []), *(["collision"] if "collision" in config else []),
            "plant.integrator", "plant.friction", "plant.coulomb_law", "plant.friction_width_rad_s", "plant.clip_effort", "plant.stop_on_breach.position", "plant.stop_on_breach.velocity",
            "plant.stop_on_breach.torque", "plant.start_pose_rad", *(f"cost_weights.{key}" for key in config.get("cost_weights", {})), *(f"solver.{key}" for key in config["solver"] if key != "type"), *(f"admm.{key}" for key in config["admm"] if key != "type")})
        gato_default = dict(value=None, label="GATO default")  # MpcParams' None follows GATO
        self.assertEqual(specs["warm_start"]["choices"], [gato_default, "shift", "hold"])
        self.assertEqual(specs["admm_linsys"]["choices"], [gato_default, "pcg", "bdsv_factor", "auto"])
        self.assertEqual(specs["reset_rho_each_step"]["choices"], [gato_default, True, False])
        self.assertEqual((specs["admm.iters"]["kind"], specs["admm.iters"]["nullable"]), ("int", True))
        self.assertTrue(specs["warm_start"]["gato_default"] and specs["admm.rho_u"]["gato_default"])
        self.assertNotIn("gato_default", specs["max_sqp_time_s"])  # its None is "no limit", not GATO's
        self.assertEqual(specs["reseed_threshold"]["gato_none"], "off")
        for fixed in ("solver.exact_hessian", "solver.cost_curvature", "solver.linsys"):
            self.assertTrue(specs[fixed]["disabled"], fixed)
        self.assertEqual(specs["N"]["choices"], [16, 32])
        self.assertNotIn("disabled", specs["N"])
        self.assertEqual(specs["friction"]["choices"], [dict(value=None, label="Loss-free"), dict(
            value=self.friction, label="URDF coefficients")])
        self.assertNotIn("law", self.friction)
        width = config["friction_law"]["width_rad_s"]  # the source's predictor default
        self.assertEqual(config["friction_law"], dict(type="Tanh", width_rad_s=width))
        self.assertEqual(specs["friction_law"]["choices"], [dict(value=config["friction_law"], label=f"tanh {width:g} rad/s")])
        self.assertEqual(specs["friction_law"]["effect"], "compiled_model")
        self.assertTrue(specs["friction_law"]["disabled"])
        self.assertEqual(specs["solver.defect_exit"]["min"], 0.)
        self.assertEqual(config["solver"]["defect_exit"], 0.)
        self.assertEqual({key: specs["max_sqp_time_s"][key] for key in ("kind", "nullable", "min", "max")},
                         dict(kind="float", nullable=True, min=1e-4, max=10))
        self.assertEqual(specs["warmup"]["kind"], "bool")
        for path in ("plant.integrator", "plant.friction", "plant.coulomb_law", "plant.friction_width_rad_s"):
            self.assertEqual(specs[path]["group"], specs["friction"]["group"])
            self.assertTrue(specs[path]["description"])
        self.assertEqual(specs["plant.integrator"]["choices"], [dict(value="rk4", label="RK4"),
                                                                dict(value="euler", label="Euler")])
        self.assertEqual(specs["plant.coulomb_law"]["choices"], ["tanh", "sign", "constraint"])
        for path, label in (("plant.clip_effort", "Clip effort"), ("plant.stop_on_breach.position", "Joint limits"),
                            ("plant.stop_on_breach.velocity", "Velocity"), ("plant.stop_on_breach.torque", "Torque")):
            self.assertEqual((specs[path]["kind"], specs[path]["group"], specs[path]["label"]),
                             ("bool", "Limit handling", label))
            self.assertTrue(specs[path]["description"])
        self.assertEqual({specs[f"plant.stop_on_breach.{key}"]["row"] for key in ("position", "velocity", "torque")},
                         {"Stop on breach"})
        validate_settings(dict(self.config, max_sqp_time_s=.05, warmup=False, friction=self.friction), self.task, self.schema)

    def test_custom_native_menu_is_retained_without_convenience_weight_controls(self):
        from live_mpc import mpc_params
        probe = live_probe()
        probe["defaults"]["cost"]["input"]["weight"] = [.1] * 7
        schema = build_schema(probe, MPC_ROOT, start_pose())
        config = deepcopy(schema["defaults"]["config"])
        self.assertNotIn("cost_weights", config)
        self.assertTrue(schema["orientation_goal_supported"])
        self.assertEqual(schema["fixed_horizon_N"], config["N"])
        knot = next(spec for spec in schema["parameters"] if spec["path"] == "N")
        self.assertEqual(knot["choices"], [config["N"]]); self.assertTrue(knot["disabled"])
        changed = dict(config, N=16 if config["N"] != 16 else 32)
        with self.assertRaisesRegex(ValueError, "Custom CostMenu fixes N"):
            validate_settings(changed, self.task, schema, check_available=False)
        self.assertFalse(any(spec["path"].startswith("cost") for spec in schema["parameters"]))
        validate_settings(config, self.task, schema, check_available=False)
        self.assertEqual(mpc_params(config)["cost"], probe["defaults"]["cost"])

    def test_weight_controls_rebuild_the_native_menu_for_the_edited_horizon(self):
        from live_mpc import mpc_params
        from native_cost import serialized_cost
        config = deepcopy(self.config)
        config["N"] = 16
        config["cost_weights"].update(position=6., orientation=1., terminal_orientation=8.)
        valid, _ = validate_settings(config, self.task, self.schema)
        payload = mpc_params(valid)
        self.assertEqual(payload["cost"], serialized_cost(16, config["cost_weights"]))
        self.assertEqual(len(payload["cost"]["frame_pos"]["weight"]), 16)
        self.assertNotIn("cost_weights", payload)

    def test_native_config_roundtrips_with_hidden_fixed_type_metadata(self):
        from live_mpc import mpc_params
        from tiago_mpc.mpc import MpcParams
        from tiago_mpc.record import from_dict, to_dict
        from tiago_mpc.dynamics import Tanh
        paths = {spec["path"] for spec in self.schema["parameters"]}
        self.assertFalse(any(path == "type" or path.endswith(".type") for path in paths))
        self.assertEqual(self.config["type"], "MpcParams")
        self.assertEqual(self.config["solver"]["type"], "SolverSettings")
        self.assertEqual(self.config["admm"]["type"], "AdmmLimits")
        for friction in (None, self.friction):
            config = dict(self.config, friction=friction)
            valid, _ = validate_settings(config, self.task, self.schema)
            decoded = from_dict(mpc_params(valid))
            self.assertIsInstance(decoded, MpcParams)
            self.assertEqual(to_dict(decoded), mpc_params(config))
            if friction is not None:
                self.assertIsInstance(decoded.friction_law, Tanh)
                self.assertIsInstance(decoded.friction.coulomb_nm, tuple)

    def test_config_type_metadata_cannot_be_removed_changed_or_injected(self):
        for path in ("type", "solver.type", "admm.type"):
            for replacement in (None, "OtherType", True, {}):
                config = deepcopy(self.config)
                parent = config
                for key in path.split(".")[:-1]:
                    parent = parent[key]
                key = path.split(".")[-1]
                if replacement is None:
                    del parent[key]
                else:
                    parent[key] = replacement
                with self.subTest(path=path, replacement=replacement), self.assertRaises(ValueError):
                    validate_settings(config, self.task, self.schema)
        config = deepcopy(self.config)
        config["plant"]["type"] = "SimConfig"
        with self.assertRaisesRegex(ValueError, "unknown"):
            validate_settings(config, self.task, self.schema)

    def test_plant_friction_needs_euler_and_takes_any_coulomb_law(self):
        def plant(**values):
            return dict(self.config, plant=dict(self.config["plant"], **values))
        for law in ("tanh", "sign", "constraint"):
            validate_settings(plant(integrator="euler", friction=True, coulomb_law=law), self.task, self.schema)
        validate_settings(plant(integrator="euler", friction=False), self.task, self.schema)  # loss-free Euler
        validate_settings(plant(friction=False, coulomb_law="tanh", friction_width_rad_s=.001), self.task, self.schema)  # unused
        with self.assertRaisesRegex(ValueError, "Plant friction needs the semi-implicit Euler integrator"):
            validate_settings(plant(integrator="rk4", friction=True), self.task, self.schema)
        for values in (dict(integrator="implicit"), dict(coulomb_law="viscous"), dict(friction_width_rad_s=0),
                       dict(friction_width_rad_s=None)):
            with self.subTest(**values), self.assertRaises(ValueError):
                validate_settings(plant(**values), self.task, self.schema)

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
    def test_release_retains_a_borrowed_solver_lease_until_its_descriptor_closes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'gpu.lock'
            locks = GPULocks(MPC_ROOT)
            locks.paths = [path]
            self.assertTrue(locks.acquire())
            borrowed = os.dup(locks.handles[0].fileno())
            try:
                locks.release()
                self.assertEqual(locks.handles, [])
                with path.open('a') as contender:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    os.close(borrowed)
                    borrowed = None
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if borrowed is not None:
                    os.close(borrowed)
                locks.release()

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
