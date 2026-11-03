"""Compact playback is a projection, never a reduced authoritative recording."""
from copy import deepcopy
import errno
import gzip
import json
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from history_store import HistoryGenerationError, HistoryStore, playback_record
from server import make_server


def fixture_records():
    return [
        dict(type='segment', generation=0, settings_version=1, sim_time_s=0.,
             context=dict(task=dict(kind='reach'), joint_names=['J1'])),
        dict(type='state', generation=0, settings_version=1, sim_time_s=0., q=[.1], qd=[.2], torque_nm=[3.]),
        dict(type='plan', generation=0, settings_version=1, origin='play', seq=1,
             N=3, dt_s=.01, sim_time_s=0., request_time_s=0., plan_origin_time_s=.002,
             measured_time_s=0., available_time_s=.002, scheduled_activation_time_s=.002,
             solve_latency_s=.002, latency_overrun=False, stats=dict(sqp_iters=2),
             q=[[i/10] for i in range(300)], qd_rad_s=[[.2]], torque_nm=[[3.]],
             ee_xyz=[[1., 2., 3.]], reference_xyz=[[2., 3., 4.]],
             diagnostics=dict(initial_merit=[4., 2.]), initial_state=dict(q=[.1])),
        dict(type='control', generation=0, settings_version=1, sim_time_s=.002,
             plan_seq=1, torque_nm=[3.], requested_torque_nm=[4.], plan_activated=True),
        dict(type='state', generation=0, settings_version=1, sim_time_s=.003, q=[.11], qd=[.21], plan_seq=1),
        dict(type='interval', generation=0, settings_version=1, start_time_s=0., end_time_s=.003, solve_wall_s=.002),
        dict(type='event', generation=0, settings_version=1, sim_time_s=.003, event_kind='overrun', data={'wall_s': .004}),
        dict(type='plan', generation=0, settings_version=1, origin='play', seq=2,
             N=3, dt_s=.01, sim_time_s=.003, q=[[.7]], torque_nm=[[5.]], stats=dict(sqp_iters=1)),
    ]


class PlaybackStoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.store = HistoryStore(self.folder.name)
        self.addCleanup(self.store.close)
        self.records = fixture_records()
        self.store.append(self.records)

    def test_projection_preserves_cursor_motion_events_and_original_full_records(self):
        before = deepcopy(self.records)
        compact = []
        for cursor in range(0, len(self.records), 3):
            full = json.loads(self.store.page_json(0, cursor, 3))
            page = json.loads(self.store.page_json(0, cursor, 3, playback=True))
            self.assertEqual({k:v for k,v in full.items() if k != 'records'},
                             {k:v for k,v in page.items() if k != 'records'})
            compact.extend(page['records'])
        for original, projected in zip(self.records, compact):
            if original['type'] == 'plan':
                self.assertTrue(projected['summary'])
                self.assertEqual(projected['seq'], original['seq'])
                self.assertEqual(projected['stats'], original['stats'])
                self.assertNotIn('q', projected)
                self.assertNotIn('diagnostics', projected)
            else:
                self.assertEqual(projected, original)
        self.assertEqual(self.records, before)
        self.assertEqual(self.store.page(0, 0, 32)['records'], before)

    def test_projection_is_encoded_once_and_pages_never_decode_predictions(self):
        with patch('history_store.json.loads', side_effect=AssertionError('Unexpected prediction decode')):
            encoded = self.store.page_json(0, 0, 32, playback=True)
        self.assertEqual(json.loads(encoded)['records'], [playback_record(r) for r in self.records])
        self.assertEqual(len(self.store.playback_offsets), len(self.store.offsets))

    def test_preview_stays_complete_when_its_sequence_overlaps_a_play_solve(self):
        preview = dict(self.records[2], origin='preview', ee_xyz=[[9., 8., 7.]])
        self.store.append([preview])
        page = json.loads(self.store.page_json(0, 0, 32, playback=True))
        self.assertEqual(page['records'][-1], preview)
        self.assertTrue(page['records'][2]['summary'])
        selected = json.loads(self.store.plans_json(0, ['1', 'preview:1']))
        self.assertEqual(selected['plans'], [self.records[2], preview])

    def test_full_plans_use_index_and_preserve_requested_order_without_context_merge(self):
        with patch.object(self.store, '_page_encoded', side_effect=AssertionError('Unexpected history scan')):
            response = json.loads(self.store.plans_json(0, ['2', '1']))
        self.assertEqual(response, dict(generation=0, plans=[self.records[7], self.records[2]]))
        self.assertNotIn('task', response['plans'][0])
        self.assertNotIn('summary', response['plans'][0])
        for invalid in ([], [''], ['1', '1'], ['missing'], ['1']*33, [True]):
            with self.subTest(ids=invalid), self.assertRaises(ValueError):
                self.store.plans_json(0, invalid)

    def test_reset_rejects_old_generation_and_removes_both_files(self):
        paths = self.store.path, self.store.playback_path
        self.store.reset(1)
        self.assertTrue(all(not p.exists() for p in paths))
        self.assertEqual(self.store.playback_offsets, [])
        for read in (lambda: self.store.page_json(0, 0, 32, playback=True),
                     lambda: self.store.plans_json(0, ['1'])):
            with self.assertRaises(HistoryGenerationError):
                read()
        self.assertEqual(json.loads(self.store.page_json(1, 0, 32, playback=True))['records'], [])

    def test_truncated_compact_or_full_record_never_returns_partial_json(self):
        self.store.playback_stream.truncate(self.store.playback_stream.tell()-2)
        self.store.playback_stream.flush()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.store.page_json(0, 0, 32, playback=True)
        self.store.stream.truncate(self.store.stream.tell()-2)
        self.store.stream.flush()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.store.plans_json(0, ['2'])

    def test_second_file_failure_rolls_back_both_committed_prefixes(self):
        original = self.store.playback_stream
        before = self.store.path.read_bytes(), self.store.playback_path.read_bytes(), self.store.metadata()
        class FailedWrite:
            def __getattr__(self, name):
                return getattr(original, name)
            def write(self, payload):
                original.write(payload[:7])
                raise OSError(errno.ENOSPC, 'full')
        self.store.playback_stream = FailedWrite()
        with self.assertRaisesRegex(OSError, 'RAM-backed'):
            self.store.append([dict(type='state', sim_time_s=1., q=[5.])])
        self.assertEqual((self.store.path.read_bytes(), self.store.playback_path.read_bytes(), self.store.metadata()), before)
        self.store.playback_stream = original
        self.store.append([dict(type='state', sim_time_s=1., q=[5.])])
        self.assertEqual(json.loads(self.store.page_json(0, len(self.records), 1, playback=True))['records'][0]['q'], [5.])


class PlaybackHTTPTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.store = HistoryStore(self.folder.name)
        self.addCleanup(self.store.close)
        self.records = fixture_records()
        self.store.append(self.records)
        self.live = SimpleNamespace(generation=0, closed=False,
            history=self.store.page, history_json=self.store.page_json,
            playback_json=lambda generation, after, limit: self.store.page_json(generation, after, limit, playback=True),
            plans_json=self.store.plans_json)
        self.server = make_server(dict(trajectories=[]), b'<robot/>', {}, port=0, live=self.live)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def close_server(self):
        self.live.closed = True
        self.server.shutdown()
        self.thread.join(2)
        self.server.server_close()

    def request(self, path, compressed=False):
        request = Request(self.base+path, headers={'Accept-Encoding': 'gzip'} if compressed else {})
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            payload = response.read()
            if response.headers.get('Content-Encoding') == 'gzip':
                payload = gzip.decompress(payload)
            return response.status, json.loads(payload), response.headers

    def test_compact_and_selected_plan_http_are_compressed_and_lossless(self):
        code, page, headers = self.request('/api/live/playback?generation=0&after=0&limit=32', compressed=True)
        self.assertEqual(code, 200)
        self.assertEqual(page['records'], [playback_record(r) for r in self.records])
        self.assertEqual(headers.get('Content-Encoding'), 'gzip')
        code, result, headers = self.request('/api/live/plans?generation=0&ids=2,1', compressed=True)
        self.assertEqual(code, 200)
        self.assertEqual(result['plans'], [self.records[7], self.records[2]])
        self.assertEqual(headers.get('Content-Encoding'), 'gzip')

    def test_endpoint_validation_and_stale_generation_are_explicit(self):
        for path in ('/api/live/playback', '/api/live/playback?generation=0&generation=0',
                     '/api/live/playback?generation=0&after=', '/api/live/playback?generation=0&limit=2049',
                     '/api/live/playback?generation=0&unknown=1',
                     '/api/live/plans?generation=0', '/api/live/plans?generation=0&ids=',
                     '/api/live/plans?generation=0&ids=1,1', '/api/live/plans?generation=0&ids=1&ids=2',
                     '/api/live/plans?generation=0&ids=999', '/api/live/plans?generation=0&ids=1&unknown=1'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 400)
        self.store.reset(1)
        self.live.generation = 1
        for path in ('/api/live/playback?generation=0', '/api/live/plans?generation=0&ids=1'):
            code, body, _ = self.request(path)
            self.assertEqual(code, 409)
            self.assertEqual(body['generation'], 1)

    def test_compact_sse_preserves_full_preview_and_never_mutates_shared_plan(self):
        events = [self.records[2], dict(self.records[2], origin='preview'), self.records[1]]
        before = deepcopy(events)
        self.live.subscribe = lambda: (0, events)
        self.live.unsubscribe = lambda: None
        def stop(cursor, timeout):
            self.live.closed = True
            return cursor, []
        self.live.read_events = stop
        with urlopen(self.base+'/api/live/events?compact=1', timeout=3) as response:
            payload = response.read().decode()
        received = [json.loads(line[6:]) for line in payload.splitlines() if line.startswith('data: ')]
        self.assertTrue(received[0]['summary'])
        self.assertNotIn('q', received[0])
        self.assertEqual(received[1:], events[1:])
        self.assertEqual(events, before)
        self.live.closed = False
        with urlopen(self.base+'/api/live/events', timeout=3) as response:
            payload = response.read().decode()
        self.assertEqual([json.loads(line[6:]) for line in payload.splitlines() if line.startswith('data: ')], events)


if __name__ == '__main__':
    unittest.main()
