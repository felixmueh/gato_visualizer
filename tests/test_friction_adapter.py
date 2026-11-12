"""CPU-only native construction for the standard adapter's friction, armature and law controls.

Run with the selected TIAGo checkout's interpreter and TIAGO_MPC_ROOT.
Joint coefficients and PD gains are code-owned; only widths and enable/law choices
are accepted as scoped values.
"""
from copy import deepcopy
from dataclasses import fields, replace
import importlib
import json
import unittest
from unittest.mock import patch

import numpy as np

from live_mpc import import_tiago
from tests.tiago_mpc_source import MPC_ROOT
from worktree_settings import validate_description, validate_values


class FrictionAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import_tiago(MPC_ROOT)
        cls.tm = importlib.import_module("tiago_mpc")
        cls.settings = importlib.import_module("adapters.tiago")

    def test_fixed_descriptors_are_finite_complete_and_have_separate_native_ownership(self):
        tm, settings = self.tm, self.settings
        description = settings.describe()
        json.dumps(description, allow_nan=False)
        validate_description(description)
        self.assertEqual(description["simulation"]["controls"], ["armature", "law"])
        self.assertEqual(description["simulation"]["defaults"]["law"], "default")
        self.assertEqual(description["predictor"]["controls"], ["armature", "friction", "friction_law", "collision"])
        self.assertEqual(set(description["simulation"]["defaults"]),
                         {"armature_on", "law", "ff_width_rad_s"})
        self.assertTrue({"armature_on", "friction_on", "friction_width_rad_s"} <= set(description["predictor"]["defaults"]))
        friction_paths = ("armature_on", "friction_on", "friction_width_rad_s")
        for role in ("simulation", "predictor"):
            parameters = description[role]["parameters"]
            self.assertEqual({field["path"] for field in parameters}, description[role]["defaults"].keys())
            self.assertTrue(all(field.get("group") for field in parameters))
            if role == "simulation":
                self.assertTrue(all(field["effect"] == "runtime" for field in parameters))
            else:
                self.assertTrue(all(field["effect"] == "compiled_model" for field in parameters if field["path"] in friction_paths))
            self.assertEqual({field["path"] for field in parameters if field["kind"] == "vector"}, set())
        predictor = {field["path"]: field for field in description["predictor"]["parameters"]}
        # Defaults are the native ones: TIAGO's armature, no predictor friction, its tanh width.
        defaults = description["predictor"]["defaults"]
        self.assertEqual((defaults["armature_on"], defaults["friction_on"], defaults["friction_width_rad_s"]),
                         (True, False, tm.TIAGO.friction_law.width_rad_s))
        self.assertEqual(settings.build_predictor(defaults, tm.TIAGO), tm.TIAGO)
        self.assertNotIn("visible_if", predictor["friction_width_rad_s"])
        self.assertEqual(predictor["friction_width_rad_s"]["enabled_if"], {"friction_on": True})
        for role, path in (("simulation", "ff_width_rad_s"), ("predictor", "friction_width_rad_s")):
            width = next(field for field in description[role]["parameters"] if field["path"] == path)
            self.assertEqual(width["min"], 0.)
            self.assertIs(width["min_exclusive"], True)
        for role in ("simulation", "predictor"):
            values = deepcopy(description[role]["defaults"])
            values["armature_on"] = False
            if role == "simulation":
                values["law"] = "both"
                settings.build_simulation(values, tm.SimConfig())
            else:
                values["friction_on"] = True
                settings.build_predictor(values, tm.TIAGO)
        self.assertEqual(settings.describe(), description)

    def test_simulation_preserves_native_friction_law_and_unclaimed_state_integration(self):
        tm, settings = self.tm, self.settings
        for physical_law in (tm.StickSlip(), tm.Sign(), tm.Tanh(.123)):
            with self.subTest(physical_law=physical_law):
                base = tm.SimConfig(q=tuple(tm.Q_START + .01), qd=(.02,) * 7, substep=.0007,
                                    friction=tm.Friction((.4,) * 7, (.6,) * 7), friction_law=physical_law,
                                    integrator="euler", sync_real_time=True, armature=(.1,) * 7)
                values = settings.describe()["simulation"]["defaults"]
                plant, law = settings.build_simulation(values, base)
                self.assertEqual(plant.armature, tm.ARMATURE_KG_M2)
                self.assertIsNone(law)  # the package loop resolves its default law
                self.assertEqual(plant.friction, base.friction)  # the plant's own coefficients stay
                self.assertIs(plant.friction_law, physical_law)
                self.assertEqual(replace(plant, armature=base.armature), base)
                self.assertEqual(base.friction.coulomb_nm, (.4,) * 7)
                self.assertEqual(tm.from_dict(json.loads(json.dumps(tm.to_dict(plant)))), plant)

    def test_off_is_exact_zero_and_physical_friction_enable_remains_the_native_choice(self):
        tm, settings = self.tm, self.settings
        description = settings.describe()
        simulation = description["simulation"]["defaults"]
        predictor = description["predictor"]["defaults"]
        simulation["armature_on"] = predictor["armature_on"] = False
        plant, law = settings.build_simulation(simulation, tm.SimConfig())
        params = settings.build_predictor(predictor, replace(tm.TIAGO, friction=tm.urdf_friction()))
        self.assertEqual(plant.armature, (0.,) * 7)
        self.assertEqual(params.armature, (0.,) * 7)
        self.assertIsNone(plant.friction)  # a loss-free base plant stays loss-free
        self.assertIsNone(params.friction)
        self.assertNotIn("armature", simulation)
        self.assertNotIn("armature", predictor)
        self.assertIsNone(law)  # the package loop resolves its default law

    def test_selected_package_execution_law_matches_the_package_laws_and_commands(self):
        tm, settings = self.tm, self.settings
        friction = tm.urdf_friction()
        for mode, expected in (("plan", tm.SampleKnot()), ("pd", tm.PlanFeedback()),
                               ("ff", tm.FrictionFeedforward(friction, tm.SampleKnot())),
                               ("both", tm.FrictionFeedforward(friction, tm.PlanFeedback()))):
            with self.subTest(mode=mode):
                values = settings.describe()["simulation"]["defaults"]
                values["law"] = mode
                plant, law = settings.build_simulation(values, tm.SimConfig())
                self.assertEqual(law, expected)
                self.assertEqual(type(law).__module__, "tiago_mpc.laws")
                states = np.arange(42.).reshape(3, 14) / 100
                plan = tm.Plan(1., .03, states, np.arange(14.).reshape(2, 7), measured_t=1.)
                observed = tm.State(.99, np.linspace(-.1, .1, 7), np.full(7, -.1))
                actual, wanted = law(plan, 1.039, observed), expected(plan, 1.039, observed)
                self.assertIsInstance(actual, tm.Command)
                np.testing.assert_array_equal(actual.requested, wanted.requested)
                np.testing.assert_array_equal(actual.applied, wanted.applied)
                self.assertEqual(tm.from_dict(json.loads(json.dumps(tm.to_dict(plant)))), plant)
                self.assertEqual(tm.from_dict(json.loads(json.dumps(tm.to_dict(law)))), law)

    def test_predictor_claims_its_independent_model_and_preserves_every_other_parameter(self):
        tm, settings = self.tm, self.settings
        with patch.object(tm, "compile_binary", side_effect=AssertionError("Settings resolution must never compile")):
            values = settings.describe()["predictor"]["defaults"]
            base = replace(tm.TIAGO, N=16, dt_s=.023, joint_margin_rad=.2, effort_fraction=.7,
                           velocity_fraction=.6, max_sqp_time_s=None, warm_start="hold",
                           solver=replace(tm.TIAGO.solver, mu=3.), cost=tm.default_cost(16, torque=.0003))
            off = settings.build_predictor(values, base)
            self.assertEqual(off.armature, tm.ARMATURE_KG_M2)
            self.assertIsNone(off.friction)
            values["friction_on"] = True
            values["friction_width_rad_s"] = .137
            params = settings.build_predictor(values, base)
            self.assertEqual(params.friction_law, tm.Tanh(.137))
            self.assertEqual(params.friction.coulomb_nm, tm.urdf_friction().coulomb_nm)
            self.assertEqual(params.friction.viscous_nm_s_per_rad, tm.urdf_friction().viscous_nm_s_per_rad)
            self.assertEqual(replace(params, armature=base.armature, friction=base.friction,
                                     friction_law=base.friction_law), base)
            self.assertIs(params.cost, base.cost)
            self.assertIs(params.solver, base.solver)
            self.assertIs(params.admm, base.admm)
            self.assertEqual(tm.from_dict(json.loads(json.dumps(tm.to_dict(params)))), params)
        plant, _ = settings.build_simulation(settings.describe()["simulation"]["defaults"],
                                              tm.SimConfig(friction=tm.urdf_friction(), integrator="euler"))
        self.assertEqual(plant.friction, tm.urdf_friction())

    def test_requested_width_preserves_fixed_pd_gains_and_model_coefficients(self):
        tm, settings = self.tm, self.settings
        values = settings.describe()["simulation"]["defaults"]
        values.update(law="both", ff_width_rad_s=.071)
        prior = tm.urdf_friction()
        feedback = tm.PlanFeedback()
        expected = tm.FrictionFeedforward(prior, feedback, evaluation=tm.Tanh(.071))
        base = tm.SimConfig(friction=tm.urdf_friction(), friction_law=tm.Tanh(.123), integrator="euler")
        plant, law = settings.build_simulation(values, base)
        self.assertEqual(law, expected)
        self.assertEqual(law.base_law, tm.PlanFeedback())
        self.assertEqual(plant.armature, tm.ARMATURE_KG_M2)
        self.assertEqual(plant.friction, base.friction)
        self.assertEqual(plant.friction_law, base.friction_law)
        plan = tm.Plan(1., .03, np.arange(42.).reshape(3, 14) / 100, np.arange(14.).reshape(2, 7), measured_t=1.)
        observed = tm.State(.99, np.linspace(-.1, .1, 7), np.full(7, -.1))
        actual, wanted = law(plan, 1.039, observed), expected(plan, 1.039, observed)
        self.assertIsInstance(actual, tm.Command)
        np.testing.assert_array_equal(actual.requested, wanted.requested)
        np.testing.assert_array_equal(actual.applied, wanted.applied)
        self.assertEqual(tm.from_dict(json.loads(json.dumps(tm.to_dict(law)))), law)

    def test_code_owned_vectors_are_rejected_by_normal_backend_value_validation(self):
        description = self.settings.describe()
        removed = {"simulation": ("armature", "coulomb_nm", "viscous_nm_s_per_rad",
                                  "ff_coulomb_nm", "ff_viscous_nm_s_per_rad", "kp", "kd"),
                   "predictor": ("armature", "coulomb_nm", "viscous_nm_s_per_rad")}
        for role, keys in removed.items():
            for key in keys:
                with self.subTest(role=role, key=key):
                    values = deepcopy(description[role]["defaults"])
                    values[key] = [1.] * 7
                    with self.assertRaisesRegex(ValueError, "unknown=.*" + key):
                        validate_values(description, role, values)

    def test_inactive_values_are_still_validated(self):
        tm, settings = self.tm, self.settings
        cases = (("simulation", "ff_width_rad_s", 0.),
                 ("simulation", "law", "unknown"),
                 ("simulation", "armature_on", "false"),
                 ("predictor", "friction_width_rad_s", float("inf")),
                 ("predictor", "armature_on", "false"),
                 ("predictor", "friction_on", "false"))
        for role, key, bad in cases:
            with self.subTest(role=role, key=key):
                values = settings.describe()[role]["defaults"]
                values["armature_on"] = False
                values[key] = bad
                with self.assertRaises(ValueError):
                    if role == "simulation":
                        settings.build_simulation(values, tm.SimConfig())
                    else:
                        settings.build_predictor(values, tm.TIAGO)


if __name__ == "__main__":
    unittest.main()
