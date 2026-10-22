"""CPU regressions for the private numeric sidecar; no native modules loaded."""
from copy import deepcopy
import fcntl
import gc
import json
import os
import socket
import struct
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np

from solver_process import (ARRAY_FRAME, MAX_MESSAGE_BYTES, receive_leased_message,
                            receive_message, send_lease, send_message)


class ByteChannel:
    def __init__(self, payload=b"", chunk=1024):
        self.payload, self.chunk = payload, chunk

    def sendall(self, payload):
        self.payload += payload

    def recv(self, size):
        count = min(size, self.chunk)
        result, self.payload = self.payload[:count], self.payload[count:]
        return result

    def settimeout(self, timeout):
        self.timeout = timeout


def binary_frame(envelope, data=b""):
    metadata = json.dumps(envelope).encode()
    payload = struct.pack("!Q", len(metadata)) + metadata + data
    return struct.pack("!Q", ARRAY_FRAME | len(payload)) + payload


class ArrayTransportTests(unittest.TestCase):
    def test_nested_arrays_roundtrip_without_list_conversion_and_retain_lifetime(self):
        class BufferOnly(np.ndarray):
            def tolist(self):
                raise AssertionError("Numeric buffer converted to Python floats")
        floats = np.arange(24, dtype=np.float32).reshape(4, 6)[:, ::2].view(BufferOnly)
        expected = floats.copy()
        # Literal array-looking dictionaries and nulls have no reserved meaning.
        literal = {"__solver_array__": 0, "path": ["float"], "dtype": "<f4", "shape": [12]}
        message = dict(float=floats, nested=[dict(scalar=np.array(.125, dtype=">f8")),
                       np.array([True, False]), np.array([], dtype=np.int16)],
                       integer=np.uint64(2**63+1), literal=literal, nullable=None)
        channel = ByteChannel(chunk=7)
        send_message(channel, message, array_buffers=True)
        floats[:] = -99
        received = receive_message(channel)
        del message, floats, channel
        gc.collect()
        np.testing.assert_array_equal(received["float"], expected)
        self.assertEqual(received["float"].dtype, np.dtype("float32"))
        self.assertEqual(received["nested"][0]["scalar"].shape, ())
        self.assertEqual(received["nested"][0]["scalar"].dtype.str, ">f8")
        self.assertEqual(received["nested"][0]["scalar"].item(), .125)
        np.testing.assert_array_equal(received["nested"][1], [True, False])
        self.assertEqual(received["nested"][2].shape, (0,))
        self.assertEqual(received["integer"], 2**63+1)
        self.assertEqual(received["literal"], literal)
        self.assertIsNone(received["nullable"])
        with self.assertRaises(ValueError):
            received["float"][0, 0] = 1
        with self.assertRaises(ValueError):
            received["float"].flags.writeable = True

    def test_mixed_json_and_binary_frames_preserve_message_boundaries(self):
        sender, receiver = socket.socketpair()
        try:
            regular = dict(operation="configure", payload=dict(N=32, values=[.1, None, "text"]))
            send_message(sender, regular)
            send_message(sender, dict(state=np.arange(14, dtype=np.float64)), array_buffers=True)
            send_message(sender, dict(operation="close"))
            self.assertEqual(receive_message(receiver), regular)
            received = receive_message(receiver)
            np.testing.assert_array_equal(received["state"], np.arange(14))
            self.assertEqual(receive_message(receiver), dict(operation="close"))
            # Existing callers retain the exact ordinary JSON framing and
            # array-to-list semantics unless the solve explicitly enables it.
            channel = ByteChannel()
            send_message(channel, dict(array=np.array([1., 2.])))
            size, = struct.unpack("!Q", channel.payload[:8])
            self.assertFalse(size & ARRAY_FRAME)
            self.assertEqual(receive_message(channel), dict(array=[1., 2.]))
        finally:
            sender.close()
            receiver.close()

    def test_native_plan_arrays_cross_unchanged(self):
        states, torques = np.arange(42.).reshape(3, 14)/7, np.arange(14.).reshape(2, 7)/3
        channel = ByteChannel()
        send_message(channel, dict(plan=dict(_states=states, _torques=torques)), array_buffers=True)
        received = receive_message(channel)["plan"]
        np.testing.assert_array_equal(received["_states"], states)
        np.testing.assert_array_equal(received["_torques"], torques)

    def test_unsupported_dtypes_nonfinite_and_total_limit_rejected_before_send(self):
        invalid = (np.array([object()]), np.zeros(1, dtype=[("x", "f4")]),
                   np.array(["text"]), np.array([1j]), np.array([np.inf]), np.array([np.nan]))
        for value in invalid:
            channel = ByteChannel()
            with self.subTest(dtype=value.dtype), self.assertRaises(ValueError):
                send_message(channel, dict(value=value), array_buffers=True)
            self.assertEqual(channel.payload, b"")
        with patch("solver_process.MAX_MESSAGE_BYTES", 100):
            for value in (np.zeros(100, dtype=np.float64), np.array([1.])):
                channel = ByteChannel()
                with self.assertRaises(ValueError):
                    send_message(channel, dict(value=value), array_buffers=True)
                self.assertEqual(channel.payload, b"")
        with self.assertRaises(TypeError):
            send_message(ByteChannel(), {1: np.zeros(1)}, array_buffers=True)

    def test_malformed_array_metadata_and_payloads_are_rejected(self):
        item = dict(path=["value"], dtype="<f4", shape=[2], nbytes=8)
        envelope = dict(message=dict(value=None), arrays=[item])
        invalid = []
        for key, values in dict(dtype=["object", "|O", "float32", "garbage", "|V4"],
                                shape=[[-1], [True], [2.], [1]*33, [MAX_MESSAGE_BYTES+1], "2"],
                                nbytes=[True, -1, 4, 12], path=[[], ["missing"], [False]]).items():
            for value in values:
                changed = deepcopy(envelope); changed["arrays"][0][key] = value
                invalid.append(binary_frame(changed, b"\0"*8))
        duplicate = deepcopy(envelope); duplicate["arrays"].append(deepcopy(item))
        invalid.extend([binary_frame(duplicate, b"\0"*16), binary_frame(envelope, b"\0"*9),
                        binary_frame(envelope, np.array([1, np.inf], dtype="<f4").tobytes()),
                        binary_frame(dict(message=dict(value={"path": ["value"]}), arrays=[item]), b"\0"*8),
                        binary_frame(dict(message=[], arrays=[])),
                        struct.pack("!QQ", ARRAY_FRAME | 8, 1000)])
        for frame in invalid:
            with self.subTest(frame=frame[:150]), self.assertRaises(ValueError):
                receive_message(ByteChannel(frame))

    def test_truncation_size_limit_and_deadline_apply_to_binary_frames(self):
        with self.assertRaisesRegex(ValueError, "transport limit"):
            receive_message(ByteChannel(struct.pack("!Q", ARRAY_FRAME | (MAX_MESSAGE_BYTES+1))))
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            receive_message(ByteChannel(struct.pack("!Q", ARRAY_FRAME | 100) + b"short"))
        with self.assertRaises(TimeoutError):
            receive_message(ByteChannel(), deadline=time.monotonic()-1)

    def test_malformed_binary_reply_closes_borrowed_lease_descriptors(self):
        sender, receiver = socket.socketpair()
        try:
            with tempfile.NamedTemporaryFile() as lockfile:
                descriptor = os.open(lockfile.name, os.O_RDWR)
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX)
                    send_lease(sender, [descriptor])
                finally:
                    os.close(descriptor)
                sender.sendall(binary_frame(dict(message=dict(value=None), arrays=[
                    dict(path=["value"], dtype="|O", shape=[1], nbytes=8)]), b"\0"*8))
                with self.assertRaises(ValueError):
                    receive_leased_message(receiver)
                # A leaked SCM_RIGHTS duplicate would still own this flock.
                fcntl.flock(lockfile.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            sender.close()
            receiver.close()
