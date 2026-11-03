"""Preallocated RAM-backed control arrays and a bounded lossless recording ring.

Private tmpfs files use mmap for cross-interpreter sharing, avoiding shared_memory
resource-tracker ownership races. Socket notifications publish control writes;
flock protects recording slot publication/reclamation. No numerical objects or
controller state are pickled onto the control channel.
"""
from __future__ import annotations

import fcntl
import mmap
import math
import os
import operator
from pathlib import Path
import pickle
import struct
import time
import uuid

import numpy as np

from runtime_files import ended_owner, runtime_directory

CONTROL_HEADER = struct.Struct('!QddddddQ')
RING_HEADER = struct.Struct('!QQQQ')  # retired, occupied, slot bytes, producer PID
SLOT_HEADER = struct.Struct('!QQ')  # request id (0: free), bytes (0: reserved)
# Conservative minimum also used by the numerical/reporting batch thresholds.
# Enlarging the recording budget must not enlarge those batches.
SLOTS = 64
SLOT_BYTES = 256*1024
RECORDING_BUFFER_ENV = 'TIAGO_VISUALIZER_RECORDING_BUFFER_MIB'
DEFAULT_RECORDING_BUFFER_BYTES = 256*1024*1024
MAX_RECORDING_BUFFER_BYTES = 4096*1024*1024


def recording_buffer_bytes():
    """Explicit per-stream byte budget; sparse pages are committed on use."""
    value = os.environ.get(RECORDING_BUFFER_ENV, str(DEFAULT_RECORDING_BUFFER_BYTES//1024**2))
    try:
        mib = int(value)
    except ValueError:
        raise ValueError(f'{RECORDING_BUFFER_ENV} must be an integer from 1 to 4096') from None
    if not 1 <= mib <= 4096:
        raise ValueError(f'{RECORDING_BUFFER_ENV} must be an integer from 1 to 4096')
    return mib*1024*1024


def _ring_slots(file_bytes, slot_bytes):
    """Read capacity from the layout, independent of this process's settings."""
    if slot_bytes < SLOT_BYTES:
        raise ValueError('Invalid shared recording layout')
    slots, remainder = divmod(file_bytes-128, SLOT_HEADER.size+slot_bytes)
    if slots < SLOTS or remainder:
        raise ValueError('Invalid shared recording layout')
    return slots


def recording_slot_bytes(max_sqp_iters):
    # Four per-iteration channels, allowing eight bytes each; fixed horizon,
    # row diagnostics and metadata fit in the extra 64 KiB for supported N<=128.
    return max(SLOT_BYTES, 32*int(max_sqp_iters)+64*1024)


def _create(kind, size):
    folder = runtime_directory('solver-buffers')
    for old in folder.glob('p*-*.buffer'):
        if ended_owner(old.name.split('-', 1)[0]):
            old.unlink(missing_ok=True)
    path = folder / f'p{os.getpid()}-{kind}-{uuid.uuid4().hex}.buffer'
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    os.ftruncate(fd, size)
    return path, fd


class ControlArrays:
    """One request/result slot created and unlinked by the coordinator.

    The solver child attaches to the same file. Socket notifications transfer
    access: the coordinator writes the request, the child reads it and writes
    the result, then the coordinator copies the result before the next request.
    """
    def __init__(self, n, dt, path=None):
        self.n, self.dt = int(n), float(dt)
        size = 128+14*8+n*6*4+n*14*8+(n-1)*7*8
        self.owner = path is None
        if self.owner:
            self.path, self.fd = _create('control', size)
        else:
            self.path = Path(path)
            self.fd = os.open(self.path, os.O_RDWR)
            if os.fstat(self.fd).st_size != size:
                os.close(self.fd)
                raise ValueError('Shared control layout does not match the configured horizon')
        self.mapping = mmap.mmap(self.fd, size)
        offset = 128
        self.x = np.ndarray((14,), dtype=np.float64, buffer=self.mapping, offset=offset)
        offset += self.x.nbytes
        self.reference = np.ndarray((n,6), dtype=np.float32, buffer=self.mapping, offset=offset)
        offset += self.reference.nbytes
        self.states = np.ndarray((n,14), dtype=np.float64, buffer=self.mapping, offset=offset)
        offset += self.states.nbytes
        self.torques = np.ndarray((n-1,7), dtype=np.float64, buffer=self.mapping, offset=offset)

    def write_request(self, identifier, state, reference):
        if np.shape(reference) != self.reference.shape:
            raise ValueError('Reference does not match the configured horizon')
        self.x[:7], self.x[7:] = state.q, state.qd
        self.reference[:] = reference
        self.expected = identifier, state.t, getattr(state, 'measured_t', state.t)
        CONTROL_HEADER.pack_into(self.mapping, 0, *self.expected, 0., 0., 0., self.dt, self.n)

    def read_request(self, identifier):
        from tiago_mpc.interfaces import Prediction, State
        found, t, measured, _, _, _, dt, n = CONTROL_HEADER.unpack_from(self.mapping)
        if found != identifier or n != self.n or dt != self.dt:
            raise ValueError('Mismatched shared control request')
        if not np.isfinite(self.x).all():
            raise ValueError('Nonfinite shared control request')
        rotation = self.reference[:, 3:]
        if (not np.isfinite(self.reference[:, :3]).all() or
                not (np.isfinite(rotation).all(axis=1) | np.isnan(rotation).all(axis=1)).all()):
            raise ValueError('Reference positions must be finite; an orientation is three finite values or none')
        if np.abs(self.x).max() > np.finfo(np.float32).max:
            raise ValueError("The state is beyond the solver's range (the plant became unstable); press Reset")
        initial = (State(t, self.x[:7].copy(), self.x[7:].copy()) if measured == t else
                   Prediction(t, self.x[:7], self.x[7:], measured_t=measured))
        return initial, self.reference.copy()

    def write_result(self, identifier, plan, wall_s):
        found, t, measured, _, _, _, dt, n = CONTROL_HEADER.unpack_from(self.mapping)
        if (found != identifier or plan.t0 != t or plan.measured_t != measured or
                plan.dt != dt or plan.states.shape != self.states.shape or plan.torques.shape != self.torques.shape):
            raise ValueError('Solver plan does not match the shared control request')
        self.states[:], self.torques[:] = plan.states, plan.torques
        CONTROL_HEADER.pack_into(self.mapping, 0, identifier, t, measured,
            plan.stats['wall_s'], plan.stats.get('solve_time_us', 0.), wall_s, dt, n)

    def read_result(self, identifier):
        from tiago_mpc.interfaces import Plan
        found, t, measured, wall, solve_us, controller_wall, dt, n = CONTROL_HEADER.unpack_from(self.mapping)
        if ((found, t, measured) != self.expected or found != identifier or n != self.n or dt != self.dt):
            raise ValueError('Mismatched shared control reply')
        # Plan owns/validates its arrays before the next request can reuse the slot.
        return Plan(t, dt, self.states, self.torques,
                    dict(wall_s=wall, solve_time_us=solve_us, controller_wall_s=controller_wall), measured_t=measured)

    def close(self):
        self.x = self.reference = self.states = self.torques = None
        self.mapping.close()
        os.close(self.fd)
        if self.owner:
            self.path.unlink(missing_ok=True)


class RecordingRing:
    """Coordinator-owned storage with independently consumed solver captures.

    The child reserves and publishes slots; their locators transfer to ingestion
    or cancellation cleanup. Each locator must be consumed or discarded once.
    Closing the creator retires the ring, and the last consumer unlinks it after
    outstanding captures have been released. An attachment only closes its map.
    """
    def __init__(self, path=None, *, slot_bytes=SLOT_BYTES, budget_bytes=None):
        self.owner = path is None
        if self.owner:
            try:
                self.slot_bytes = operator.index(slot_bytes)
                budget = recording_buffer_bytes() if budget_bytes is None else operator.index(budget_bytes)
            except TypeError:
                raise ValueError('Recording slot and buffer sizes must be integer bytes') from None
            if self.slot_bytes < SLOT_BYTES:
                raise ValueError(f'Recording slot must hold at least {SLOT_BYTES} bytes')
            minimum = 128+SLOTS*(SLOT_HEADER.size+self.slot_bytes)
            if not minimum <= budget <= MAX_RECORDING_BUFFER_BYTES:
                raise ValueError(f'Recording buffer needs {minimum} to {MAX_RECORDING_BUFFER_BYTES} bytes '
                                 f'for {SLOTS} or more slots; increase {RECORDING_BUFFER_ENV}')
            self.slots = (budget-128)//(SLOT_HEADER.size+self.slot_bytes)
            size = 128+self.slots*(SLOT_HEADER.size+self.slot_bytes)
            self.path, self.fd = _create('recording', size)
            os.pwrite(self.fd, RING_HEADER.pack(0,0,self.slot_bytes,os.getpid()),0)
        else:
            self.path = Path(path)
            self.fd = os.open(path, os.O_RDWR)
            try:
                retired,count,self.slot_bytes,_ = RING_HEADER.unpack(os.pread(self.fd,RING_HEADER.size,0))
                size = os.fstat(self.fd).st_size
                self.slots = _ring_slots(size, self.slot_bytes)
            except (ValueError, struct.error):
                os.close(self.fd)
                raise ValueError('Invalid shared recording layout') from None
            os.pwrite(self.fd,RING_HEADER.pack(retired,count,self.slot_bytes,os.getpid()),0)
        self.capacity_bytes = size
        self.mapping = mmap.mmap(self.fd, size)
        self.next_slot = 0
        self.high_water_slots = 0
        self.reserve_wait_s = 0.
        self.reserve_wait_count = 0

    def reserve(self, identifier):
        """Reserve ownership before notifying control; payload readiness follows."""
        slot = self.next_slot % self.slots
        offset = 128+slot*(SLOT_HEADER.size+self.slot_bytes)
        waiting_since = None
        while True:
            fcntl.flock(self.fd, fcntl.LOCK_EX)
            retired, count, size, producer = RING_HEADER.unpack_from(self.mapping)
            occupied, _ = SLOT_HEADER.unpack_from(self.mapping, offset)
            if retired:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
                raise RuntimeError('Recording producer was retired')
            if not occupied:
                SLOT_HEADER.pack_into(self.mapping, offset, identifier, 0)
                RING_HEADER.pack_into(self.mapping, 0, retired, count+1, size, producer)
                fcntl.flock(self.fd, fcntl.LOCK_UN)
                self.next_slot += 1
                self.high_water_slots = max(self.high_water_slots, count+1)
                if waiting_since is not None:
                    self.reserve_wait_s += time.perf_counter()-waiting_since
                return slot
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            if waiting_since is None:
                waiting_since = time.perf_counter()
                self.reserve_wait_count += 1
            time.sleep(.001)  # Lossless backpressure, only when the consumer falls behind.

    def put(self, identifier, record, *, slot=None):
        payload = pickle.dumps(record, protocol=5)
        if len(payload) > self.slot_bytes:
            raise ValueError(f'Solve recording exceeds the {self.slot_bytes}-byte shared recording slot')
        slot = self.reserve(identifier) if slot is None else slot
        offset = 128+slot*(SLOT_HEADER.size+self.slot_bytes)
        fcntl.flock(self.fd,fcntl.LOCK_EX)
        try:
            found,_ = SLOT_HEADER.unpack_from(self.mapping,offset)
            if found == identifier:  # Cancellation may already have released the reservation.
                self.mapping[offset+SLOT_HEADER.size:offset+SLOT_HEADER.size+len(payload)] = payload
                SLOT_HEADER.pack_into(self.mapping,offset,identifier,len(payload))
        finally:
            fcntl.flock(self.fd,fcntl.LOCK_UN)
        return slot

    def close(self):
        if self.owner:
            fcntl.flock(self.fd, fcntl.LOCK_EX)
            _, count, size, producer = RING_HEADER.unpack_from(self.mapping)
            RING_HEADER.pack_into(self.mapping, 0, 1, count, size, producer)
            if count == 0:
                self.path.unlink(missing_ok=True)
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        self.mapping.close()
        os.close(self.fd)


def take_record(locator, *, discard=False, raw=False):
    """Free an owned slot; raw consumers defer deserialization to presentation."""
    path, slot, expected = locator['path'], locator['slot'], locator['request_id']
    if not isinstance(slot, int) or slot < 0:
        raise ValueError('Invalid recording slot')
    try:
        fd = os.open(path, os.O_RDWR)
    except FileNotFoundError:
        if discard:
            return None
        raise
    try:
        abandoned = False
        while True:
            fcntl.flock(fd, fcntl.LOCK_EX)
            retired,count,capacity,producer = RING_HEADER.unpack(os.pread(fd,RING_HEADER.size,0))
            slots = _ring_slots(os.fstat(fd).st_size, capacity)
            if slot >= slots:
                raise ValueError('Invalid recording slot')
            offset = 128+slot*(SLOT_HEADER.size+capacity)
            identifier, size = SLOT_HEADER.unpack(os.pread(fd, SLOT_HEADER.size, offset))
            if identifier != expected or size > capacity:
                if discard:
                    return None
                raise ValueError('Recording slot was reused or already consumed')
            if size or discard:
                break
            dead = ended_owner(f'p{producer}')
            if not dead:
                try:
                    dead = Path(f'/proc/{producer}/stat').read_text().rsplit(')',1)[1].split()[0] == 'Z'
                except FileNotFoundError:
                    dead = True
            if retired or dead:
                abandoned = True
                break
            fcntl.flock(fd,fcntl.LOCK_UN)
            # Only the independent consumer waits for recording readiness.
            time.sleep(.0001)
        payload = None if discard or abandoned else os.pread(fd, size, offset+SLOT_HEADER.size)
        os.pwrite(fd, SLOT_HEADER.pack(0, 0), offset)
        os.pwrite(fd, RING_HEADER.pack(retired, count-1, capacity, producer), 0)
        if retired and count == 1:
            Path(path).unlink(missing_ok=True)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    if abandoned:
        raise RuntimeError('Recording producer ended before publishing its reserved capture')
    if discard:
        return None
    if raw:
        return payload
    return _decode_record(payload)


def _decode_record(payload):
    result = pickle.loads(payload)
    if result is not None and '_recording_error' in result:
        raise RuntimeError(result['_recording_error'])
    return result


def resolve_record(record):
    """Materialize a buffered solve in the consumer process; ordinary records pass through."""
    if '_recording' in record:
        raw = take_record(record['_recording'])
        record = dict(raw, **{key:value for key,value in record.items() if key != '_recording'})
    elif '_recording_bytes' in record:
        raw = _decode_record(record['_recording_bytes'])
        record = dict(raw, **{key:value for key,value in record.items() if key != '_recording_bytes'})
    if '_schedule' in record:
        record = dict(record)
        at,latency,origin,rate,wall = record.pop('_schedule')
        available = at+latency
        record.update(request_time_s=at,sim_time_s=at,available_time_s=available,solve_latency_s=latency,
            scheduled_activation_time_s=origin+math.ceil((max(available,record['plan_origin_time_s'])-origin-1e-9)*rate)/rate,
            latency_overrun=bool(0 < latency < wall))
    if '_control' in record:
        record = dict(record)
        command,mpc,requested,seq,elapsed,new,clipped = record.pop('_control')
        record.update(torque_nm=command,mpc_torque_nm=mpc,requested_torque_nm=requested,
            law_sample_time_s=record['sim_time_s'],plan_seq=seq,plan_elapsed_s=elapsed,plan_activated=new,
            horizon_exhausted=False,plan_exhausted=False)
        if clipped:record['planned_torque_nm']=requested
    if record.get('_numerical'):
        record = {key:(value.tolist() if isinstance(value,np.ndarray) and not key.startswith('_') else value)
                  for key,value in record.items() if key != '_numerical'}
    return record


def discard_records(records):
    for record in records:
        if '_recording' in record:
            take_record(record['_recording'], discard=True)
