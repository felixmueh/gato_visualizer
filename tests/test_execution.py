"""CPU evidence for the production multirate and spawned-process paths."""
from copy import deepcopy
import tempfile
import threading
import time
import unittest
from urllib.request import Request, urlopen

import numpy as np

from execution_bridge import ProcessLiveService
from history_store import HistoryStore, HistoryGenerationError
from execution_session import DEFAULT_EXECUTION, breach_message, interval_record, validate_execution
from native_session import NativeSession
from execution_worker import estimated_states, worker_main
from server import make_server
from tests.tiago_mpc_source import MPC_ROOT, live_probe, start_pose
LOCK_HELD = False


class FakeClock:
    def __init__(self): self.value=0.
    def __call__(self): return self.value


class FakeLocks:
    def __init__(self, root):
        self.handles = []
    def acquire(self):
        global LOCK_HELD
        LOCK_HELD = True
        self.handles = [True]
        return True
    def release(self):
        global LOCK_HELD
        LOCK_HELD = False
        self.handles = []


def float32_finite(x):
    """GATO stages states as float32; a finite float64 state may overflow."""
    with np.errstate(over='ignore'):
        return bool(np.isfinite(np.asarray(x, dtype=np.float32)).all())


class FakeController:
    fresh = True
    def reset(self, x):
        if not LOCK_HELD:
            raise AssertionError('Controller reset outside lock')
        if not float32_finite(x):
            raise ValueError('reset x0 must be finite')
        self.fresh = True


class FakePlant:
    """Native plant protocol with an Euler-like toy integrator."""
    def __init__(self, adapter, substep):
        self.adapter, self.q, self.qd, self.t = adapter, adapter.x[:7].copy(), adapter.x[7:].copy(), adapter.t
        self.command = None
        self.substep = substep
        self.run_state = {}
        self.step_callback = None
        self.events = []
    def start(self, clock):
        self.native_clock = clock
        self.t = clock.now()
    def state(self):
        from tiago_mpc.interfaces import State
        return State(self.t, self.q.copy(), self.qd.copy())
    def apply(self, command):
        self.command = np.array(command, dtype=float)
    def advance(self, t):
        while self.command is not None and self.t < t-1e-12:
            if self.adapter.clock:
                self.adapter.clock.value += .0001
            h = min(self.substep,t-self.t)
            if getattr(self.adapter, 'blow_up', False):
                # Unstable plant: finite in float64, beyond the solver's float32.
                self.q, self.qd = np.full(7, 1e300), np.full(7, 1e300)
            else:
                self.q, self.qd = self.q+self.command*h, self.qd+self.command*h
            self.t += h
            if self.step_callback is not None:
                self.events.extend(self.step_callback(self.state()))
        self.t = t
        self.native_clock.reach(t)
    def take_events(self):
        events, self.events = self.events, []
        return events
    def stop(self):
        self.command = np.zeros(7)
    def close(self):
        pass


# Raw limits that never bind, and a tight 1.5 Nm effort limit (max_sqp_iters 6000).
WIDE_LIMITS = dict(lower=np.full(7, -np.inf), upper=np.full(7, np.inf),
                   velocity=np.full(7, np.inf), effort=np.full(7, 1e9))
TIGHT_EFFORT = dict(WIDE_LIMITS, effort=np.full(7, 1.5))


class FakeAdapter:
    def __init__(self, root=None):
        self.x = np.zeros(14)
        self.t = 0.
        self.dt = .02
        self.N = 3
        self.sequence = 0
        self.applied_torque = None
        self.u = np.zeros(7)
        self.controller = FakeController()
        self.delay = 0
        self.fail = False
        self.clock = None
        self.warmups = []
        self.configurations = 0
    def configure(self, config, task):
        if not LOCK_HELD:
            raise AssertionError('Configure outside lock')
        self.configurations += 1
        self.controller = FakeController()
        self.dt, self.N = config['dt_s'], config['N']
        self.delay = .25 if config['solver']['max_sqp_iters'] == 9000 else 0
        self.fail = config['solver']['max_sqp_iters'] == 8000
        self.blow_up = config['solver']['max_sqp_iters'] == 7000
        self.limit_handling = dict(limits=TIGHT_EFFORT if config['solver']['max_sqp_iters'] == 6000 else WIDE_LIMITS,
                                   clip_effort=config['plant']['clip_effort'],
                                   stop_on_breach=config['plant']['stop_on_breach'])
        self.task = task
        self.controller.reset(self.x)
    def reset_state(self, start_pose=None):
        if start_pose is not None:
            self.start_pose = np.asarray(start_pose, dtype=float)
        self.x[:] = 0
        self.x[:7] = getattr(self, 'start_pose', 0)
        self.t = 0
        self.sequence = 0
        self.applied_torque = None
    def new_plant(self, substep):
        return FakePlant(self, substep)
    def task_reference(self, time_s=None):
        return np.zeros((self.N,6))
    def target_world_at(self, time_s):
        return np.zeros(3)
    def warmup(self, state, reference):
        # No GPU object here. Worker configure/reset still exercise the strict
        # FakeController lock assertion; direct numerical tests need no lease.
        self.warmups.append(state.t)
        self.controller.fresh = True
    def solve_snapshot(self, origin, version, initial=None, reference=None):
        if self.fail:
            raise RuntimeError('intentional test solve failure')
        if not float32_finite(self.x):
            raise FloatingPointError('Nonfinite torque or predicted trajectory')
        if self.delay:
            # CPU/GIL activity in this process cannot hold the HTTP GIL.
            stop = time.perf_counter()+self.delay
            while time.perf_counter() < stop:
                sum(range(500))
        if self.clock:
            self.clock.value += .03
        if origin == 'preview':
            self.controller.reset(self.x)
        was_fresh = self.controller.fresh
        self.controller.fresh = False
        self.sequence += 1
        state = self.x if initial is None else np.r_[initial.q, initial.qd]
        at = self.t if initial is None else initial.t
        measured = self.t if initial is None else getattr(initial, 'measured_t', initial.t)
        return dict(type='plan', _states=np.tile(state, (self.N, 1)),
                    _torques=np.arange(1., self.N)[:, None]*np.ones(7),
                    _reference=np.zeros((self.N, 6)) if reference is None else np.array(reference), N=self.N, dt_s=self.dt,
                    sim_time_s=self.t, seq=self.sequence, origin=origin,
                    plan_origin_time_s=at, measured_time_s=measured,
                    initial_state=dict(q=state[:7].tolist(), qd=state[7:].tolist(), time_s=at,
                                       measured_time_s=measured),
                    settings_version=version, target_xyz=[0,0,0],
                    stats=dict(solve_time_ms=2., step_wall_s=getattr(self, 'plan_wall_s', 0.),
                               sqp_iters=1, controller_restarted=was_fresh,
                               controller_epoch=self.configurations))
    def segment_header(self, version, execution):
        return dict(type='segment', sim_time_s=self.t, settings_version=version,
                    context=dict(task=self.task, end_effector_frame='arm_right_tool_joint',
                                 position_tol_m=.01, speed_l1_tol_rad_s=.1,
                                 settings=dict(execution=execution)))
    def state_snapshot(self, settings_version=0):
        return dict(type='state', sim_time_s=self.t, _x=self.x.copy(),
                    q=self.x[:7].tolist(), qd=self.x[7:].tolist(),
                    torque_nm=None if self.applied_torque is None else self.applied_torque.tolist(),
                    settings_version=settings_version, target_xyz=[0,0,0])


def fake_schema(root):
    from live_mpc import build_schema
    probe = live_probe()
    # FakeAdapter models only the protocol and toy plant below. Its synthetic
    # N16 catalog cannot stand in for native armature/provider availability.
    probe['defaults'].pop('armature', None)
    probe['source_settings'] = {role: dict(defaults={}, parameters=[], controls=[], module=None)
                                for role in ('simulation', 'predictor')}
    probe['effective_settings'] = {}
    probe['available_N_by_friction'] = dict(off=[16], on=[])
    schema = build_schema(probe, root or MPC_ROOT, start_pose())
    schema['defaults']['config']['N'] = 16
    return schema


def fake_worker(*args):
    import live_mpc
    live_mpc.GPULocks = FakeLocks
    worker_main(*args)


class FakeRenderer:
    def __init__(self, root):
        pass
    def __call__(self, frame, context=None):
        from live_presentation import mutable
        plan, state, events = frame
        result=[]
        if plan:
            event=mutable(plan)
            for key in ('_states','_torques','_reference'):
                event.pop(key,None)
            result.append(event)
        if state:
            event=mutable(state)
            event.pop('_x',None)
            event['ee_xyz']=[0,0,0]
            result.append(event)
        result.extend(events)
        return result


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        global LOCK_HELD
        LOCK_HELD = True
    def session(self, adapter, execution, **kwargs):
        session = NativeSession(adapter, execution, **kwargs)
        self.addCleanup(session.close)
        return session
    def test_native_horizon_expiry_stops_without_an_implicit_final_hold(self):
        adapter=FakeAdapter()
        session=self.session(adapter,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.))
        records=self.run_until(session,.1)
        controls=[r for r in records if r['type']=='control']
        self.assertEqual([round(r['sim_time_s'],9) for r in controls],[0.])
        np.testing.assert_allclose(controls[0]['torque_nm'],np.ones(7))
        self.assertAlmostEqual(adapter.t,.04)
        np.testing.assert_allclose(adapter.x[:7],np.ones(7)*.04)
        self.assertTrue(session.finished)
        self.assertEqual(session.outcome.reason,'lease_expired')

    def test_reporting_boundaries_round_to_the_native_command_grid(self):
        adapter=FakeAdapter();adapter.N=16
        session=self.session(adapter,dict(DEFAULT_EXECUTION,simulation_hz=70.,control_hz=23.,to_hz=11.))
        records=[]
        for endpoint in (.035,.07,.15,.231):
            while session.progress.t < endpoint-1e-12 and not session.finished:
                records.extend(session.advance_interval(endpoint))
        times=[r['sim_time_s'] for r in records if r['type']=='state']
        for tick in range(1,7):
            self.assertTrue(any(abs(t-tick/23)<1e-12 for t in times))
        self.assertAlmostEqual(adapter.t,6/23)
        self.assertEqual(session.solves,3)
        self.assertFalse(session.finished)

    def test_replan_between_control_ticks_cannot_change_held_torque(self):
        a=FakeAdapter();a.N=16
        original=a.solve_snapshot
        def production_like_solve(origin, version, **kwargs):
            plan=original(origin,version,**kwargs)
            # Make each newly optimized control observably different.
            plan['_torques'][:] = a.sequence*10
            return plan
        a.solve_snapshot=production_like_solve
        session=self.session(a,dict(DEFAULT_EXECUTION,simulation_hz=1000.,control_hz=23.,to_hz=11.))
        records=[]
        while session.progress.t < .12-1e-12:
            records.extend(session.advance_interval(.12))
        # The .090909 TO slot waits for the .130435 command tick.
        after=[r for r in records if r['type']=='state' and r['sim_time_s']>1/11+1e-12]
        self.assertTrue(after)
        self.assertTrue(all(r['torque_nm']==[10.]*7 for r in after))
    def test_reporting_chunks_accumulate_one_to_interval(self):
        adapter=FakeAdapter();adapter.N=64
        session=self.session(adapter,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=10.,to_hz=1.))
        records=[]
        for endpoint in (.1,.2,.3):
            records.extend(session.advance_interval(endpoint,emit_partial=False))
        self.assertFalse(any(r['type']=='interval' for r in records))
        records.extend(session.advance_interval(.35,emit_partial=True))
        intervals=[r for r in records if r['type']=='interval']
        self.assertEqual(len(intervals),1)
        self.assertAlmostEqual(intervals[0]['end_time_s'],.4)
        self.assertEqual(intervals[0]['start_time_s'],0)
        self.assertEqual(intervals[0]['to_budget_s'],1.)

    def run_recorded(self, end, **rates):
        a=FakeAdapter();a.N=16
        session=self.session(a,dict(DEFAULT_EXECUTION,**rates))
        records=[session.initial_state()]
        while session.progress.t < end-1e-12 and not session.finished:
            records.extend(session.advance_interval(min(end,session.chunk_end(.1))))
        return a,session,records
    def test_states_are_recorded_at_every_command_and_control_update(self):
        a,session,records=self.run_recorded(.25,simulation_hz=1000.,control_hz=500.,to_hz=100.)
        kind=lambda k:[r for r in records if r['type']==k]
        ticks=[round(r['sim_time_s']*1000) for r in kind('state')]
        # Every 2 ms command tick (the 10 ms TO ticks are among them) and the end; the
        # physics steps in between are simulated but not recorded.
        self.assertEqual(ticks,list(range(0,251,2)))
        self.assertEqual(session.steps,250)
        self.assertEqual([round(c['sim_time_s']*1000) for c in kind('control')],list(range(0,250,2)))
        self.assertEqual(len(kind('plan')),len(kind('interval')))
        self.assertEqual(len(kind('plan')),25)
        self.assertTrue(all('record_every' not in r for r in records))
        self.assertLessEqual(len(ticks),estimated_states(dict(DEFAULT_EXECUTION,simulation_hz=1000.,control_hz=500.,to_hz=100.),.25))
    def test_noncommensurate_requests_and_recording_follow_command_ticks(self):
        execution=dict(DEFAULT_EXECUTION,simulation_hz=70.,control_hz=23.,to_hz=11.)
        a,session,records=self.run_recorded(.5,**{k:execution[k] for k in ('simulation_hz','control_hz','to_hz')})
        times=[r['sim_time_s'] for r in records if r['type']=='state']
        events=[k/23 for k in range(13)]
        self.assertEqual(len(times),len(events))
        for t,expected in zip(times,events):
            self.assertAlmostEqual(t,expected,places=12)
        self.assertGreater(session.steps,len(times))
        self.assertLessEqual(len(times),estimated_states(execution,.5))
    def test_chunks_end_on_a_command_tick(self):
        a=FakeAdapter()
        a.t=.0123
        session=self.session(a,dict(DEFAULT_EXECUTION,control_hz=500.))
        end=session.chunk_end(.1)
        self.assertGreater(end,.1123-1e-12)
        self.assertAlmostEqual((end-a.t)*500,round((end-a.t)*500),places=9)
    def limited(self, limits, clip_effort=False, **stop_on):
        a=FakeAdapter();a.N=16
        a.limit_handling=dict(limits=dict(WIDE_LIMITS,**limits),clip_effort=clip_effort,
                              stop_on_breach=dict(dict(position=True,velocity=True,torque=True),**stop_on))
        return a
    def run_until(self, session, end):
        records=[]
        while session.progress.t < end-1e-12 and not session.finished:
            batch=session.advance_interval(end)
            records.extend(batch)
            if any(r['type']=='breach' for r in batch):
                break
        return records
    def test_clip_effort_applies_the_clipped_torque_and_records_the_planned_one(self):
        from tiago_mpc.laws import EffortClip, SampleKnot
        from tiago_mpc.record import to_dict
        a=self.limited(dict(effort=np.full(7,1.5)),clip_effort=True)
        a.law, a.effective_settings = SampleKnot(), {}
        session=self.session(a,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.))
        self.assertIs(session.law,a.law)
        self.assertEqual(session.settings.effort_handling,EffortClip(effort=(1.5,)*7))
        self.assertEqual(a.effective_settings['law'],to_dict(a.law))
        self.assertEqual(a.effective_settings['effort_handling'],to_dict(session.settings.effort_handling))
        records=self.run_until(session,.1)
        controls=[r for r in records if r['type']=='control']
        self.assertEqual([r['torque_nm'] for r in controls],[[1.]*7,[1.5]*7,[1.5]*7])
        self.assertNotIn('planned_torque_nm',controls[0])  # within the limit: unchanged, not marked
        self.assertEqual([r['planned_torque_nm'] for r in controls[1:]],[[3.]*7,[5.]*7])
        self.assertEqual([r for r in records if r['type']=='state'][-1]['torque_nm'],[1.5]*7)
        self.assertEqual(sum(r['clipped_commands'] for r in records if r['type']=='interval'),2)
        self.assertFalse(any(r['type']=='breach' for r in records))  # the clipped torque cannot breach
        np.testing.assert_allclose(a.x[:7],np.full(7,.04+.08*1.5))
    def test_torque_breach_stops_at_its_command_and_rearms_within_the_limit(self):
        a=self.limited(dict(effort=np.full(7,1.5)))
        a.effective_settings = {}
        session=self.session(a,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.))
        self.assertIsNone(session.settings.effort_handling)
        self.assertIsNone(a.effective_settings['effort_handling'])
        records=self.run_until(session,.5)
        breach=next(r for r in records if r['type']=='breach')
        self.assertEqual((breach['type'],round(breach['sim_time_s'],9)),('breach',.04))
        self.assertEqual(breach['breaches'][0],dict(joint_index=0,quantity='torque',value=3.,limit=1.5))
        self.assertEqual(len(breach['breaches']),7)
        self.assertEqual(breach['message'],'Limit breach at 0.040 s: joint 1 torque 3 Nm beyond its effort limit 1.5 Nm (+6 more)')
        # Stopped before integrating; the state at the breaching command's tick is recorded.
        self.assertAlmostEqual(a.t,.04)
        self.assertTrue(any(r['type']=='state' and abs(r['sim_time_s']-.04)<1e-12 for r in records))
        self.assertEqual([r['torque_nm'] for r in records if r['type']=='control'][-1],[3.]*7)
        # Continuing holds the command until the next plan at .12 s re-arms
        # effort, so the next second-knot command breaches at .16 s.
        records=self.run_until(session,.5)
        self.assertEqual([round(r['sim_time_s'],9) for r in records if r['type']=='breach'],[.16])
        self.assertAlmostEqual(a.t,.16)
        stopped=self.limited(dict(effort=np.full(7,1.5)),torque=False)
        session=self.session(stopped,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.))
        self.assertFalse(any(r['type']=='breach' for r in self.run_until(session,.3)))
        self.assertAlmostEqual(stopped.t,.32)
    def test_substep_breaches_retain_detection_time_and_deliver_at_command_tick(self):
        adapter=self.limited(dict(velocity=np.full(7,.015)));adapter.N=16
        session=self.session(adapter,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.))
        records=self.run_until(session,.5)
        breach=next(r for r in records if r['type']=='breach')
        self.assertAlmostEqual(breach['sim_time_s'],.02)
        self.assertEqual(breach['breaches'][0]['quantity'],'velocity')
        self.assertAlmostEqual(adapter.t,.04)
        adapter=self.limited(dict(upper=np.full(7,.025)));adapter.N=16
        session=self.session(adapter,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.))
        breach=next(r for r in self.run_until(session,.5) if r['type']=='breach')
        self.assertAlmostEqual(breach['sim_time_s'],.03)
        self.assertEqual((breach['breaches'][0]['quantity'],breach['breaches'][0]['limit']),('position',.025))
        self.assertAlmostEqual(adapter.t,.04)

    def test_breaches_at_one_tick_name_the_largest_excess_first(self):
        from execution_session import LimitWatch
        watch=LimitWatch(dict(WIDE_LIMITS,effort=np.array([43.,43,26,26,26,26,26])),False,
                         dict(position=True,velocity=True,torque=True),np.zeros(14))
        found=watch.torque(np.array([0,0,0,0,-28.28,0,371.7]))
        self.assertEqual([b['joint_index'] for b in found],[6,4])
        self.assertTrue(breach_message(.03,found).startswith('Limit breach at 0.030 s: joint 7 torque 371.7 Nm beyond its effort limit 26 Nm (+1 more)'))
    def test_a_value_beyond_its_limit_at_the_start_does_not_stop(self):
        a=self.limited(dict(upper=np.full(7,-.1)))
        session=self.session(a,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.))
        self.assertFalse(any(r['type']=='breach' for r in self.run_until(session,.3)))
    def test_execution_has_no_recording_setting(self):
        self.assertEqual(DEFAULT_EXECUTION['control_hz'],500.)
        self.assertNotIn('record_every',DEFAULT_EXECUTION)
        self.assertEqual(DEFAULT_EXECUTION['solve_latency_s'],'measured')
        with self.assertRaises(ValueError):
            validate_execution(dict(DEFAULT_EXECUTION,record_every=2))
        self.assertEqual(validate_execution(dict(DEFAULT_EXECUTION,to_hz=0))['to_hz'],0)
        for latency in (-1, True, None, float('nan'), float('inf'), 'ideal'):
            with self.subTest(latency=latency), self.assertRaises(ValueError):
                validate_execution(dict(DEFAULT_EXECUTION,solve_latency_s=latency))

    def test_delayed_activation_uses_native_wall_and_original_plan_age(self):
        a=FakeAdapter(); a.N=16; a.clock=FakeClock(); a.plan_wall_s=.025
        session=self.session(a,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=50.,to_hz=25.),clock=a.clock)
        records=self.run_until(session,.08)
        controls=[r for r in records if r['type']=='control']
        self.assertEqual([round(r['sim_time_s'],9) for r in controls],[.04,.06])
        self.assertEqual([r['plan_elapsed_s'] for r in controls],[.04,.06])
        self.assertEqual([r['torque_nm'] for r in controls],[[3.]*7,[4.]*7])  # knot zero was missed
        self.assertEqual(controls[0]['plan_activated'],True)
        first=next(r for r in records if r['type']=='plan')
        self.assertAlmostEqual(first['solve_latency_s'],.025)
        self.assertGreaterEqual(first['controller_wall_s'],0.)
        self.assertAlmostEqual(first['available_time_s'],.025)
        self.assertAlmostEqual(first['scheduled_activation_time_s'],.04)
        states=[r for r in records if r['type']=='state' and r['sim_time_s']<=.04]
        self.assertTrue(all(r['torque_nm'] is None and np.array_equal(r['_x'],np.zeros(14)) for r in states))

    def test_active_timing_counts_state_capture_and_excludes_time_parked_between_batches(self):
        class CostedAdapter(FakeAdapter):
            def state_snapshot(self, settings_version=0):
                self.captures += 1
                self.clock.value += .003
                return super().state_snapshot(settings_version)

        adapter = CostedAdapter()
        adapter.clock, adapter.captures = FakeClock(), 0
        session = self.session(adapter, dict(DEFAULT_EXECUTION, solve_latency_s=0.), clock=adapter.clock)
        records = session.advance_interval(.01)
        first_cost = session.compute_wall
        adapter.clock.value += 10.  # Deliberate wall time while the native callback is parked.
        self.assertEqual(session.compute_wall, first_cost)
        records.extend(session.advance_interval(.02))
        expected = session.solves*.03 + session.steps*.0001 + adapter.captures*.003
        self.assertAlmostEqual(session.compute_wall, expected)
        self.assertAlmostEqual(sum(r['total_wall_s'] for r in records if r['type'] == 'interval'), expected)

    def test_long_delay_keeps_old_plan_and_skips_slots_without_catchup(self):
        a=FakeAdapter();a.N=16
        session=self.session(a,dict(DEFAULT_EXECUTION,solve_latency_s=.025))
        records=self.run_until(session,.085)
        plans=[r for r in records if r['type']=='plan']
        controls=[r for r in records if r['type']=='control']
        np.testing.assert_allclose([r['sim_time_s'] for r in plans],[0,.026,.052,.078],atol=1e-12)
        self.assertTrue(all(r['plan_seq']==1 for r in controls if .026<=r['sim_time_s']<.052))
        self.assertEqual([r['plan_seq'] for r in controls if r['plan_activated']],[1,2,3])
        self.assertAlmostEqual(controls[0]['plan_elapsed_s'],.026)

    def test_back_to_back_reporting_preserves_pending_plan(self):
        adapter=FakeAdapter()
        session=self.session(adapter,dict(DEFAULT_EXECUTION,to_hz=0,solve_latency_s=.0055))
        first=session.advance_interval(.003)
        pending=next(r for r in first if r['type']=='plan')
        self.assertEqual(session.solves,1)
        self.assertFalse(any(r['type']=='control' for r in first))
        self.assertIsNone(adapter.applied_torque)
        records=first+self.run_until(session,.02)
        np.testing.assert_allclose([r['sim_time_s'] for r in records if r['type']=='plan'],[0,.006,.012,.018],atol=1e-12)
        self.assertEqual(next(r for r in records if r['type']=='control')['plan_seq'],pending['seq'])
        self.assertTrue(all(r['to_back_to_back'] for r in records if r['type']=='interval'))
        self.assertTrue(all(r['to_budget_s'] is None and r['mpc_ratio'] is None for r in records if r['type']=='interval'))

    def test_back_to_back_has_no_deadline_even_when_call_overhead_exceeds_simulated_solve_delay(self):
        interval=interval_record(0., .004, .004, .006, .001, .007, to_back_to_back=True)
        self.assertIsNone(interval['to_budget_s'])
        self.assertIsNone(interval['mpc_ratio'])
        self.assertEqual(interval['severity'], 'yellow')
        self.assertAlmostEqual(interval['mpc_realtime_ratio'], 1.5)
        self.assertEqual(interval_record(0., .01, None, .004, .001, .006, to_back_to_back=True)['severity'], 'none')
        # Fixed-rate TO keeps its real deadline, even at a final partial interval.
        self.assertEqual(interval_record(0., .004, .005, .006, .001, .007)['severity'], 'red')

    def test_resume_holds_committed_torque_and_moving_anchor_uses_explicit_zero(self):
        a=FakeAdapter(); a.t=4.; a.x[7:]=.2; a.applied_torque=np.full(7,3.)
        session=self.session(a,dict(DEFAULT_EXECUTION,solve_latency_s=.01))
        self.assertEqual(session.initial_state()['startup_command_source'],'held_command')
        session.advance_interval(4.005)
        np.testing.assert_allclose(a.x[:7],.018)
        np.testing.assert_allclose(a.applied_torque,3)
        a=FakeAdapter(); a.t=4.; a.x[7:]=.2
        session=self.session(a,dict(DEFAULT_EXECUTION,solve_latency_s=.01))
        self.assertEqual(session.initial_state()['startup_command_source'],'zero_effort_moving_anchor')
        np.testing.assert_array_equal(a.applied_torque,np.zeros(7))
        session.advance_interval(4.005)
        self.assertAlmostEqual(a.t,4.006)

    def test_command_request_transcript_matches_native_virtual_loop(self):
        from tiago_mpc.interfaces import State, Plan
        from tiago_mpc.loops import VirtualTimeSettings, run_virtual_time
        class Plant:
            def start(self,clock):
                self.clock,self.t,self.q,self.qd,self.command=clock,clock.now(),np.zeros(7),np.zeros(7),None
            def state(self): return State(self.t,self.q.copy(),self.qd.copy())
            def apply(self,u): self.command=np.array(u)
            def advance(self,t):
                if self.command is not None:
                    self.q += self.command*(t-self.t); self.qd += self.command*(t-self.t)
                self.t=t; self.clock.reach(t)
            def take_events(self): return []
            def stop(self): pass
        class Mpc:
            N=32; dt=.01
            def __init__(self): self.requests=[]
            def warmup(self,*args): pass
            def request(self,s,*args):
                self.requests.append(s.t)
                self.pending=Plan(s.t,self.dt,np.tile(np.r_[s.q,s.qd],(self.N,1)),
                                  .01*np.arange(1.,self.N)[:,None]*np.ones(7),dict(wall_s=.013), measured_t=getattr(s, "measured_t", s.t))
            def result(self,block=False): return self.pending
        class Task:
            def done(self,*args): return False
            def at(self,*args): return (np.zeros((32,6)),None)
        for latency,to_hz in ((.0055,100.),('measured',100.),(.025,100.),(.0055,0.)):
            with self.subTest(latency=latency,to_hz=to_hz):
                mpc=Mpc(); ticks=[]
                settings=VirtualTimeSettings(command_period=.002,update_period=1/to_hz if to_hz else 0.,
                                             solve_latency_s=latency)
                outcome=run_virtual_time(Plant(),mpc,Task(),tick_callbacks=[ticks.append],
                    settings=settings,duration=.08)
                self.assertEqual(outcome.status,'timeout')
                a=FakeAdapter(); a.N=32; a.dt=.01; a.plan_wall_s=.013
                solve=a.solve_snapshot
                def scaled(origin,version,**kwargs):
                    p=solve(origin,version,**kwargs); p['_torques']*=.01; return p
                a.solve_snapshot=scaled
                session=self.session(a,dict(DEFAULT_EXECUTION,to_hz=to_hz,solve_latency_s=latency))
                records=self.run_until(session,.08)
                commands=[r for r in records if r['type']=='control']
                sent=[t for t in ticks if t.command is not None]
                np.testing.assert_allclose([r['sim_time_s'] for r in records if r['type']=='plan'],mpc.requests,atol=1e-12)
                np.testing.assert_allclose([r['sim_time_s'] for r in commands],[t.t for t in sent],atol=1e-12)
                np.testing.assert_allclose([r['torque_nm'] for r in commands],[t.command for t in sent],atol=1e-12)
    def test_actual_physics_and_nominal_to_budget_red_priority(self):
        self.assertEqual(interval_record(0,.01,.1,.11,.3,.42)['severity'],'red')
        self.assertEqual(interval_record(0,.01,.1,.02,.001,.021)['severity'],'yellow')
        self.assertEqual(interval_record(0,.01,.1,.001,.001,.003)['severity'],'none')
        for changes in (dict(control_hz=2000),dict(to_hz=1001),dict(simulation_hz=True),dict(duration_s=121)):
            with self.assertRaises(ValueError):
                validate_execution(dict(DEFAULT_EXECUTION,**changes))
    def test_cancel_after_solve_never_integrates_and_terminal_torque_not_read(self):
        a=FakeAdapter()
        session=self.session(a,DEFAULT_EXECUTION)
        self.assertEqual(session.advance_interval(.01,cancelled=lambda:session.solves>0),[])
        self.assertEqual(a.t,0)
        self.assertEqual(session.steps,0)
        self.assertTrue(session.finished)
    def test_history_roundtrip_generation_and_page_bounds(self):
        with tempfile.TemporaryDirectory() as folder:
            store=HistoryStore(folder)
            try:
                store.append([dict(type='state',sim_time_s=t,q=[t]*7) for t in range(600)])
                page=store.page(0,0,256)
                self.assertEqual(page['next_cursor'],256)
                self.assertEqual(store.page(0,256,256)['records'][0]['sim_time_s'],256)
                old=store.path
                store.reset(1)
                self.assertFalse(old.exists())
                with self.assertRaises(HistoryGenerationError):
                    store.page(0,0,256)
                with self.assertRaises(ValueError):
                    store.page(1,0,2049)
            finally:
                store.close()


class SpawnTests(unittest.TestCase):
    def setUp(self):
        self.service=ProcessLiveService(MPC_ROOT,adapter_factory=FakeAdapter,schema_factory=fake_schema,
                    worker_target=fake_worker,render_factory=FakeRenderer)
        self.service.subscribe()
        self.wait(lambda:self.service.latest.get('plan',{}).get('origin')=='preview')
    def tearDown(self):
        self.service.close()
    def wait(self, predicate, timeout=5):
        with self.service.condition:
            if not self.service.condition.wait_for(predicate,timeout):
                self.fail(f'Condition timed out: {self.service.latest}')
    def settings(self, **execution):
        return dict(type='set_settings',config=deepcopy(self.service.config),task=deepcopy(self.service.task),
                    execution=dict(DEFAULT_EXECUTION,calculation='manual',duration_s=.125,**execution))
    def records(self):
        records=[];cursor=0
        while True:
            page=self.service.history(self.service.generation,cursor)
            records.extend(page['records'])
            if page['next_cursor']==cursor:
                return records
            cursor=page['next_cursor']
    def test_precalculation_preserves_anchor_and_reports_command_endpoint(self):
        request=self.settings(simulation_hz=100.,control_hz=25.,to_hz=10.)
        request['anchor']=dict(sim_time_s=2.,q=[.3]*7,qd=[.2]*7)
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('status',{}).get('settings_version')==1 and self.service.latest['status']['state']=='paused')
        self.service.command(dict(type='precalculate',anchor=request['anchor']))
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Precalculation complete')
        records=self.records();states=[r for r in records if r['type']=='state']
        self.assertTrue([r for r in records if r['type']=='plan' and r['origin']=='play'][0]['stats']['controller_restarted'])
        self.assertEqual(states[0]['sim_time_s'],2.)
        self.assertEqual(states[0]['q'],[.3]*7)
        self.assertEqual(states[0]['qd'],[.2]*7)
        self.assertAlmostEqual(states[-1]['sim_time_s'],2.16)
        self.assertTrue(self.service.latest['history']['complete'])
        oldgen=self.service.generation
        changes=[];self.service.generation_listeners.append(changes.append)  # Run again results follow it
        self.service.command(dict(type='reset'))
        self.wait(lambda:self.service.latest.get('plan',{}).get('generation')==oldgen+1)
        self.assertEqual(changes,[oldgen+1])
        self.assertEqual(self.service.latest['plan']['seq'],1)
        self.assertEqual([r for r in self.records() if r['type']=='state'][0]['sim_time_s'],0)

    def test_a_new_start_pose_starts_a_run_at_zero_and_reset_returns_to_it(self):
        old = self.settings()
        old['anchor'] = dict(sim_time_s=3., q=[.7]*7, qd=[.2]*7)
        self.service.command(old)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.assertEqual(self.records()[1]['sim_time_s'], 3.)
        request = self.settings()
        pose = list(request['config']['plant']['start_pose_rad'])
        pose[3] += .3
        request['config']['plant']['start_pose_rad'] = pose
        # Editing the start pose starts at t = 0 from it, as Reset; the anchor is not used.
        request['anchor'] = dict(sim_time_s=3., q=[.7]*7, qd=[.2]*7)
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==2)
        header, first = self.records()[:2]
        self.assertEqual((header['type'], self.service.config['plant']['start_pose_rad']), ('segment', pose))
        self.assertEqual((first['sim_time_s'], first['q'], first['qd']), (0., pose, [0.]*7))
        self.service.command(dict(type='precalculate'))
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Precalculation complete')
        self.assertGreater([r for r in self.records() if r['type']=='state'][-1]['sim_time_s'], 0.)
        self.service.command(dict(type='reset'))
        self.wait(lambda:self.service.latest.get('plan',{}).get('origin')=='preview' and
                  self.service.latest.get('status',{}).get('generation')==self.service.generation and
                  self.service.latest['status'].get('message','').startswith('Preview ready'))
        self.assertEqual([(r['sim_time_s'], r['q']) for r in self.records() if r['type']=='state'], [(0., pose)])
        # Other settings changes keep continuing from the displayed state.
        unchanged = self.settings()
        unchanged['anchor'] = dict(sim_time_s=0., q=pose, qd=[.1]*7)
        self.service.command(unchanged)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==3)
        self.assertEqual(self.records()[1]['qd'], [.1]*7)

    def test_atomic_settings_reset_starts_automatic_calculation_at_comfortable_state(self):
        old = self.settings()
        old['anchor'] = dict(sim_time_s=3., q=[.7]*7, qd=[.2]*7)
        self.service.command(old)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        request = self.settings()
        request['execution']['calculation'] = 'automatic'
        request['reset'] = True
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('status',{}).get('settings_version')==2 and
                  self.service.latest['status'].get('message')=='Precalculation complete')
        states = [r for r in self.records() if r['type']=='state']
        self.assertEqual(states[0]['sim_time_s'], 0.)
        self.assertEqual(states[0]['q'], request['config']['plant']['start_pose_rad'])
        self.assertEqual(states[0]['qd'], [0.]*7)
        self.assertAlmostEqual(states[-1]['sim_time_s'], .126)
        self.assertEqual([r for r in self.records() if r['type']=='plan'][0]['seq'], 1)
        for invalid in (1, 'true', None):
            with self.assertRaisesRegex(ValueError, 'boolean'):
                self.service.command(dict(request, reset=invalid))
        with self.assertRaisesRegex(ValueError, 'anchor'):
            self.service.command(dict(request, anchor=old['anchor']))
    def test_native_solve_cannot_block_http_and_rapid_obsolete_settings_discarded(self):
        request=self.settings();request['config']['solver']['max_sqp_iters']=9000
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.service.command(dict(type='precalculate'))
        self.wait(lambda:self.service.latest.get('status',{}).get('job_active'))
        server=make_server(dict(trajectories=[]),b'<robot/>',{},port=0,live=self.service)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            started=time.perf_counter()
            with urlopen(f'http://127.0.0.1:{server.server_port}/api/live/schema',timeout=.2) as response:
                self.assertEqual(response.status,200)
            self.assertLess(time.perf_counter()-started,.2)
            for index in range(4):
                request=self.settings();request['anchor']=dict(sim_time_s=index,q=[index/10]*7,qd=[0]*7)
                self.service.command(request)
            version=self.service.next_version
            self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==version)
            self.assertTrue(all(r['settings_version']==version for r in self.records()))
            self.assertEqual([r['type'] for r in self.records()[:2]],['segment','state'])
            self.assertEqual(self.records()[1]['q'],[.3]*7)
        finally:
            server.shutdown();server.server_close();thread.join()
    def test_on_play_runs_past_duration_without_controller_reset_until_paused(self):
        request=self.settings(simulation_hz=100.,control_hz=25.,to_hz=10.)
        request['execution']['calculation']='on_play'
        request['execution']['duration_s']=.125
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        generation=self.service.generation
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=.35)
        self.assertTrue(self.service.latest['status']['job_active'])
        self.assertIsNone(self.service.latest['status']['requested_end_s'])
        self.assertFalse(self.service.latest['history']['complete'])
        first_tip=self.service.latest['history']['history_end_s']
        self.service.command(dict(type='play'))  # Idempotent while already running.
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=first_tip+.15)
        plans=[r for r in self.records() if r['type']=='plan' and r['origin']=='play']
        self.assertGreaterEqual(len(plans),5)
        self.assertTrue(plans[0]['stats']['controller_restarted'])
        self.assertTrue(all(not plan['stats']['controller_restarted'] for plan in plans[1:]))
        revision=self.service.revision.value
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        self.assertFalse(self.service.latest['status']['job_active'])
        self.assertFalse(self.service.latest['history']['complete'])
        self.assertEqual(self.service.generation,generation)
        self.assertEqual(self.service.revision.value,revision)
        paused_tip=self.service.latest['history']['history_end_s']
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>paused_tip)
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        self.assertEqual(self.service.generation,generation)
        self.assertEqual(self.service.revision.value,revision)
        resumed=[r for r in self.records() if r['type']=='plan' and r['origin']=='play']
        self.assertTrue(all(not p['stats']['controller_restarted'] for p in resumed[1:]))
        self.assertEqual({p['stats']['controller_epoch'] for p in resumed},{plans[0]['stats']['controller_epoch']})
        times=[r['sim_time_s'] for r in self.records() if r['type']=='state']
        self.assertTrue(all(left<right for left,right in zip(times,times[1:])))

    def test_reset_reconstructs_controller_and_discards_old_run_output(self):
        request=self.settings()
        request['execution']['calculation']='on_play'
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        old_generation=self.service.generation
        old_epoch=self.service.latest['plan']['stats']['controller_epoch']
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=.03)
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        self.service.command(dict(type='reset'))
        self.wait(lambda:self.service.latest.get('plan',{}).get('generation')==old_generation+1)
        plan=self.service.latest['plan']
        self.assertGreater(plan['stats']['controller_epoch'],old_epoch)
        self.assertEqual(plan['seq'],1)
        records=self.records()
        self.assertEqual([r['type'] for r in records[:2]],['segment','state'])
        self.assertEqual(records[1]['sim_time_s'],0.)
        self.assertTrue(all(r['generation']==old_generation+1 for r in records))

    def test_cancel_wakes_a_parked_run_and_rebuilds_on_next_play(self):
        request=self.settings()
        request['execution']['calculation']='on_play'
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=.03)
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        generation=self.service.generation
        old_epoch=self.service.latest['plan']['stats']['controller_epoch']
        old_ack=self.service.latest['status']['bridge_command_epoch']
        revision=self.service.revision.value
        self.service.command(dict(type='cancel'))
        self.wait(lambda:self.service.latest.get('status',{}).get('bridge_command_epoch',0)>old_ack)
        self.assertGreater(self.service.revision.value,revision)
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('plan',{}).get('stats',{}).get('controller_epoch',0)>old_epoch)
        self.assertEqual(self.service.generation,generation)
        replacement=[r for r in self.records() if r['type']=='plan' and
                     r['stats']['controller_epoch']>old_epoch]
        self.assertTrue(replacement[0]['stats']['controller_restarted'])

    def test_native_plan_expiry_finishes_job_and_reports_reason(self):
        request=self.settings(to_hz=1.)
        request['config']['dt_s']=.002
        request['execution']['duration_s']=.2
        request['execution']['max_plan_age_s']=None
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.service.command(dict(type='precalculate'))
        self.wait(lambda:self.service.latest.get('status',{}).get('termination') is not None)
        status=self.service.latest['status']
        self.assertEqual(status['termination']['reason'],'lease_expired')
        self.assertEqual(status['message'],'Simulation stopped: lease_expired')
        self.assertFalse(status['job_active'])
        self.assertFalse(status['complete'])
        self.assertAlmostEqual(status['history_end_s'],.03)

    def test_breach_pauses_calculation_and_play_continues_until_a_new_breach(self):
        request=self.settings(simulation_hz=100.,control_hz=25.,to_hz=10.)
        request['config']['dt_s']=.01  # Explicit command/knot relation, independent of native defaults.
        request['execution']['calculation']='on_play'
        request['config']['solver']['max_sqp_iters']=6000  # 1.5 Nm effort limit
        request['config']['plant']['clip_effort']=False
        request['config']['dt_s']=.01  # the fake plan's torque grows by one per 10 ms knot
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        generation=self.service.generation
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('breach') is not None)
        status=self.service.latest['status']
        self.assertEqual((status['state'],status['job_active']),('paused',False))
        self.assertAlmostEqual(status['breach']['sim_time_s'],.04)
        self.assertTrue(status['message'].startswith('Limit breach at 0.040 s: joint 1 torque 5 Nm beyond its effort limit 1.5 Nm'))
        self.assertAlmostEqual(status['history_end_s'],.04)
        self.assertEqual(self.service.generation,generation)
        self.service.command(dict(type='play'))
        self.wait(lambda:(self.service.latest.get('status',{}).get('breach') or {}).get('sim_time_s',0)>.05)
        self.assertAlmostEqual(self.service.latest['status']['breach']['sim_time_s'],.16)
        breaches=[r for r in self.records() if r['type']=='breach']
        self.assertEqual([round(r['sim_time_s'],9) for r in breaches],[.04,.16])
        plans=[r for r in self.records() if r['type']=='plan' and r['origin']=='play']
        self.assertTrue(all(not plan['stats']['controller_restarted'] for plan in plans[1:]))
        clipped=self.settings(simulation_hz=100.,control_hz=25.,to_hz=10.)
        clipped['config']['dt_s']=.01
        clipped['execution']['duration_s']=.3
        clipped['config']['plant']['clip_effort']=True
        clipped['config']['solver']['max_sqp_iters']=6000
        self.service.command(clipped)
        version=self.service.next_version
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==version)
        self.service.command(dict(type='precalculate'))
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Precalculation complete')
        records=self.records()
        self.assertFalse(any(r['type']=='breach' for r in records))
        self.assertTrue(all(max(r['torque_nm'])<=1.5 for r in records if r['type']=='control'))
        self.assertTrue(any('planned_torque_nm' in r for r in records if r['type']=='control'))

    def test_inspection_pause_preserves_private_controller_and_committed_history(self):
        request=self.settings(simulation_hz=100.,control_hz=25.,to_hz=10.)
        request['execution']['calculation']='on_play'
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=.15)
        revision=self.service.revision.value
        generation=self.service.generation
        self.service.pause_for_inspection('inspection-cpu-check',timeout=3)
        self.assertEqual(self.service.revision.value,revision)
        self.assertEqual(self.service.generation,generation)
        self.assertFalse(self.service.latest['status']['job_active'])
        paused_tip=self.service.latest['status']['history_end_s']
        plans_before=[r for r in self.records() if r['type']=='plan' and r['origin']=='play']
        time.sleep(.05)
        self.assertEqual(self.service.latest['status']['history_end_s'],paused_tip)
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=paused_tip+.1)
        self.service.pause_for_inspection('inspection-cpu-check-again',timeout=3)
        plans_after=[r for r in self.records() if r['type']=='plan' and r['origin']=='play']
        self.assertGreater(len(plans_after),len(plans_before))
        self.assertTrue(all(not p['stats']['controller_restarted'] for p in plans_after[len(plans_before):]))
        self.assertEqual(self.service.revision.value,revision)
        times=[r['sim_time_s'] for r in self.records() if r['type']=='state']
        self.assertTrue(all(a<b for a,b in zip(times,times[1:])))

    def test_on_play_pause_during_native_solve_is_reported(self):
        request=self.settings()
        request['execution']['calculation']='on_play'
        request['config']['solver']['max_sqp_iters']=9000
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        generation=self.service.generation
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('job_active'))
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        self.assertFalse(self.service.latest['status']['job_active'])
        self.assertFalse(self.service.latest['history']['complete'])
        self.assertEqual(self.service.generation,generation)
        self.service.command(dict(type='preview',anchor=dict(sim_time_s=0.,q=[0.]*7,qd=[0.]*7)))
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Prediction inspected at displayed state; history retained')
        self.assertFalse(self.service.latest['history']['complete'])
    def test_pending_settings_anchor_survives_later_cancel_before_native_return(self):
        request=self.settings()
        request['execution']['calculation']='on_play'
        request['config']['solver']['max_sqp_iters']=9000
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('job_active'))
        replacement=self.settings()
        replacement['config']['solver']['max_sqp_iters']=1
        replacement['execution']['calculation']='on_play'
        replacement['anchor']=dict(sim_time_s=3.,q=[.7]*7,qd=[.2]*7)
        self.service.command(replacement)
        self.service.command(dict(type='cancel'))
        self.wait(lambda:self.service.latest.get('status',{}).get('settings_version')==2 and not self.service.latest['status']['job_active'])
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=3.125)
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        initial=[r for r in self.records() if r['type']=='state'][0]
        self.assertEqual(initial['sim_time_s'],3.)
        self.assertEqual(initial['q'],[.7]*7)
        self.assertEqual(initial['qd'],[.2]*7)
        self.assertGreaterEqual(self.service.latest['history']['history_end_s'],3.125)
    def test_anchored_preview_preserves_authoritative_history_and_tip(self):
        self.service.command(self.settings())
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.service.command(dict(type='precalculate'))
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Precalculation complete')
        generation=self.service.generation
        before=self.records()
        tip=self.service.latest['history']['history_end_s']
        self.service.command(dict(type='preview',anchor=dict(sim_time_s=.025,q=[.4]*7,qd=[.1]*7)))
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Prediction inspected at displayed state; history retained')
        self.assertEqual(self.service.generation,generation)
        self.assertEqual(self.records(),before)
        self.assertTrue(self.service.latest['history']['complete'])
        self.assertEqual(self.service.latest['history']['history_end_s'],tip)
        self.assertEqual(self.service.latest['plan']['sim_time_s'],.025)
        self.assertNotIn('_states',self.service.latest['plan'])
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=tip+.125-1e-12)
        self.assertAlmostEqual(self.service.latest['history']['history_end_s'],tip+.126)
    def test_cancel_keeps_history_and_error_recovers_in_same_process(self):
        request=self.settings();request['execution']['calculation']='automatic';request['execution']['duration_s']=.2
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Precalculation complete')
        generation=self.service.generation;count=len(self.records())
        self.service.command(dict(type='pause'))
        self.assertEqual(self.service.generation,generation)
        self.assertEqual(len(self.records()),count)
        request=self.settings();request['config']['solver']['max_sqp_iters']=8000
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='error')
        pid=self.service._process.pid
        repaired=self.settings();repaired['config']['solver']['max_sqp_iters']=1
        self.service.command(repaired)
        version=self.service.next_version
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==version)
        self.assertEqual(self.service._process.pid,pid)

    def test_reset_recovers_after_plant_blow_up_beyond_solver_precision(self):
        # The 0.2 s TO interval spans two 0.1 s batches, so the failed solve's
        # restored tip is already the blown-up state that Reset discards.
        request=self.settings(simulation_hz=100.,control_hz=25.,to_hz=5.)
        request['config']['solver']['max_sqp_iters']=7000
        request['execution']['duration_s']=.5
        self.service.command(request)
        version=self.service.next_version
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==version)
        self.service.command(dict(type='precalculate'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='error')
        self.assertEqual(self.service.latest['status']['message'],'Nonfinite torque or predicted trajectory')
        self.service.command(dict(type='reset'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')!='error' and
                  self.service.latest.get('plan',{}).get('origin')=='preview')
        self.assertEqual(self.records()[1]['q'],self.service.config['plant']['start_pose_rad'])


if __name__=='__main__':
    unittest.main()
