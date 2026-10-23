"""CPU checks of the independent simulator and predictor friction."""
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

    def test_the_session_steps_tiago_mpc_sim_plant_with_either_law(self):
        from gato.common import rk4
        from tiago_mpc.dynamics import plant_rk4
        adapter, tiago = self.adapter, self.adapter.tiago
        model = adapter.new_plant(.001).model
        # Hard-sign RK4 with the URDF damping diverges at 1 ms (docs/friction.md): 0.1 ms there.
        for friction, rate in ((None, 1000.), (tiago.urdf_friction(), 10000.)):
            with self.subTest(friction=friction):
                adapter.reset_state()
                adapter.x[7:] = np.linspace(-.2, .2, 7)
                adapter.plant_friction = friction
                adapter.configure_task(3, .02, deepcopy(REACH_DEFAULT_TASK))
                torques = np.arange(14.).reshape(2, 7)/10
                adapter.solve_snapshot = lambda origin, version: dict(
                    type="plan", seq=1, N=3, dt_s=.02, _states=np.zeros((3, 14)), _torques=torques, stats=dict(solve_time_ms=1.))
                adapter.state_record = lambda version=0: dict(type="state")
                q, qd = adapter.x[:7].copy(), adapter.x[7:].copy()
                session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, simulation_hz=rate))
                states = [r for r in session.advance_interval(.01) if r["type"] == "state"]
                steps = round(.01*rate)
                self.assertEqual(len(states), 5)  # at the 500 Hz command ticks
                self.assertEqual(session.steps, steps)
                for _ in range(steps):
                    q, qd = (rk4(model, model.createData(), q, qd, torques[0], 1/rate) if friction is None else
                             plant_rk4(model, model.createData(), q, qd, torques[0], 1/rate, friction))
                np.testing.assert_allclose(adapter.x, np.r_[q, qd], rtol=0, atol=1e-12)
                self.assertAlmostEqual(adapter.t, .01)
                del adapter.solve_snapshot, adapter.state_record

    def test_simulator_friction_is_the_urdf_hard_sign_law_and_predictor_friction_a_tanh_variant(self):
        tiago, probe = self.adapter.tiago, live_probe()
        plant = tiago.urdf_friction()
        self.assertIsNone(plant.width_rad_s)
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
