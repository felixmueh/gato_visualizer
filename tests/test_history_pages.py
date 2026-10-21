"""Raw HTTP pages reuse only the bounded, committed JSONL byte window."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from execution_bridge import HistoryGenerationError, HistoryStore


class EncodedHistoryPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = HistoryStore(self.temp.name)
        self.store.reset(7)
        self.records = [dict(type='state', generation=7, sim_time_s=i/1000,
                             q=[i/1000, -0.0, 1e-20], nested={'label': 'μ "quoted"\nline'})
                        for i in range(601)]
        self.store.append(self.records)
        self.store.complete = False

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_raw_page_matches_existing_encoding_exactly_and_never_decodes_records(self):
        for after, limit in ((0, 1), (0, 256), (255, 256), (512, 256), (601, 256)):
            with self.subTest(after=after, limit=limit):
                page = self.store.page(7, after, limit)
                expected = json.dumps(page, allow_nan=False, separators=(',', ':')).encode()
                with patch('execution_bridge.json.loads', side_effect=AssertionError('Decoded history JSON')):
                    actual = self.store.page_json(7, after, limit)
                self.assertEqual(actual, expected)
                self.assertEqual(json.loads(actual)['records'], self.records[after:after+limit])

    def test_generation_and_page_limits_match_python_page(self):
        for method in (self.store.page, self.store.page_json):
            with self.assertRaises(HistoryGenerationError):
                method(6, 0, 256)
            for after, limit in ((-1, 256), (602, 256), (0, 0), (0, 257)):
                with self.subTest(method=method.__name__, after=after, limit=limit), self.assertRaises(ValueError):
                    method(7, after, limit)

    def test_captured_page_excludes_later_appends_and_survives_generation_reset(self):
        old = self.store.path
        original_open = Path.open
        def open_after_change(path, *args, **kwargs):
            if path == old and args == ('rb',):
                self.store.append([dict(type='state', sim_time_s=999., q=[99]*7)])
                self.store.reset(8)
            return original_open(path, *args, **kwargs)
        with patch.object(Path, 'open', open_after_change):
            page = json.loads(self.store.page_json(7, 590, 256))
        self.assertEqual(page, dict(generation=7, next_cursor=601, complete=False,
                                    records=self.records[590:], history_end_s=.6))
        self.assertEqual(self.store.generation, 8)
        self.assertTrue(old.exists())

    def test_truncated_committed_page_is_rejected(self):
        self.store.stream.truncate(self.store.stream.tell()-1)
        self.store.stream.flush()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            self.store.page_json(7, 600, 256)
