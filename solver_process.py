"""Selected-interpreter solver RPC. The numerical coordinator owns GPU locks.

The socket is independent of stdout: native diagnostics go to retained logs.
Every request/reply names its process epoch and request identity. This boundary
also supports future read-only inspection jobs without importing another GATO.
"""
from __future__ import annotations

from collections.abc import Mapping
from array import array
import json
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


def send_message(channel, message):
    payload = json.dumps(wire_value(message), allow_nan=False, separators=(",", ":")).encode()
    if len(payload) > MAX_MESSAGE_BYTES:
        raise ValueError("Solver RPC message exceeds the transport limit")
    channel.sendall(struct.pack("!Q", len(payload)) + payload)


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
    if size > MAX_MESSAGE_BYTES:
        raise ValueError("Solver RPC message exceeds the transport limit")
    message = json.loads(read(size))
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
            send_message(self.channel, dict(identity, operation=operation, payload=payload))
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


def model_contract(adapter):
    """Coordinate/semantic compatibility, separate from physical parameters."""
    return dict(joint_names=list(adapter.model.names)[1:], nq=adapter.model.nq,
        nv=adapter.model.nv, coordinate_units="rad,rad/s,Nm", torque_semantics="actuator_joint_torque",
        reference_frame="torso_lift_link", end_effector_frame=adapter.reach.EE_FRAME,
        world_from_reference=np.asarray(adapter.kinematics.world_from_torso.homogeneous).tolist(),
        tcp_offset=np.asarray(adapter.kinematics.ee_offset.homogeneous).tolist())


def validate_contract(simulator, predictor):
    for key in ("joint_names", "nq", "nv", "coordinate_units", "torque_semantics",
                "reference_frame", "end_effector_frame"):
        if simulator.get(key) != predictor.get(key):
            raise ValueError(f"Solver profile has incompatible {key}")
    for key in ("world_from_reference", "tcp_offset"):
        a, b = np.asarray(simulator.get(key)), np.asarray(predictor.get(key))
        if a.shape != (4, 4) or b.shape != (4, 4) or not np.allclose(a, b, rtol=0, atol=1e-9):
            raise ValueError(f"Solver profile has incompatible {key}")


def native_plan(event):
    """Convert all packed solver coordinates at the implementation boundary."""
    event = wire_value(event)
    xu, signs = np.asarray(event["_xu"]), np.asarray(event["_signs"])
    count = event["N"] - 1
    xu = xu.reshape(-1).copy()
    xu[:count * 21] *= np.tile(signs, count * 3)
    xu[count * 21:] *= np.tile(signs, 2)
    event["_xu"] = xu.tolist()
    event["_signs"] = [1.] * 7
    return event
