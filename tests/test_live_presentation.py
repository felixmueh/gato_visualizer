"""CPU-only state rendering checks; no solver, model load or native worker."""
import math
import unittest
from types import SimpleNamespace

import numpy as np

from live_presentation import render_state, snapshot


class StateDistanceTests(unittest.TestCase):
    def render(self, position, target, *, tolerance=.125, speed=.5, kind="reach", frozen=False):
        state = dict(type="state", sim_time_s=1.25, settings_version=3,
                     _x=np.r_[np.arange(7, dtype=float), speed, np.zeros(6)],
                     target_xyz=list(target), torque_nm=list(range(7)))
        # The arrival rule and task come from the segment header, not the state.
        context = dict(task=dict(kind=kind), position_tol_m=tolerance, speed_l1_tol_rad_s=.5)
        captured = snapshot(state) if frozen else state
        kinematics = SimpleNamespace(ee_positions=lambda q: np.array([position], dtype=float))
        rendered = render_state(captured, kinematics, context)
        self.assertIn("_x", captured)
        self.assertEqual(rendered["q"], list(range(7)))
        self.assertEqual(rendered["qd"], [speed] + [0.]*6)
        self.assertEqual(rendered["torque_nm"], list(range(7)))
        self.assertNotIn("task_kind", rendered)
        self.assertEqual(rendered["sim_time_s"], 1.25)
        self.assertEqual(rendered["settings_version"], 3)
        self.assertEqual(rendered["target_xyz"], list(target))
        self.assertEqual(rendered["ee_xyz"], list(position))
        self.assertNotIn("_x", rendered)
        return rendered

    def test_distances_match_numpy_for_finite_world_coordinates(self):
        rng = np.random.default_rng(42)
        for frozen in (False, True):
            for position, target in rng.uniform(-3., 3., (64, 2, 3)):
                rendered = self.render(position, target, frozen=frozen)
                expected = float(np.linalg.norm(position-target))
                self.assertTrue(math.isclose(rendered["distance_m"], expected, rel_tol=1e-12, abs_tol=1e-12))
                self.assertIsInstance(rendered["distance_m"], float)

    def test_inclusive_position_and_speed_arrival_boundaries_are_preserved(self):
        for frozen in (False, True):
            for distance, speed, kind, arrived in [
                (0., 0., "reach", True),
                (.125, .5, "reach", True),
                (math.nextafter(.125, 0.), .5, "reach", True),
                (math.nextafter(.125, math.inf), .5, "reach", False),
                (.125, math.nextafter(.5, math.inf), "reach", False),
                (.125, .5, "figure8", False),
            ]:
                with self.subTest(distance=distance, speed=speed, kind=kind, frozen=frozen):
                    rendered = self.render([distance, 0., 0.], [0., 0., 0.], speed=speed, kind=kind, frozen=frozen)
                    self.assertEqual(rendered["distance_m"], distance)
                    self.assertIs(rendered["arrived"], arrived)
