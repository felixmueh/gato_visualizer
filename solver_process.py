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
from pathlib import Path
import socket
import struct
import subprocess
import time
import uuid

import numpy as np

ROOT = Path(__file__).resolve().parent
MAX_MESSAGE_BYTES = 512 * 1024 * 1024
ARRAY_FRAME = 1 << 63


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
            if dtype.kind == "f" and not np.isfinite(value).all():
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
        if dtype.kind == "f" and not np.isfinite(value).all():
            raise ValueError("Nonfinite solver RPC array")
        parent[key] = value
        offset += size
    if offset != len(payload):
        raise ValueError("Unexpected trailing solver RPC array bytes")
    return message


def send_lease(channel, descriptors):
    """Borrow the coordinator's existing flock descriptions, never reacquire."""
    rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array("i", descriptors))] if descriptors else []
    channel.sendmsg([b"L"], rights)


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


class SolverProcess:
    """One child; callers hold the coordinator's GPU lease for its whole call."""
    def __init__(self, profile, *, script=None, lease_fds=lambda: ()):
        self.profile = dict(profile)
        self.lease_fds = lease_fds
        self.epoch = uuid.uuid4().hex
        self.sequence = 0
        self.channel, child = socket.socketpair()
        folder = ROOT / "_expr_data/live/solver-processes"
        folder.mkdir(parents=True, exist_ok=True)
        self.log_path = folder / f"{time.time_ns()}-{self.epoch}.log"
        environment = dict(os.environ, GATO_CACHE_DIR=profile["cache"], PYTHONUNBUFFERED="1")
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

    def close(self):
        try:
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
