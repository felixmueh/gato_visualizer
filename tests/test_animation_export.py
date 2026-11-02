"""CPU-only MP4 lifecycle, input bounds and actual H.264 encoding."""
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib

from animation_export import AnimationExportService, MAX_FRAME_COUNT, resolve_ffmpeg

ROOT = Path(__file__).resolve().parents[1]


def png(width=64, height=48, color=(255, 0, 0), random_pixels=False):
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data)))
    rows = b"".join(b"\0" + (os.urandom(width * 3) if random_pixels else bytes(color) * width)
                    for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


class AnimationExportTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / "_expr_data/tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        # A subprocess fixture exercises actual pipe draining/backpressure and
        # termination without depending on ffmpeg for lifecycle checks.
        self.encoder = self.folder / "encoder"
        self.encoder.write_text(f"#!{sys.executable}\n" + '''
import pathlib, sys, time
mode = pathlib.Path(__file__).with_suffix('.mode').read_text()
if mode == 'stall':
    time.sleep(60)
sys.stderr.write('diagnostic' * 5000)
sys.stderr.flush()
sys.stdin.buffer.read()
if mode == 'timeout':
    time.sleep(60)
if mode == 'fail':
    sys.exit(6)
pathlib.Path(sys.argv[-1]).write_bytes(b'ftyp-test-mp4')
count = int(sys.argv[sys.argv.index('-frames:v') + 1])
if mode == 'short':
    count -= 1
print('frame=' + str(count), flush=True)
''')
        self.encoder.chmod(0o700)
        self.encoder.with_suffix(".mode").write_text("normal")

    def service(self, **kwargs):
        service = AnimationExportService(kwargs.pop("ffmpeg", self.encoder),
                                         directory=self.folder / "runtime", **kwargs)
        self.addCleanup(service.close)
        return service

    def test_order_dimensions_and_exact_frame_count_are_required(self):
        service = self.service()
        identifier = service.start(64, 48, frame_count=2)
        with self.assertRaisesRegex(ValueError, "Expected frame 0"):
            service.append_frame(identifier, 1, png())
        with self.assertRaisesRegex(ValueError, "dimensions"):
            service.append_frame(identifier, 0, png(48, 64))
        for invalid in (b"not-png", png()[:-1], png() + png()):
            with self.assertRaises(ValueError):
                service.append_frame(identifier, 0, invalid)
        self.assertEqual(service.append_frame(identifier, 0, png()), 1)
        with self.assertRaisesRegex(ValueError, "received 1"):
            service.finish(identifier)
        with self.assertRaisesRegex(ValueError, "Expected frame 1"):
            service.append_frame(identifier, 0, png())
        service.append_frame(identifier, 1, png())
        path = service.finish(identifier)
        self.assertEqual(service.finish(identifier), path)
        self.assertEqual(service.download_path(identifier), path)
        self.assertTrue(path.is_relative_to(service.directory))
        self.assertTrue(path.is_file())
        self.assertLessEqual(len(service.jobs[identifier].stderr), 16384)
        service.cancel(identifier)
        service.cancel(identifier)
        self.assertFalse(path.parent.exists())
        with self.assertRaises(KeyError):
            service.download_path(identifier)

    def test_limits_and_finished_results_use_slots_until_download_cleanup(self):
        service = self.service(max_jobs=1)
        for width, height, fps, count in ((63, 48, 30, 1), (64, 48, 60, 1),
                                          (64, 48, 30, MAX_FRAME_COUNT + 1),
                                          (64, 48, 30, True), (3840, 3840, 30, 1)):
            with self.assertRaises(ValueError):
                service.start(width, height, fps, count)
        identifier = service.start(64, 48, frame_count=1)
        with self.assertRaises(ValueError):
            service.download_path(identifier)
        service.append_frame(identifier, 0, png())
        service.finish(identifier)
        with self.assertRaisesRegex(RuntimeError, "still active"):
            service.start(64, 48, frame_count=1)
        service.cancel(identifier)
        service.start(64, 48, frame_count=1)
        service.close()
        service.close()
        self.assertFalse(service.directory.exists())
        with self.assertRaisesRegex(RuntimeError, "closed"):
            service.start(64, 48, frame_count=1)

    def test_encoder_failure_or_short_video_discards_all_scratch(self):
        for mode in ("fail", "short", "timeout"):
            with self.subTest(mode=mode):
                self.encoder.with_suffix(".mode").write_text(mode)
                service = self.service(finish_timeout_s=0.05 if mode == "timeout" else 5)
                identifier = service.start(64, 48, frame_count=1)
                service.append_frame(identifier, 0, png())
                with self.assertRaises(RuntimeError):
                    service.finish(identifier)
                self.assertEqual(service.jobs, {})
                self.assertFalse((service.directory / identifier).exists())
                service.close()

    def test_cancel_interrupts_a_blocked_encoder_write(self):
        self.encoder.with_suffix(".mode").write_text("stall")
        service = self.service()
        identifier = service.start(256, 256, frame_count=1)
        process = service.jobs[identifier].process
        errors = []

        def write():
            try:
                service.append_frame(identifier, 0, png(256, 256, random_pixels=True))
            except RuntimeError as exc:
                errors.append(exc)

        worker = threading.Thread(target=write)
        worker.start()
        time.sleep(0.05)
        service.cancel(identifier)
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsNotNone(process.poll())
        self.assertEqual(service.jobs, {})

    def test_abandoned_upload_expires_and_ended_owner_is_removed(self):
        orphan = self.folder / "runtime" / "p999999999"
        orphan.mkdir(parents=True)
        (orphan / "scratch.mp4").write_bytes(b"old")
        service = self.service(ttl_s=0.05)
        self.assertFalse(orphan.exists())
        identifier = service.start(64, 48, frame_count=1)
        process = service.jobs[identifier].process
        deadline = time.monotonic() + 3
        while process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNotNone(process.poll())
        # close waits for any in-flight cleanup before removing the pid folder.
        service.close()
        self.assertEqual(service.jobs, {})
        self.assertFalse(service.directory.exists())

    def test_encoder_resolution_and_missing_encoder_have_clear_errors(self):
        self.assertEqual(resolve_ffmpeg(self.encoder), str(self.encoder))
        with self.assertRaisesRegex(RuntimeError, "needs ffmpeg"):
            resolve_ffmpeg(self.folder / "missing")
        service = self.service(ffmpeg=self.folder / "missing")
        with self.assertRaisesRegex(RuntimeError, "needs ffmpeg"):
            service.start(64, 48, frame_count=1)
        self.assertEqual(service.jobs, {})

    def test_real_h264_is_30fps_faststart_and_preserves_frame_order(self):
        try:
            executable = resolve_ffmpeg()
        except RuntimeError:
            self.skipTest("ffmpeg is not installed")
        service = self.service(ffmpeg=executable)
        identifier = service.start(64, 48, frame_count=3)
        for index, color in enumerate(((255, 0, 0), (0, 255, 0), (0, 0, 255))):
            service.append_frame(identifier, index, png(color=color))
        path = service.finish(identifier)
        encoded = path.read_bytes()
        self.assertLess(encoded.index(b"moov"), encoded.index(b"mdat"))
        decoded = subprocess.run([executable, "-hide_banner", "-i", str(path),
                                  "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                                 capture_output=True, check=True, timeout=10)
        metadata = decoded.stderr.decode()
        self.assertIn("h264", metadata)
        self.assertIn("yuv420p", metadata)
        self.assertIn("30 fps", metadata)
        self.assertEqual(len(decoded.stdout), 3 * 64 * 48 * 3)
        for index in range(3):
            sample = decoded.stdout[index * 64 * 48 * 3:index * 64 * 48 * 3 + 3]
            self.assertGreater(sample[index], 240)
            self.assertTrue(all(value < 15 for channel, value in enumerate(sample) if channel != index))
        service.cancel(identifier)
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
