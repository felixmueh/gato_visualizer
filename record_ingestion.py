"""Drain solver captures independently of presentation, with bounded byte credit.

Only this process consumes recording locators. It copies their serialized bytes
without decoding diagnostics, releases the solver slots, and queues owned packets.
The history process returns byte credit on receipt, before FK or JSON work.
"""
from __future__ import annotations

import os
import pickle
import queue
import time
import traceback

from solver_lifecycle import run_with_parent

BUFFER_ENV = 'TIAGO_VISUALIZER_INGEST_BUFFER_MIB'
DEFAULT_BUFFER_MIB = 256


def buffer_bytes():
    try:
        mib = int(os.environ.get(BUFFER_ENV, DEFAULT_BUFFER_MIB))
    except ValueError as error:
        raise ValueError(f'{BUFFER_ENV} must be a positive integer MiB budget') from error
    if not 1 <= mib <= 4096:
        raise ValueError(f'{BUFFER_ENV} must be an integer MiB budget between 1 and 4096')
    return mib * 1024 * 1024


def _ingest(source, output, condition, used, peak, waited, packets, capacity, discard, finished):
    from solver_exchange import take_record, discard_records
    while True:
        try:
            packet = source.get(timeout=.05)
        except queue.Empty:
            if finished.is_set():
                break
            continue
        records = packet.get('records', ())
        if discard.is_set():
            discard_records(records)
            continue
        captured = []
        try:
            for record in records:
                if '_recording' in record:
                    raw = take_record(record['_recording'], raw=True)
                    record = {key: value for key, value in record.items() if key != '_recording'}
                    record['_recording_bytes'] = raw
                captured.append(record)
            if records:
                packet = dict(packet, records=captured)
            payload = pickle.dumps(packet, protocol=5)
            if len(payload) > capacity:
                raise ValueError(f'Raw recording packet exceeds the {capacity}-byte ingestion budget')
        except Exception as error:
            discard_records(records[len(captured):])
            # Keep failure in FIFO order with the history preceding it.
            packet = dict(kind='ingestion_failure', generation=packet.get('generation'),
                          token=packet.get('token'), message=str(error), detail=traceback.format_exc())
            payload = pickle.dumps(packet, protocol=5)
        with condition:
            start = None
            while used.value + len(payload) > capacity and not discard.is_set():
                if start is None:
                    start = time.monotonic()
                condition.wait(.05)
            if start is not None:
                waited.value += time.monotonic()-start
            if discard.is_set():
                continue
            used.value += len(payload)
            peak.value = max(peak.value, used.value)
            packets.value += 1
        output.put(payload)
    output.put(None)


class RecordIngestion:
    """One CPU process and a byte-bounded FIFO; no renderer or GPU imports."""
    def __init__(self, context, source, *, capacity=None):
        self.capacity = buffer_bytes() if capacity is None else int(capacity)
        if self.capacity < 4096:
            raise ValueError('Ingestion capacity must be at least 4096 bytes')
        self.output = context.Queue()
        self.condition = context.Condition()
        self.used = context.Value('q', 0, lock=False)
        self.peak = context.Value('q', 0, lock=False)
        self.waited = context.Value('d', 0., lock=False)
        self.packets = context.Value('q', 0, lock=False)
        self.discard = context.Event()
        self.finished = context.Event()
        self.ended = False
        self.process = context.Process(target=run_with_parent, args=(os.getpid(), _ingest,
            source, self.output, self.condition, self.used, self.peak, self.waited,
            self.packets, self.capacity, self.discard, self.finished),
            name='live-mpc-ingest', daemon=True)
        try:
            self.process.start()
        except BaseException:
            self.output.close()
            raise

    def get(self, timeout=None):
        payload = self.output.get(timeout=timeout)
        if payload is None:
            self.ended = True
            raise EOFError('Recording ingestion finished')
        with self.condition:
            self.used.value -= len(payload)
            self.condition.notify_all()
        return pickle.loads(payload)

    def metrics(self):
        with self.condition:
            return dict(capacity_bytes=self.capacity, queued_bytes=self.used.value,
                        peak_bytes=self.peak.value, backpressure_wall_s=self.waited.value,
                        packets=self.packets.value)

    def begin_close(self):
        # Continue reclaiming solver slots while the coordinator shuts down.
        self.discard.set()
        with self.condition:
            self.condition.notify_all()

    def finish(self):
        # Called only after the numerical producer exits and flushes its queue.
        self.finished.set()

    def close(self):
        self.begin_close()
        self.finish()
        # Drain the output pipe so its feeder can exit even without a receiver.
        until = time.monotonic()+3
        while self.process.is_alive() and time.monotonic() < until:
            try:
                self.get(timeout=.05)
            except (queue.Empty, EOFError):
                pass
        self.process.join(timeout=.1)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=2)
        self.output.close()

    @staticmethod
    def reclaim_abandoned(coordinator_pid):
        """After producer shutdown, no capture from this service is still usable.

        An abruptly killed ingestion process can lose the locators in its current
        packet. Unlink only this stopped coordinator's private recording files;
        existing solver mappings survive until its parent-death cleanup finishes.
        """
        from runtime_files import runtime_directory, ended_owner
        if not ended_owner(f'p{coordinator_pid}'):
            return
        for path in runtime_directory('solver-buffers').glob(f'p{coordinator_pid}-recording-*.buffer'):
            path.unlink(missing_ok=True)
