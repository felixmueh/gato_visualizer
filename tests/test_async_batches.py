"""Asynchronous publication, committed snapshots and cooperative pause ownership."""
import threading
import unittest

import numpy as np

from execution_session import DEFAULT_EXECUTION
from native_session import NativeSession
from tests.test_execution import FakeAdapter
from tests.test_solver_exchange import DeferredRemote


class AsyncBatchTests(unittest.TestCase):
    def session(self, *, buffered=False, latency=.002, to_hz=500.):
        adapter = FakeAdapter()
        adapter.N = 64
        if buffered:
            adapter.problem_configuration = dict(friction=None)
            adapter.remote = DeferredRemote(adapter)
        session = NativeSession(adapter, dict(DEFAULT_EXECUTION, to_hz=to_hz, solve_latency_s=latency,
                                              latency_compensation=False))
        self.addCleanup(session.close)
        return adapter, session

    def test_producer_continues_with_bounded_queue_and_owned_committed_snapshot(self):
        adapter, session = self.session()
        records = session.advance_interval(.2)
        progress = session.progress
        np.testing.assert_equal(progress.x.flags.writeable, False)
        state = progress.x.copy()
        with session._condition:
            self.assertTrue(session._condition.wait_for(lambda: len(session._batches) == 2, timeout=2))
            self.assertFalse(session._parked)
            self.assertGreater(adapter.t, progress.t)
        self.assertIs(session.progress, progress)
        np.testing.assert_array_equal(progress.x, state)
        records.extend(session.pause())
        self.assertTrue(session._parked)
        self.assertEqual(session.progress.t, adapter.t)
        times = [r['sim_time_s'] for r in records if r['type'] == 'state']
        np.testing.assert_allclose(times, np.arange(1, len(times)+1)*.002, atol=1e-12)
        paused_at = session.progress.t
        while session.progress.t < paused_at+.01-1e-12:
            records.extend(session.advance_interval(paused_at+.01))
        self.assertEqual(adapter.warmups, [0.])

    def test_close_wakes_full_batch_queue_and_restores_only_committed_tip(self):
        adapter, session = self.session()
        session.advance_interval(.2)
        tip = session.progress
        with session._condition:
            self.assertTrue(session._condition.wait_for(lambda: len(session._batches) == 2, timeout=2))
        closed = threading.Event()
        thread = threading.Thread(target=lambda: (session.close(), closed.set()), daemon=True)
        thread.start()
        self.assertTrue(closed.wait(2))
        thread.join()
        self.assertEqual(adapter.t, tip.t)
        np.testing.assert_array_equal(adapter.x, tip.x)
        self.assertEqual(session.solves, tip.solves)
        self.assertEqual(session.steps, tip.steps)
        self.assertEqual((session.interval_start, session.pending_solve_wall, session.pending_physics_wall,
                          session.pending_total_wall, session.pending_foreground_wall,
                          session.pending_solver_reported, session.pending_clipped), tip.interval)
        self.assertFalse(session._batches)

    def test_pause_arriving_after_nonblocking_poll_collects_before_parking(self):
        adapter, session = self.session(buffered=True, latency=.02)
        polled, allow_boundary = threading.Event(), threading.Event()
        result = adapter.remote.result_stream

        def delayed_poll(block=False):
            answer = result(block)
            if not block and adapter.remote.stream_pending and session.plant.t > 0 and not polled.is_set():
                polled.set()
                if not allow_boundary.wait(2):
                    raise AssertionError('Pause did not reach delayed poll')
            return answer

        adapter.remote.result_stream = delayed_poll
        # Establish the invocation without a second owner competing for batches.
        with session._condition:
            session._allowed_until = .2
            session._publish_at = .01
            session._thread = threading.Thread(target=session._run, daemon=True)
            session._thread.start()
        self.assertTrue(polled.wait(2))
        with session._condition:
            session._pause_requested = True
        allow_boundary.set()
        records = session.pause()
        self.assertTrue(session._parked)
        self.assertFalse(adapter.remote.stream_pending)
        self.assertAlmostEqual(adapter.t, .002)
        self.assertEqual(sum(r['type'] == 'plan' for r in records), 1)
        self.assertEqual(session.steps, 0)

    def failed_terminal_session(self):
        adapter, session = self.session(buffered=True, latency=0., to_hz=1.)
        adapter.N = 2
        def fail_close():
            raise RuntimeError('end stream failed')
        adapter.remote.end_stream = fail_close
        first = session.advance_interval(.1)
        with session._condition:
            self.assertTrue(session._condition.wait_for(lambda: session._finished, timeout=2))
        self.assertEqual(session.outcome.reason, 'lease_expired')
        self.assertFalse(session.finished)
        return adapter, session, first

    def test_terminal_cleanup_error_follows_committed_batches(self):
        _, session, records = self.failed_terminal_session()
        with self.assertRaisesRegex(RuntimeError, 'end stream failed'):
            while True:
                records.extend(session.advance_interval(.1))
        self.assertTrue(any(r['type'] == 'state' and abs(r['sim_time_s']-.02)<1e-12 for r in records))

    def test_pause_error_does_not_commit_discarded_tail(self):
        adapter, session, _ = self.failed_terminal_session()
        committed = session.progress
        with self.assertRaisesRegex(RuntimeError, 'end stream failed'):
            session.pause()
        self.assertIs(session.progress, committed)
        session.close()
        self.assertEqual(adapter.t, committed.t)

    def test_owner_partial_flush_updates_the_cancellation_checkpoint(self):
        _, session = self.session()
        session.advance_interval(.006, emit_partial=False)
        interval = session.flush_interval()
        self.assertIsNotNone(interval)
        self.assertEqual(session.progress.interval[0], .006)
        session.close()
        self.assertIsNone(session.flush_interval())


if __name__ == '__main__':
    unittest.main()
