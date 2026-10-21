"""Lossless HTTP transport checks without a numerical worker or GPU."""
import gzip
import json
import threading
import unittest
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import make_server


class HistoryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.page = dict(generation=7, next_cursor=256, complete=False,
                         history_end_s=.255, records=[
            dict(type="state", generation=7, sim_time_s=i/1000,
                 q=[i/1000+j for j in range(7)],
                 qd=[j/10 for j in range(7)]) for i in range(256)])
        def history(generation, after, limit):
            from execution_bridge import HistoryGenerationError
            if generation != 7:
                raise HistoryGenerationError("History changed; current generation=7")
            self.assertEqual((after, limit), (0, 256))
            return self.page
        self.live = SimpleNamespace(generation=7, history=history)
        self.server = make_server(dict(trajectories=[]), b"<robot/>", {}, port=0, live=self.live)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/live/history?generation=7"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, encoding=None, method="GET"):
        headers = {} if encoding is None else {"Accept-Encoding": encoding}
        return urlopen(Request(self.url, headers=headers, method=method))

    def test_gzip_and_plain_preserve_every_record_cursor_and_timestamp(self):
        with self.request() as response:
            plain = response.read()
            self.assertIsNone(response.headers.get("Content-Encoding"))
            self.assertEqual(response.headers["Vary"], "Accept-Encoding")
            self.assertEqual(json.loads(plain), self.page)
        with self.request("br, gzip") as response:
            compressed = response.read()
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            self.assertEqual(int(response.headers["Content-Length"]), len(compressed))
            self.assertLess(len(compressed), len(plain))
            self.assertEqual(gzip.decompress(compressed), plain)
        with self.request("gzip", method="HEAD") as response:
            self.assertEqual(response.read(), b"")
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            self.assertEqual(int(response.headers["Content-Length"]), len(compressed))

    def test_encoding_exclusions_and_small_errors_remain_plain_json(self):
        for encoding in ("br", "gzip;q=0", "*;q=1, gzip;q=0", "*;q=1, gzip ;q=0"):
            with self.subTest(encoding=encoding), self.request(encoding) as response:
                self.assertIsNone(response.headers.get("Content-Encoding"))
                self.assertEqual(json.load(response), self.page)
        with self.request("*;q=.5") as response:
            self.assertEqual(json.loads(gzip.decompress(response.read())), self.page)
        self.url = self.url.replace("generation=7", "generation=6")
        with self.assertRaises(HTTPError) as error:
            self.request("gzip")
        response = error.exception
        self.assertEqual(response.code, 409)
        self.assertIsNone(response.headers.get("Content-Encoding"))
        self.assertEqual(response.headers["Vary"], "Accept-Encoding")
        self.assertEqual(json.load(response)["generation"], 7)

    def test_encoded_history_fast_path_preserves_plain_gzip_head_and_query_errors(self):
        from execution_bridge import HistoryGenerationError
        encoded = json.dumps(self.page, allow_nan=False, separators=(",", ":")).encode()
        calls = []
        def history_json(generation, after, limit):
            calls.append((generation, after, limit))
            if generation != 7:
                raise HistoryGenerationError("History changed; current generation=7")
            if after < 0 or not 1 <= limit <= 2048:
                raise ValueError("Invalid history page")
            return encoded
        self.live.history_json = history_json
        self.live.history = lambda *args: self.fail("Decoded Python history path was called")
        with self.request() as response:
            self.assertEqual(response.read(), encoded)
        with self.request("gzip") as response:
            compressed = response.read()
            self.assertEqual(gzip.decompress(compressed), encoded)
        with self.request("gzip", method="HEAD") as response:
            self.assertEqual(response.read(), b"")
            self.assertEqual(int(response.headers["Content-Length"]), len(compressed))
        self.assertEqual(calls, [(7, 0, 256)]*3)
        initial = self.url
        self.url = initial + "&limit=1024"
        with self.request() as response:
            self.assertEqual(response.read(), encoded)
        self.assertEqual(calls[-1], (7, 0, 1024))
        for suffix, status in (("&limit=2049", 400), ("&after=-1", 400),
                               ("&limit=1&limit=2", 400), ("&unknown=1", 400)):
            self.url = initial + suffix
            with self.subTest(suffix=suffix), self.assertRaises(HTTPError) as error:
                self.request()
            self.assertEqual(error.exception.code, status)
        self.url = initial.replace("generation=7", "generation=6")
        with self.assertRaises(HTTPError) as error:
            self.request()
        self.assertEqual(error.exception.code, 409)
        self.assertEqual(json.load(error.exception)["generation"], 7)


if __name__ == "__main__":
    unittest.main()
