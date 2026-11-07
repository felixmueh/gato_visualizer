"""Selected-interpreter solver RPC. The numerical coordinator owns GPU locks.

The socket is independent of stdout: native diagnostics go to retained logs.
Every request/reply names its process epoch and request identity. This boundary
also supports future read-only inspection jobs without importing another GATO.
"""
from __future__ import annotations

from collections.abc import Mapping
from array import array
import json
import math
import os
import select
from pathlib import Path
import socket
import struct
import subprocess
import time
import uuid

import numpy as np

from runtime_files import runtime_directory

ROOT = Path(__file__).resolve().parent
MAX_MESSAGE_BYTES = 512 * 1024 * 1024
ARRAY_FRAME = 1 << 63


def _telemetry_path(path):
    """Undefined recorded telemetry may cross the wire; control inputs may not."""
    return (len(path) >= 3 and path[:2] == ["result", "plan"]
            and path[2] in ("diagnostics", "_native_stats"))


def _array_dtype(value):
    try:
        dtype = np.dtype(value)
    except TypeError as exc:
        raise ValueError("Invalid solver RPC array dtype") from exc
    if (dtype.fields is not None or dtype.subdtype is not None or dtype.metadata is not None or
            dtype.kind not in "biuf" or dtype.itemsize not in (1, 2, 4, 8) or
            (dtype.kind == "f" and dtype.itemsize == 1)):
        raise ValueError("Unsupported solver RPC array dtype")
    return dtype


def _array_message(message):
    """Extract numerical buffers by path, without reserving JSON value tags."""
    descriptors, buffers = [], []
    total = 0
    def extract(value, path):
        nonlocal total
        if isinstance(value, np.ndarray):
            dtype = _array_dtype(value.dtype)
            total += value.nbytes
            if total > MAX_MESSAGE_BYTES:
                raise ValueError("Solver RPC message exceeds the transport limit")
            if dtype.kind == "f" and not _telemetry_path(path) and not np.isfinite(value).all():
                raise ValueError("Nonfinite solver RPC array")
            descriptors.append(dict(path=path, dtype=dtype.str, shape=list(value.shape), nbytes=value.nbytes))
            buffers.append(value.tobytes(order="C"))
            return None
        if isinstance(value, Mapping):
            if any(not isinstance(key, str) for key in value):
                raise TypeError("Array solver RPC objects require string keys")
            return {key: extract(item, [*path, key]) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [extract(item, [*path, index]) for index, item in enumerate(value)]
        return value
    return dict(message=extract(message, []), arrays=descriptors), buffers


def _restore_arrays(payload):
    """Arrays retain immutable frame bytes as their base after this call exits."""
    if len(payload) < 8:
        raise ValueError("Invalid solver RPC array frame")
    metadata_size, = struct.unpack_from("!Q", payload)
    offset = 8 + metadata_size
    if offset > len(payload):
        raise ValueError("Invalid solver RPC array metadata length")
    envelope = json.loads(payload[8:offset])
    if (not isinstance(envelope, dict) or set(envelope) != {"message", "arrays"} or
            not isinstance(envelope["message"], dict) or not isinstance(envelope["arrays"], list)):
        raise ValueError("Invalid solver RPC array envelope")
    message = envelope["message"]
    for item in envelope["arrays"]:
        if not isinstance(item, dict) or set(item) != {"path", "dtype", "shape", "nbytes"}:
            raise ValueError("Invalid solver RPC array descriptor")
        shape, size, path = item["shape"], item["nbytes"], item["path"]
        if (not isinstance(item["dtype"], str) or not isinstance(shape, list) or len(shape) > 32 or
                any(type(dimension) is not int or not 0 <= dimension <= MAX_MESSAGE_BYTES for dimension in shape) or
                type(size) is not int or size < 0):
            raise ValueError("Invalid solver RPC array shape or byte count")
        dtype = _array_dtype(item["dtype"])
        if dtype.str != item["dtype"] or math.prod(shape) * dtype.itemsize != size or offset + size > len(payload):
            raise ValueError("Inconsistent solver RPC array dtype, shape or byte count")
        if not isinstance(path, list) or not path:
            raise ValueError("Invalid solver RPC array path")
        parent = message
        for index, key in enumerate(path):
            if not ((isinstance(parent, dict) and isinstance(key, str) and key in parent) or
                    (isinstance(parent, list) and type(key) is int and 0 <= key < len(parent))):
                raise ValueError("Invalid solver RPC array path")
            if index + 1 < len(path):
                parent = parent[key]
        if parent[key] is not None:
            raise ValueError("Solver RPC array path is duplicate or does not replace a placeholder")
        value = np.frombuffer(payload, dtype=dtype, count=size // dtype.itemsize, offset=offset).reshape(shape)
        if dtype.kind == "f" and not _telemetry_path(path) and not np.isfinite(value).all():
            raise ValueError("Nonfinite solver RPC array")
        parent[key] = value
        offset += size
    if offset != len(payload):
        raise ValueError("Unexpected trailing solver RPC array bytes")
    return message


def send_lease(channel, descriptors, *, payload=b''):
    """Borrow the coordinator's existing flock descriptions, never reacquire."""
    rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array("i", descriptors))] if descriptors else []
    frame = b'L'+payload
    sent = channel.sendmsg([frame], rights)
    if sent < len(frame):
        channel.sendall(frame[sent:])


def receive_leased_message(channel):
    marker, ancillary, flags, _ = channel.recvmsg(1, socket.CMSG_SPACE(32 * array("i").itemsize),
                                                socket.MSG_CMSG_CLOEXEC)
    descriptors = []
    for level, kind, data in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            received = array("i")
            received.frombytes(data[:len(data) - len(data) % received.itemsize])
            descriptors.extend(received)
    try:
        if marker != b"L" or flags & socket.MSG_CTRUNC:
            raise RuntimeError("Invalid solver GPU lease transport")
        if channel.recv(1, socket.MSG_PEEK) == b'S':
            data = bytearray()
            while len(data) < 9:
                part = channel.recv(9-len(data))
                if not part:
                    raise RuntimeError('Solver process disconnected')
                data.extend(part)
            identifier, = struct.unpack('!Q', data[1:])
            return dict(protocol=1, operation='submit_stream', request_id=identifier), descriptors
        return receive_message(channel), descriptors
    except BaseException:
        for descriptor in descriptors:
            os.close(descriptor)
        raise


def wire_value(value):
    if isinstance(value, np.ndarray):
        return wire_value(value.tolist())
    if isinstance(value, Mapping):
        return {key: wire_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [wire_value(item) for item in value]
    return value.item() if isinstance(value, np.generic) else value


def reference_to_wire(rows):
    """tiago_mpc's (N, 6) reference rows (grasp-frame position, then orientation as a
    rotation vector, in its ROOT_FRAME) as JSON rows. The solver RPC and the history carry
    finite numbers only, so a NaN orientation slot (no orientation target) travels as null."""
    reference = np.asarray(rows, dtype=float)
    if reference.ndim != 2 or reference.shape[1] != 6:
        raise ValueError("A reference needs rows of six values")
    rotation = reference[:, 3:]
    if (not np.isfinite(reference[:, :3]).all() or
            not (np.isfinite(rotation).all(axis=1) | np.isnan(rotation).all(axis=1)).all()):
        raise ValueError("Reference positions must be finite; an orientation is three finite values or none")
    return [[None if math.isnan(value) else float(value) for value in row] for row in reference]


def reference_from_wire(rows, n):
    """The (n, 6) float32 rows tiago_mpc reads from reference_to_wire's JSON rows: null
    orientation slots become NaN; positions and given orientations must be finite."""
    if not isinstance(rows, (list, tuple, np.ndarray)) or len(rows) != n or any(
            not isinstance(row, (list, tuple, np.ndarray)) or len(row) != 6 for row in rows):
        raise ValueError(f"A reference needs {n} rows of six values")
    reference = np.array([[math.nan if value is None else value for value in row] for row in rows],
                         dtype=np.float32)
    rotation = reference[:, 3:]
    if (not np.isfinite(reference[:, :3]).all() or
            not (np.isfinite(rotation).all(axis=1) | np.isnan(rotation).all(axis=1)).all()):
        raise ValueError("Reference positions must be finite; an orientation is three finite values or none")
    return reference


def send_message(channel, message, *, array_buffers=False):
    # Let the JSON encoder traverse ordinary containers and numeric buffers in
    # C. Recursively normalizing every float in Python doubled this work.
    def encode(value):
        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, Mapping):
            return dict(value)
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")
    buffers = []
    if array_buffers:
        message, buffers = _array_message(message)
    payload = json.dumps(message, default=encode, allow_nan=False, separators=(",", ":")).encode()
    if array_buffers:
        payload = struct.pack("!Q", len(payload)) + payload
    size = len(payload) + sum(map(len, buffers))
    if size > MAX_MESSAGE_BYTES:
        raise ValueError("Solver RPC message exceeds the transport limit")
    channel.sendall(struct.pack("!Q", size | (ARRAY_FRAME if array_buffers else 0)) + payload + b"".join(buffers))


def receive_message(channel, deadline=None):
    def read(size):
        data = bytearray()
        while len(data) < size:
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Solver response deadline expired")
                channel.settimeout(remaining)
            part = channel.recv(min(size - len(data), 1048576))
            if not part:
                raise RuntimeError("Solver process disconnected")
            data.extend(part)
        return data
    size, = struct.unpack("!Q", read(8))
    array_buffers = bool(size & ARRAY_FRAME)
    size &= ~ARRAY_FRAME
    if size > MAX_MESSAGE_BYTES:
        raise ValueError("Solver RPC message exceeds the transport limit")
    payload = read(size)
    message = _restore_arrays(bytes(payload)) if array_buffers else json.loads(payload)
    if not isinstance(message, dict):
        raise ValueError("Solver RPC requires an object")
    return message


KEPT_LOGS = 16


class SolverProcess:
    """One child; callers hold the coordinator's GPU lease for its whole call."""
    def __init__(self, profile, *, script=None, lease_fds=lambda: ()):
        self.profile = dict(profile)
        self.lease_fds = lease_fds
        self.epoch = uuid.uuid4().hex
        self.sequence = 0
        self.control = self.recording = None
        self.stream_pending = False
        self.channel, child = socket.socketpair()
        folder = runtime_directory("solver-processes")
        # Bounded: keep the logs of the last KEPT_LOGS children (names sort by start time).
        for old in sorted(folder.glob("*.log"))[:-(KEPT_LOGS-1)]:
            old.unlink(missing_ok=True)
        self.log_path = folder / f"{time.time_ns()}-{self.epoch}.log"
        from source_runtime import cache_environment
        # GATO_CACHE_DIR only for an explicit cache override; else tiago_mpc's default.
        environment = dict(cache_environment(profile), PYTHONUNBUFFERED="1")
        # A launch-time source choice must not leak into a different profile.
        environment.pop("TIAGO_MPC_ROOT", None)
        environment.pop("TIAGO_PYTHON", None)
        environment["PATH"] = str(Path(profile["python"]).parent) + os.pathsep + environment.get("PATH", "")
        try:
            with self.log_path.open("wb") as log:
                self.process = subprocess.Popen([profile["python"], str(script or ROOT / "solver_worker.py"),
                    "--fd", str(child.fileno()), "--root", profile["mpc_root"],
                    "--parent-pid", str(os.getpid())],
                    pass_fds=(child.fileno(),), stdout=log, stderr=log, env=environment)
        except BaseException:
            self.channel.close()
            raise
        finally:
            child.close()

    def request(self, operation, *, timeout=None, **payload):
        if self.stream_pending:
            raise RuntimeError('Finish the pending numerical request before a setup operation')
        self.sequence += 1
        identity = dict(protocol=1, epoch=self.epoch, request_id=self.sequence)
        previous_timeout = self.channel.gettimeout()
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            self.channel.settimeout(timeout)
            send_lease(self.channel, list(self.lease_fds()))
            send_message(self.channel, dict(identity, operation=operation, payload=payload),
                         array_buffers=operation == "solve")
            reply = receive_message(self.channel, deadline=deadline)
        except TimeoutError as exc:
            self._stop(f"{operation} exceeded its {timeout}s startup/teardown deadline")
            raise RuntimeError(f"Solver {operation} timed out; diagnostics: {self.log_path}") from exc
        except (OSError, RuntimeError) as exc:
            raise RuntimeError(f"Solver process failed; diagnostics: {self.log_path}: {exc}") from exc
        finally:
            self.channel.settimeout(previous_timeout)
        if any(reply.get(key) != value for key, value in identity.items()):
            raise RuntimeError("Discarded stale or mismatched solver RPC reply")
        if not reply.get("ok"):
            raise ValueError(reply.get("error", "Solver request failed"))
        return reply.get("result")

    def start_stream(self, n, dt, *, recording=True, max_sqp_iters=5):
        from solver_exchange import ControlArrays, RecordingRing
        if self.control is not None:
            raise RuntimeError('A numerical stream is already active')
        self.control = ControlArrays(n, dt)
        from solver_exchange import recording_slot_bytes
        self.recording = RecordingRing(slot_bytes=recording_slot_bytes(max_sqp_iters)) if recording else None
        try:
            self.request('start_stream', n=n, dt=dt, control_path=str(self.control.path),
                         recording_path=str(self.recording.path) if self.recording else None)
        except BaseException:
            self.control.close()
            if self.recording is not None:
                self.recording.close()
            self.control = self.recording = None
            raise

    def submit_stream(self, state, reference):
        if self.stream_pending or self.control is None:
            raise RuntimeError('Numerical stream is not ready for a request')
        self.sequence += 1
        self.control.write_request(self.sequence, state, reference)
        send_lease(self.channel, list(self.lease_fds()), payload=b'S'+struct.pack('!Q', self.sequence))
        self.stream_pending = True
        return self.sequence

    def wait_stream(self):
        while not select.select([self.channel], [], [], .05)[0]:
            if self.process.poll() is not None:
                raise RuntimeError(f'Solver process disconnected; diagnostics: {self.log_path}')

    def wait_idle(self, timeout=15):
        """Wait for paused Live's own solve/capture, leaving its reply unread.

        A new request can be queued while the child finishes an older capture.
        Wait for the current reply before trusting the child's idle marker.
        Call only while the numerical invocation is parked.
        """
        deadline = time.monotonic()+timeout
        while self.control is not None:
            if self.process.poll() is not None:
                raise RuntimeError(f'Solver process disconnected; diagnostics: {self.log_path}')
            unread = self.stream_pending and not select.select([self.channel], [], [], 0.)[0]
            if not unread and not self.control.busy:
                return
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Live solver did not finish its pending work before the inspection timeout')
            time.sleep(min(.01, remaining))

    def result_stream(self, block=False):
        if not self.stream_pending:
            return None
        if block:
            self.wait_stream()
        elif not select.select([self.channel], [], [], 0.)[0]:
            if self.process.poll() is not None:
                raise RuntimeError(f'Solver process disconnected; diagnostics: {self.log_path}')
            return None
        if self.channel.recv(1, socket.MSG_PEEK) != b'R':
            self.stream_pending = False
            reply = receive_message(self.channel)
            raise ValueError(reply.get('error', 'Invalid numerical response'))
        data = bytearray()
        while len(data) < 13:
            part = self.channel.recv(13-len(data))
            if not part:
                raise RuntimeError('Solver process disconnected')
            data.extend(part)
        identifier, slot = struct.unpack('!QI', data[1:])
        self.stream_pending = False
        if identifier != self.sequence:
            raise ValueError('Discarded mismatched numerical response')
        plan = self.control.read_result(identifier)
        locator = (dict(path=str(self.recording.path), slot=slot, request_id=identifier)
                   if self.recording is not None else None)
        return plan, locator

    def end_stream(self):
        from solver_exchange import take_record
        try:
            if self.stream_pending:
                _, locator = self.result_stream(block=True)
                if locator is not None:
                    take_record(locator, discard=True)
            if self.control is not None and self.process.poll() is None:
                self.request('end_stream')
        finally:
            if self.control is not None:
                self.control.close()
            if self.recording is not None:
                self.recording.close()
            self.control = self.recording = None

    def close(self):
        try:
            self.end_stream()
            if self.process.poll() is None:
                try:
                    self.request("close", timeout=5)
                except (OSError, RuntimeError, ValueError):
                    # Closing the private socket also asks a failed child to
                    # exit at its next receive; preserve the original failure.
                    pass
        finally:
            self.channel.close()
            # Requests are serial: ordinary solves have finished before close.
            # Bound failed startup/teardown, while the coordinator holds leases.
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._stop("solver did not exit after close")

    def _stop(self, reason):
        with self.log_path.open("a") as log:
            log.write(f"\nCoordinator cleanup: {reason}\n")
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)

    def terminate(self, reason):
        """Explicit inspection Stop only; caller holds its GPU lease until exit.

        Ordinary Live Pause/cancel never uses this. Wait for any outstanding
        request thread to return before closing its socket.
        """
        self._stop(reason)


def model_contract(kinematics, tiago):
    """Coordinate/semantic compatibility, separate from physical parameters."""
    joints = list(tiago.RIGHT_ARM_JOINTS)
    return dict(joint_names=joints, nq=len(joints), nv=len(joints), coordinate_units="rad,rad/s,Nm",
        torque_semantics="actuator_joint_torque", reference_frame=tiago.ROOT_FRAME,
        end_effector_frame=kinematics.end_effector_frame,
        world_from_reference=np.asarray(kinematics.world_from_torso.homogeneous).tolist(),
        tcp_offset=np.asarray(kinematics.ee_offset.homogeneous).tolist())


def validate_contract(simulator, predictor):
    for key in ("joint_names", "nq", "nv", "coordinate_units", "torque_semantics",
                "reference_frame", "end_effector_frame"):
        if simulator.get(key) != predictor.get(key):
            raise ValueError(f"Solver profile has incompatible {key}")
    for key in ("world_from_reference", "tcp_offset"):
        a, b = np.asarray(simulator.get(key)), np.asarray(predictor.get(key))
        if a.shape != (4, 4) or b.shape != (4, 4) or not np.allclose(a, b, rtol=0, atol=1e-9):
            raise ValueError(f"Solver profile has incompatible {key}")
