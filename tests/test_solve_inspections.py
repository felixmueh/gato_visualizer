"""CPU proof of single-call capture, binary transport, bounds and job ownership."""
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

from execution_bridge import HistoryStore
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
        problem_configuration=dict(N=3, dt_s=.03, solver=dict(max_sqp_iters=5), admm=dict(rho=.01),
            admm_linsys='pcg', joint_margin_rad=.1, velocity_fraction=.8, effort_fraction=.85, friction=None),
        joint_limits=dict(lower_position_rad=[-2]*7,upper_position_rad=[2]*7,
                          velocity_rad_s=[1]*7,effort_nm=[10]*7),
        constraint_bounds_native=groups(), task=dict(kind='reach',target_offset_m=[0,0,0]),
        model_identity=dict(full_urdf_sha256='original-model'), solver_profile={})


def trace(n=3, k=2):
    xu=np.zeros((k+1,1,21*n-7),dtype=np.float32)
    for i in range(k+1):
        for knot in range(n):
            xu[i,0,21*knot:21*knot+7]=i+.25
            xu[i,0,21*knot+7:21*knot+14]=i+.5
            if knot<n-1:
                xu[i,0,21*knot+14:21*knot+21]=i+.75
    xu[-1]=xu[-2] # authentic zero-PCG shortcut
    return SimpleNamespace(xu=xu,pcg_iters=np.array([[4],[0]],np.int32),
        line_search_ran=np.array([True,False]),stop_reason='zero_pcg',iterations_run=k)


def metadata(identifier='result'):
    p=plan()
    return dict(p,id=identifier,signs=[1,1,1,1,1,-1,1],
        solver_profile=dict(profile=dict(mpc_root='/captured/profile')),end_effector_frame='tool',
        original=dict(source=dict(kind='live',generation=2),solve_id='chosen'),initialization='cold_state',
        diagnostics=dict(min_merit=[[3.]],step_size=[[1.]]),requested=dict(sqp_iters=20,budget_s=None))


class FakeKinematics:
    def __init__(self,*args,**kwargs): pass
    def ee_positions(self,q): return np.asarray(q)[:,:3]
    def target_to_world(self,point): return np.asarray(point)+1


class ArtifactTests(unittest.TestCase):
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
                self.assertEqual(solve['iterations'][-1]['status'],'zero-PCG shortcut')
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
            longer.pcg_iters=np.array([[4]]*3+[[0]],np.int32); longer.line_search_ran=np.array([True]*3+[False])
            descriptor=write_artifact(folder,longer,metadata())
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

    def test_native_capture_has_finite_shape_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            bad=trace();bad.xu=bad.xu[:1]
            with self.assertRaisesRegex(ValueError,'shape'):write_artifact(folder,bad,metadata())


class NativeOperationTests(unittest.TestCase):
    def test_exact_single_cold_solve_and_captured_bounds_signs(self):
        class Solver:
            lib=SimpleNamespace(ITERATION_CAPTURE_AVAILABLE=True)
            calls=0
            configured=[]
            masks=[]
            def solve(self,x,reference,xu_warm=None,*,capture_iterations=False,budget_s=None):
                self.calls+=1
                self.inputs=(x.copy(),reference.copy(),xu_warm,capture_iterations,budget_s)
                return SimpleNamespace(iteration_trace=trace(),solve_time_us=1234,
                    stats=SimpleNamespace(min_merit=np.array([[3.]]),step_size=np.array([[1.]])))
            def get_row_groups(self): return groups()
            def set_row_group_bounds(self,g,lo,hi):self.configured.append((g,lo.copy(),hi.copy()))
            def set_row_group_mask(self,g,mask):self.masks.append((g,mask.copy()))
            def reset_dual(self):pass
            def reset_rho(self):pass
        solver=Solver()
        mpc=SimpleNamespace(signs=np.array([1,1,1,1,1,-1,1]),N=3,dt=.03,params=SimpleNamespace(ee_frame='tool'),
            controller=SimpleNamespace(admm_linsys='pcg',solver=solver))
        session=SimpleNamespace(mpc=mpc,model_identity={'actual':'model'},
            configuration=plan()['problem_configuration'],tiago=SimpleNamespace())
        p=plan()
        # Make the sign conversion observable with asymmetric effective q bounds.
        p['constraint_bounds_native'][0]['lo'][5]=-.7
        p['constraint_bounds_native'][0]['hi'][5]=1.3
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'source'
            (root/'models/tiago_pro').mkdir(parents=True)
            full=root/'models/tiago_pro/tiago_pro.urdf';full.write_text('<robot/>')
            reduced=root/'reduced.urdf';reduced.write_text('<robot/>')
            session.tiago.FULL_URDF,session.tiago.ARM_URDF=full,reduced
            session.model_identity.update(full_urdf_sha256=hashlib.sha256(full.read_bytes()).hexdigest(),
                                          native_urdf_sha256=hashlib.sha256(reduced.read_bytes()).hexdigest())
            result=inspect_solve(session,dict(id='native' ,problem=captured_problem(p),sqp_iters=1000,
                budget_s=.02,original={'solve_id':'chosen'},actual_solver_profile={'profile':{'id':'active','mpc_root':str(root)}},
                artifact_directory=folder))
            self.assertEqual(solver.calls,1)
            self.assertIsNone(solver.inputs[2])
            self.assertTrue(solver.inputs[3])
            self.assertEqual(solver.inputs[4],.02)
            self.assertAlmostEqual(solver.inputs[0][0,5],-.2,places=6)
            self.assertEqual(solver.configured[0][1][5],-1.3)
            self.assertEqual(solver.configured[0][2][5],.7)
            self.assertAlmostEqual(solver.configured[1][2][0],.8)
            self.assertAlmostEqual(solver.configured[2][2][0],8.5)
            self.assertTrue(solver.masks[0][1].all())
            self.assertEqual(result['iterations_run'],2)
            self.assertNotIn('xu',json.dumps(result))
            record=json.loads(Path(result['path']).read_text())
            self.assertEqual(record['constraint_bounds_native'],p['constraint_bounds_native'])
            self.assertEqual(record['joint_limits']['upper_position_rad'],[2]*7)

    def test_capture_reads_actual_installed_native_bounds_not_display_limits(self):
        signed=groups()
        signed[0]['lo'][5],signed[0]['hi'][5]=-1.3,.7
        captured=capture_constraint_bounds(SimpleNamespace(get_row_groups=lambda:signed),[1,1,1,1,1,-1,1])
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
        self.history=HistoryStore(self.folder/'history');self.history.append([dict(plan(),type='plan',id='7',seq=7)])
        self.profile=dict(id='active',mpc_root='/selected/mpc',python='/selected/python',cache='/selected/cache')
        self.live=SimpleNamespace(history_store=self.history, pauses=[],
                                  pause_for_inspection=lambda identifier,timeout:self.live.pauses.append(identifier))
        self.profiles=SimpleNamespace(active_selection=lambda identifier=None:deepcopy(self.profile))
        self.plots=SimpleNamespace(mpc_root='/simulator',default_scene={},
            _descriptor=lambda source:self.history.plot_source(source['generation']))
        self.probe=lambda selection:dict(compatible=True,available_N=[3],available_N_by_friction=dict(off=[3],on=[]),
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
        return dict(source=dict(kind='live',generation=0),selection=dict(solve_id='7'),sqp_iters=1000,profile_id='active',**values)

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
        self.assertEqual(result['iterations_run'],2)
        self.assertEqual(result['stop_reason'],'zero_pcg')
        self.assertEqual(self.live.pauses,[result['id']])
        self.assertEqual(self.history.path.read_bytes(),before)
        self.assertEqual([op for op,_ in self.calls],['lock','construct','bootstrap','configure','inspect','close','unlock'])
        # The captured MpcParams with the requested cap; the child replaces max_sqp_iters.
        self.assertEqual(dict(self.calls)['configure'],dict(params=plan()['problem_configuration'],max_sqp_iters=1000,timeout=120))
        self.assertLess(len(json.dumps(result)),20000)
        self.assertNotIn('xu',json.dumps(result))
        self.assertTrue(Path(self.service.descriptor(result['id'])['binary_path']).exists())

    def test_profile_with_templates_is_checked(self):
        # Profiles carry a templates dict since 8f7fdd5; Run again failed with
        # "unhashable type: 'dict'" while caching the profile probe.
        self.profile['templates']=dict(reach=dict(N=3))
        capability=self.service.capability(self.request())
        self.assertTrue(capability['available'],capability)

    def test_old_native_profile_capability_is_explicit_and_never_constructs_solver(self):
        self.service.probe=lambda *args,**kwargs:dict(compatible=True,available_N=[3],available_N_by_friction=dict(off=[3],on=[]),capabilities={})
        capability=self.service.capability(self.request())
        self.assertFalse(capability['available'])
        self.assertIn('capture',capability['reason'])
        result=self.wait(self.service.submit(self.request())['id'])
        self.assertEqual(result['state'],'failed')
        self.assertEqual(self.calls,[])
        self.assertEqual(self.live.pauses,[])

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
        def counted(selection):
            self.probes.append(deepcopy(selection))
            return original(selection)
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
        self.assertEqual(len(self.probes),1)
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

    def test_negative_capture_capability_is_cached_until_binary_rebuild(self):
        _, module, _ = self.cached_profile()
        counted = self.service.probe
        def without_capture(selection):
            result = counted(selection)
            result['capabilities']['iteration_capture_by_friction']['off']['3'] = False
            return result
        self.service.probe = without_capture
        for _ in range(3):
            result = self.service.capability(self.request())
            self.assertFalse(result['available'])
            self.assertIn('capture',result['reason'])
        self.assertEqual(len(self.probes),1)
        self.service.probe = counted
        module.write_bytes(b'capture-capable rebuilt binary')
        self.assertTrue(self.service.capability(self.request())['available'])
        self.assertEqual(len(self.probes),2)

    def test_concurrent_capability_checks_share_one_probe(self):
        self.cached_profile()
        entered, release = threading.Event(), threading.Event()
        counted = self.service.probe
        def slow(selection):
            entered.set()
            if not release.wait(3):
                raise AssertionError('Test did not release source probe')
            return counted(selection)
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
        def changing(selection):
            result = counted(selection)
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
