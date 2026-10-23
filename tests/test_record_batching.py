"""Completed-record reporting is bounded without changing numerical intervals."""
from copy import deepcopy
from pathlib import Path
import queue
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from execution_session import MultirateSession
from execution_worker import CompletedRecords, MAX_PACKET_RECORDS, RECORD_INTERVAL_S, worker_main
from tests.test_execution import FakeLocks, fake_schema
from tests.test_solver_profiles import ProfileAdapter


class CompletedRecordsTests(unittest.TestCase):
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


class WorkerRecordBatchingTests(unittest.TestCase):
    def run_worker(self, action=None, record_every=1):
        schema = fake_schema(None)
        execution = dict(schema['defaults']['execution'], calculation='on_play', duration_s=.2, record_every=record_every)
        config, task = deepcopy(schema['defaults']['config']), deepcopy(schema['defaults']['task'])
        commands, messages, shutdown = queue.Queue(), [], threading.Event()
        revision = SimpleNamespace(value=0)
        commands.put(dict(type='precalculate', token=0, generation=0, settings_version=1,
                          config=config, task=task, execution=execution))
        batches = []

        class Session(MultirateSession):
            def advance_interval(self, *args, **kwargs):
                if action == 'failure' and len(batches) == 2:
                    raise RuntimeError('test failure with buffered committed records')
                if action == 'revision' and len(batches) == 2:
                    revision.value = 1
                    commands.put(dict(type='cancel', token=1, generation=0))
                batch = super().advance_interval(*args, **kwargs)
                if batch:
                    batches.append(batch)
                if len(batches) == 2 and action not in (None, 'failure', 'revision'):
                    command = dict(type=action, token=0, generation=0)
                    if action == 'inspection_pause':
                        command['inspection_id'] = 'test-inspection'
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
             patch('execution_worker.MultirateSession', Session), \
             patch('execution_worker.time.monotonic', return_value=100.):
            worker_main(Path('.'), commands, Results(), revision, shutdown,
                        adapter_factory=ProfileAdapter, schema_factory=lambda root: schema)
        return messages, batches

    def assert_committed_batches(self, messages, batches):
        # Initial state is immediate; all committed interval records follow in
        # their original order, retaining the exact per-interval measurements.
        old_packets = [m for m in messages if m['kind'] == 'records' and m['generation'] == 0]
        actual = [r for m in old_packets for r in m['records']][1:]
        expected = [r for batch in batches for r in batch]
        self.assertEqual(len(actual), len(expected))
        for before, after in zip(expected, actual):
            self.assertIs(before, after)
        self.assertTrue(all(len(m['records']) <= MAX_PACKET_RECORDS for m in old_packets))
        return old_packets

    def test_fast_completion_batches_all_states_plans_and_deadline_flags(self):
        messages, batches = self.run_worker()
        packets = self.assert_committed_batches(messages, batches)
        self.assertEqual(len(batches), 20)
        self.assertLess(len(packets), 10)
        self.assertTrue(packets[-1]['complete'])
        self.assertEqual(sum(r['type'] == 'state' for m in packets for r in m['records']), 201)
        self.assertEqual(messages[-1]['events'][0]['message'], 'Precalculation complete')

    def test_default_recording_thins_states_but_keeps_commands_plans_and_intervals(self):
        # 1000/500/100 with every 2nd physics step: each 500 Hz command and the
        # state it produced are recorded; plans and intervals are complete.
        self.assertEqual(fake_schema(None)['defaults']['execution']['record_every'], 2)
        messages, batches = self.run_worker(record_every=2)
        self.assert_committed_batches(messages, batches)
        records = [r for m in messages if m['kind'] == 'records' for r in m['records']]
        count = lambda kind: sum(r['type'] == kind for r in records)
        self.assertEqual((count('state'), count('control'), count('plan'), count('interval')), (101, 100, 20, 20))

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

    def test_error_flushes_prior_committed_records_before_failure(self):
        messages, batches = self.run_worker('failure')
        packets = self.assert_committed_batches(messages, batches)
        self.assertEqual(len(batches), 2)
        self.assertLess(next(i for i,m in enumerate(messages) if m is packets[-1]), next(i for i,m in enumerate(messages) if m['kind']=='failure'))


if __name__ == '__main__':
    unittest.main()
