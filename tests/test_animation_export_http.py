"""Animation export routes against a real local HTTP server and CPU encoder."""
from http.client import HTTPConnection
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

from animation_export import AnimationExportService, MAX_FRAME_BYTES, resolve_ffmpeg
from server import make_server
from test_animation_export import png

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "/api/animation-export/"


class AnimationExportHttpTests(unittest.TestCase):
    def setUp(self):
        try:
            self.ffmpeg = resolve_ffmpeg()
        except RuntimeError:
            self.skipTest("ffmpeg is not installed")
        parent = ROOT / "_expr_data/tests"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.service = AnimationExportService(self.ffmpeg, directory=self.temporary.name)
        self.addCleanup(self.service.close)
        self.server = self.serve(self.service)

    def serve(self, service):
        server = make_server(dict(trajectories=[]), b"<robot/>", {}, port=0,
                             live_error="Replay-only fixture", animation_exports=service)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.addCleanup(stop)
        return server

    def request(self, path, *, method="POST", body=b"", headers=None, server=None):
        connection = HTTPConnection("127.0.0.1", (server or self.server).server_port, timeout=5)
        try:
            connection.request(method, PREFIX + path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def json_request(self, path, settings, **kwargs):
        return self.request(path, body=json.dumps(settings).encode(),
                            headers={"Content-Type": "application/json"}, **kwargs)

    def start(self, count=2):
        status, _, payload = self.json_request("start", dict(width=32, height=32, fps=30, frame_count=count))
        self.assertEqual(status, 200, payload)
        return json.loads(payload)["id"]

    def assert_json_error(self, response, status):
        actual, headers, payload = response
        self.assertEqual(actual, status, payload)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertIsInstance(json.loads(payload)["error"], str)

    def test_start_frames_finish_head_download_and_result_cleanup(self):
        identifier = self.start()
        directory = self.service.jobs[identifier].directory
        for index, color in enumerate(((255, 0, 0), (0, 0, 255))):
            status, _, payload = self.request(f"frame?id={identifier}&index={index}",
                body=png(32, 32, color), headers={"Content-Type": "image/png"})
            self.assertEqual(status, 200, payload)
            self.assertEqual(json.loads(payload), dict(accepted=index + 1))
        status, _, payload = self.request(f"finish?id={identifier}")
        self.assertEqual(status, 200, payload)
        download_url = json.loads(payload)["download_url"]
        self.assertEqual(download_url, PREFIX + f"download?id={identifier}")
        status, headers, payload = self.request(f"download?id={identifier}", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(payload, b"")
        self.assertEqual(headers["Content-Type"], "video/mp4")
        self.assertIn(identifier, self.service.jobs)
        status, headers, video = self.request(f"download?id={identifier}", method="GET")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "video/mp4")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Content-Disposition"], 'attachment; filename="tiago-animation.mp4"')
        self.assertEqual(int(headers["Content-Length"]), len(video))
        self.assertEqual(video[4:8], b"ftyp")
        self.assertLess(video.index(b"moov"), video.index(b"mdat"))
        decoded = subprocess.run([self.ffmpeg, "-v", "error", "-threads", "2", "-i", "pipe:0",
                                  "-f", "rawvideo", "-pix_fmt", "rgb24", "-threads", "2", "pipe:1"],
                                 input=video, capture_output=True, check=True, timeout=5).stdout
        self.assertEqual(len(decoded), 2 * 32 * 32 * 3)
        self.assertGreater(decoded[0], 240)
        self.assertGreater(decoded[32 * 32 * 3 + 2], 240)
        deadline = time.monotonic() + 2
        while directory.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(directory.exists())
        self.assertNotIn(identifier, self.service.jobs)
        self.assert_json_error(self.request(f"download?id={identifier}", method="GET"), 404)

    def test_cancellation_is_idempotent_and_removes_running_encoder(self):
        identifier = self.start()
        job = self.service.jobs[identifier]
        for _ in range(2):
            status, _, payload = self.request(f"cancel?id={identifier}")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(payload), dict(cancelled=True))
        self.assertIsNotNone(job.process.poll())
        self.assertFalse(job.directory.exists())
        self.assert_json_error(self.request(f"finish?id={identifier}"), 404)

    def test_cross_origin_request_cannot_start_or_cancel_an_export(self):
        response = self.request("start", body=json.dumps(dict(width=32, height=32, frame_count=1)).encode(),
            headers={"Origin": "http://another-viewer.invalid", "Content-Type": "application/json"})
        self.assert_json_error(response, 403)
        self.assertEqual(self.service.jobs, {})
        identifier = self.start()
        self.assert_json_error(self.request(f"cancel?id={identifier}",
            headers={"Origin": "http://another-viewer.invalid"}), 403)
        self.assertIn(identifier, self.service.jobs)
        status, _, _ = self.request(f"cancel?id={identifier}",
            headers={"Origin": f"http://127.0.0.1:{self.server.server_port}"})
        self.assertEqual(status, 200)

    def test_declared_body_bounds_are_checked_before_reading(self):
        for length in ("0", "-1", "4097", "invalid"):
            with self.subTest(start_length=length):
                self.assert_json_error(self.request("start", headers={
                    "Content-Type": "application/json", "Content-Length": length}), 400)
        identifier = self.start()
        for length in ("0", "-1", str(MAX_FRAME_BYTES + 1), "invalid"):
            with self.subTest(frame_length=length):
                self.assert_json_error(self.request(f"frame?id={identifier}&index=0", headers={
                    "Content-Type": "image/png", "Content-Length": length}), 400)
        self.assertEqual(self.service.jobs[identifier].next_index, 0)

    def test_content_types_selectors_sequence_and_incomplete_finish_are_json_errors(self):
        self.assert_json_error(self.request("start", body=b"{}", headers={"Content-Type": "text/plain"}), 400)
        self.assert_json_error(self.json_request("start", []), 400)
        self.assert_json_error(self.json_request("start", dict(width=32, height=32, extra=True)), 400)
        identifier = self.start()
        for selector in (f"id={identifier}", f"id={identifier}&id={identifier}&index=0",
                         f"id={identifier}&index=not-a-number"):
            with self.subTest(selector=selector):
                self.assert_json_error(self.request("frame?" + selector, body=png(32, 32),
                    headers={"Content-Type": "image/png"}), 400)
        self.assert_json_error(self.request(f"frame?id={identifier}&index=0", body=png(32, 32),
            headers={"Content-Type": "application/octet-stream"}), 400)
        self.assert_json_error(self.request(f"frame?id={identifier}&index=1", body=png(32, 32),
            headers={"Content-Type": "image/png"}), 400)
        self.assert_json_error(self.request(f"finish?id={identifier}"), 400)
        self.assert_json_error(self.request(f"finish?id={identifier}", body=b"{}"), 400)
        self.assert_json_error(self.request(f"download?id={identifier}", method="GET"), 400)
        self.assert_json_error(self.request(f"download?id={identifier}&id={identifier}", method="GET"), 400)

    def test_unknown_ids_return_json_404_and_disabled_service_returns_503(self):
        self.assert_json_error(self.request("frame?id=missing&index=0", body=png(32, 32),
            headers={"Content-Type": "image/png"}), 404)
        self.assert_json_error(self.request("finish?id=missing"), 404)
        self.assert_json_error(self.request("download?id=missing", method="GET"), 404)
        disabled = self.serve(None)
        for path, method in (("start", "POST"), ("download?id=missing", "GET")):
            self.assert_json_error(self.request(path, method=method, server=disabled), 503)


if __name__ == "__main__":
    unittest.main()
