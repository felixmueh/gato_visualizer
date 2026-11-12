"""Shared control/recording ownership and process overlap, without a GPU."""
import json
import os
from pathlib import Path
import select
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import sys
from contextlib import contextmanager

import numpy as np

from tests.tiago_mpc_source import EXECUTION
from native_session import NativeSession
from live_presentation import render_plan
from solver_adapter import SimulatorAdapter
from solver_exchange import ControlArrays, RecordingRing, discard_records, resolve_record, take_record, SLOTS
from solver_process import SolverProcess
from tests.test_solver_boundary import config, fake_gpu
from tests.tiago_mpc_source import MPC_ROOT, live_probe


class DeferredRemote:
    """An unread async plan, with deterministic wall cost at collection."""
    def __init__(self, adapter, clock=None):
        self.adapter, self.clock, self.stream_pending = adapter, clock, False
    def start_stream(self, *args, **kwargs):pass
    def submit_stream(self, state, reference):
        self.initial, self.stream_pending = state, True
    def result_stream(self, block=False):
        if not self.stream_pending or not block:return None
        from tiago_mpc.interfaces import Plan
        self.stream_pending = False
        if self.clock:self.clock.value += .001
        state, a = self.initial, self.adapter
        return Plan(state.t, a.dt, np.tile(np.r_[state.q,state.qd], (a.N,1)),
                    np.full((a.N-1,7),3.),dict(wall_s=.001,controller_wall_s=.001),measured_t=state.t),None
    def end_stream(self):self.stream_pending=False


class ExchangeTests(unittest.TestCase):
    def test_recording_budget_controls_capacity_and_attached_consumers_use_file_layout(self):
        from solver_exchange import RECORDING_BUFFER_ENV, SLOT_BYTES, SLOT_HEADER
        with patch.dict(os.environ, {RECORDING_BUFFER_ENV: '32'}):
            ring = RecordingRing()
        try:
            self.assertEqual(ring.slots, (32*1024**2-128)//(SLOT_BYTES+SLOT_HEADER.size))
            self.assertLessEqual(ring.capacity_bytes, 32*1024**2)
            self.assertGreater(ring.slots, SLOTS)
            # Attach ignores the consumer's environment and supports slots above
            # the old 64-entry limit, including consumption after retirement.
            with patch.dict(os.environ, {RECORDING_BUFFER_ENV: 'invalid'}):
                attached = RecordingRing(ring.path)
            try:
                self.assertEqual(attached.slots, ring.slots)
                attached.next_slot = ring.slots-1
                slot = attached.put(7, dict(value=11))
                locator = dict(path=str(ring.path), slot=slot, request_id=7)
            finally:
                attached.close()
        finally:
            ring.close()
        self.assertTrue(ring.path.exists())
        self.assertEqual(take_record(locator), dict(value=11))
        self.assertFalse(ring.path.exists())

    def test_recording_budget_rejects_invalid_or_insufficient_capacity(self):
        from solver_exchange import RECORDING_BUFFER_ENV, recording_slot_bytes, SLOT_BYTES
        for value in ('0', '-1', 'nan', 'inf', '1.5', '4097', '16'):
            with self.subTest(value=value), patch.dict(os.environ, {RECORDING_BUFFER_ENV: value}):
                with self.assertRaises(ValueError):
                    RecordingRing()
        for budget in (float('nan'), 1000.5, -1, 1, 5*1024**3):
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                RecordingRing(budget_bytes=budget)
        with self.assertRaisesRegex(ValueError, 'increase'):
            RecordingRing(slot_bytes=recording_slot_bytes(100000), budget_bytes=32*1024**2)
        with self.assertRaisesRegex(ValueError, 'slot must hold'):
            RecordingRing(slot_bytes=SLOT_BYTES-1)

    def test_raw_capture_is_owned_and_reclaims_before_presentation(self):
        import pickle
        ring = RecordingRing()
        slot = ring.put(9, dict(value=11, _states=np.arange(7.)))
        locator = dict(path=str(ring.path), slot=slot, request_id=9)
        ring.close()
        with patch('solver_exchange.pickle.loads', side_effect=AssertionError('Decoded during ingestion')):
            payload = take_record(locator, raw=True)
        self.assertIsInstance(payload, bytes)
        self.assertFalse(ring.path.exists())
        record = resolve_record(dict(_recording_bytes=payload, value=12, seq=4,
                                     plan_origin_time_s=.1, _schedule=(0., .05, 0., 100., .05)))
        self.assertEqual(record['value'], 12)
        self.assertEqual(record['seq'], 4)
        np.testing.assert_array_equal(record['_states'], np.arange(7.))
        self.assertAlmostEqual(record['scheduled_activation_time_s'], .1)
        self.assertNotIn('_recording_bytes', record)
        with self.assertRaisesRegex(RuntimeError, 'capture failed'):
            resolve_record(dict(_recording_bytes=pickle.dumps(dict(_recording_error='capture failed'))))

    def test_shared_input_rejects_finite_states_outside_float32_range(self):
        from tiago_mpc.interfaces import State
        control = ControlArrays(4, .02)
        try:
            control.write_request(1, State(0., np.full(7, 1e100), np.zeros(7)), np.zeros((4,6)))
            with self.assertRaisesRegex(ValueError, "beyond the solver's range"):
                control.read_request(1)
        finally:
            control.close()

    def test_shared_input_preserves_disabled_and_enabled_orientation_targets(self):
        from tiago_mpc.interfaces import State
        control = ControlArrays(4, .02)
        reference = np.array([[.1, .2, .3, np.nan, np.nan, np.nan],
                              [.2, .3, .4, 0., .2, -.3],
                              [.3, .4, .5, np.nan, np.nan, np.nan],
                              [.4, .5, .6, 0., 0., 0.]], dtype=np.float32)
        state = State(0., np.zeros(7), np.zeros(7))
        try:
            control.write_request(1, state, reference)
            _, received = control.read_request(1)
            np.testing.assert_array_equal(received, reference)
            self.assertFalse(np.shares_memory(received, control.reference))
            # Missing orientation means three NaNs; partial/infinite targets
            # and nonfinite positions remain invalid at the child boundary.
            for row in ([.1, .2, .3, np.nan, 0., 0.],
                        [.1, .2, .3, np.inf, np.inf, np.inf],
                        [np.nan, .2, .3, np.nan, np.nan, np.nan]):
                with self.subTest(row=row):
                    reference[0] = row
                    control.write_request(2, state, reference)
                    with self.assertRaisesRegex(ValueError, 'Reference positions'):
                        control.read_request(2)
        finally:
            control.close()

    def test_combined_lease_submission_completes_a_partial_socket_write(self):
        from solver_process import send_lease
        class Channel:
            def sendmsg(self, buffers, rights):
                self.frame = b''.join(buffers)
                self.rights = rights
                return 3
            def sendall(self, payload):
                self.rest = payload
        channel = Channel()
        send_lease(channel, [], payload=b'S12345678')
        self.assertEqual(channel.frame[:3]+channel.rest, b'LS12345678')

    @contextmanager
    def child_adapter(self, directory, patch_code):
        script=Path(directory)/'worker.py'
        script.write_text('''import os,sys,socket,time
from pathlib import Path
sys.path.insert(0, %r)
root=sys.argv[sys.argv.index('--root')+1]
os.environ['TIAGO_MPC_ROOT']=root
from solver_lifecycle import arm_parent_death_signal
arm_parent_death_signal(int(sys.argv[sys.argv.index('--parent-pid')+1]))
from tests.test_solver_boundary import fake_gpu
from solver_exchange import RecordingRing
from solver_worker import serve
%s
with fake_gpu(),socket.socket(fileno=int(sys.argv[sys.argv.index('--fd')+1])) as channel:
    serve(channel,root)
''' % (str(Path(__file__).resolve().parents[1]),patch_code))
        with fake_gpu():
            profile=dict(id='test-ready',mpc_root=str(MPC_ROOT),python=sys.executable,cache=os.environ['GATO_CACHE_DIR'])
            remote=SolverProcess(profile,script=script)
            adapter=SimulatorAdapter(MPC_ROOT)
            adapter.remote,adapter.profile=remote,profile
            adapter.profile_schema=dict(available_N_by_friction=dict(off=[4],on=[]),source_settings=live_probe().get('source_settings',{}))
            try:
                remote.request('bootstrap')
                adapter.configure(config(),dict(kind='reach',target_offset_m=[0.,0.,0.]))
                yield adapter,remote
            finally:adapter.close_solver()

    def test_close_reclaims_queued_captures_but_preserves_handed_off_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.child_adapter(directory, '') as (adapter, remote):
                execution = dict(EXECUTION, simulation_hz=100000., control_hz=100000.,
                                 to_hz=100000., solve_latency_s=0., latency_compensation=False)
                session = NativeSession(adapter, execution)
                try:
                    first = session.advance_interval(.01)
                    tip = session.progress
                    path = remote.recording.path
                    with session._condition:
                        self.assertTrue(session._condition.wait_for(lambda: len(session._batches) == 2, timeout=3))
                    session.close()
                    self.assertEqual(adapter.t, tip.t)
                    self.assertTrue(path.exists())  # Only the handed-off batch still owns slots.
                    resolved = [resolve_record(r) for r in first]
                    self.assertEqual(sum(r['type'] == 'plan' for r in resolved), tip.solves)
                    self.assertFalse(path.exists())
                finally:
                    session.close()

    def test_control_reply_precedes_capture_readiness_and_next_input_cannot_mutate_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'allow-capture'
            code='''original_put=RecordingRing.put
def delayed_put(self,*a,**kw):
    until=time.monotonic()+5
    while not Path(%r).exists():
        if time.monotonic()>until:raise AssertionError('Control waited for recording')
        time.sleep(.001)
    return original_put(self,*a,**kw)
RecordingRing.put=delayed_put
''' % str(marker)
            with self.child_adapter(directory,code) as (adapter,remote):
                from tiago_mpc.interfaces import State
                remote.start_stream(adapter.N,adapter.dt)
                state=State(0.,adapter.x[:7].copy(),adapter.x[7:].copy())
                first_ref=np.zeros((adapter.N,6),dtype=np.float32)
                remote.submit_stream(state,first_ref)
                first,locator=remote.result_stream(True)
                self.assertEqual(first.t0,0.)
                self.assertFalse(marker.exists())
                next_state=State(.002,np.full(7,.25),np.zeros(7))
                remote.submit_stream(next_state,np.ones((adapter.N,6),dtype=np.float32))
                marker.touch()
                second,next_locator=remote.result_stream(True)
                capture=take_record(locator)
                np.testing.assert_array_equal(capture['initial_state']['q'],state.q)
                np.testing.assert_array_equal(capture['_reference'],first_ref)
                np.testing.assert_array_equal(take_record(next_locator)['initial_state']['q'],next_state.q)
                self.assertEqual(second.t0,.002)

    def test_producer_exit_after_control_reply_releases_unpublished_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.child_adapter(directory,"RecordingRing.put=lambda *a,**kw:sys.exit(17)") as (adapter,remote):
                from tiago_mpc.interfaces import State
                from solver_exchange import RING_HEADER
                remote.start_stream(adapter.N,adapter.dt)
                remote.submit_stream(State(0.,adapter.x[:7],adapter.x[7:]),np.zeros((adapter.N,6)))
                _,locator=remote.result_stream(True)
                remote.process.wait(timeout=5)
                with self.assertRaisesRegex(RuntimeError,'producer ended'):
                    take_record(locator)
                self.assertEqual(RING_HEADER.unpack_from(remote.recording.mapping)[1],0)

    def test_inspection_idle_wait_preserves_the_unread_reply_and_timeout_preserves_the_session(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory)/'allow-capture'
            code = '''original_put=RecordingRing.put
def delayed_put(self,*args,**kwargs):
    until=time.monotonic()+5
    while not Path(%r).exists():
        if time.monotonic()>until:raise AssertionError('Capture was not released')
        time.sleep(.001)
    return original_put(self,*args,**kwargs)
RecordingRing.put=delayed_put
''' % str(marker)
            with self.child_adapter(directory, code) as (adapter, remote):
                session = NativeSession(adapter, dict(EXECUTION, solve_latency_s=.002,
                                                      latency_compensation=False))
                try:
                    records = session.advance_interval(.002)
                    invocation, progress = session._thread, session.progress
                    remote.wait_stream()
                    self.assertTrue(remote.control.busy)
                    with self.assertRaisesRegex(TimeoutError, 'inspection timeout'):
                        remote.wait_idle(timeout=.02)
                    self.assertIs(session._thread, invocation)
                    self.assertIs(session.progress, progress)
                    self.assertTrue(session._parked)
                    self.assertTrue(remote.stream_pending)
                    finished, errors = threading.Event(), []
                    def wait_idle():
                        try:
                            remote.wait_idle(timeout=2)
                        except Exception as error:
                            errors.append(error)
                        finally:
                            finished.set()
                    waiter = threading.Thread(target=wait_idle)
                    waiter.start()
                    self.assertFalse(finished.wait(.03))
                    marker.touch()
                    self.assertTrue(finished.wait(2))
                    waiter.join()
                    self.assertEqual(errors, [])
                    self.assertFalse(remote.control.busy)
                    self.assertTrue(remote.stream_pending)
                    self.assertTrue(select.select([remote.channel], [], [], 0)[0])
                    records.extend(session.advance_interval(.004))
                    records = [resolve_record(record) for record in records]
                    plans = [record for record in records if record['type'] == 'plan']
                    self.assertEqual(len(plans), 1)
                    self.assertEqual(plans[0]['request_time_s'], 0.)
                    self.assertIs(session._thread, invocation)
                finally:
                    marker.touch()
                    session.close()

    def test_inspection_idle_wait_rejects_the_previous_captures_idle_gap_before_the_current_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            capture, received, release = [Path(directory)/name for name in
                                          ('allow-capture', 'second-received', 'allow-second')]
            code = '''import solver_worker
original_put=RecordingRing.put
def delayed_put(self,*args,**kwargs):
    until=time.monotonic()+5
    while not Path(%r).exists():
        if time.monotonic()>until:raise AssertionError('Capture was not released')
        time.sleep(.001)
    return original_put(self,*args,**kwargs)
RecordingRing.put=delayed_put
original_receive=solver_worker.receive_leased_message
submissions=0
def delayed_receive(channel):
    global submissions
    request,leases=original_receive(channel)
    if request['operation']=='submit_stream':
        submissions+=1
        if submissions==2:
            Path(%r).touch()
            until=time.monotonic()+5
            while not Path(%r).exists():
                if time.monotonic()>until:raise AssertionError('Second request was not released')
                time.sleep(.001)
    return request,leases
solver_worker.receive_leased_message=delayed_receive
''' % (str(capture), str(received), str(release))
            with self.child_adapter(directory, code) as (adapter, remote):
                from tiago_mpc.interfaces import State
                try:
                    remote.start_stream(adapter.N, adapter.dt)
                    reference = np.zeros((adapter.N, 6))
                    remote.submit_stream(State(0., adapter.x[:7], adapter.x[7:]), reference)
                    _, first_locator = remote.result_stream(True)
                    remote.submit_stream(State(.002, adapter.x[:7], adapter.x[7:]), reference)
                    capture.touch()
                    deadline = time.monotonic()+2
                    while not received.exists() and time.monotonic() < deadline:
                        time.sleep(.001)
                    self.assertTrue(received.exists())
                    self.assertFalse(remote.control.busy)
                    self.assertFalse(select.select([remote.channel], [], [], 0)[0])
                    with self.assertRaisesRegex(TimeoutError, 'inspection timeout'):
                        remote.wait_idle(timeout=.02)
                    self.assertTrue(remote.stream_pending)
                    release.touch()
                    remote.wait_idle(timeout=2)
                    self.assertTrue(remote.stream_pending)
                    self.assertTrue(select.select([remote.channel], [], [], 0)[0])
                    second, second_locator = remote.result_stream(True)
                    self.assertEqual(second.t0, .002)
                    take_record(first_locator)
                    take_record(second_locator)
                finally:
                    capture.touch()
                    release.touch()

    def test_capture_error_is_reported_without_unleased_teardown_and_configure_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            code='''original_put=RecordingRing.put
failed=False
def fail_once(self,identifier,record,**kw):
    global failed
    if not failed:
        failed=True
        raise ValueError('injected capture failure')
    return original_put(self,identifier,record,**kw)
RecordingRing.put=fail_once
'''
            with self.child_adapter(directory,code) as (adapter,remote):
                from tiago_mpc.interfaces import State
                initial=State(0.,adapter.x[:7],adapter.x[7:])
                reference=np.zeros((adapter.N,6))
                remote.start_stream(adapter.N,adapter.dt)
                remote.submit_stream(initial,reference)
                _,locator=remote.result_stream(True)
                with self.assertRaisesRegex(RuntimeError,'injected capture failure'):
                    take_record(locator)
                self.assertIsNone(remote.process.poll())
                remote.submit_stream(initial,reference)
                with self.assertRaisesRegex(ValueError,'Previous solve recording failed'):
                    remote.result_stream(True)
                remote.end_stream()
                adapter.configure(config(),dict(kind='reach',target_offset_m=[0.,0.,0.]))
                remote.start_stream(adapter.N,adapter.dt)
                remote.submit_stream(initial,reference)
                _,locator=remote.result_stream(True)
                self.assertIn('_states',take_record(locator))

    def test_reserved_capture_waits_for_publication_and_cancelled_slots_are_not_resurrected(self):
        ring=RecordingRing()
        try:
            slot=ring.reserve(1)
            locator=dict(path=str(ring.path),slot=slot,request_id=1)
            got=[]
            reader=threading.Thread(target=lambda:got.append(take_record(locator)))
            reader.start()
            reader.join(.01)
            self.assertTrue(reader.is_alive())
            self.assertEqual(got,[])
            ring.put(1,dict(value=7),slot=slot)
            reader.join(2)
            self.assertEqual(got,[dict(value=7)])
            slot=ring.reserve(2)
            locator=dict(path=str(ring.path),slot=slot,request_id=2)
            take_record(locator,discard=True)
            ring.next_slot=slot
            self.assertEqual(ring.reserve(3),slot)
            ring.put(2,dict(value='cancelled'),slot=slot)
            ring.put(3,dict(value='current'),slot=slot)
            self.assertEqual(take_record(dict(locator,request_id=3)),dict(value='current'))
        finally:ring.close()

    def test_maximum_supported_iteration_diagnostics_fit_the_configured_ring(self):
        from solver_exchange import recording_slot_bytes
        ring=RecordingRing(slot_bytes=recording_slot_bytes(100000))
        attached=RecordingRing(ring.path)
        try:
            record=dict(_states=np.zeros((128,14)),_torques=np.zeros((127,7)),_reference=np.zeros((128,6)),
                        diagnostics={key:np.zeros(100000,dtype=np.float64) for key in ('pcg_iters','pcg_times_us','min_merit','step_size')})
            slot=attached.put(1,record)
            captured=take_record(dict(path=str(ring.path),slot=slot,request_id=1))
            self.assertEqual(captured['diagnostics']['pcg_iters'].shape,(100000,))
            self.assertEqual(attached.slot_bytes,ring.slot_bytes)
        finally:
            attached.close()
            ring.close()
    def buffered_adapter(self, clock=None):
        live_probe()
        from tests.test_execution import FakeAdapter
        adapter = FakeAdapter()
        adapter.problem_configuration = dict(friction=None)
        adapter.remote = DeferredRemote(adapter,clock)
        return adapter

    def test_torque_breach_completes_its_interval_and_parks_before_collecting_the_next_solve(self):
        from tests.test_execution import WIDE_LIMITS
        adapter = self.buffered_adapter()
        adapter.limit_handling = dict(limits=dict(WIDE_LIMITS,effort=np.ones(7)),clip_effort=False,
                                     stop_on_breach=dict(position=False,velocity=False,torque=True))
        session = NativeSession(adapter,dict(EXECUTION,to_hz=500.,solve_latency_s=.002,latency_compensation=False))
        try:
            records = session.advance_interval(.01)
            self.assertAlmostEqual(adapter.t,.004)
            self.assertTrue(session._parked)
            self.assertTrue(adapter.remote.stream_pending)
            self.assertEqual(sum(r['type']=='plan' for r in records),1)
            self.assertEqual(sum(r['type']=='control' for r in records),1)
            self.assertEqual(session.steps,2)
            self.assertTrue(any(r['type']=='breach' for r in records))
        finally:session.close()

    def test_terminal_fault_records_the_drained_solve_even_when_its_plan_never_activates(self):
        adapter = self.buffered_adapter()
        session = NativeSession(adapter, dict(EXECUTION, to_hz=100., solve_latency_s=.03,
                                              latency_compensation=False))
        self.addCleanup(session.close)
        records = []
        while not session.finished:
            records.extend(session.advance_interval(.1))
        records = [resolve_record(record) for record in records]
        plans = [record for record in records if record['type'] == 'plan']
        controls = [record for record in records if record['type'] == 'control']
        self.assertEqual(session.outcome.reason, 'lease_expired')
        self.assertAlmostEqual(session.progress.t, .04)
        self.assertEqual([record['seq'] for record in plans], [1, 2])
        np.testing.assert_allclose([record['sim_time_s'] for record in plans], [0., .03])
        self.assertEqual({record['plan_seq'] for record in controls}, {1})
        self.assertEqual(session.solves, len(plans))
        self.assertFalse(adapter.remote.stream_pending)

    def test_finite_duration_drains_the_final_solve_and_completes_at_the_anchored_endpoint(self):
        adapter = self.buffered_adapter()
        adapter.t = .05
        session = NativeSession(adapter, dict(EXECUTION, to_hz=100., solve_latency_s=.03,
                                              latency_compensation=False), duration_s=.004)
        self.addCleanup(session.close)
        records = []
        while not session.finished:
            records.extend(session.advance_interval(.054))
        records = [resolve_record(record) for record in records]
        plans = [record for record in records if record['type'] == 'plan']
        self.assertEqual(session.outcome.status, 'timeout')
        self.assertAlmostEqual(session.progress.t, .054)
        self.assertEqual(session.solves, 1)
        self.assertEqual(len(plans), 1)
        self.assertAlmostEqual(plans[0]['request_time_s'], .05)
        self.assertAlmostEqual(plans[0]['available_time_s'], .08)
        self.assertFalse(any(record['type'] == 'control' for record in records))
        self.assertFalse(adapter.remote.stream_pending)
        self.assertEqual(session.advance_interval(.054), [])

    def test_async_physics_and_total_wall_are_charged_at_the_same_interval_boundary(self):
        from tests.test_execution import FakeClock
        clock = FakeClock()
        adapter = self.buffered_adapter(clock)
        adapter.clock, adapter.applied_torque = clock,np.zeros(7)
        session = NativeSession(adapter,dict(EXECUTION,to_hz=500.,solve_latency_s=.002,latency_compensation=False),clock=clock)
        try:
            records = session.advance_interval(.006)
            intervals = [r for r in records if r['type']=='interval']
            self.assertEqual(len(intervals),3)
            for interval in intervals:
                self.assertAlmostEqual(interval['physics_wall_s'],.0002)
            np.testing.assert_allclose([interval['total_wall_s'] for interval in intervals],
                                       [.0012, .0012, .0002], atol=1e-12)
            self.assertEqual(session.solves, 2)
            self.assertTrue(adapter.remote.stream_pending)
        finally:session.close()

    def test_recording_retirement_preserves_in_flight_data_and_reclaims_after_consumption(self):
        ring = RecordingRing()
        source = np.arange(64.)
        slot = ring.put(7, dict(_states=source))
        locator = dict(path=str(ring.path), slot=slot, request_id=7)
        source[:] = -1
        ring.close()
        self.assertTrue(Path(locator['path']).exists())
        record = resolve_record(dict(type='plan', seq=1, _recording=locator))
        np.testing.assert_array_equal(record['_states'], np.arange(64.))
        self.assertFalse(Path(locator['path']).exists())
        discard_records([dict(_recording=locator)])

    def test_full_ring_applies_backpressure_and_never_overwrites_a_retained_solve(self):
        from solver_exchange import SLOT_BYTES, SLOT_HEADER
        ring = RecordingRing(budget_bytes=128+SLOTS*(SLOT_HEADER.size+SLOT_BYTES))
        locators = []
        for i in range(SLOTS):
            slot = ring.put(i+1, dict(value=i))
            locators.append(dict(path=str(ring.path), slot=slot, request_id=i+1))
        done = threading.Event()
        writer = threading.Thread(target=lambda: (ring.put(SLOTS+1, dict(value=SLOTS)), done.set()))
        writer.start()
        try:
            self.assertFalse(done.wait(.03))
            self.assertEqual(take_record(locators[0])['value'], 0)
            self.assertTrue(done.wait(2))
            self.assertEqual(ring.high_water_slots, SLOTS)
            self.assertEqual(ring.reserve_wait_count, 1)
            self.assertGreater(ring.reserve_wait_s, .02)
            for i, locator in enumerate(locators[1:], 1):
                self.assertEqual(take_record(locator)['value'], i)
            self.assertEqual(take_record(dict(path=str(ring.path), slot=0, request_id=SLOTS+1))['value'], SLOTS)
        finally:
            writer.join(2)
            ring.close()

    def test_shared_control_replies_own_their_arrays_and_reject_wrong_request_identity(self):
        live_probe()
        from tiago_mpc.interfaces import Plan, State
        owner = ControlArrays(4, .02)
        child = ControlArrays(4, .02, owner.path)
        try:
            initial = State(1., np.ones(7), np.zeros(7))
            owner.write_request(8, initial, np.zeros((4,6)))
            state, reference = child.read_request(8)
            plan = Plan(1., .02, np.ones((4,14)), np.ones((3,7)), dict(wall_s=.002), measured_t=1.)
            child.write_result(8, plan, .003)
            returned = owner.read_result(8)
            owner.write_request(9, State(2., np.zeros(7), np.zeros(7)), reference)
            child.states[:] = 9.
            np.testing.assert_array_equal(returned.states, np.ones((4,14)))
            with self.assertRaisesRegex(ValueError, 'Mismatched'):
                owner.read_result(8)
        finally:
            child.close()
            owner.close()

    def test_real_child_allows_physics_to_advance_before_reply_and_retains_every_solve(self):
        with tempfile.TemporaryDirectory() as directory, fake_gpu():
            folder = Path(directory)
            marker = folder/'physics'
            script = folder/'worker.py'
            script.write_text('''import os,sys,socket,time
from pathlib import Path
sys.path.insert(0, %r)
root=sys.argv[sys.argv.index('--root')+1]
os.environ['TIAGO_MPC_ROOT']=root
from solver_lifecycle import arm_parent_death_signal
arm_parent_death_signal(int(sys.argv[sys.argv.index('--parent-pid')+1]))
from tests.test_solver_boundary import fake_gpu,FakeMpc
from solver_worker import serve
original=FakeMpc.request
def wait_for_physics(self,state,reference,updates=None):
    if state.t==0.:
        until=time.monotonic()+5
        while not Path(%r).exists():
            if time.monotonic()>until:raise AssertionError('The plant was blocked behind the solver')
            time.sleep(.001)
    return original(self,state,reference,updates)
FakeMpc.request=wait_for_physics
with fake_gpu(),socket.socket(fileno=int(sys.argv[sys.argv.index('--fd')+1])) as channel:
    serve(channel,root)
''' % (str(Path(__file__).resolve().parents[1]),str(marker)))
            profile = dict(id='shared', mpc_root=str(MPC_ROOT), python=sys.executable, cache=os.environ['GATO_CACHE_DIR'])
            remote = SolverProcess(profile, script=script)
            adapter = SimulatorAdapter(MPC_ROOT)
            adapter.remote, adapter.profile = remote, profile
            adapter.profile_schema = dict(available_N_by_friction=dict(off=[4],on=[]),
                                          source_settings=live_probe().get('source_settings',{}))
            session = None
            try:
                remote.request('bootstrap')
                execution = dict(EXECUTION, to_hz=500., solve_latency_s=.002, latency_compensation=True)
                adapter.configure(config(), dict(kind='reach',target_offset_m=[0.,0.,0.]), execution=execution)
                original_plant = adapter.new_plant
                def observed(substep):
                    plant = original_plant(substep)
                    advance = plant.advance
                    def step(t):
                        advance(t)
                        marker.touch()
                    plant.advance = step
                    return plant
                adapter.new_plant = observed
                adapter.applied_torque = np.zeros(7)
                session = NativeSession(adapter, execution)
                raw = session.advance_interval(.004)
                self.assertTrue(marker.exists())
                self.assertTrue(any('_recording' in record for record in raw))
                records = [resolve_record(record) for record in raw]
                plans = [record for record in records if record['type']=='plan']
                self.assertEqual(len(plans), 1)
                self.assertEqual(len([r for r in records if r['type']=='control']),1)
                json.dumps([r for r in records if r['type']=='control'], allow_nan=False)
                from live_presentation import render_state
                context = adapter.segment_header(0,execution)['context']
                state = next(r for r in records if r['type']=='state')
                json.dumps(render_state(state,adapter.kinematics,context), allow_nan=False)
                rendered = render_plan(plans[0], adapter.kinematics)
                self.assertEqual(rendered['initial_state']['time_s'], .002)
                self.assertEqual(rendered['initial_state']['measured_time_s'], 0.)
                self.assertEqual(rendered['diagnostics']['step_size'], [1.,None])
                self.assertEqual(rendered['stats']['sqp_iters'],2)
                more = [resolve_record(r) for r in session.advance_interval(.006)]
                resumed = next(r for r in more if r['type']=='plan')
                self.assertFalse(render_plan(resumed,adapter.kinematics)['stats']['controller_restarted'])
                control_path, recording_path = remote.control.path, remote.recording.path
                paused_time = adapter.t
                session.close()
                self.assertEqual(adapter.t,paused_time)
                self.assertFalse(control_path.exists())
                self.assertFalse(recording_path.exists())
                self.assertIsNone(remote.control)
                adapter.reset_state()
                execution = dict(execution, simulation_hz=100000., control_hz=100000., to_hz=100000.,
                                 solve_latency_s=0., latency_compensation=False)
                adapter.configure(config(),dict(kind='reach',target_offset_m=[0.,0.,0.]),execution=execution)
                session = NativeSession(adapter,execution)
                from execution_worker import CompletedRecords
                reset = []
                def consume(packet):
                    reset.extend(resolve_record(r) for r in packet['records'])
                reporting = CompletedRecords(consume, lambda: 0., report_hz=1)
                while session.progress.t < .001-1e-12:
                    batch = session.advance_interval(.001)
                    self.assertLessEqual(sum('_recording' in r for r in batch), SLOTS//4)
                    reporting.append(batch, 1, 0)
                reporting.flush(complete=True)
                reset_plan = next(r for r in reset if r['type']=='plan')
                self.assertTrue(render_plan(reset_plan,adapter.kinematics)['stats']['controller_restarted'])
                self.assertEqual(sum(r['type']=='plan' for r in reset), 100)
            finally:
                if session is not None:session.close()
                adapter.close_solver()
