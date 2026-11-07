"""Completed-record reporting is bounded without changing numerical intervals."""
from copy import deepcopy
import queue
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

from native_session import NativeSession
from execution_worker import CompletedRecords, MAX_PACKET_RECORDS, RECORD_INTERVAL_S, worker_main
from tests.test_execution import FakeLocks, fake_schema, MPC_ROOT
from tests.test_solver_profiles import ProfileAdapter
from solver_exchange import SLOTS


class CompletedRecordsTests(unittest.TestCase):
    def test_failed_emission_reclaims_recording_ownership(self):
        from solver_exchange import RecordingRing,RING_HEADER
        ring=RecordingRing()
        try:
            slot=ring.put(1,dict(value=7))
            record=dict(type='plan',_recording=dict(path=str(ring.path),slot=slot,request_id=1))
            buffer=CompletedRecords(lambda packet:False,lambda:0.)
            buffer.append([record],0,0,complete=True)
            self.assertEqual(RING_HEADER.unpack_from(ring.mapping)[1],0)
        finally:ring.close()
        self.assertFalse(ring.path.exists())

    def test_closed_receiver_drains_and_reclaims_queued_recordings(self):
        from execution_bridge import ProcessLiveService
        from solver_exchange import RecordingRing,RING_HEADER
        ring=RecordingRing()
        try:
            service=object.__new__(ProcessLiveService)
            service.closed=True
            service._process=SimpleNamespace(is_alive=lambda:False)
            service.results=queue.Queue()
            for identifier in range(1,4):
                slot=ring.put(identifier,dict(value=identifier))
                service.results.put(dict(kind='records',records=[dict(_recording=dict(path=str(ring.path),slot=slot,request_id=identifier))]))
            service._receive()
            self.assertEqual(RING_HEADER.unpack_from(ring.mapping)[1],0)
        finally:ring.close()

    def test_full_ring_shutdown_reclaims_unpublished_batches_and_unblocks_producer(self):
        from solver_exchange import RecordingRing,discard_records,SLOT_BYTES,SLOT_HEADER
        ring=RecordingRing(budget_bytes=128+SLOTS*(SLOT_HEADER.size+SLOT_BYTES))
        records=[]
        for identifier in range(1,SLOTS+1):
            slot=ring.put(identifier,dict(value=identifier))
            records.append(dict(type='plan',_recording=dict(path=str(ring.path),slot=slot,request_id=identifier)))
        done=threading.Event()
        writer=threading.Thread(target=lambda:(ring.put(SLOTS+1,dict(value='last')),done.set()))
        writer.start()
        try:
            self.assertFalse(done.wait(.02))
            buffer=CompletedRecords(lambda packet:False,lambda:0.)
            buffer.append(records,0,0,complete=True)
            self.assertTrue(done.wait(2))
            discard_records([dict(_recording=dict(path=str(ring.path),slot=0,request_id=SLOTS+1))])
        finally:
            discard_records(records)
            writer.join(2)
            ring.close()
        self.assertFalse(ring.path.exists())
    def test_wall_deadline_and_record_cap_preserve_order_and_objects(self):
        messages, now = [], [10.]
        buffer = CompletedRecords(messages.append, lambda: now[0])
        records = [dict(type='state', q=[i], sim_time_s=i) for i in range(600)]
        buffer.append(records[:20], 3, 8)
        self.assertEqual(messages, [])
        now[0] += RECORD_INTERVAL_S + .00001
        buffer.append(records[20:30], 3, 8)
        self.assertEqual(len(messages), 1)
        buffer.append(records[30:], 3, 8, complete=True)
        self.assertTrue(all(len(m['records']) <= MAX_PACKET_RECORDS for m in messages))
        self.assertEqual([r for m in messages for r in m['records']], records)
        self.assertIs(messages[0]['records'][0], records[0])
        self.assertEqual([m['complete'] for m in messages], [False, False, False, True])
        self.assertEqual(buffer.records, [])

    def test_exact_full_packet_completion_and_identity_change(self):
        messages = []
        buffer = CompletedRecords(messages.append, lambda: 0.)
        buffer.append([{'old': True}], 1, 4)
        buffer.append([{'new': i} for i in range(256)], 2, 5, complete=True)
        self.assertEqual([(m['generation'], m['token'], m['complete']) for m in messages],
                         [(1, 4, False), (2, 5, True)])
        self.assertEqual(buffer.records, [])

    def test_recording_capacity_drains_without_changing_the_report_deadline(self):
        messages, now = [], [0.]
        buffer = CompletedRecords(messages.append, lambda: now[0], report_hz=1)
        records = [dict(type='plan', _recording=dict(request_id=i+1)) for i in range(SLOTS//2)]
        buffer.append(records, 2, 5)
        self.assertEqual(messages[0]['records'], records)
        self.assertFalse(messages[0]['report_end'])
        self.assertEqual(buffer.last_flush, 0.)
        self.assertEqual(buffer.records, [])
        now[0] = 1.
        buffer.append([], 2, 5)
        self.assertTrue(messages[-1]['report_end'])
        self.assertEqual(messages[-1]['records'], [])
        self.assertFalse(buffer.unreported)


class WorkerRecordBatchingTests(unittest.TestCase):
    def run_worker(self, action=None, ring=None, idle_wait=None):
        schema = fake_schema(None)
        execution = dict(schema['defaults']['execution'], calculation='on_play', duration_s=.2, solve_latency_s=0.)
        config, task = deepcopy(schema['defaults']['config']), deepcopy(schema['defaults']['task'])
        commands, messages, shutdown = queue.Queue(), [], threading.Event()
        revision = SimpleNamespace(value=0)
        commands.put(dict(type='precalculate', token=0, generation=0, settings_version=1,
                          config=config, task=task, execution=execution))
        batches = []

        class Session(NativeSession):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                if idle_wait is not None:
                    self.adapter.remote = SimpleNamespace(wait_idle=lambda timeout: idle_wait(self, timeout))

            def advance_interval(self, *args, **kwargs):
                if action == 'failure' and len(batches) == 2:
                    raise RuntimeError('test failure with buffered committed records')
                if action == 'revision' and len(batches) == 2:
                    revision.value = 1
                    commands.put(dict(type='cancel', token=1, generation=0))
                batch = super().advance_interval(*args, **kwargs)
                if batch:
                    batches.append(batch)
                if len(batches) == 2 and action == 'handoff_revision':
                    slot = ring.put(1, dict(value=1))
                    batch.append(dict(type='plan', _recording=dict(path=str(ring.path), slot=slot, request_id=1)))
                    revision.value = 1
                    commands.put(dict(type='cancel', token=1, generation=0))
                if len(batches) == 2 and action not in (None, 'failure', 'revision', 'handoff_revision'):
                    command = dict(type=action, token=0, generation=0)
                    if action == 'inspection_pause':
                        command['inspection_id'] = 'test-inspection'
                        command['inspection_timeout_s'] = .025
                    if action == 'switch_solver_profile':
                        command.update(profile=dict(id='second'), target_generation=1)
                    if action == 'set_settings':
                        command.update(generation=1, settings_version=2, config=config,
                                       task=task, execution=execution)
                    commands.put(command)
                return batch

        class Results:
            def put(self, message, timeout=None):
                messages.append(message)
                if message['kind'] == 'failure' or any(
                        event.get('state') == 'paused' for event in message.get('events', ())):
                    shutdown.set()

        with patch('live_mpc.GPULocks', FakeLocks), \
             patch('execution_worker.NativeSession', Session), \
             patch('execution_worker.time.monotonic', return_value=100.):
            worker_main(MPC_ROOT, commands, Results(), revision, shutdown,
                        adapter_factory=ProfileAdapter, schema_factory=lambda root: schema)
        return messages, batches

    def assert_committed_batches(self, messages, batches):
        # The segment header and initial state are immediate; all committed interval
        # records follow in their original order, retaining the exact measurements.
        old_packets = [m for m in messages if m['kind'] == 'records' and m['generation'] == 0]
        self.assertEqual([r['type'] for r in old_packets[0]['records']], ['segment', 'state'])
        actual = [r for m in old_packets for r in m['records']][2:]
        expected = [r for batch in batches for r in batch]
        self.assertGreaterEqual(len(actual), len(expected))
        for before, after in zip(expected, actual):
            self.assertIs(before, after)
        # An asynchronous producer can have queued batches and one partial
        # batch when Pause arrives. They must all precede its acknowledgement.
        tail = actual[len(expected):]
        states = [r['sim_time_s'] for r in actual if r['type'] == 'state']
        np.testing.assert_allclose(np.diff([0., *states]), .002, atol=1e-12)
        controls = [r['sim_time_s'] for r in actual if r['type'] == 'control']
        self.assertEqual(len(controls), len(set(controls)))
        self.assertLessEqual(len([r for r in tail if r['type']=='state']), 16)
        if tail and tail[-1]['type'] == 'interval':
            self.assertAlmostEqual(tail[-1]['end_time_s'], states[-1])
        self.assertTrue(all(len(m['records']) <= MAX_PACKET_RECORDS for m in old_packets))
        return old_packets

    def test_fast_completion_batches_all_records_at_the_control_events(self):
        # 1000/500/100: every 500 Hz command and the state at its tick, every plan
        # and interval, and one segment header.
        messages, batches = self.run_worker()
        packets = self.assert_committed_batches(messages, batches)
        self.assertEqual(len(batches), 20)
        self.assertLess(len(packets), 10)
        self.assertTrue(packets[-1]['complete'])
        records = [r for m in packets for r in m['records']]
        count = lambda kind: sum(r['type'] == kind for r in records)
        self.assertEqual((count('segment'), count('state'), count('control'), count('plan'), count('interval')),
                         (1, 101, 100, 20, 20))
        self.assertEqual(messages[-1]['events'][0]['message'], 'Precalculation complete')

    def test_commands_flush_old_records_before_status_or_new_generation(self):
        for action in ('pause', 'cancel', 'inspection_pause', 'switch_solver_profile', 'set_settings'):
            with self.subTest(action=action):
                messages, batches = self.run_worker(action)
                packets = self.assert_committed_batches(messages, batches)
                self.assertEqual(len(batches), 2)
                last_packet = next(i for i, m in enumerate(messages) if m is packets[-1])
                later = messages[last_packet+1:]
                self.assertTrue(later)
                self.assertEqual(later[-1]['events'][0]['state'], 'paused')
                if action == 'switch_solver_profile':
                    self.assertEqual(later[0]['kind'], 'profile_activated')
                if action in ('switch_solver_profile', 'set_settings'):
                    self.assertTrue(any(m['kind'] == 'records' and m['generation'] == 1 for m in later))

    def test_revision_cancellation_preserves_old_token_records(self):
        messages, batches = self.run_worker('revision')
        packets = self.assert_committed_batches(messages, batches)
        self.assertEqual(len(batches), 2)
        self.assertTrue(all(m['token'] == 0 for m in packets))
        self.assertEqual(messages[-1]['token'], 1)

    def test_inspection_waits_for_its_parked_child_and_acknowledges_an_idle_timeout(self):
        for timeout in (False, True):
            with self.subTest(timeout=timeout):
                calls = []
                def idle_wait(session, limit):
                    from tests import test_execution
                    self.assertTrue(test_execution.LOCK_HELD)
                    self.assertTrue(session._parked)
                    self.assertTrue(session._thread.is_alive())
                    self.assertFalse(session._cancel.is_set())
                    self.assertEqual(session.adapter.warmups, [0.])
                    calls.append(limit)
                    if timeout:
                        raise TimeoutError('injected inspection idle timeout')
                messages, batches = self.run_worker('inspection_pause', idle_wait=idle_wait)
                self.assert_committed_batches(messages, batches)
                self.assertEqual(calls, [.025])
                status = messages[-1]['events'][0]
                self.assertEqual(status['inspection_pause_id'], 'test-inspection')
                self.assertEqual(status['inspection_pause_error'],
                                 'injected inspection idle timeout' if timeout else None)
                self.assertEqual(status['state'], 'paused')

    def test_revision_after_handoff_reclaims_discarded_capture_and_tip(self):
        from solver_exchange import RecordingRing, RING_HEADER
        ring = RecordingRing()
        try:
            messages, batches = self.run_worker('handoff_revision', ring)
            self.assertEqual(RING_HEADER.unpack_from(ring.mapping)[1], 0)
            self.assertEqual(len(batches), 2)
            expected_tip = max(r['sim_time_s'] for r in batches[0] if r['type'] == 'state')
            self.assertAlmostEqual(messages[-1]['events'][0]['history_end_s'], expected_tip)
            retained = [r for m in messages if m['kind'] == 'records' for r in m['records']]
            self.assertFalse(any('_recording' in r for r in retained))
        finally:
            ring.close()

    def test_error_flushes_prior_committed_records_before_failure(self):
        messages, batches = self.run_worker('failure')
        packets = self.assert_committed_batches(messages, batches)
        self.assertEqual(len(batches), 2)
        self.assertLess(next(i for i,m in enumerate(messages) if m is packets[-1]), next(i for i,m in enumerate(messages) if m['kind']=='failure'))


if __name__ == '__main__':
    unittest.main()
