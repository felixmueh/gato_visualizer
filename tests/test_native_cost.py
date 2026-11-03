"""Native-menu tracking controls and horizon changes, without a compiled model."""
from copy import deepcopy
from dataclasses import replace
import importlib
import unittest

import numpy as np

from native_cost import cost_weights, native_params, serialized_cost, with_knot_count
from tests.tiago_mpc_source import live_probe


class NativeCostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        live_probe()
        cls.tm = importlib.import_module("tiago_mpc")

    def test_serialized_controls_match_actual_constructor_including_zero_weights(self):
        tm = self.tm
        for n in (2, 16, 64):
            for values in (dict(position=2., terminal_position=7., velocity=.123, torque=.002,
                                orientation=1.3, terminal_orientation=8.5),
                           dict.fromkeys(("position", "terminal_position", "velocity", "torque",
                                          "orientation", "terminal_orientation"), 0.)):
                with self.subTest(n=n, values=values):
                    actual = tm.to_dict(tm.default_cost(n, **values))
                    self.assertEqual(serialized_cost(n, values), actual)
                    self.assertEqual(cost_weights(actual), values)
                    # This must include native CostMenu/SolverSettings only.
                    params = native_params(dict(tm.to_dict(tm.TIAGO), N=n, cost_weights=values))
                    self.assertEqual(params.cost, tm.default_cost(n, **values))
                    self.assertNotIn("cost_weights", tm.to_dict(params))
                    self.assertEqual(tm.to_dict(params)["solver"]["type"], "SolverSettings")

    def test_horizon_rebuild_preserves_weights_and_menu_shapes(self):
        tm = self.tm
        params = replace(tm.TIAGO, cost=tm.default_cost(32, orientation=.9, terminal_orientation=4.))
        before = deepcopy(tm.to_dict(params))
        for n in (16, 64):
            changed = with_knot_count(params, n)
            self.assertEqual(changed.N, n)
            self.assertEqual(np.shape(changed.cost.frame_pos.weight), (n, 3))
            self.assertEqual(np.shape(changed.cost.orientation.weight), (n, 3))
            self.assertEqual(cost_weights(tm.to_dict(changed.cost)), cost_weights(before["cost"]))
            self.assertIs(changed.solver, params.solver)
        self.assertEqual(tm.to_dict(params), before)

    def test_custom_menu_preserved_and_never_mistaken_for_scalar_controls(self):
        tm = self.tm
        from gato.cost_menu import Term
        base = deepcopy(tm.TIAGO)
        customs = [replace(base.cost, input=Term(.1, target="gravity"), q_ref=(0.,)*7),
                   replace(base.cost, frame_pos=replace(base.cost.frame_pos, activation="pseudo_huber", eps=.1)),
                   replace(base.cost, state=Term([.1]*14)),
                   replace(base.cost, frame_pos=replace(base.cost.frame_pos, target=(1., 0., 0.)))]
        for cost in customs:
            with self.subTest(cost=cost):
                params = replace(base, cost=cost)
                self.assertIsNone(cost_weights(tm.to_dict(cost)))
                self.assertEqual(tm.to_dict(native_params(tm.to_dict(params))), tm.to_dict(params))
                self.assertIs(with_knot_count(params, params.N), params)
                with self.assertRaisesRegex(ValueError, "cannot replace a custom CostMenu"):
                    native_params(dict(tm.to_dict(params), cost_weights=cost_weights(tm.to_dict(base.cost))))
                with self.assertRaisesRegex(ValueError, "custom CostMenu.*explicit menu"):
                    with_knot_count(params, 16)

    def test_custom_per_knot_fields_are_validated_by_native_gato_before_use(self):
        tm = self.tm
        from gato.cost_menu import Term
        # The shape is deliberately 32 knots while the draft claims 16. Native
        # GATO validates each of these features, including the gravity reference.
        for cost in (
                replace(tm.default_cost(16), input=Term(.1, target="gravity"), q_ref=((0.,)*7,)*32),
                replace(tm.TIAGO.cost, frame_pos=replace(tm.TIAGO.cost.frame_pos, activation="pseudo_huber", eps=.1)),
                replace(tm.TIAGO.cost, frame_pos=Term(1., target=((0.,)*3,)*32)),
                replace(tm.TIAGO.cost, frame_pos=Term(1., activation=("quadratic",)*32))):
            with self.subTest(cost=cost):
                invalid = tm.to_dict(replace(tm.TIAGO, N=16, cost=cost))
                with self.assertRaisesRegex(ValueError, "Invalid native CostMenu for N=16"):
                    native_params(invalid)

    def test_unknown_and_invalid_weights_fail_before_native_configuration(self):
        values = cost_weights(self.tm.to_dict(self.tm.TIAGO.cost))
        for invalid in ({**values, "legacy_q_cost": 4.}, {**values, "position": -1.},
                        {**values, "position": True}, {**values, "torque": float("nan")}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                native_params(dict(self.tm.to_dict(self.tm.TIAGO), cost_weights=invalid))
