"""CPU checks of the independent plant and predictor friction."""
from copy import deepcopy
from contextlib import ExitStack
import unittest
from unittest.mock import patch

import numpy as np

from execution_session import DEFAULT_EXECUTION
from native_session import NativeSession
from live_mpc import REACH_DEFAULT_TASK
from solver_adapter import SimulatorAdapter
from tests.tiago_mpc_source import MPC_ROOT, live_probe


class FrictionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        live_probe()
        cls.adapter = SimulatorAdapter(MPC_ROOT)

    def test_the_session_steps_tiago_mpc_sim_plant_with_each_integrator_and_coulomb_law(self):
        from tiago_mpc.clock import VirtualClock
        from tiago_mpc.dynamics import Tanh, Sign, StickSlip
        from tiago_mpc.laws import SampleKnot
        adapter, tiago = self.adapter, self.adapter.tiago
        # Compare the session's command-tick stepping with the upstream plant
        # advancing the same held command directly, for every plant option.
        for integrator, friction, law in (("rk4", None, "constraint"), ("euler", None, "constraint"),
                                          ("euler", tiago.urdf_friction(), "tanh"),
                                          ("euler", tiago.urdf_friction(), "sign"),
                                          ("euler", tiago.urdf_friction(), "stick_slip")):
            with self.subTest(integrator=integrator, law=friction and law), ExitStack() as cleanup:
                cleanup.enter_context(patch.dict(adapter.source_settings["simulation"], law="plan"))
                adapter.reset_state()
                adapter.x[7:] = np.linspace(-.2, .2, 7)
                evaluation = Tanh(.03) if law == 'tanh' else Sign() if law == 'sign' else StickSlip()
                adapter.plant_options = dict(integrator=integrator, friction=friction, friction_law=evaluation)
                adapter.configure_task(3, .02, deepcopy(REACH_DEFAULT_TASK))
                torques = np.arange(14.).reshape(2, 7)/10
                cleanup.enter_context(patch.object(adapter, "solve_snapshot", lambda origin, version,
                    initial=None, reference=None: dict(
                        type="plan", seq=1, N=3, dt_s=.02, sim_time_s=adapter.t if initial is None else initial.t,
                        _states=np.zeros((3, 14)), _torques=torques, stats=dict(solve_time_ms=1.,step_wall_s=0.))))
                cleanup.enter_context(patch.object(adapter, "warmup", lambda state, reference: None))
                cleanup.enter_context(patch.object(adapter, "state_record", lambda version=0: dict(type="state")))
                session = NativeSession(adapter, dict(DEFAULT_EXECUTION, simulation_hz=1000., solve_latency_s=0.))
                cleanup.callback(session.close)
                self.assertEqual(session.law, SampleKnot())
                # The provider may add inertia/change coefficients. Compare the
                # scheduler with the exact native configuration it built.
                reference = session.plant.config.build()
                cleanup.callback(reference.close)
                reference.start(VirtualClock())
                reference.apply(torques[0])
                states = [r for r in session.advance_interval(.01) if r["type"] == "state"]
                self.assertEqual(len(states), 5)  # at the 500 Hz command ticks
                self.assertEqual(session.steps, 10)
                reference.advance(.01)
                expected = reference.state()
                self.assertEqual(reference.config.integrator, integrator)
                self.assertEqual(reference.config.friction_law, evaluation)
                np.testing.assert_allclose(adapter.x, np.r_[expected.q, expected.qd], rtol=0, atol=1e-12)
                self.assertAlmostEqual(adapter.t, .01)

    def test_plant_friction_uses_the_urdf_coefficients_and_predictor_friction_a_fixed_tanh_width(self):
        tiago, probe = self.adapter.tiago, live_probe()
        plant = tiago.urdf_friction()
        self.assertEqual(probe["friction"]["coulomb_nm"], list(plant.coulomb_nm))
        self.assertEqual(probe["friction"]["viscous_nm_s_per_rad"], list(plant.viscous_nm_s_per_rad))
        self.assertEqual(probe["friction"]["type"], "Friction")
        self.assertNotIn('law', probe['friction'])
        from tiago_mpc import TIAGO, to_dict
        self.assertEqual(probe['defaults']['friction_law'], to_dict(TIAGO.friction_law))
        self.assertEqual(probe['defaults']['friction_law']['type'], 'Tanh')
        self.assertIsNone(probe["defaults"]["friction"])

    def test_inspection_capability_uses_captured_predictor_variant(self):
        from solve_inspections import InspectionService
        service = InspectionService.__new__(InspectionService)
        checked = dict(compatible=True, available_N=[32], available_N_by_friction=dict(off=[32], on=[]),
                       capabilities=dict(iteration_capture_by_friction=dict(off={'32': True}, on={})))
        service._profile_capabilities = lambda profile, params=None: checked
        problem = dict(problem_configuration=dict(N=32, friction=live_probe()["friction"]), original_solver_profile={})
        with self.assertRaisesRegex(ValueError, 'prebuilt'):
            service._checked(dict(profile={}), problem)
        checked['available_N_by_friction']['on'] = [32]
        # Capped solves need the captured predictor module, not native trace capture.
        self.assertIs(service._checked(dict(profile={}), problem), checked)

    def test_old_embedded_friction_metadata_cannot_be_guessed_for_run_again(self):
        from solve_inspections import InspectionService
        service = InspectionService.__new__(InspectionService)
        problem = dict(problem_configuration=dict(N=32, friction=dict(law=dict(type="Tanh", width_rad_s=.03))))
        with self.assertRaisesRegex(ValueError, "older embedded friction-law format.*motion remains viewable"):
            service._checked(dict(profile={}), problem)


if __name__ == '__main__':
    unittest.main()
