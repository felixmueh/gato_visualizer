"""Package laws run on native state at command ticks, before limit handling."""
import unittest

import numpy as np

import tiago_mpc as tm
from execution_session import DEFAULT_EXECUTION, MultirateSession
from tests.test_execution import FakeAdapter, TIGHT_EFFORT


class ExecutionLawTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(tm, 'PlanFeedback'), 'Selected source has no optional PD law')
    def test_pd_uses_current_feedback_between_solves(self):
        adapter = FakeAdapter()
        adapter.law = tm.PlanFeedback(kp=2., kd=.5)
        session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0.))
        commands = [r for r in session.advance_interval(.006) if r['type'] == 'control']
        np.testing.assert_allclose(commands[0]['torque_nm'], np.ones(7))
        # Toy plant: after2ms of u=1, q=v=.002; planned q/v remain0.
        np.testing.assert_allclose(commands[1]['requested_torque_nm'], np.ones(7)*.995)
        np.testing.assert_allclose(commands[1]['mpc_torque_nm'], np.ones(7))

    @unittest.skipUnless(hasattr(tm, 'FrictionFeedforward'), 'Selected source has no optional FF law')
    def test_feedforward_samples_delayed_plan_velocity_in_native_coordinates(self):
        adapter = FakeAdapter()
        original = adapter.solve_snapshot
        direction = np.array([1, 1, 1, 1, 1, -1, 1])

        def solve(*args):
            plan = original(*args)
            plan['_states'][:, 7:] = np.arange(adapter.N)[:, None]*.2*direction
            return plan

        adapter.solve_snapshot = solve
        adapter.law = tm.FrictionFeedforward(tm.Friction((.5,)*7, (.2,)*7), evaluation=tm.Tanh(.01))
        session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=.0055))
        records = session.advance_interval(.01)
        first = next(r for r in records if r['type'] == 'control')
        self.assertAlmostEqual(first['sim_time_s'], .006)
        self.assertAlmostEqual(first['law_sample_time_s'], .006)
        # v_plan=.06 at6ms; measured startup velocity is0.
        expected = np.ones(7)+.5*np.tanh(.06*direction/.01)+.2*.06*direction
        np.testing.assert_allclose(first['torque_nm'], expected)

    @unittest.skipUnless(hasattr(tm, 'FrictionFeedforward'), 'Selected source has no optional FF law')
    def test_limits_apply_to_total_law_command(self):
        adapter = FakeAdapter()
        original = adapter.solve_snapshot

        def solve(*args):
            plan = original(*args)
            plan['_states'][:, 7:] = .1
            return plan

        adapter.solve_snapshot = solve
        adapter.law = tm.FrictionFeedforward(tm.Friction((3.,)*7, (0.,)*7), evaluation=tm.Tanh(.01))
        adapter.limit_handling = dict(limits=TIGHT_EFFORT, clip_effort=True,
                                      stop_on_breach=dict(position=True, velocity=True, torque=True))
        session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0.))
        command = next(r for r in session.advance_interval(.002) if r['type'] == 'control')
        self.assertTrue(np.min(command['requested_torque_nm']) > 3.9)
        np.testing.assert_allclose(command['mpc_torque_nm'], np.ones(7))
        np.testing.assert_allclose(command['torque_nm'], np.full(7, 1.5))

    def test_default_law_preserves_final_knot_hold_when_command_grid_skips_it(self):
        adapter = FakeAdapter()
        adapter.law = tm.SampleKnot()
        settings = dict(DEFAULT_EXECUTION, simulation_hz=100., control_hz=25., to_hz=10., solve_latency_s=0.)
        session = MultirateSession(adapter, settings)
        commands = [r for r in session.advance_interval(.1) if r['type'] == 'control']
        np.testing.assert_allclose([r['torque_nm'] for r in commands], [[1]*7, [2]*7, [2]*7])
        self.assertEqual([r['plan_exhausted'] for r in commands], [False, True, True])

    def test_exhausted_law_holds_final_valid_total_without_extrapolation(self):
        adapter, calls = FakeAdapter(), []

        def law(plan, t, state):
            calls.append(t)
            return tm.SampleKnot()(plan, t, state)+5

        adapter.law = law
        settings = dict(DEFAULT_EXECUTION, simulation_hz=100., control_hz=25., to_hz=10., solve_latency_s=0.)
        session = MultirateSession(adapter, settings)
        commands = [r for r in session.advance_interval(.1) if r['type'] == 'control']
        np.testing.assert_allclose([r['torque_nm'] for r in commands], [[6]*7, [7]*7, [7]*7])
        np.testing.assert_allclose(calls, [0., .02])


if __name__ == '__main__':
    unittest.main()
