"""Independent cold SQP caps, binary transport, captured bounds and job ownership."""
from copy import deepcopy
import json
import hashlib
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np

from history_store import HistoryStore
from gato_visualizer.plotting import InspectionContext, SolveView
from inspection_artifacts import ReadOnlyIterationTrace, write_artifact
from inspection_problem import captured_problem, capture_constraint_bounds
from inspection_worker import inspect_solve
from plot_sources import SourceReader, inspect_source
from solve_inspections import InspectionService
from server import make_server


def groups(n=3):
    return [dict(kind=i, block=int(i==2), mech=2, n_rows=7, knot_lo=0, knot_hi=n-int(i==2),
                 sigma=0., rho=.1, cone=0, active=[127]*n,
                 lo=[-1.9 if i==0 else -.8 if i==1 else -8.5]*7,
                 hi=[1.9 if i==0 else .8 if i==1 else 8.5]*7) for i in range(3)]


def plan():
    return dict(id='chosen', seq=7, origin='controller', N=3, dt_s=.03,
        initial_state=dict(q=[.2]*7, qd=[.1]*7, time_s=1.25), reference_native=[[.1,.2,.3,0,0,0]]*3,
        problem_configuration=dict(type='MpcParams', N=3, dt_s=.03,
            solver=dict(type='SolverSettings', max_sqp_iters=5), cost=dict(type='CostMenu', input=dict(type='Term', weight=.0001)), admm=dict(type='AdmmLimits', rho=.01),
            admm_linsys='pcg', joint_margin_rad=.1, velocity_fraction=.8, effort_fraction=.85, friction=None,
            friction_law=dict(type='Tanh', width_rad_s=.03)),
        joint_limits=dict(lower_position_rad=[-2]*7,upper_position_rad=[2]*7,
                          velocity_rad_s=[1]*7,effort_nm=[10]*7),
        constraint_bounds_native=groups(), task=dict(kind='reach',target_offset_m=[0,0,0]),
        model_identity=dict(full_urdf_sha256='original-model'), solver_profile={})


CONTEXT_KEYS = ('problem_configuration', 'joint_limits', 'constraint_bounds_native', 'task', 'model_identity', 'solver_profile')


def segment(p=None):
    """A Live segment header: the constant context its recorded plans leave out."""
    p = p or plan()
    return dict(type='segment', sim_time_s=0., context={key: p[key] for key in CONTEXT_KEYS})


def recorded(p):
    """A plan as Live records it: without its segment's context."""
    return {key: value for key, value in p.items() if key not in CONTEXT_KEYS}


def trace(n=3, k=2):
    xu=np.zeros((k+1,1,21*n-7),dtype=np.float32)
    for i in range(k+1):
        for knot in range(n):
            xu[i,0,21*knot:21*knot+7]=i+.25
            xu[i,0,21*knot+7:21*knot+14]=i+.5
            if knot<n-1:
                xu[i,0,21*knot+14:21*knot+21]=i+.75
    xu[-1]=xu[-2]  # two independent capped solves may return the same final trajectory
    return SimpleNamespace(xu=xu,snapshot_count=k+1)


def metadata(identifier='result'):
    p=plan()
    return dict(p,id=identifier,signs=[1,1,1,1,1,-1,1],
        solver_profile=dict(profile=dict(mpc_root='/captured/profile')),end_effector_frame='tool', fixed_joints={},
        original=dict(source=dict(kind='live',generation=2),solve_id='chosen'),initialization='cold_state',
        mode="independent_sqp_caps", requested=dict(sqp_iters=2,budget_s=None),
        runs=[dict(cap=cap,actual_sqp_iters=1,stop_reason="zero_pcg",call_wall_s=.001,
                   stats=dict(sqp_iters=1,pcg_iters=4 if cap==1 else 0),
                   diagnostics=dict(final_merit=[3.],step_size=[1.])) for cap in (1,2)])


class FakeKinematics:
    def __init__(self,*args,**kwargs): pass
    def ee_positions(self,q): return np.asarray(q)[:,:3]
    def target_to_world(self,point): return np.asarray(point)+1


class ArtifactTests(unittest.TestCase):
    def test_inspection_grasp_paths_and_references_keep_the_recorded_torso_posture(self):
        import shutil
        from live_mpc import import_tiago, body_joints
        from server import RobotKinematics
        from tests.tiago_mpc_source import MPC_ROOT
        tiago=import_tiago(MPC_ROOT)
        fixed=dict(body_joints(MPC_ROOT),torso_lift_joint=.27)
        expected=RobotKinematics(tiago.FULL_URDF,fixed_joints=fixed,
                                 reduced_urdf=tiago.arm_urdf(),end_effector_frame=tiago.GRASP_FRAME)
        q=np.array([tiago.Q_START,np.asarray(tiago.Q_START)+.01,np.asarray(tiago.Q_START)+.02])
        snapshots=trace()
        for snapshot in snapshots.xu:
            for knot in range(3):snapshot[0,knot*21:knot*21+7]=q[knot]
        data=metadata();data.update(signs=[1.]*7,end_effector_frame=tiago.GRASP_FRAME,fixed_joints=fixed)
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder)
            data['model_snapshots']={}
            for name,source in [('full',tiago.FULL_URDF),('reduced',tiago.arm_urdf())]:
                path=folder/(name+'.urdf');shutil.copyfile(source,path)
                data['model_snapshots'][name]=dict(filename=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            descriptor=write_artifact(folder,snapshots,data)
            raw=SourceReader().read(descriptor)
            handle=raw['plans'][0]['iteration_trace']
            prediction=handle.prediction(1)
            np.testing.assert_allclose(prediction['ee_xyz'],expected.ee_positions(q),atol=1e-7)
            np.testing.assert_allclose(prediction['reference_xyz'],
                [expected.target_to_world(row[:3]) for row in data['reference_native']],atol=1e-10)
            np.testing.assert_allclose(handle.path_chunk(1)['ee_xyz'][1],expected.ee_positions(q),atol=1e-6)

    def test_npz_only_trace_read_once_and_only_selected_snapshot_in_context(self):
        with tempfile.TemporaryDirectory() as folder:
            descriptor=write_artifact(folder,trace(),metadata())
            self.assertNotIn('xu',json.loads(Path(descriptor['path']).read_text()))
            self.assertLess(Path(descriptor['path']).stat().st_size,15000)
            for name in ('full','reduced'):
                Path(folder,name+'.urdf').write_text('<robot/>')
            record=json.loads(Path(descriptor['path']).read_text())
            record['model_snapshots']={name:dict(filename=name+'.urdf',sha256=hashlib.sha256(b'<robot/>').hexdigest()) for name in ('full','reduced')}
            Path(descriptor['path']).write_text(json.dumps(record))
            reader=SourceReader()
            with patch('server.RobotKinematics',FakeKinematics), patch('inspection_artifacts.np.load',wraps=np.load) as load:
                raw=reader.read(descriptor)
                self.assertIs(reader.read(descriptor),raw)
                self.assertEqual(load.call_count,1)
                selected,context=inspect_source(raw,dict(solve_id='result',iteration=1))
                solve=context['selected_solve']
                self.assertFalse(context['episode_available'])
                self.assertEqual(solve['final_prediction'],{})
                self.assertEqual(solve['selected_prediction']['q'][0][5],-1.25)
                self.assertEqual(solve['selected_prediction']['torque_nm'][0][5],-1.75)
                self.assertEqual(solve['selected_iteration'],1)
                self.assertEqual([item['index'] for item in solve['iterations']],[0,1,2])
                self.assertEqual(solve['iterations'][-1]['status'],'SQP cap 2 (ran 1)')
                self.assertTrue(all('prediction' not in item and 'q' not in item for item in solve['iterations']))
                json.dumps(context,allow_nan=False) # no lazy handle or arrays on wire
                view=SolveView(selected,InspectionContext(sqp_iteration='seed'))
                self.assertEqual(view.q[0][5],-.25)
                self.assertEqual(view.torque_nm[0][5],-.75)
                self.assertEqual(SolveView(selected,InspectionContext(sqp_iteration=99)).prediction,None)
                self.assertEqual(SolveView(selected).q[0][5],-1.25)
                handle=selected['iteration_trace']
                with self.assertRaises(ValueError): handle.xu[0,0,0]=100
                self.assertEqual(load.call_count,1)

    def test_path_chunks_cover_aligned_bounded_snapshots_once(self):
        with tempfile.TemporaryDirectory() as folder:
            longer=trace(k=4)
            meta=metadata();meta['requested']['sqp_iters']=4
            meta['runs']=[dict(meta['runs'][0],cap=k) for k in range(1,5)]
            descriptor=write_artifact(folder,longer,meta)
            handle=ReadOnlyIterationTrace(descriptor,FakeKinematics())
            with patch.object(FakeKinematics,'ee_positions',autospec=True,side_effect=lambda self,q:np.asarray(q)[:,:3]) as fk:
                chunk=handle.path_chunk(3,max_points=6) # two N=3 snapshots per chunk
                self.assertEqual((chunk['start'],chunk['stop']),(2,4))
                self.assertEqual(chunk['ee_xyz'][1],[list(row) for row in handle.prediction(3)['ee_xyz']])
                self.assertIs(handle.path_chunk(2,max_points=6),chunk)
                self.assertEqual(fk.call_count,3) # two chunk snapshots and one selected prediction
                last=handle.path_chunk(4,max_points=6)
                self.assertEqual((last['start'],last['stop']),(4,5))
            self.assertEqual(len(handle.path_chunk(0)['ee_xyz']),5)
            self.assertIsNone(handle.path_chunk(5))
            self.assertIsNone(ReadOnlyIterationTrace(descriptor).path_chunk(0)) # no captured FK
            json.dumps(chunk,allow_nan=False)

    def test_standalone_inspection_default_ignores_episode_cursor_with_null_selector(self):
        retained=dict(plan(),id='standalone-result',origin='inspection',sim_time_s=None,
                      q=[[.25]*7]*3,knot_time_s=[0.,.03,.06])
        raw=dict(source=dict(kind='inspection',id='standalone-result'),states=[],plans=[retained])
        for cursor in (0.,999.):
            selected,context=inspect_source(raw,dict(solve_seq=None,iteration=None),
                                            dict(mode='entire',cursor_s=cursor))
            self.assertIsNotNone(selected)
            self.assertEqual(selected['id'],'standalone-result')
            self.assertEqual(context['association'],'standalone solve')
            self.assertFalse(context['episode_available'])
            self.assertEqual(context['selected_solve']['id'],'standalone-result')
            self.assertTrue(context['selected_solve']['final_prediction'])
        with self.assertRaisesRegex(ValueError,'not retained'):
            inspect_source(raw,dict(solve_id='missing'),dict(cursor_s=0.))

    def test_missing_exact_reference_and_bounds_do_not_use_display_geometry(self):
        for key in ('initial_state','reference_native','problem_configuration','constraint_bounds_native'):
            p=plan();p.pop(key)
            with self.assertRaisesRegex(ValueError,key): captured_problem(p)
        p=plan();p['reference_native']=[[0]*3]*3
        with self.assertRaisesRegex(ValueError,'reference'): captured_problem(p)
        p=plan();p['constraint_bounds_native'][0]['active']=[]
        with self.assertRaisesRegex(ValueError,'activity mask'): captured_problem(p)

    def test_preserves_explicit_parameters_without_changing_selected_problem(self):
        original=plan();saved=deepcopy(original)
        problem=captured_problem(original)
        self.assertEqual(problem['problem_configuration'],saved['problem_configuration'])
        problem['problem_configuration']['solver']['max_sqp_iters']=1000
        self.assertEqual(original,saved)

    def test_pre_migration_recordings_report_run_again_unavailable(self):
        p=plan();p['problem_configuration']=dict(N=3,dt_s=.03,solver_params=dict(max_sqp_iters=5),controller={})
        with self.assertRaisesRegex(ValueError,'unavailable: pre-migration recording'): captured_problem(p)
        p=plan();p['problem_configuration'].pop('type')
        with self.assertRaisesRegex(ValueError,'unavailable: pre-migration recording'): captured_problem(p)
        p=plan();p['problem_configuration']['solver'].pop('type')
        with self.assertRaisesRegex(ValueError,'captured MpcParams are incomplete'): captured_problem(p)

    def test_previous_cost_api_is_viewable_but_cannot_be_run_again(self):
        p = plan()
        p['problem_configuration']['solver']['type'] = 'SolverParams'
        p['problem_configuration'].pop('cost')
        with self.assertRaisesRegex(ValueError, 'previous cost API'):
            captured_problem(p)

    def test_reference_preserves_disabled_orientation_and_rejects_partial_targets(self):
        p = plan()
        p['reference_native'] = [[.1, .2, .3, None, None, None],
                                 [.2, .3, .4, 0., .4, 0.],
                                 [.3, .4, .5, None, None, None]]
        self.assertEqual(captured_problem(p)['reference_native'], p['reference_native'])
        json.dumps(captured_problem(p), allow_nan=False)
        p['reference_native'][0][3] = 0.
        with self.assertRaisesRegex(ValueError, 'reference'):
            captured_problem(p)

    def test_previous_friction_api_is_viewable_but_cannot_be_run_again(self):
        for nested in (False, True):
            p = plan()
            if nested:
                p['problem_configuration']['friction'] = dict(type='Friction', coulomb_nm=[1.]*7,
                    viscous_nm_s_per_rad=[2.]*7, law=dict(type='Tanh', width_rad_s=.2))
            else:
                p['problem_configuration'].pop('friction_law')
            original = deepcopy(p)
            with self.subTest(nested=nested), self.assertRaisesRegex(ValueError, 'previous friction API'):
                captured_problem(p)
            from inspection_problem import run_again_capability
            capability = run_again_capability(p)
            self.assertFalse(capability['available'])
            self.assertIn('recorded motion', capability['reason'])
            self.assertEqual(p, original)

    def test_native_capture_has_finite_shape_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            bad=trace();bad.xu=bad.xu[:1]
            with self.assertRaisesRegex(ValueError,'shape'):write_artifact(folder,bad,metadata())


class NativeOperationTests(unittest.TestCase):
    def test_independent_cold_caps_keep_seed_objective_bounds_and_actual_work_separate(self):
        from live_mpc import import_tiago
        from tests.tiago_mpc_source import MPC_ROOT
        import_tiago(MPC_ROOT)
        from dataclasses import replace
        import tiago_mpc as tm
        made, closed, initial_closed = [], [], []
        params = replace(tm.TIAGO, N=3, cost=tm.default_cost(3, orientation=2., terminal_orientation=5.),
                         solver=replace(tm.TIAGO.solver, max_sqp_iters=3))
        class Solver:
            def __init__(self, cap):
                self.cap, self.configured, self.masks, self.resets = cap, [], [], []
            def solve(self, x, reference, xu_warm=None, *, budget_s=None):
                self.inputs = x.copy(), reference.copy(), xu_warm.copy(), budget_s
                # A solver may mutate borrowed inputs: later caps still get fresh copies.
                result = xu_warm.copy()
                result[0, 14] += self.cap
                xu_warm[:] = 999.
                reference[:] = 999.
                actual = 1 if self.cap == 3 else self.cap
                self.result = result.copy()
                return SimpleNamespace(xu=result,solve_time_us=1234,stats=SimpleNamespace(
                    sqp_iters=np.array([actual]),pcg_iters=np.ones((actual,1),dtype=int)*4,
                    budget_hit=self.cap==3,kkt_converged=np.array([False]),
                    final_merit=np.array([3.]),min_merit=np.array([[6.],[3.]]),step_size=np.array([[1.]]),
                    row_max_violation=np.array([[.1],[.2],[.3],[.4]])))
            def set_cost_menu(self, menu): self.menu = menu
            def get_row_groups(self): return groups()+[dict(kind=5,n_rows=4)]
            def set_row_group_bounds(self,g,lo,hi): self.configured.append((g,lo.copy(),hi.copy()))
            def set_row_group_mask(self,g,mask): self.masks.append((g,mask.copy()))
            def reset_dual(self): self.resets.append('dual')
            def reset_rho(self): self.resets.append('rho')
            def set_admm_linsys(self, mode): self.linsys = mode
        class FakeMpc:
            def __init__(self, configured, binary):
                self.params=configured
                self.controller=SimpleNamespace(admm_linsys='auto',solver=Solver(configured.solver.max_sqp_iters))
                made.append(self)
                self.binary=binary
            def close(self): closed.append(self)
        session=SimpleNamespace(mpc=SimpleNamespace(params=params,close=lambda:initial_closed.append(True)),
            binary=Path('cached-only.so'),model_identity={},configuration=tm.to_dict(params),
            tiago=SimpleNamespace(GRASP_FRAME='tool'),kinematics=SimpleNamespace(fixed_joints={'torso_lift_joint':.27}))
        p=plan();p['problem_configuration']=tm.to_dict(params)
        p['reference_native']=[[.1,.2,.3,None,None,None],[.2,.3,.4,0.,.4,0.],[.3,.4,.5,0.,.4,0.]]
        p['constraint_bounds_native'][0]['lo'][5]=-.7
        p['constraint_bounds_native'][0]['hi'][5]=1.3
        p['constraint_bounds_native'][1]['active'][1]=63
        original=deepcopy(p)
        with tempfile.TemporaryDirectory() as folder, patch('tiago_mpc.mpc.Mpc',FakeMpc), \
                patch('inspection_worker.snapshot_models',return_value={}):
            result=inspect_solve(session,dict(id='caps',problem=captured_problem(p),sqp_iters=3,budget_s=.02,
                original={'solve_id':'chosen'},actual_solver_profile={'profile':{'id':'active'}},artifact_directory=folder))
            self.assertEqual(len(made),3)
            self.assertEqual(closed,made)
            self.assertEqual(initial_closed,[True])
            for cap,mpc in enumerate(made,1):
                solver=mpc.controller.solver
                self.assertEqual(mpc.params.solver.max_sqp_iters,cap)
                self.assertEqual(mpc.binary,session.binary)
                np.testing.assert_array_equal(solver.inputs[0],np.full((1,14),[.2]*7+[.1]*7,dtype=np.float32))
                np.testing.assert_array_equal(solver.inputs[1].reshape(3,6)[:,:3],np.array(p['reference_native'],dtype=np.float32)[:,:3])
                np.testing.assert_array_equal(solver.inputs[1].reshape(3,6)[:,3:],0.)
                held=np.zeros((3,21),dtype=np.float32);held[:,:14]=[.2]*7+[.1]*7
                np.testing.assert_array_equal(solver.inputs[2],held.reshape(1,-1)[:,:-7])
                self.assertEqual(solver.inputs[3],.02)
                np.testing.assert_allclose(solver.menu.frame_pos.target,np.array(p['reference_native'],dtype=float)[:,:3])
                np.testing.assert_allclose(solver.menu.orientation.weight[:,0],[0.,2.,5.])
                self.assertFalse(np.allclose(solver.menu.orientation.target,np.eye(3)))
                self.assertEqual(solver.configured[0][1][5],-.7)
                self.assertEqual(solver.configured[0][2][5],1.3)
                self.assertEqual(len(solver.configured),3)  # the appended collision group is untouched
                self.assertFalse(solver.masks[1][1][1,6])
                self.assertEqual(solver.resets,['dual','rho'])
                self.assertEqual(solver.linsys,'pcg')
            self.assertEqual(p,original)
            self.assertEqual(params.cost.orientation.weight[0][0],2.)
            record=json.loads(Path(result['path']).read_text())
            self.assertEqual(record['fixed_joints'],{'torso_lift_joint':.27})
            self.assertEqual(result['mode'],'independent_sqp_caps')
            self.assertEqual(result['solves_run'],3)
            self.assertEqual(result['snapshot_count'],4)
            self.assertEqual([run['actual_sqp_iters'] for run in record['runs']],[1,2,1])
            self.assertEqual(record['runs'][-1]['stop_reason'],'wall_budget')
            self.assertEqual(record['runs'][0]['diagnostics']['row_max_violation'],[[.1],[.2],[.3],[.4]])
            self.assertNotIn('actual_configuration',record['runs'][0])
            self.assertNotIn('xu',json.dumps(result))
            with np.load(result['binary_path'],allow_pickle=False) as saved:
                for i,mpc in enumerate(made,1):
                    np.testing.assert_array_equal(saved['xu'][i],mpc.controller.solver.result)

    def test_capture_reads_actual_installed_native_bounds_not_display_limits(self):
        installed=groups()
        installed[0]['lo'][5],installed[0]['hi'][5]=-.7,1.3
        captured=capture_constraint_bounds(SimpleNamespace(get_row_groups=lambda:installed))
        self.assertAlmostEqual(captured[0]['lo'][5],-.7)
        self.assertAlmostEqual(captured[0]['hi'][5],1.3)
        self.assertEqual(captured[0]['hi'][0],1.9) # raw2 minus configured .1
        self.assertEqual(captured[1]['hi'][0],.8)
        self.assertEqual(captured[2]['hi'][0],8.5)


def contract():
    return dict(world_from_reference=np.eye(4).tolist(),tcp_offset=np.eye(4).tolist())


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.folder=Path(self.temp.name)
        self.history=HistoryStore(self.folder/'history');self.history.append([segment(),dict(recorded(plan()),type='plan',id='7',seq=7)])
        self.profile=dict(id='active',mpc_root='/selected/mpc',python='/selected/python',cache='/selected/cache')
        self.live=SimpleNamespace(history_store=self.history, pauses=[], generation=0, generation_listeners=[],
                                  pause_for_inspection=lambda identifier,timeout:self.live.pauses.append(identifier))
        self.profiles=SimpleNamespace(active_selection=lambda identifier=None:deepcopy(self.profile))
        self.plots=SimpleNamespace(mpc_root='/simulator',default_scene={},replays=SimpleNamespace(current=None,listeners=[]),
            _descriptor=lambda source:self.history.plot_source(source['generation']))
        self.probe=lambda selection, **kwargs:dict(compatible=True,available_N=[3],available_N_by_friction=dict(off=[3],on=[]),
            contract=contract(),capabilities=dict(iteration_capture_by_friction=dict(off={'3':True},on={})))
        self.calls=[]
        parent=self
        class Remote:
            epoch='isolated-epoch'
            def __init__(self,profile,lease_fds):parent.calls.append(('construct',deepcopy(profile)));self.stopped=False
            def request(self,operation,**payload):
                parent.calls.append((operation,payload))
                if operation=='bootstrap':return dict(contract=contract())
                if operation=='configure':return dict(capabilities={'iteration_capture':True})
                if operation=='inspect':
                    data=metadata(payload['id']);data.update(solver_profile=payload['actual_solver_profile'])
                    return write_artifact(payload['artifact_directory'],trace(),data)
            def close(self):parent.calls.append(('close',None))
            def terminate(self,reason):self.stopped=True
        self.remote=Remote
        class Locks:
            handles=[]
            def __init__(self,root):pass
            def acquire(self):parent.calls.append(('lock',None));return True
            def release(self):parent.calls.append(('unlock',None))
        self.locks=Locks
        self.service=InspectionService(self.plots,self.profiles,live=self.live,directory=self.folder/'inspections',
            process_factory=self.remote,locks_factory=self.locks,probe=self.probe)

    def tearDown(self):self.service.close();self.history.close();self.temp.cleanup()

    def request(self,**values):
        return dict(source=dict(kind='live',generation=0),selection=dict(solve_id='7'),sqp_iters=2,profile_id='active',**values)

    def wait(self,identifier):
        end=time.monotonic()+3
        while time.monotonic()<end:
            result=self.service.job(identifier)
            if result['state'] in ('completed','failed','busy','cancelled'):return result
            time.sleep(.01)
        self.fail('Inspection job did not complete')

    def test_async_result_links_original_and_does_not_mutate_history(self):
        before=self.history.path.read_bytes()
        accepted=self.service.submit(self.request(budget_s=.1))
        result=self.wait(accepted['id'])
        self.assertEqual(result['state'],'completed',result)
        self.assertEqual(result['source'],dict(kind='inspection',id=result['id']))
        self.assertEqual(result['original_solve_id'],'7')
        self.assertEqual(result['actual_solver_profile']['profile'],self.profile)
        self.assertEqual(result['solves_run'],2)
        self.assertEqual(result['snapshot_count'],3)
        self.assertEqual(result['stop_reason'],'independent_caps_completed')
        self.assertEqual(self.live.pauses,[result['id']])
        self.assertEqual(self.history.path.read_bytes(),before)
        self.assertEqual([op for op,_ in self.calls],['lock','construct','bootstrap','configure','inspect','close','unlock'])
        # The captured MpcParams with the requested cap; the child replaces max_sqp_iters.
        self.assertEqual(dict(self.calls)['configure'],dict(params=plan()['problem_configuration'],max_sqp_iters=2,timeout=120))
        self.assertLess(len(json.dumps(result)),20000)
        self.assertNotIn('xu',json.dumps(result))
        self.assertTrue(Path(self.service.descriptor(result['id'])['binary_path']).exists())

    def new_generation(self,generation):
        self.live.generation=generation
        for listener in self.live.generation_listeners:listener(generation)

    def test_live_preview_in_main_history_precedes_the_detached_preview_store(self):
        preview = dict(recorded(plan()), origin='preview', type='plan', seq=1, id='1')
        self.history.append([preview])
        previews = HistoryStore(self.folder/'previews')
        try:
            detached = dict(preview, initial_state=dict(q=[.9]*7, qd=[0.]*7, time_s=3.))
            previews.append([segment(), detached])
            self.live.inspection_store = previews
            def descriptor(source):
                return dict(self.history.plot_source(source['generation']),
                            preview_source=previews.plot_source(source['generation']))
            self.plots._descriptor = descriptor
            body = dict(self.request(), selection=dict(solve_id='preview:1'))
            with patch.object(previews, 'selected_plan', side_effect=AssertionError('Read detached duplicate')):
                problem, identifier = self.service._problem(self.service._request(body, capability=True))
                self.assertEqual(identifier, 'preview:1')
                self.assertEqual(problem['initial_state'], preview['initial_state'])
                self.assertTrue(self.service.capability(body)['available'])
                incomplete = dict(preview, id='2', seq=2)
                incomplete.pop('reference_native')
                self.history.append([incomplete])
                previews.append([dict(detached, id='2', seq=2)])
                body['selection'] = dict(solve_id='preview:2')
                with self.assertRaisesRegex(ValueError, 'reference_native'):
                    self.service._problem(self.service._request(body, capability=True))
        finally:
            previews.close()

    def test_preview_fallback_requires_a_valid_primary_source_and_detached_prefix(self):
        from history_store import HistoryGenerationError
        previews = HistoryStore(self.folder/'previews')
        try:
            preview = dict(recorded(plan()), origin='preview', type='plan', seq=1, id='1')
            previews.append([segment(), preview])
            self.live.inspection_store = previews
            def descriptor(source):
                return dict(self.history.plot_source(source['generation']),
                            preview_source=previews.plot_source(source['generation']))
            self.plots._descriptor = descriptor
            body = dict(self.request(), selection=dict(solve_id='preview:1'))
            request = self.service._request(body, capability=True)
            self.assertEqual(self.service._problem(request)[0], captured_problem(dict(plan(), **preview)))
            with patch.object(previews, 'selected_plan', side_effect=AssertionError('Fell back from invalid primary')):
                for changes, error in ((dict(byte_end=request['descriptor']['byte_end']-1), ValueError),
                                       (dict(path='/wrong/history.jsonl'), HistoryGenerationError),
                                       (dict(generation=9), HistoryGenerationError)):
                    stale = deepcopy(request)
                    stale['descriptor'].update(changes)
                    with self.subTest(changes=changes), self.assertRaises(error):
                        self.service._problem(stale)
            stale = deepcopy(request)
            stale['descriptor']['preview_source']['generation'] = 9
            with self.assertRaisesRegex(ValueError, 'not retained'):
                self.service._problem(stale)
        finally:
            previews.close()

    def test_optional_missing_plan_lookup_keeps_descriptor_and_default_lookup_validation(self):
        from history_store import HistoryGenerationError
        descriptor = self.history.plot_source(0)
        self.assertIsNone(self.history.selected_plan(descriptor, 'preview:missing', missing_ok=True))
        with self.assertRaisesRegex(ValueError, 'not retained'):
            self.history.selected_plan(descriptor, 'preview:missing')
        with self.assertRaisesRegex(ValueError, 'prefix'):
            self.history.selected_plan(dict(descriptor, byte_end=descriptor['byte_end']-1),
                                       'preview:missing', missing_ok=True)
        with self.assertRaises(HistoryGenerationError):
            self.history.selected_plan(dict(descriptor, generation=9), 'preview:missing', missing_ok=True)
        with self.assertRaisesRegex(ValueError, 'retained solve id'):
            self.history.selected_plan(descriptor, True, missing_ok=True)

    def test_results_live_in_ram_only_while_their_source_is_current(self):
        # Felix, 2026-10-23: runtime scratch; a Live result goes with its run.
        result=self.wait(self.service.submit(self.request())['id'])
        folder=Path(self.service.descriptor(result['id'])['path']).parent
        self.assertEqual(folder.parent,self.folder/'inspections'/f'p{os.getpid()}')
        self.new_generation(0)  # the same run stays current
        self.assertTrue(folder.is_dir())
        self.new_generation(1)
        self.assertFalse(folder.exists())
        with self.assertRaisesRegex(ValueError,'no longer current'):self.service.descriptor(result['id'])

    def test_replay_results_go_when_another_recording_is_loaded(self):
        self.plots._descriptor=lambda source:dict(kind='replay',id=source['id'],revision='r1')
        self.service._problem=lambda request:(captured_problem(plan()),'7')
        notify=lambda current:[listener(current) for listener in self.plots.replays.listeners]
        self.plots.replays.current=('a','r1')
        result=self.wait(self.service.submit(dict(self.request(),source=dict(kind='replay',id='a')))['id'])
        self.assertEqual(result['state'],'completed',result)
        folder=Path(self.service.descriptor(result['id'])['path']).parent
        self.new_generation(1)  # Live changes do not touch Replay results
        self.assertTrue(folder.is_dir())
        notify(('a','r2'))  # the same recording reloaded at a new revision
        self.assertFalse(folder.exists())

    def test_failed_jobs_leftovers_and_close_leave_nothing(self):
        stale=self.folder/'other'/'p999999999'/'old';stale.mkdir(parents=True)
        InspectionService(self.plots,self.profiles,directory=self.folder/'other').close()
        self.assertEqual(list((self.folder/'other').iterdir()),[])  # ended server's leftovers and own results
        class Failing(self.remote):
            def request(remote,operation,**payload):
                if operation=='inspect':
                    Path(payload['artifact_directory'],'partial').write_text('x')
                    raise RuntimeError('native failure')
                return super().request(operation,**payload)
        self.service.process_factory=Failing
        result=self.wait(self.service.submit(self.request())['id'])
        self.assertEqual(result['state'],'failed',result)
        self.assertFalse((self.service.directory/result['id']).exists())
        self.service.close()
        self.assertFalse(self.service.directory.exists())

    def test_profile_with_templates_is_checked(self):
        # Profiles carry a templates dict since 8f7fdd5; Run again failed with
        # "unhashable type: 'dict'" while caching the profile probe.
        self.profile['templates']=dict(reach=dict(N=3))
        capability=self.service.capability(self.request())
        self.assertTrue(capability['available'],capability)

    def test_capped_solves_work_without_native_iteration_capture(self):
        self.service.probe=lambda *args,**kwargs:dict(compatible=True,available_N=[3],
            available_N_by_friction=dict(off=[3],on=[]),contract=contract(),capabilities=dict(python_iteration_capture=False))
        capability=self.service.capability(self.request())
        self.assertTrue(capability['available'],capability)
        self.assertEqual(capability['mode'],'independent_sqp_caps')
        result=self.wait(self.service.submit(self.request())['id'])
        self.assertEqual(result['state'],'completed',result)
        self.assertEqual(result['solves_run'],2)
        self.assertEqual(self.live.pauses,[result['id']])
        self.assertIn('inspect',[operation for operation,_ in self.calls])

    def cached_profile(self):
        root = self.folder/'mpc'
        (root/'tiago_mpc').mkdir(parents=True)
        source = root/'tiago_mpc/mpc.py'; source.write_text('# original')
        cache = self.folder/'cache'
        module = cache/'modules/tiago/current/bsqpN3_tiago.so'
        module.parent.mkdir(parents=True); module.write_bytes(b'old native binary')
        python = self.folder/'venv/bin/python'
        python.parent.mkdir(parents=True); python.write_text('test interpreter')
        self.profile.update(mpc_root=str(root), python=str(python), cache=str(cache))
        original = self.probe
        self.probes = []
        def counted(selection, **kwargs):
            self.probes.append(deepcopy(selection))
            return original(selection, **kwargs)
        self.service.probe = counted
        return source, module, python

    def test_following_different_solves_reuses_probe_but_checks_each_captured_problem(self):
        self.cached_profile()
        self.assertTrue(self.service.capability(self.request())['available'])
        self.history.append([dict(plan(),type='plan',id='8',seq=8)])
        request = self.request(); request['selection'] = dict(solve_id='8')
        self.assertTrue(self.service.capability(request)['available'])
        missing = dict(plan(),type='plan',id='9',seq=9); missing.pop('reference_native')
        self.history.append([missing])
        request['selection'] = dict(solve_id='9')
        result = self.service.capability(request)
        self.assertFalse(result['available'])
        self.assertIn('reference_native',result['reason'])
        wrong_contract = dict(plan(),type='plan',id='10',seq=10,
                              solver_profile=dict(coordinate_contract=dict(nq=99)))
        self.history.append([wrong_contract])
        request['selection'] = dict(solve_id='10')
        result = self.service.capability(request)
        self.assertFalse(result['available'])
        self.assertIn('nq',result['reason'])
        unsupported = dict(plan(),type='plan',id='11',seq=11,N=4,
                           reference_native=[[.1,.2,.3,0,0,0]]*4,
                           constraint_bounds_native=groups(4))
        unsupported['problem_configuration']['N'] = 4
        self.history.append([unsupported])
        request['selection'] = dict(solve_id='11')
        result = self.service.capability(request)
        self.assertFalse(result['available'])
        self.assertIn('N=4',result['reason'])
        # The same captured model reuses its probe; a different N/model is
        # checked independently rather than assuming one profile-wide answer.
        self.assertEqual(len(self.probes),2)
        self.assertEqual(self.calls,[])

    def test_capability_cache_invalidates_for_rebuild_source_environment_and_profile(self):
        source, module, python = self.cached_profile()
        def check(count):
            request = self.request(); request['profile_id'] = self.profile['id']
            result = self.service.capability(request)
            self.assertTrue(result['available'], result)
            self.assertEqual(len(self.probes),count)
        check(1); check(1)
        # Replacement at the same path, preserving size and mtime, must still
        # invalidate: rebuilds can preserve names and restored timestamps.
        stamp = module.stat()
        replacement = module.with_suffix('.new'); replacement.write_bytes(module.read_bytes())
        os.utime(replacement, ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
        replacement.replace(module)
        check(2)
        source.write_text('# updated source'); check(3)
        python.write_text('new interpreter'); check(4)
        self.profile['id'] = 'replacement-profile'; check(5)
        new_module = module.with_name('bsqpN32_tiago.so'); new_module.write_bytes(b'new N')
        check(6)
        new_module.unlink(); check(7)

    def test_absent_native_capture_does_not_disable_capped_solves_and_probe_stays_cached(self):
        _, module, _ = self.cached_profile()
        counted = self.service.probe
        def without_capture(selection, **kwargs):
            result = counted(selection, **kwargs)
            result['capabilities']['iteration_capture_by_friction']['off']['3'] = False
            return result
        self.service.probe = without_capture
        for _ in range(3):
            result = self.service.capability(self.request())
            self.assertTrue(result['available'],result)
            self.assertEqual(result['mode'],'independent_sqp_caps')
        self.assertEqual(len(self.probes),1)
        self.service.probe = counted
        module.write_bytes(b'capture-capable rebuilt binary')
        self.assertTrue(self.service.capability(self.request())['available'])
        self.assertEqual(len(self.probes),2)

    def test_capability_cache_watches_installed_and_editable_gato_sources(self):
        _, _, python = self.cached_profile()
        packages = python.parent.parent / 'lib/python3.10/site-packages'
        installed = packages / 'gato/interface.py'
        installed.parent.mkdir(parents=True); installed.write_text('# installed GATO')
        metadata = packages / 'gato_mpc-0.1.5.dist-info'
        metadata.mkdir(); (metadata/'METADATA').write_text('Version: 0.1.5\n')
        direct_url = metadata/'direct_url.json'
        editable = self.folder/'editable-gato/python/gato/interface.py'
        editable.parent.mkdir(parents=True); editable.write_text('# editable GATO')
        self.assertTrue(self.service.capability(self.request())['available'])
        self.service.capability(self.request()); self.assertEqual(len(self.probes), 1)
        installed.write_text('# changed installed GATO')
        self.service.capability(self.request()); self.assertEqual(len(self.probes), 2)
        direct_url.write_text(json.dumps(dict(url=(self.folder/'editable-gato').as_uri(), dir_info=dict(editable=True))))
        self.service.capability(self.request()); self.assertEqual(len(self.probes), 3)
        editable.write_text('# changed editable GATO')
        self.service.capability(self.request()); self.assertEqual(len(self.probes), 4)

    def test_concurrent_capability_checks_share_one_probe(self):
        self.cached_profile()
        entered, release = threading.Event(), threading.Event()
        counted = self.service.probe
        def slow(selection, **kwargs):
            entered.set()
            if not release.wait(3):
                raise AssertionError('Test did not release source probe')
            return counted(selection, **kwargs)
        self.service.probe = slow
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.service.capability(self.request())))
                   for _ in range(4)]
        try:
            for thread in threads: thread.start()
            self.assertTrue(entered.wait(2))
        finally:
            release.set()
            for thread in threads: thread.join(timeout=3)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(results),4)
        self.assertTrue(all(result['available'] for result in results),results)
        self.assertEqual(len(self.probes),1)

    def test_changes_during_probe_are_not_cached_as_current(self):
        source, _, _ = self.cached_profile()
        counted = self.service.probe
        def changing(selection, **kwargs):
            result = counted(selection, **kwargs)
            source.write_text('# source changed during probe')
            return result
        self.service.probe = changing
        result = self.service.capability(self.request())
        self.assertFalse(result['available'])
        self.assertIn('changed while checking',result['reason'])
        self.service.probe = counted
        self.assertTrue(self.service.capability(self.request())['available'])
        self.assertEqual(len(self.probes),2)

    def test_canonical_busy_never_constructs_a_solver(self):
        self.service.locks_factory=lambda root:SimpleNamespace(acquire=lambda:False)
        result=self.wait(self.service.submit(self.request())['id'])
        self.assertEqual(result['state'],'busy')
        self.assertEqual(self.calls,[])
        self.assertIn('locks',result['message'])

    def test_missing_explicit_replay_trajectory_never_substitutes_latest_plan(self):
        request=self.request()
        request['source']=dict(kind='replay',id='recorded')
        request['selection']=dict(trajectory_index=99)
        self.plots._descriptor=lambda source:dict(kind='replay',id='recorded')
        raw=dict(plans=[dict(plan(),id='first',trajectory_index=2),dict(plan(),id='latest',trajectory_index=4)])
        with patch.object(self.service.reader,'read',return_value=raw):
            result=self.wait(self.service.submit(request)['id'])
        self.assertEqual(result['state'],'failed')
        self.assertIn('not a retained solve',result['error'])
        self.assertEqual(self.calls,[])
        self.assertEqual(self.live.pauses,[])

    def test_invalid_caps_and_budget_are_rejected_before_enqueue(self):
        for value in (0,-1,True,1.5,float('inf'),10001):
            request=self.request();request['sqp_iters']=value
            with self.assertRaises(ValueError):self.service.submit(request)
        for value in (0,-1,True,float('nan'),float('inf'),'1'):
            with self.assertRaises(ValueError):self.service.submit(self.request(budget_s=value))

    def test_http_submission_poll_capability_stop_and_same_origin(self):
        server=make_server(dict(source={},trajectories=[]),'',{},host='127.0.0.1',port=0,
                           inspections=self.service)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        def post(path,body,origin=None):
            headers={'Content-Type':'application/json'}
            if origin is not None:headers['Origin']=origin
            with urlopen(Request(base+path,json.dumps(body).encode(),headers)) as response:
                return response.status,json.load(response)
        try:
            status,capability=post('/api/solve-inspections/capability',self.request())
            self.assertEqual(status,200);self.assertTrue(capability['available'],capability)
            status,accepted=post('/api/solve-inspections',self.request())
            self.assertEqual(status,202)
            result=self.wait(accepted['id'])
            with urlopen(base+'/api/solve-inspections/jobs/'+accepted['id']) as response:
                self.assertEqual(json.load(response)['source'],result['source'])
            self.assertEqual(post('/api/solve-inspections/jobs/'+accepted['id']+'/stop',{})[0],200)
            with self.assertRaises(HTTPError) as error:
                post('/api/solve-inspections',self.request(),origin='http://unrelated.example')
            self.assertEqual(error.exception.code,403)
            with self.assertRaises(HTTPError) as error:
                post('/api/solve-inspections/jobs/missing/stop',{})
            self.assertEqual(error.exception.code,404)
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2)

    def test_queued_stop_constructs_nothing_and_running_stop_terminates_only_its_child(self):
        entered=threading.Event();release=threading.Event()
        original=self.remote.request
        def blocked(remote,operation,**payload):
            if operation=='inspect':
                entered.set();release.wait(3)
                if remote.stopped:raise RuntimeError('explicitly stopped')
            return original(remote,operation,**payload)
        def terminate(remote,reason):remote.stopped=True;release.set()
        with patch.object(self.remote,'request',blocked),patch.object(self.remote,'terminate',terminate):
            first=self.service.submit(self.request());self.assertTrue(entered.wait(3))
            second=self.service.submit(self.request())
            self.assertEqual(self.service.stop(second['id'])['state'],'cancelled')
            self.assertEqual(self.service.stop(first['id'])['state'],'cancelled')
            end=time.monotonic()+3
            while self.service.active is not None and time.monotonic()<end:time.sleep(.01)
            self.assertEqual(sum(op=='construct' for op,_ in self.calls),1)
            self.assertEqual(self.service.job(first['id'])['state'],'cancelled')
            self.assertEqual(self.service.job(second['id'])['state'],'cancelled')
