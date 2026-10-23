"""Byte-exact batched history writes and atomic offset publication."""
import json
from pathlib import Path
import tempfile
import threading
import unittest

from execution_bridge import HistoryStore


class StreamCounter:
    def __init__(self, stream):
        self.stream = stream
        self.calls = dict(write=0, tell=0, flush=0)

    def write(self, value):
        self.calls['write'] += 1
        return self.stream.write(value)

    def tell(self):
        self.calls['tell'] += 1
        return self.stream.tell()

    def flush(self):
        self.calls['flush'] += 1
        return self.stream.flush()

    def close(self):
        self.stream.close()


class BatchHistoryTests(unittest.TestCase):
    def test_packet_write_is_byte_exact_with_every_offset_and_plan_retained(self):
        with tempfile.TemporaryDirectory() as folder:
            store = HistoryStore(folder)
            counter = StreamCounter(store.stream)
            store.stream = counter
            segment = dict(type='segment', sim_time_s=0., context=dict(joint_limits=dict(source='urdf'), task=dict(kind='reach')))
            records = []
            try:
                for packet in range(3):
                    batch = [dict(type='state', sim_time_s=(packet*500+i)*.001, q=[i]*7)
                             for i in range(500)]
                    batch.insert(101, dict(type='plan', seq=packet+1, sim_time_s=packet*.5,
                                           description='retained μ trajectory', q=[[packet]*7]))
                    if packet == 0:
                        batch.insert(0, segment)
                    records.extend(batch)
                    store.append_encoded(HistoryStore.encode(batch))
                    self.assertEqual(counter.calls, dict(write=packet+1, tell=packet+1, flush=packet+1))
                store.append_encoded([])
                self.assertEqual(counter.calls, dict(write=3, tell=3, flush=3))
                encoded = [json.dumps(record, allow_nan=False, separators=(',', ':')).encode()+b'\n'
                           for record in records]
                expected = b''.join(encoded)
                self.assertEqual(store.path.read_bytes(), expected)
                offset = 0
                for actual, line in zip(store.offsets, encoded):
                    self.assertEqual(actual, offset)
                    offset += len(line)
                restored = []
                for after in range(0, len(records), 256):
                    restored.extend(store.page(0, after, 256)['records'])
                self.assertEqual(restored, records)
                descriptor = store.plot_source(0)
                for record in records:
                    if record['type'] == 'plan':
                        # A plan is read with its segment's constant context.
                        self.assertEqual(store.selected_plan(descriptor, record['seq']), dict(segment['context'], **record))
                self.assertEqual(store.state_count, 1500)
                self.assertEqual(store.metadata(), dict(type='history', generation=0,
                    history_cursor=1504, history_end_s=1.499, complete=True))
                old = store.path
                store.reset(1)
                self.assertEqual(old.read_bytes(), expected)
                self.assertEqual(store.offsets, [])
                self.assertEqual(store.plan_offsets, {})
                fresh = dict(type='plan', seq=1, sim_time_s=0., q=[[99]*7])
                store.append([fresh])
                self.assertEqual(store.offsets, [0])
                with self.assertRaisesRegex(ValueError, 'no segment header'):
                    store.selected_plan(store.plot_source(1), 1)  # a history without its header fails clearly
                self.assertEqual(old.read_bytes(), expected)
            finally:
                store.close()

    def test_metadata_waits_for_complete_packet_before_publishing_offsets(self):
        with tempfile.TemporaryDirectory() as folder:
            store = HistoryStore(folder)
            writing, release, reader_attempted, read_done = (threading.Event() for _ in range(4))
            original_lock, original_stream = store.lock, store.stream
            class ObservedLock:
                def __enter__(self):
                    if threading.current_thread().name == 'metadata-reader':
                        reader_attempted.set()
                    original_lock.acquire()
                def __exit__(self, *args):
                    original_lock.release()
            class BlockedStream(StreamCounter):
                def write(self, value):
                    writing.set()
                    if not release.wait(3):
                        raise AssertionError('Test did not release packet write')
                    return super().write(value)
            store.lock, store.stream = ObservedLock(), BlockedStream(original_stream)
            results = []
            def read():
                results.append(store.metadata())
                read_done.set()
            writer = threading.Thread(target=store.append, args=([
                dict(type='state', sim_time_s=1., q=[1]*7),
                dict(type='plan', seq=1, sim_time_s=1.)],))
            reader = threading.Thread(target=read, name='metadata-reader')
            try:
                writer.start()
                self.assertTrue(writing.wait(2))
                reader.start()
                self.assertTrue(reader_attempted.wait(2))
                self.assertFalse(read_done.is_set())
            finally:
                release.set()
                writer.join(timeout=3)
                if reader.ident is not None:
                    reader.join(timeout=3)
                store.close()
            self.assertFalse(writer.is_alive())
            self.assertFalse(reader.is_alive())
            self.assertEqual(results[0]['history_cursor'], 2)
            self.assertEqual(results[0]['history_end_s'], 1.)
            self.assertEqual(store.state_count, 1)
            self.assertEqual(len(store.plan_offsets), 1)
