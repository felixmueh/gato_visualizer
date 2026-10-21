"""Presentation preferences cannot restart or reschedule numerical execution."""
from copy import deepcopy
import json
from pathlib import Path
import queue
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from execution_bridge import HistoryStore, ProcessLiveService
from execution_session import MultirateSession
from execution_worker import CompletedRecords, worker_main
from presentation_settings import DEFAULT_PRESENTATION, PresentationSettings, validate_presentation
from server import make_server
from tests.test_execution import FakeAdapter, FakeLocks, fake_schema
from visualizer_config import load_visualizer_config, save_local_settings, save_source_selection


class PresentationConfigTests(unittest.TestCase):
    def test_defaults_validation_and_other_settings_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            original = dict(ingest_directory='recordings', source=dict(mpc_root='/source'),
                            plotters_directory='plots', solver_profiles=[dict(id='first', mpc_root='/other')])
            path.write_text(json.dumps(original))
            self.assertEqual(load_visualizer_config(path).presentation, DEFAULT_PRESENTATION)
            service = PresentationSettings(path)
            updated = dict(report_hz=10, buffer_ms=1000, interpolate=True)
            self.assertEqual(service.update(updated), updated)
            self.assertEqual(json.loads(path.read_text()), dict(original, presentation=updated))
            save_source_selection(path, dict(mpc_root='/new-source'))
            save_local_settings(path, plotters_directory='new-plots', solver_profiles=[])
            self.assertEqual(load_visualizer_config(path).presentation, updated)
            self.assertEqual(PresentationSettings(path).settings(), updated)
        for changes in (dict(report_hz=True), dict(report_hz=0), dict(report_hz=121),
                        dict(report_hz=float('nan')), dict(buffer_ms=-1), dict(buffer_ms=10001),
                        dict(buffer_ms=float('inf')), dict(interpolate=1)):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_presentation(dict(DEFAULT_PRESENTATION, **changes))
        for invalid in ({}, [], dict(DEFAULT_PRESENTATION, extra=1)):
            with self.assertRaises(ValueError):
                validate_presentation(invalid)

    def test_api_persists_without_live_and_rejects_invalid_or_foreign_origin(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            path.write_text('{}')
            server = make_server({}, '<robot/>', {}, port=0, live=None,
                                 presentation=PresentationSettings(path))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f'http://127.0.0.1:{server.server_port}/api/presentation/settings'
            try:
                self.assertEqual(json.load(urlopen(url)), DEFAULT_PRESENTATION)
                value = dict(report_hz=60, buffer_ms=0, interpolate=False)
                request = Request(url, data=json.dumps(value).encode(), headers={'Content-Type':'application/json'})
                self.assertEqual(json.load(urlopen(request)), value)
                self.assertEqual(json.load(urlopen(url)), value)
                self.assertEqual(load_visualizer_config(path).presentation, value)
                request = Request(url, data=b'{"report_hz": 10}', headers={'Content-Type':'application/json'})
                with self.assertRaises(HTTPError) as caught:
                    urlopen(request)
                self.assertEqual(caught.exception.code, 400)
                request = Request(url, data=json.dumps(value).encode(), headers={
                    'Content-Type':'application/json', 'Origin':'http://unrelated.example'})
                with self.assertRaises(HTTPError) as caught:
                    urlopen(request)
                self.assertEqual(caught.exception.code, 403)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_bridge_command_does_not_change_numerical_transaction(self):
        live = ProcessLiveService.__new__(ProcessLiveService)
        live.condition = threading.Condition()
        live.commands = queue.Queue(maxsize=2)
        live.closed = False
        live._process = SimpleNamespace(is_alive=lambda: True)
        live.revision = SimpleNamespace(value=17)
        live.version, live.generation = 4, 8
        live.config = {'unchanged': True}
        live.set_report_hz(10)
        self.assertEqual(live.commands.get_nowait(), dict(type='set_report_hz', report_hz=10))
        self.assertEqual((live.revision.value, live.version, live.generation), (17, 4, 8))
        self.assertEqual(live.config, {'unchanged': True})


class ReportingCadenceTests(unittest.TestCase):
    def test_large_report_waits_for_deadline_then_emits_bounded_subpackets(self):
        messages, now = [], [0.]
        records = [dict(type='state', sim_time_s=i/1000) for i in range(5000)]
        buffer = CompletedRecords(messages.append, lambda: now[0], report_hz=10)
        buffer.append(records[:4000], 2, 7)
        now[0] = .09
        buffer.append(records[4000:], 2, 7)
        self.assertEqual(messages, [])  # Neither 256 nor 4096 is an early-flush trigger.
        now[0] = .1
        buffer.append([], 2, 7)
        self.assertEqual([r for m in messages for r in m['records']], records)
        self.assertTrue(all(len(m['records']) <= 256 for m in messages))
        self.assertEqual([m['report_end'] for m in messages], [False]*19+[True])
        self.assertTrue(all(not m['complete'] for m in messages))

    def test_receiver_announces_only_after_final_subpacket(self):
        from collections import deque
        from tests.test_execution import FakeRenderer
        with tempfile.TemporaryDirectory() as folder:
            live = ProcessLiveService.__new__(ProcessLiveService)
            live.condition, live.events = threading.Condition(), deque()
            live.latest, live.cursor, live.version, live.generation = {}, 0, 0, 0
            live.closed, live._profile_revision_floor = False, 0
            live.profile_switch = dict(state="idle")
            live._process = SimpleNamespace(is_alive=lambda: False)
            live.revision = SimpleNamespace(value=0)
            live.renderer = FakeRenderer(None)
            live.history_store = HistoryStore(Path(folder)/'history')
            live.inspection_store = HistoryStore(Path(folder)/'inspection')
            packets = [dict(kind='records', generation=0, token=0, report_end=last,
                            records=[dict(type='state', sim_time_s=t, q=[t]*7)])
                       for t,last in ((0.,False),(.001,True))]
            packets.append(dict(kind='events', generation=0, token=0, progress=True,
                                events=[dict(type='status', state='playing')]))
            cursors = []
            class Results:
                def get(self, timeout=None):
                    cursors.append(live.cursor)
                    if packets:
                        return packets.pop(0)
                    live.closed = True
                    raise queue.Empty
            live.results = Results()
            try:
                live._receive()
                self.assertEqual(cursors[:2], [0,0])
                self.assertEqual([e['type'] for _,e in live.events], ['history','state','status'])
                self.assertEqual(live.latest['state']['sim_time_s'], .001)
                page = live.history(0)
                self.assertEqual([r['sim_time_s'] for r in page['records']], [0.,.001])
            finally:
                live.history_store.close()
                live.inspection_store.close()

    def test_runtime_report_update_keeps_session_warm_start_and_all_intervals(self):
        schema = fake_schema(None)
        commands, messages, shutdown = queue.Queue(), [], threading.Event()
        revision = SimpleNamespace(value=0)
        execution = dict(schema['defaults']['execution'], calculation='manual', duration_s=.2)
        commands.put(dict(type='precalculate', token=0, generation=3, settings_version=1,
                          config=deepcopy(schema['defaults']['config']),
                          task=deepcopy(schema['defaults']['task']), execution=execution))
        sessions, batches, rates = [], [], []

        class Session(MultirateSession):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                sessions.append(self)
            def advance_interval(self, *args, **kwargs):
                batch = super().advance_interval(*args, **kwargs)
                batches.append(batch)
                if len(batches) == 2:
                    # No numerical token/generation/settings fields are needed.
                    commands.put(dict(type='set_report_hz', report_hz=10))
                return batch

        class Buffer(CompletedRecords):
            def set_report_hz(self, value):
                rates.append(value)
                super().set_report_hz(value)

        class Results:
            def put(self, message, timeout=None):
                messages.append(message)
                if any(e.get('message') == 'Precalculation complete' for e in message.get('events', ())):
                    shutdown.set()

        with patch('live_mpc.GPULocks', FakeLocks), patch('execution_worker.MultirateSession', Session), \
             patch('execution_worker.CompletedRecords', Buffer), \
             patch('execution_worker.time.monotonic', return_value=100.):
            worker_main(Path('.'), commands, Results(), revision, shutdown,
                        adapter_factory=FakeAdapter, schema_factory=lambda root: schema, report_hz=30)
        self.assertEqual(rates, [30, 10])
        self.assertEqual(len(sessions), 1)
        self.assertEqual(revision.value, 0)
        packets = [m for m in messages if m['kind']=='records']
        self.assertTrue(all((m['generation'],m['token']) == (3,0) for m in packets))
        records = [r for m in packets for r in m['records']][1:]  # Exclude immediate initial state.
        expected = [r for batch in batches for r in batch]
        self.assertEqual(len(records), len(expected))
        self.assertTrue(all(a is b for a,b in zip(records,expected)))
        self.assertEqual(sum(r['type']=='interval' for r in records),20)
        plans = [r for r in records if r['type']=='plan']
        self.assertEqual([p['stats']['controller_restarted'] for p in plans], [True]+[False]*19)
        self.assertTrue(all(p['settings_version']==1 for p in plans))
        # With fixed wall time, progress and report updates cannot flush history.
        # Initial state, then only completion's bounded report packets.
        self.assertEqual(len(packets), 3)
        self.assertTrue(packets[-1]['complete'])


if __name__ == '__main__':
    unittest.main()
