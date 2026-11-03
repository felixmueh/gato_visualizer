"""CPU projection checks with the native physical plant and a deterministic fake MPC."""
from copy import deepcopy
from dataclasses import replace
import unittest

import numpy as np

from execution_session import DEFAULT_EXECUTION, validate_execution
from native_session import NativeSession
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

    def task_reference(self, time_s=None):
        return np.zeros((self.N, 6), dtype=np.float32)

    def warmup(self, state, reference):
        pass

    def target_world_at(self, time_s):
        return np.zeros(3)

    def solve_snapshot(self, origin, version, initial=None, reference=None):
        at = self.t if initial is None else initial.t
        measured = self.t if initial is None else getattr(initial, 'measured_t', initial.t)
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
    session = NativeSession(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=latency,
                                             latency_compensation=True))
    # Matching propagation is an explicit test configuration, not a Live invariant.
    session.settings = replace(session.settings, compensation=replace(session.settings.compensation,
        friction=adapter.config.friction, friction_law=adapter.config.friction_law,
        armature=adapter.config.armature, substep=adapter.config.substep))
    records = [session.initial_state()]
    while session.progress.t < end-1e-12:
        before = session.progress.t
        records.extend(session.advance_interval(end))
        if session.progress.t <= before and not session.finished:
            raise AssertionError("projection session did not advance")
        if session.finished:
            break
    session.close()
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

    def test_forecast_past_finite_plan_reports_unavailable_without_final_hold(self):
        import_tiago(MPC_ROOT)
        import tiago_mpc as tm
        adapter = ProjectionAdapter(tm.PlanFeedback(), n=2, dt=.002)
        session, _ = run_projection(adapter, end=.01)
        self.assertTrue(session.finished)
        self.assertEqual(session.outcome.reason, 'lease_expired')
        self.assertFalse(hasattr(session, '_forecast_initial_state'))


if __name__ == "__main__":
    unittest.main()
