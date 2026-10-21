"""Indexed retained Solve lookups do not decode the 1000 Hz state stream."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from execution_bridge import HistoryGenerationError, HistoryStore
from inspection_problem import captured_problem
from solve_inspections import InspectionService
from tests.test_solve_inspections import plan


class PlanIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.history, self.previews = HistoryStore(root/'history'), HistoryStore(root/'previews')
        self.profile = dict(id='active', mpc_root='/selected/mpc', python='/selected/python', cache='/selected/cache')
        self.live = SimpleNamespace(history_store=self.history, inspection_store=self.previews)
        def descriptor(source):
            value = self.history.plot_source(source['generation'])
            value['preview_source'] = self.previews.plot_source(source['generation'])
            return value
        plots = SimpleNamespace(mpc_root='/simulator', default_scene={}, _descriptor=descriptor)
        profiles = SimpleNamespace(active_selection=lambda identifier=None: self.profile)
        self.service = InspectionService(plots, profiles, live=self.live, directory=root/'inspections')

    def tearDown(self):
        self.service.close()
        self.history.close()
        self.previews.close()
        self.temp.cleanup()

    def request(self, identifier, generation=0):
        return self.service._request(dict(source=dict(kind='live', generation=generation),
            selection=dict(solve_id=identifier)), capability=True)

    def test_one_plan_decode_after_thousands_of_states_and_exact_old_selection(self):
        first = dict(plan(), type='plan', id='7', seq=7)
        self.history.append([first])
        early = self.request('7')
        for packet in range(5):
            self.history.append([dict(type='state', sim_time_s=(packet*1000+i)*.001,
                                      q=[i]*7, plan_seq=7) for i in range(1000)])
            self.history.append([dict(first, id=str(8+packet), seq=8+packet)])
        before = self.history.path.read_bytes()
        with patch.object(self.service.reader, 'read', side_effect=AssertionError('Scanned Live stream')), \
             patch('execution_bridge.json.loads', wraps=json.loads) as decode:
            for request in (early, self.request('7'), self.request('12')):
                decode.reset_mock()
                problem, identifier = self.service._problem(request)
                self.assertEqual(problem, captured_problem(first))
                self.assertEqual(identifier, str(request['body']['selection']['solve_id']))
                self.assertEqual(decode.call_count, 1)
        self.assertEqual(self.history.path.read_bytes(), before)
        self.assertEqual(self.history.state_count, 5000)

    def test_descriptor_prefix_generation_path_and_missing_identity_are_strict(self):
        first = dict(plan(), type='plan', id='7', seq=7)
        self.history.append([first])
        descriptor = self.history.plot_source(0)
        self.history.append([dict(first, id='8', seq=8)])
        with self.assertRaisesRegex(ValueError, 'not retained'):
            self.history.selected_plan(descriptor, '8')
        for changes in (dict(cursor=descriptor['cursor']+1), dict(byte_end=descriptor['byte_end']-1),
                        dict(cursor=True), dict(kind='replay')):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'prefix'):
                self.history.selected_plan(dict(descriptor, **changes), '7')
        with self.assertRaises(HistoryGenerationError):
            self.history.selected_plan(dict(descriptor, path='/another/history.jsonl'), '7')
        for identifier in ('missing', 'preview:7', '', True, {'seq': 7}):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                self.history.selected_plan(descriptor, identifier)
        old, content = self.history.path, self.history.path.read_bytes()
        self.history.reset(1)
        self.assertEqual(old.read_bytes(), content)
        with self.assertRaises(HistoryGenerationError):
            self.history.selected_plan(descriptor, '7')
        with self.assertRaisesRegex(ValueError, 'not retained'):
            self.history.selected_plan(self.history.plot_source(1), '7')

    def test_previews_use_separate_index_and_keep_explicit_id_across_later_plans(self):
        executed = dict(plan(), type='plan', id='7', seq=7)
        preview = dict(executed, origin='preview', initial_state=dict(q=[.8]*7, qd=[0]*7, time_s=3.))
        self.history.append([executed])
        self.previews.append([preview])
        request = self.request('preview:7')
        self.previews.append([dict(preview, id='8', seq=8)])
        with patch.object(self.service.reader, 'read', side_effect=AssertionError('Scanned preview stream')):
            problem, identifier = self.service._problem(request)
            self.assertEqual(identifier, 'preview:7')
            self.assertEqual(problem, captured_problem(preview))
            self.assertEqual(self.service._problem(self.request(7))[0], captured_problem(executed))
            for identifier in ('preview:', 'preview:missing', 'preview:preview:7', '8'):
                with self.subTest(identifier=identifier), self.assertRaisesRegex(ValueError, 'not retained'):
                    self.service._problem(self.request(identifier))
        stale = deepcopy(request)
        stale['descriptor']['preview_source']['generation'] = 9
        with self.assertRaisesRegex(ValueError, 'not retained'):
            self.service._problem(stale)
        old = self.previews.path
        self.history.reset(1); self.previews.reset(1)
        self.assertTrue(old.exists())
        with self.assertRaises(HistoryGenerationError):
            self.service._problem(request)
        with self.assertRaisesRegex(ValueError, 'not retained'):
            self.service._problem(self.request('preview:7', generation=1))

    def test_live_trajectory_selector_never_falls_back_to_latest_plan(self):
        self.history.append([dict(plan(), type='plan', id='7', seq=7)])
        request = self.request('7')
        request['body']['selection'] = dict(trajectory_index=0)
        with self.assertRaisesRegex(ValueError, 'explicit retained solve id'):
            self.service._problem(request)
