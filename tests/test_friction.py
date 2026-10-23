"""CPU checks of the independent plant and predictor friction."""
from copy import deepcopy
import unittest

import numpy as np

from execution_session import DEFAULT_EXECUTION, MultirateSession
from live_mpc import REACH_DEFAULT_TASK
from solver_adapter import SimulatorAdapter
from tests.tiago_mpc_source import MPC_ROOT, live_probe


class FrictionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        live_probe()
        cls.adapter = SimulatorAdapter(MPC_ROOT)

    def test_the_session_steps_tiago_mpc_sim_plant_with_each_integrator_and_coulomb_law(self):
        from tiago_mpc.sim import SimPlant
        adapter, tiago = self.adapter, self.adapter.tiago
        # Compare the session's command-tick stepping with the upstream plant
        # advancing the same held command directly, for every plant option.
        for integrator, friction, law in (("rk4", None, "constraint"), ("euler", None, "constraint"),
                                          ("euler", tiago.urdf_friction(.03), "tanh"),
                                          ("euler", tiago.urdf_friction(), "sign"),
                                          ("euler", tiago.urdf_friction(), "constraint")):
            with self.subTest(integrator=integrator, law=friction and law):
                adapter.reset_state()
                adapter.x[7:] = np.linspace(-.2, .2, 7)
                adapter.plant_options = dict(integrator=integrator, friction=friction, coulomb_law=law)
                adapter.configure_task(3, .02, deepcopy(REACH_DEFAULT_TASK))
                torques = np.arange(14.).reshape(2, 7)/10
                adapter.solve_snapshot = lambda origin, version: dict(
                    type="plan", seq=1, N=3, dt_s=.02, _states=np.zeros((3, 14)), _torques=torques, stats=dict(solve_time_ms=1.))
                adapter.state_record = lambda version=0: dict(type="state")
                reference = SimPlant(adapter.x[:7], adapter.x[7:], substep=.001, **adapter.plant_options)
                reference.start()
                reference.apply(torques[0])
                session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, simulation_hz=1000.))
                states = [r for r in session.advance_interval(.01) if r["type"] == "state"]
                self.assertEqual(len(states), 5)  # at the 500 Hz command ticks
                self.assertEqual(session.steps, 10)
                reference.advance(.01)
                expected = reference.state()
                self.assertEqual((reference.settings["integrator"], reference.settings["coulomb_law"]),
                                 (integrator, friction and law))
                np.testing.assert_allclose(adapter.x, np.r_[expected.q, expected.qd], rtol=0, atol=1e-12)
                self.assertAlmostEqual(adapter.t, .01)
                del adapter.solve_snapshot, adapter.state_record

    def test_plant_friction_uses_the_urdf_coefficients_and_predictor_friction_a_fixed_tanh_width(self):
        tiago, probe = self.adapter.tiago, live_probe()
        plant = tiago.urdf_friction()
        self.assertEqual(probe["friction"]["coulomb_nm"], list(plant.coulomb_nm))
        self.assertEqual(probe["friction"]["viscous_nm_s_per_rad"], list(plant.viscous_nm_s_per_rad))
        self.assertEqual(probe["friction"]["width_rad_s"], .03)
        self.assertIsNone(probe["defaults"]["friction"])

    def test_inspection_capability_uses_captured_predictor_variant(self):
        from solve_inspections import InspectionService
        service = InspectionService.__new__(InspectionService)
        checked = dict(compatible=True, available_N=[32], available_N_by_friction=dict(off=[32], on=[]),
                       capabilities=dict(iteration_capture_by_friction=dict(off={'32': True}, on={})))
        service._profile_capabilities = lambda profile: checked
        problem = dict(problem_configuration=dict(N=32, friction=live_probe()["friction"]), original_solver_profile={})
        with self.assertRaisesRegex(ValueError, 'prebuilt'):
            service._checked(dict(profile={}), problem)
        checked['available_N_by_friction']['on'] = [32]
        with self.assertRaisesRegex(ValueError, 'iteration capture'):
            service._checked(dict(profile={}), problem)
        checked['capabilities']['iteration_capture_by_friction']['on']['32'] = True
        self.assertIs(service._checked(dict(profile={}), problem), checked)


if __name__ == '__main__':
    unittest.main()
