"""Package laws run on native state at command ticks, before limit handling."""
import unittest

import numpy as np

import tiago_mpc as tm
from execution_session import DEFAULT_EXECUTION
from native_session import NativeSession
from tests.test_execution import FakeAdapter, TIGHT_EFFORT


class ExecutionLawTests(unittest.TestCase):
    def test_age_limit_uses_the_separate_native_safety_object(self):
        adapter = FakeAdapter()
        adapter.N, adapter.effective_settings = 32, {}
        session = NativeSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0., max_plan_age_s=.003))
        self.addCleanup(session.close)
        records = session.advance_interval(.01)
        self.assertEqual(adapter.effective_settings['safety'],
                         {'type': 'ExecutionSafety', 'max_plan_age_s': .003})
        np.testing.assert_allclose([r['sim_time_s'] for r in records if r['type'] == 'control'], [0., .002])
        self.assertTrue(session.finished)
        self.assertEqual(session.outcome.reason, 'lease_expired')

    def test_custom_law_fault_is_reported_without_sending_a_command(self):
        adapter = FakeAdapter()
        adapter.law = lambda plan, t, state: tm.Fault('custom_law_fault')
        session = NativeSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0.))
        self.addCleanup(session.close)
        records = session.advance_interval(.002)
        self.assertFalse(any(r['type'] == 'control' for r in records))
        self.assertTrue(session.finished)
        self.assertEqual(session.outcome.reason, 'custom_law_fault')

    @unittest.skipUnless(hasattr(tm, 'PlanFeedback'), 'Selected source has no optional PD law')
    def test_pd_uses_current_feedback_between_solves(self):
        adapter = FakeAdapter()
        adapter.law = tm.PlanFeedback(kp=2., kd=.5)
        session = NativeSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0.))
        self.addCleanup(session.close)
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

        def solve(*args, **kwargs):
            plan = original(*args, **kwargs)
            plan['_states'][:, 7:] = np.arange(adapter.N)[:, None]*.2*direction
            return plan

        adapter.solve_snapshot = solve
        adapter.law = tm.FrictionFeedforward(tm.Friction((.5,)*7, (.2,)*7), tm.SampleKnot(), evaluation=tm.Tanh(.01))
        session = NativeSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=.0055))
        self.addCleanup(session.close)
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

        def solve(*args, **kwargs):
            plan = original(*args, **kwargs)
            plan['_states'][:, 7:] = .1
            return plan

        adapter.solve_snapshot = solve
        adapter.law = tm.FrictionFeedforward(tm.Friction((3.,)*7, (0.,)*7), evaluation=tm.Tanh(.01))
        adapter.limit_handling = dict(limits=TIGHT_EFFORT, clip_effort=True,
                                      stop_on_breach=dict(position=True, velocity=True, torque=True))
        session = NativeSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0.))
        self.addCleanup(session.close)
        command = next(r for r in session.advance_interval(.002) if r['type'] == 'control')
        self.assertTrue(np.min(command['requested_torque_nm']) > 3.9)
        np.testing.assert_allclose(command['mpc_torque_nm'], np.ones(7))
        np.testing.assert_allclose(command['torque_nm'], np.full(7, 1.5))

    def test_default_law_reports_native_horizon_expiry_without_a_terminal_torque(self):
        adapter = FakeAdapter()
        adapter.law = tm.SampleKnot()
        settings = dict(DEFAULT_EXECUTION, simulation_hz=100., control_hz=25., to_hz=10., solve_latency_s=0.)
        session = NativeSession(adapter, settings)
        self.addCleanup(session.close)
        records = []
        while not session.finished and session.progress.t < .1:
            records.extend(session.advance_interval(.1))
        commands = [r for r in records if r['type'] == 'control']
        np.testing.assert_allclose([r['torque_nm'] for r in commands], [[1]*7])
        self.assertTrue(session.finished)
        self.assertEqual(session.outcome.reason, 'lease_expired')

    def test_exhausted_law_is_not_called_past_its_valid_horizon(self):
        adapter, calls = FakeAdapter(), []

        def law(plan, t, state):
            calls.append(t)
            command = tm.SampleKnot()(plan, t, state)
            if isinstance(command, tm.Fault):
                return command
            return tm.Command(command.requested+5, command.applied+5)

        adapter.law = law
        settings = dict(DEFAULT_EXECUTION, simulation_hz=100., control_hz=25., to_hz=10., solve_latency_s=0.)
        session = NativeSession(adapter, settings)
        self.addCleanup(session.close)
        records = []
        while not session.finished and session.progress.t < .1:
            records.extend(session.advance_interval(.1))
        commands = [r for r in records if r['type'] == 'control']
        np.testing.assert_allclose([r['torque_nm'] for r in commands], [[6]*7])
        np.testing.assert_allclose(calls, [0.])


if __name__ == '__main__':
    unittest.main()
