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

from execution_bridge import ProcessLiveService
from history_store import HistoryStore
from native_session import NativeSession
from execution_worker import CompletedRecords, worker_main
from presentation_settings import DEFAULT_PRESENTATION, PresentationSettings, validate_presentation
from server import make_server
from tests.test_execution import FakeAdapter, FakeLocks, fake_schema
from visualizer_config import load_visualizer_config, save_local_settings, save_source_selection


class PresentationConfigTests(unittest.TestCase):
    def test_partial_updates_preserve_other_fields_and_reject_invalid_atomically(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            path.write_text('{}')
            live = SimpleNamespace(set_report_hz=lambda value: None)
            service = PresentationSettings(path, live=live)
            self.assertEqual(service.patch({'buffer_ms': 700}), dict(DEFAULT_PRESENTATION, buffer_ms=700))
            self.assertEqual(service.patch({'interpolate': True})['buffer_ms'], 700)
            before = service.settings(), path.read_bytes(), path.stat().st_mtime_ns
            for invalid in ([], None, {'unknown': 1}, {'buffer_ms': -1}, {'interpolate': None},
                            {'report_hz': 0, 'limit_tint': False}):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    service.patch(invalid)
                self.assertEqual((service.settings(), path.read_bytes(), path.stat().st_mtime_ns), before)
            self.assertEqual(service.patch({}), before[0])
            self.assertEqual(path.stat().st_mtime_ns, before[2])

    def test_concurrent_disjoint_patches_both_survive_and_failed_live_update_rolls_back(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            path.write_text('{}')
            service = PresentationSettings(path)
            barrier, failures = threading.Barrier(3), []
            def apply(changes):
                try:
                    barrier.wait()
                    service.patch(changes)
                except Exception as error:
                    failures.append(error)
            workers = [threading.Thread(target=apply, args=(value,))
                       for value in ({'buffer_ms': 700}, {'limit_tint': False})]
            for worker in workers:
                worker.start()
            barrier.wait()
            for worker in workers:
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(service.settings(), dict(DEFAULT_PRESENTATION, buffer_ms=700, limit_tint=False))
            before = service.settings(), json.loads(path.read_text())
            def reject(value):
                raise RuntimeError('worker stopped')
            service.live = SimpleNamespace(set_report_hz=reject)
            with self.assertRaisesRegex(RuntimeError, 'worker stopped'):
                service.patch({'report_hz': 50, 'buffer_ms': 100})
            self.assertEqual((service.settings(), json.loads(path.read_text())), before)

    def test_defaults_validation_and_other_settings_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            original = dict(ingest_directory='recordings', source=dict(mpc_root='/source'),
                            plotters_directory='plots', solver_profiles=[dict(id='first', mpc_root='/other')])
            path.write_text(json.dumps(original))
            self.assertEqual(load_visualizer_config(path).presentation, DEFAULT_PRESENTATION)
            service = PresentationSettings(path)
            updated = dict(DEFAULT_PRESENTATION, report_hz=10, buffer_ms=1000, interpolate=True, limit_tint=False,
                           ghost_start_opacity_percent=70, ghost_end_opacity_percent=10,
                           limit_near_percent=80, limit_at_position_rad=0, limit_at_velocity_rad_s=.05,
                           limit_at_torque_percent=1.5)
            self.assertEqual(service.update(updated), updated)
            self.assertEqual(json.loads(path.read_text()), dict(original, presentation=updated))
            save_source_selection(path, dict(mpc_root='/new-source'))
            save_local_settings(path, plotters_directory='new-plots', solver_profiles=[])
            self.assertEqual(load_visualizer_config(path).presentation, updated)
            self.assertEqual(PresentationSettings(path).settings(), updated)
        for changes in (dict(report_hz=True), dict(report_hz=0), dict(report_hz=121),
                        dict(report_hz=float('nan')), dict(buffer_ms=-1), dict(buffer_ms=10001),
                        dict(buffer_ms=float('inf')), dict(interpolate=1), dict(limit_tint=1),
                        dict(ghost_start_opacity_percent=-1), dict(ghost_start_opacity_percent=101),
                        dict(ghost_start_opacity_percent=True), dict(ghost_start_opacity_percent=float('nan')),
                        dict(ghost_end_opacity_percent=-1), dict(ghost_end_opacity_percent=101),
                        dict(ghost_end_opacity_percent=False), dict(ghost_end_opacity_percent='25'),
                        dict(limit_near_percent=0), dict(limit_near_percent=101), dict(limit_near_percent=True),
                        dict(limit_at_position_rad=-.001), dict(limit_at_position_rad=.2),
                        dict(limit_at_velocity_rad_s=float('nan')), dict(limit_at_torque_percent=11)):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_presentation(dict(DEFAULT_PRESENTATION, **changes))
        for invalid in ({}, [], dict(DEFAULT_PRESENTATION, extra=1)):
            with self.assertRaises(ValueError):
                validate_presentation(invalid)

    def test_saved_config_without_limit_use_fields_takes_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            older = dict(report_hz=30, buffer_ms=100, interpolate=True, limit_tint=False)
            path.write_text(json.dumps(dict(presentation=older)))
            self.assertEqual(load_visualizer_config(path).presentation, dict(DEFAULT_PRESENTATION, **older))
            self.assertEqual(DEFAULT_PRESENTATION['limit_near_percent'], 90)
            self.assertEqual(DEFAULT_PRESENTATION['ghost_start_opacity_percent'], 55)
            self.assertEqual(DEFAULT_PRESENTATION['ghost_end_opacity_percent'], 25)
            self.assertEqual(DEFAULT_PRESENTATION['limit_at_position_rad'], .003)
            self.assertEqual(DEFAULT_PRESENTATION['limit_at_velocity_rad_s'], .01)
            self.assertEqual(DEFAULT_PRESENTATION['limit_at_torque_percent'], .2)

    def test_legacy_scalar_ghost_opacity_migrates_on_load_without_writing_and_saves_new_endpoints(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            legacy = dict(source=dict(mpc_root='/source'), presentation=dict(ghost_opacity_percent=70))
            path.write_text(json.dumps(legacy))
            before = path.read_bytes(), path.stat().st_mtime_ns
            value = load_visualizer_config(path).presentation
            self.assertEqual(value['ghost_start_opacity_percent'], 70)
            self.assertAlmostEqual(value['ghost_end_opacity_percent'], 70 * (25 / 55))
            self.assertNotIn('ghost_opacity_percent', value)
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)
            service = PresentationSettings(path)
            self.assertEqual(service.settings(), value)
            changed = dict(value, ghost_end_opacity_percent=12)
            service.update(changed)
            self.assertEqual(json.loads(path.read_text()), dict(legacy, presentation=changed))
            self.assertEqual(load_visualizer_config(path).presentation, changed)
            for endpoint in ('ghost_start_opacity_percent', 'ghost_end_opacity_percent'):
                incomplete = dict(DEFAULT_PRESENTATION)
                incomplete.pop(endpoint)
                with self.assertRaises(ValueError):
                    validate_presentation(incomplete)
            with self.assertRaises(ValueError):
                validate_presentation(dict(DEFAULT_PRESENTATION, ghost_opacity_percent=70))

    def test_explicit_ghost_endpoints_override_legacy_scalar_and_missing_endpoints_derive_from_it(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'visualizer.json'
            for new, start, end in ((dict(ghost_start_opacity_percent=80, ghost_end_opacity_percent=10), 80, 10),
                                    (dict(ghost_start_opacity_percent=80), 80, 70 * (25 / 55)),
                                    (dict(ghost_end_opacity_percent=10), 70, 10)):
                with self.subTest(new=new):
                    path.write_text(json.dumps(dict(presentation=dict(ghost_opacity_percent=70, **new))))
                    value = load_visualizer_config(path).presentation
                    self.assertEqual(value['ghost_start_opacity_percent'], start)
                    self.assertAlmostEqual(value['ghost_end_opacity_percent'], end)
                    self.assertNotIn('ghost_opacity_percent', value)

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
                value = dict(DEFAULT_PRESENTATION, report_hz=60, buffer_ms=0, interpolate=False, limit_tint=True)
                request = Request(url, data=json.dumps(value).encode(), headers={'Content-Type':'application/json'})
                self.assertEqual(json.load(urlopen(request)), value)
                self.assertEqual(json.load(urlopen(url)), value)
                self.assertEqual(load_visualizer_config(path).presentation, value)
                request = Request(url + '/patch', data=b'{"buffer_ms": 123}',
                                  headers={'Content-Type':'application/json'})
                value = dict(value, buffer_ms=123)
                self.assertEqual(json.load(urlopen(request)), value)
                self.assertEqual(json.load(urlopen(url)), value)
                request = Request(url + '/patch', data=b'{"unknown": 1}',
                                  headers={'Content-Type':'application/json'})
                with self.assertRaises(HTTPError) as caught:
                    urlopen(request)
                self.assertEqual(caught.exception.code, 400)
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
            header = dict(type='segment', sim_time_s=0., context=dict(task=dict(kind='reach')))
            packets = [dict(kind='records', generation=0, token=0, report_end=last,
                            records=[*first, dict(type='state', sim_time_s=t, q=[t]*7)])
                       for t,last,first in ((0.,False,[header]),(.001,True,[]))]
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
                # The segment header is announced once, with the report that carried it.
                self.assertEqual([e['type'] for _,e in live.events], ['history','segment','state','status'])
                self.assertEqual(live.latest['state']['sim_time_s'], .001)
                page = live.history(0)
                self.assertEqual([r['type'] for r in page['records']], ['segment','state','state'])
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

        class Session(NativeSession):
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

        with patch('live_mpc.GPULocks', FakeLocks), patch('execution_worker.NativeSession', Session), \
             patch('execution_worker.CompletedRecords', Buffer), \
             patch('execution_worker.time.monotonic', return_value=100.):
            worker_main(Path('.'), commands, Results(), revision, shutdown,
                        adapter_factory=FakeAdapter, schema_factory=lambda root: schema, report_hz=30)
        self.assertEqual(rates, [30, 10])
        self.assertEqual(len(sessions), 1)
        self.assertEqual(revision.value, 0)
        packets = [m for m in messages if m['kind']=='records']
        self.assertTrue(all((m['generation'],m['token']) == (3,0) for m in packets))
        records = [r for m in packets for r in m['records']][2:]  # Exclude the immediate header and initial state.
        expected = [r for batch in batches for r in batch]
        self.assertEqual(len(records), len(expected))
        self.assertTrue(all(a is b for a,b in zip(records,expected)))
        self.assertEqual(sum(r['type']=='interval' for r in records),20)
        plans = [r for r in records if r['type']=='plan']
        self.assertEqual([p['stats']['controller_restarted'] for p in plans], [True]+[False]*19)
        self.assertTrue(all(p['settings_version']==1 for p in plans))
        # With fixed wall time, progress and report updates cannot flush history.
        # Header and initial state, then only completion's report (239 records: one packet).
        self.assertEqual(len(packets), 2)
        self.assertTrue(packets[-1]['complete'])


if __name__ == '__main__':
    unittest.main()
