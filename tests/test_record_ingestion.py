"""Process-level ownership and bounded buffering with a stalled presenter."""
import multiprocessing as mp
import pickle
import queue
import time
import unittest
from unittest.mock import patch

from record_ingestion import RecordIngestion
from solver_exchange import RecordingRing, RING_HEADER, resolve_record


def unfinished_capture_worker(root, commands, results, revision, shutdown, *args):
    from tests.test_execution import fake_schema
    results.put(dict(kind='ready', schema=fake_schema(root)))
    ring = RecordingRing()
    try:
        slot = ring.reserve(1)
        # The ingester owns this locator while waiting for publication. Killing
        # it loses that locator, exercising cleanup beyond merely draining input.
        results.put(dict(kind='records', generation=0, token=0, records=[dict(
            _recording=dict(path=str(ring.path), slot=slot, request_id=1))]))
        shutdown.wait(10)
    finally:
        ring.close()


def wait_for(predicate, timeout=5):
    until = time.monotonic()+timeout
    while not predicate():
        if time.monotonic() >= until:
            raise AssertionError('Timed out waiting for ingestion')
        time.sleep(.005)


class RecordIngestionTests(unittest.TestCase):
    def make_ingestion(self, capacity=1024*1024):
        context = mp.get_context('spawn')
        source = context.Queue()
        ingestion = RecordIngestion(context, source, capacity=capacity)
        self.addCleanup(source.close)
        self.addCleanup(ingestion.close)
        return source, ingestion

    def test_stalled_presentation_does_not_retain_solver_slots_and_fifo_is_lossless(self):
        source, ingestion = self.make_ingestion()
        ring = RecordingRing(budget_bytes=128+64*(16+256*1024))
        try:
            # More than the entire producer ring; the parent does not consume yet.
            for identifier in range(1, 161):
                slot = ring.put(identifier, dict(value=identifier, values=list(range(10))))
                source.put(dict(kind='records', generation=3, token=9, records=[dict(
                    type='plan', seq=identifier,
                    _recording=dict(path=str(ring.path), slot=slot, request_id=identifier))]))
            source.put(dict(kind='events', events=[dict(type='status', state='paused')]))
            wait_for(lambda: ingestion.metrics()['packets'] == 161)
            self.assertEqual(RING_HEADER.unpack_from(ring.mapping)[1], 0)
            ring.close()
            self.assertFalse(ring.path.exists())
            for identifier in range(1, 161):
                packet = ingestion.get(timeout=2)
                record = packet['records'][0]
                self.assertNotIn('_recording', record)
                self.assertIsInstance(record['_recording_bytes'], bytes)
                resolved = resolve_record(record)
                self.assertEqual((resolved['seq'], resolved['value']), (identifier, identifier))
                self.assertEqual(packet['generation'], 3)
            self.assertEqual(ingestion.get(timeout=2)['events'][0]['state'], 'paused')
            self.assertEqual(ingestion.metrics()['queued_bytes'], 0)
        finally:
            if not ring.mapping.closed:
                ring.close()

    def test_byte_budget_applies_lossless_backpressure_and_resumes_in_order(self):
        source, ingestion = self.make_ingestion(capacity=8192)
        packets = [dict(kind='records', index=i, data=b'x'*3000) for i in range(4)]
        for packet in packets:
            source.put(packet)
        wait_for(lambda: ingestion.metrics()['packets'] == 2)
        time.sleep(.05)
        self.assertEqual(ingestion.metrics()['packets'], 2)
        self.assertLessEqual(ingestion.metrics()['peak_bytes'], 8192)
        self.assertEqual([ingestion.get(timeout=2) for _ in packets], packets)
        wait_for(lambda: ingestion.metrics()['backpressure_wall_s'] > 0)
        self.assertEqual(ingestion.metrics()['queued_bytes'], 0)

    def test_close_wakes_full_buffer_and_reclaims_pending_captures(self):
        source, ingestion = self.make_ingestion(capacity=4096)
        ring = RecordingRing()
        try:
            for identifier in range(1, 7):
                slot = ring.put(identifier, dict(data=b'x'*2500))
                source.put(dict(kind='records', records=[dict(_recording=dict(
                    path=str(ring.path), slot=slot, request_id=identifier))]))
            wait_for(lambda: ingestion.metrics()['packets'] == 1)
            ingestion.begin_close()
            # Simulate the producer having exited/flushed its multiprocessing queue.
            source.close()
            source.join_thread()
            ingestion.finish()
            wait_for(lambda: RING_HEADER.unpack_from(ring.mapping)[1] == 0)
            ingestion.close()
            self.assertFalse(ingestion.process.is_alive())
        finally:
            ring.close()
        self.assertFalse(ring.path.exists())

    def test_oversize_packet_is_explicit_failure_and_releases_capture(self):
        source, ingestion = self.make_ingestion(capacity=4096)
        ring = RecordingRing()
        try:
            slot = ring.put(1, dict(data=b'x'*8192))
            source.put(dict(kind='records', generation=2, token=7, records=[dict(
                _recording=dict(path=str(ring.path), slot=slot, request_id=1))]))
            packet = ingestion.get(timeout=5)
            self.assertEqual(packet['kind'], 'ingestion_failure')
            self.assertEqual((packet['generation'], packet['token']), (2, 7))
            self.assertIn('exceeds', packet['message'])
            self.assertEqual(RING_HEADER.unpack_from(ring.mapping)[1], 0)
        finally:
            ring.close()

    def test_packet_credit_is_serialized_bytes_not_record_count(self):
        source, ingestion = self.make_ingestion()
        packet = dict(kind='events', events=[dict(type='status', state='paused')])
        source.put(packet)
        wait_for(lambda: ingestion.metrics()['packets'] == 1)
        self.assertEqual(ingestion.metrics()['queued_bytes'], len(pickle.dumps(packet, protocol=5)))
        self.assertEqual(ingestion.get(timeout=2), packet)
        self.assertEqual(ingestion.metrics()['queued_bytes'], 0)


class IngestionLifecycleTests(unittest.TestCase):
    def service(self, worker=None):
        from execution_bridge import ProcessLiveService
        from tests.test_execution import FakeAdapter, fake_schema, fake_worker, FakeRenderer, MPC_ROOT
        service = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter,
            schema_factory=fake_schema, worker_target=worker or fake_worker, render_factory=FakeRenderer)
        self.addCleanup(service.close)
        return service

    def test_invalid_budget_rejects_before_starting_workers(self):
        from execution_bridge import ProcessLiveService
        with patch.dict('os.environ', TIAGO_VISUALIZER_INGEST_BUFFER_MIB='invalid'), \
             patch('execution_bridge.mp.get_context') as context:
            with self.assertRaisesRegex(ValueError, 'INGEST_BUFFER'):
                ProcessLiveService('/unused')
            context.assert_not_called()

    def test_stale_ingestion_error_cannot_cancel_current_work(self):
        service = self.service()
        service.results.put(dict(kind='ingestion_failure', generation=0, token=-1, message='stale'))
        service.results.put(dict(kind='events', generation=0, token=0,
                                events=[dict(type='test_barrier')]))
        wait_for(lambda: any(event.get('type') == 'test_barrier' for _, event in service.events))
        self.assertNotIn('error', [event.get('type') for _, event in service.events])
        self.assertEqual(service.revision.value, 0)

    def test_unexpected_numerical_exit_is_reported_after_ingestion_drains(self):
        service = self.service()
        service._process.terminate()
        service._process.join(2)
        wait_for(lambda: any('Numerical worker exited' in event.get('message', '')
                             for _, event in service.events))

    def test_killed_ingester_stops_producer_and_reclaims_its_lost_locator(self):
        from runtime_files import runtime_directory
        service = self.service(unfinished_capture_worker)
        folder = runtime_directory('solver-buffers')
        pattern = f'p{service._process.pid}-recording-*.buffer'
        wait_for(lambda: bool(list(folder.glob(pattern))))
        # The queue is empty only after the ingester has taken its first packet.
        wait_for(lambda: service.results.empty())
        service.ingestion.process.terminate()
        service.ingestion.process.join(2)
        wait_for(lambda: service.shutdown.is_set())
        wait_for(lambda: not service._process.is_alive())
        wait_for(lambda: not list(folder.glob(pattern)))
        self.assertTrue(any('Recording ingestion exited' in event.get('message', '')
                            for _, event in service.events))


if __name__ == '__main__':
    unittest.main()
