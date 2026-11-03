"""CPU projection checks with the native physical plant and a deterministic fake MPC."""
from copy import deepcopy
from dataclasses import replace
import unittest

import numpy as np

from execution_session import DEFAULT_EXECUTION, MultirateSession, validate_execution
from live_mpc import import_tiago
from tests.tiago_mpc_source import MPC_ROOT


class ProjectionAdapter:
    """Real SimPlant physics; solver replies have declared, independently varying costs."""
    def __init__(self, law=None, delays=(.0055,), n=4, dt=.01):
        import_tiago(MPC_ROOT)
        import tiago_mpc as tm
        self.tm, self.law, self.delays = tm, law, delays
        self.N, self.dt = n, dt
        self.x, self.t, self.u = np.r_[tm.Q_START, np.zeros(7)], 0., np.zeros(7)
        self.applied_torque, self.sequence, self.requests = None, 0, []
        self.config = tm.SimConfig(friction=tm.urdf_friction(), friction_law=tm.StickSlip(),
                                   armature=tm.ARMATURE_KG_M2, integrator="euler")
        raw = tm.limits()
        self.limit_handling = dict(limits=dict(lower=raw.lower, upper=raw.upper,
            velocity=raw.velocity, effort=np.full(7, 1.5)), clip_effort=True,
            stop_on_breach=dict(position=False, velocity=False, torque=False))

    def new_plant(self, substep):
        plant = replace(self.config, q=tuple(self.x[:7]), qd=tuple(self.x[7:]), substep=substep).build()
        plant.start(self.tm.VirtualClock(self.t))
        return plant

    def solve_snapshot(self, origin, version, initial=None):
        at = self.t if initial is None else initial.t
        measured = self.t if initial is None else initial.measured_t
        x = self.x.copy() if initial is None else np.r_[initial.q, initial.qd]
        self.requests.append(dict(t=self.t, at=at, measured=measured, x=x.copy()))
        delay = self.delays[min(self.sequence, len(self.delays)-1)]
        self.sequence += 1
        states = np.tile(x, (self.N, 1))
        states[:, :7] += np.arange(self.N)[:, None] * .01
        states[:, 7:] += .1
        return dict(type="plan", origin=origin, sim_time_s=self.t, plan_origin_time_s=at,
                    measured_time_s=measured, seq=self.sequence, N=self.N, dt_s=self.dt,
                    _states=states, _torques=np.full((self.N-1, 7), 18.),
                    stats=dict(step_wall_s=delay, solve_time_ms=delay*1000))

    def state_snapshot(self, version=0):
        return dict(type="state", sim_time_s=self.t, q=self.x[:7].tolist(), qd=self.x[7:].tolist())


def run_projection(adapter, *, latency=.0055, end=.06):
    session = MultirateSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=latency,
                                             latency_compensation=True))
    records = [session.initial_state()]
    while adapter.t < end-1e-12:
        before = adapter.t
        records.extend(session.advance_interval(end))
        if adapter.t <= before:
            raise AssertionError("projection session did not advance")
    return session, records


class LatencyCompensationTests(unittest.TestCase):
    def test_missing_toggle_defaults_off_and_non_boolean_values_are_rejected(self):
        old = dict(DEFAULT_EXECUTION)
        del old["latency_compensation"]
        self.assertIs(validate_execution(old)["latency_compensation"], False)
        for value in (0, 1, None, "true"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "latency_compensation"):
                validate_execution(dict(DEFAULT_EXECUTION, latency_compensation=value))

    def test_future_initial_condition_matches_clipped_physical_execution_for_all_four_laws(self):
        import_tiago(MPC_ROOT)
        import tiago_mpc as tm
        pd = tm.PlanFeedback(kp=tm.PD_KP, kd=tm.PD_KD)
        friction = tm.urdf_friction()
        laws = (tm.SampleKnot(), pd, tm.FrictionFeedforward(friction, evaluation=tm.Tanh(.01)),
                tm.FrictionFeedforward(friction, evaluation=tm.Tanh(.01), base_law=pd))
        for law in laws:
            with self.subTest(law=type(law).__name__):
                adapter = ProjectionAdapter(law)
                session, records = run_projection(adapter)
                states = {round(r["sim_time_s"], 9): np.r_[r["q"], r["qd"]]
                          for r in records if r["type"] == "state"}
                for request in adapter.requests:
                    key = round(request["at"], 9)
                    if key in states:
                        np.testing.assert_allclose(request["x"], states[key], rtol=1e-9, atol=1e-10)
                    self.assertEqual(request["measured"], request["t"])
                commands = [r for r in records if r["type"] == "control"]
                self.assertTrue(commands)
                self.assertTrue(all(np.max(np.abs(r["torque_nm"])) <= 1.5 for r in commands))
                self.assertGreater(session.pending_clipped + sum(r.get("clipped_commands", 0)
                                   for r in records if r["type"] == "interval"), 0)
                times = [r["sim_time_s"] for r in records if "sim_time_s" in r]
                self.assertEqual(times, sorted(times))

    def test_measured_forecast_uses_only_previous_solve_and_early_reply_waits_for_origin(self):
        adapter = ProjectionAdapter(delays=(.015, .003, .012))
        _, records = run_projection(adapter, latency="measured", end=.04)
        first, second = adapter.requests[:2]
        self.assertAlmostEqual(first["at"], .006)  # native 5 ms bootstrap on 2 ms ticks
        self.assertAlmostEqual(second["t"], .016)  # first solve arrived late
        self.assertAlmostEqual(second["at"], .032)  # previous 15 ms; not current 3 ms
        plans = [r for r in records if r["type"] == "plan"]
        self.assertAlmostEqual(plans[0]["scheduled_activation_time_s"], .016)
        self.assertAlmostEqual(plans[1]["available_time_s"], .019)
        self.assertAlmostEqual(plans[1]["scheduled_activation_time_s"], .032)
        applied = [r for r in records if r["type"] == "control" and r["plan_seq"] == 2]
        self.assertTrue(applied)
        self.assertAlmostEqual(applied[0]["sim_time_s"], .032)
        self.assertAlmostEqual(applied[0]["plan_elapsed_s"], 0.)

    def test_expired_plan_forecast_holds_total_command_without_mutating_real_hold_or_plant(self):
        import_tiago(MPC_ROOT)
        import tiago_mpc as tm
        adapter = ProjectionAdapter(tm.PlanFeedback(), n=2, dt=.002)
        session, _ = run_projection(adapter, end=.01)
        self.assertTrue(session.horizon_exhausted)
        before = (adapter.x.copy(), session.plant.q.copy(), session.plant.qd.copy(),
                  session.law_command.copy(), session.law_sample_time, deepcopy(session.watch.armed))
        predicted = session._forecast_initial_state()
        reference = adapter.new_plant(.001)
        reference.apply(adapter.u.copy())
        reference.advance(predicted.t)
        np.testing.assert_allclose(np.r_[predicted.q, predicted.qd], np.r_[reference.q, reference.qd])
        for old, current in zip(before[:4], (adapter.x, session.plant.q, session.plant.qd, session.law_command)):
            np.testing.assert_array_equal(old, current)
        self.assertEqual(before[4], session.law_sample_time)
        for key, value in before[5].items():
            np.testing.assert_array_equal(value, session.watch.armed[key])


if __name__ == "__main__":
    unittest.main()
