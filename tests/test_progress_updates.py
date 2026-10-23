"""Progress coalescing must never coalesce numerical history or completion."""
from copy import deepcopy
from pathlib import Path
import queue
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from execution_worker import worker_main
from tests.test_execution import FakeAdapter, FakeLocks, fake_schema


class ProgressUpdatesTests(unittest.TestCase):
    def test_fast_precalculation_retains_every_interval_with_bounded_progress(self):
        schema = fake_schema(None)
        execution = dict(schema['defaults']['execution'], calculation='manual', duration_s=.2)
        commands, messages, shutdown = queue.Queue(), [], threading.Event()
        commands.put(dict(type='precalculate', token=0, generation=0, settings_version=1,
            config=deepcopy(schema['defaults']['config']), task=deepcopy(schema['defaults']['task']),
            execution=execution))

        class Results:
            def put(self, message, timeout=None):
                messages.append(message)
                if any(event.get('message') == 'Precalculation complete'
                       for event in message.get('events', ())):
                    shutdown.set()

        # The numerical clock still runs normally. A fixed wall clock simply
        # models many completed intervals between two UI progress deadlines.
        with patch('live_mpc.GPULocks', FakeLocks), patch('execution_worker.time.monotonic', return_value=100.):
            worker_main(Path('.'), commands, Results(), SimpleNamespace(value=0), shutdown,
                        adapter_factory=FakeAdapter, schema_factory=lambda root: schema)
        records = [record for message in messages for record in message.get('records', ())]
        intervals = [record for record in records if record['type'] == 'interval']
        plans = [record for record in records if record['type'] == 'plan']
        states = [record for record in records if record['type'] == 'state']
        self.assertEqual(len(intervals), 20)
        self.assertEqual(len(plans), 20)
        self.assertEqual(len(states), 101)  # every 500 Hz command tick
        self.assertEqual(sum(record['type'] == 'segment' for record in records), 1)
        self.assertAlmostEqual(states[-1]['sim_time_s'], .2)
        status = [event for message in messages for event in message.get('events', ())]
        self.assertLessEqual(len(status), 3)
        self.assertEqual(status[-1]['message'], 'Precalculation complete')
        self.assertFalse(status[-1]['job_active'])
        self.assertTrue(status[-1]['complete'])

