"""CPU evidence for the production multirate and spawned-process paths."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.request import Request, urlopen

import numpy as np

from execution_bridge import HistoryStore, HistoryGenerationError, ProcessLiveService
from execution_session import DEFAULT_EXECUTION, MultirateSession, interval_record, validate_execution
from execution_worker import worker_main
from live_mpc import parameter_specs
from server import make_server

MPC_ROOT = Path(__file__).resolve().parents[2] / 'tiago_mpc'
LOCK_HELD = False


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


class FakeController:
    fresh = True
    def reset(self, x):
        if not LOCK_HELD:
            raise AssertionError('Controller reset outside lock')
        self.fresh = True


class FakeAdapter:
    def __init__(self, root=None):
        self.x = np.zeros(14)
        self.t = 0.
        self.dt = .02
        self.N = 3
        self.sequence = 0
        self.state_signs = np.tile([1,1,1,1,1,-1,1], 2)
        self.signs = self.state_signs[:7]
        self.applied_torque = None
        self.controller = FakeController()
        self.solver = object()
        self.reach = self
        self.model = self.data = None
        self.delay = 0
        self.fail = False
        self.restarted = True
        self.clock = None
    def configure(self, path, task):
        if not LOCK_HELD:
            raise AssertionError('Configure outside lock')
        config = json.loads(Path(path).read_text())
        self.dt, self.N = config['dt_s'], config['N']
        self.delay = .25 if config['solver_params']['max_sqp_iters'] == 9000 else 0
        self.fail = config['solver_params']['max_sqp_iters'] == 8000
        self.task = task
        self.controller.reset(self.x*self.state_signs)
    def reset_state(self, reset_controller=True):
        self.x[:] = 0
        self.t = 0
        self.sequence = 0
        self.applied_torque = None
        if reset_controller:
            self.controller.reset(self.x)
    def solve_snapshot(self, origin, version):
        if self.fail:
            raise RuntimeError('intentional test solve failure')
        if self.delay:
            # CPU/GIL activity in this process cannot hold the HTTP GIL.
            stop = time.perf_counter()+self.delay
            while time.perf_counter() < stop:
                sum(range(500))
        if self.clock:
            self.clock.value += .03
        if origin == 'preview':
            self.controller.reset(self.x*self.state_signs)
        was_fresh = self.controller.fresh
        self.controller.fresh = False
        self.sequence += 1
        blocks = []
        for k in range(self.N):
            blocks.extend((self.x[:7]*self.signs).tolist())
            blocks.extend((self.x[7:]*self.signs).tolist())
            if k < self.N-1:
                blocks.extend((np.ones(7)*(k+1)*self.signs).tolist())
        return dict(type='plan', _xu=np.array(blocks), _signs=self.signs.copy(),
                    _reference=np.zeros((self.N, 6)), N=self.N, dt_s=self.dt,
                    sim_time_s=self.t, seq=self.sequence, origin=origin,
                    settings_version=version, target_xyz=[0,0,0], task_kind='reach',
                    stats=dict(solve_time_ms=2., sqp_iters=1, controller_restarted=was_fresh))
    def rk4(self, model, data, q, v, u, h):
        if self.clock:
            self.clock.value += .0001
        return q+u*h, v+u*h
    def state_snapshot(self, rtf=0, settings_version=0):
        return dict(type='state', sim_time_s=self.t, _x=self.x.copy(),
                    q=self.x[:7].tolist(), qd=self.x[7:].tolist(),
                    torque_nm=None if self.applied_torque is None else self.applied_torque.tolist(),
                    settings_version=settings_version, target_xyz=[0,0,0])


def fake_schema(root):
    config = json.loads((MPC_ROOT/'configs/reaching.json').read_text())
    config = {k:v for k,v in config.items() if k not in ('description','save_plan_steps')}
    config['N'] = 16
    return dict(defaults=dict(config=config, task=dict(kind='reach',target_offset_m=[0,0,0]),
                              execution=dict(DEFAULT_EXECUTION)), available_N=[16],
                parameters=parameter_specs(config,[16]))


def fake_worker(*args):
    import live_mpc
    live_mpc.GPULocks = FakeLocks
    worker_main(*args)


class FakeRenderer:
    def __init__(self, root):
        pass
    def __call__(self, frame):
        from live_presentation import mutable
        plan, state, events = frame
        result=[]
        if plan:
            event=mutable(plan)
            for key in ('_xu','_signs','_reference'):
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
    def test_native_nonterminal_controls_independent_grid_and_expiration(self):
        a=FakeAdapter()
        settings=dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=25.,to_hz=10.)
        session=MultirateSession(a,settings)
        records=session.advance_interval(.1)
        controls=[r for r in records if r['type']=='control']
        self.assertEqual([round(r['sim_time_s'],9) for r in controls],[0.,.04,.08])
        np.testing.assert_allclose([r['torque_nm'] for r in controls],np.array([[1]*7,[2]*7,[2]*7]))
        self.assertEqual([r['horizon_exhausted'] for r in controls],[False,True,True])
        self.assertAlmostEqual(a.t,.1)
        np.testing.assert_allclose(a.x[:7],np.ones(7)*.16)
        self.assertEqual(session.solves,1)
        self.assertEqual(session.control_updates,3)
        self.assertEqual(len([r for r in records if r['type']=='state']),10)
    def test_noninteger_rate_splits_and_partial_resume_keep_original_grids(self):
        a=FakeAdapter()
        session=MultirateSession(a,dict(DEFAULT_EXECUTION,simulation_hz=70.,control_hz=23.,to_hz=11.))
        records=[]
        for end in (.035,.07,.15,.231):
            while a.t < end-1e-12:
                records.extend(session.advance_interval(end))
        times=[r['sim_time_s'] for r in records if r['type']=='state']
        self.assertTrue(all(0 < b-a <= 1/70+1e-12 for a,b in zip([0]+times,times)))
        for tick in range(1,6):
            self.assertTrue(any(abs(t-tick/23)<1e-12 for t in times))
        self.assertEqual(session.solves,3)
        self.assertAlmostEqual(a.t,.231)
        self.assertTrue(records[-1]['partial'])
    def test_replan_between_control_ticks_cannot_change_held_torque(self):
        a=FakeAdapter()
        original=a.solve_snapshot
        def production_like_solve(origin, version):
            plan=original(origin,version)
            # MPCAdapter.solve_snapshot assigns step.u for its conformance API.
            # Make each newly optimized first control observably different.
            for k in range(a.N-1):
                plan['_xu'][21*k+14:21*k+21] = np.ones(7)*a.sequence*10*a.signs
            a.u=np.ones(7)*a.sequence*10
            return plan
        a.solve_snapshot=production_like_solve
        session=MultirateSession(a,dict(DEFAULT_EXECUTION,simulation_hz=1000.,control_hz=23.,to_hz=11.))
        records=[]
        while a.t < .12-1e-12:
            records.extend(session.advance_interval(.12))
        # TO tick .090909 is between control ticks .086956 and .130435.
        # All physics after that replan must still use torque 10, not new 20.
        after=[r for r in records if r['type']=='state' and r['sim_time_s']>1/11+1e-12]
        self.assertTrue(after)
        self.assertTrue(all(r['torque_nm']==[10.]*7 for r in after))
    def test_chunked_numerics_accumulate_one_to_interval(self):
        a=FakeAdapter()
        session=MultirateSession(a,dict(DEFAULT_EXECUTION,simulation_hz=100.,control_hz=10.,to_hz=1.))
        records=[]
        for endpoint in (.1,.2,.3):
            records.extend(session.advance_interval(endpoint,emit_partial=False))
        self.assertFalse(any(r['type']=='interval' for r in records))
        records.extend(session.advance_interval(.35,emit_partial=True))
        intervals=[r for r in records if r['type']=='interval']
        self.assertEqual(len(intervals),1)
        self.assertAlmostEqual(intervals[0]['end_time_s'],.35)
        self.assertEqual(intervals[0]['start_time_s'],0)
        self.assertEqual(intervals[0]['to_budget_s'],1.)
    def test_actual_physics_and_nominal_to_budget_red_priority(self):
        self.assertEqual(interval_record(0,.01,.1,.11,.3,.42)['severity'],'red')
        self.assertEqual(interval_record(0,.01,.1,.02,.001,.021)['severity'],'yellow')
        self.assertEqual(interval_record(0,.01,.1,.001,.001,.003)['severity'],'none')
        for changes in (dict(control_hz=2000),dict(to_hz=1001),dict(simulation_hz=True),dict(duration_s=121)):
            with self.assertRaises(ValueError):
                validate_execution(dict(DEFAULT_EXECUTION,**changes))
    def test_cancel_after_solve_never_integrates_and_terminal_torque_not_read(self):
        a=FakeAdapter()
        session=MultirateSession(a,DEFAULT_EXECUTION)
        self.assertEqual(session.advance_interval(.01,cancelled=lambda:session.solves>0),[])
        self.assertEqual(a.t,0)
        self.assertEqual(session.steps,0)
        self.assertEqual(session.controls.shape,(2,7))
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
                self.assertTrue(old.exists())
                with self.assertRaises(HistoryGenerationError):
                    store.page(0,0,256)
                with self.assertRaises(ValueError):
                    store.page(1,0,257)
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
    def test_complete_precalculation_exact_native_anchor_and_reset_count(self):
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
        self.assertAlmostEqual(states[-1]['sim_time_s'],2.125)
        self.assertTrue(self.service.latest['history']['complete'])
        oldgen=self.service.generation
        self.service.command(dict(type='reset'))
        self.wait(lambda:self.service.latest.get('plan',{}).get('generation')==oldgen+1)
        self.assertEqual(self.service.latest['plan']['seq'],1)
        self.assertEqual([r for r in self.records() if r['type']=='state'][0]['sim_time_s'],0)

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
        self.assertEqual(states[0]['q'], [0.]*7)
        self.assertEqual(states[0]['qd'], [0.]*7)
        self.assertAlmostEqual(states[-1]['sim_time_s'], .125)
        self.assertEqual([r for r in self.records() if r['type']=='plan'][0]['seq'], 1)
        for invalid in (1, 'true', None):
            with self.assertRaisesRegex(ValueError, 'boolean'):
                self.service.command(dict(request, reset=invalid))
        with self.assertRaisesRegex(ValueError, 'anchor'):
            self.service.command(dict(request, anchor=old['anchor']))
    def test_native_solve_cannot_block_http_and_rapid_obsolete_settings_discarded(self):
        request=self.settings();request['config']['solver_params']['max_sqp_iters']=9000
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
            self.assertEqual(self.records()[0]['q'],[.3]*7)
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
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        self.assertFalse(self.service.latest['status']['job_active'])
        self.assertFalse(self.service.latest['history']['complete'])
        self.assertEqual(self.service.generation,generation)
        paused_tip=self.service.latest['history']['history_end_s']
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>paused_tip)
        self.service.command(dict(type='pause'))
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='paused')
        self.assertEqual(self.service.generation,generation)
        times=[r['sim_time_s'] for r in self.records() if r['type']=='state']
        self.assertTrue(all(left<right for left,right in zip(times,times[1:])))

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
        request['config']['solver_params']['max_sqp_iters']=9000
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
        request['config']['solver_params']['max_sqp_iters']=9000
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==1)
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('job_active'))
        replacement=self.settings()
        replacement['config']['solver_params']['max_sqp_iters']=1
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
        self.assertNotIn('_xu',self.service.latest['plan'])
        self.service.command(dict(type='play'))
        self.wait(lambda:self.service.latest.get('status',{}).get('history_end_s',0)>=tip+.125-1e-12)
        self.assertAlmostEqual(self.service.latest['history']['history_end_s'],tip+.125)
    def test_cancel_keeps_history_and_error_recovers_in_same_process(self):
        request=self.settings();request['execution']['calculation']='automatic';request['execution']['duration_s']=.2
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('status',{}).get('message')=='Precalculation complete')
        generation=self.service.generation;count=len(self.records())
        self.service.command(dict(type='pause'))
        self.assertEqual(self.service.generation,generation)
        self.assertEqual(len(self.records()),count)
        request=self.settings();request['config']['solver_params']['max_sqp_iters']=8000
        self.service.command(request)
        self.wait(lambda:self.service.latest.get('status',{}).get('state')=='error')
        pid=self.service._process.pid
        repaired=self.settings();repaired['config']['solver_params']['max_sqp_iters']=1
        self.service.command(repaired)
        version=self.service.next_version
        self.wait(lambda:self.service.latest.get('plan',{}).get('settings_version')==version)
        self.assertEqual(self.service._process.pid,pid)


if __name__=='__main__':
    unittest.main()
