"""CLI HTTP requests and errors, without a backend, browser or numerical worker."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError


spec = importlib.util.spec_from_file_location("visualizer_control", Path(__file__).parents[1] / "scripts/control.py")
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class ControlTests(unittest.TestCase):
    def invoke(self, argv, reply=None, stdin="", error=None):
        calls = []

        def opener(request, timeout):
            calls.append((request.full_url, request.get_method(),
                          None if request.data is None else json.loads(request.data), timeout))
            if error:
                raise error
            return io.BytesIO(json.dumps({"accepted": True} if reply is None else reply).encode())

        out, err = io.StringIO(), io.StringIO()
        code = control.main(argv, stdin=io.StringIO(stdin), stdout=out, stderr=err, opener=opener)
        return code, out.getvalue(), err.getvalue(), calls

    def test_get_snapshot_is_read_only_and_retains_server_version(self):
        snapshot = {"settings_version": 8, "config": {"cost_weights": {"position": 9}}}
        code, out, err, calls = self.invoke(["--url", "http://example:9000/", "get", "live"], snapshot)
        self.assertEqual((code, json.loads(out), err), (0, snapshot, ""))
        self.assertEqual(calls, [("http://example:9000/api/live/settings", "GET", None, 30)])

    def test_nested_patch_null_and_version_pass_through_without_fetch_or_full_replacement(self):
        patch = {"config": {"cost_weights": {"position": 20}, "max_sqp_time_s": None}}
        code, _, err, calls = self.invoke(["patch", "live", json.dumps(patch), "--expected-version", "7"])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2], {"type": "patch_settings", "patch": patch, "expected_settings_version": 7})

    def test_json_file_stdin_and_presentation_route(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text('{"buffer_ms":400}')
            code, _, _, calls = self.invoke(["patch", "presentation", "@" + str(path)])
            self.assertEqual(code, 0)
            self.assertEqual(calls[0][0:3], ("http://127.0.0.1:8090/api/presentation/settings/patch", "POST", {"buffer_ms": 400}))
        code, _, _, calls = self.invoke(["patch", "live", "-", "--reset"], stdin='{"task":{"kind":"reach"}}')
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][2], {"type": "patch_settings", "patch": {"task": {"kind": "reach"}}, "reset": True})

    def test_conflict_has_current_snapshot_and_is_never_retried(self):
        payload = {"accepted": False, "error": "Settings changed", "settings": {"settings_version": 9}}
        error = HTTPError("http://test", 409, "Conflict", {}, io.BytesIO(json.dumps(payload).encode()))
        code, out, err, calls = self.invoke(["patch", "live", '{"config":{"N":32}}'], error=error)
        self.assertEqual((code, out, len(calls)), (1, "", 1))
        self.assertEqual(json.loads(err), {**payload, "status": 409})

    def test_commands_and_profile_preserve_native_anchor(self):
        anchor = {"sim_time_s": 2, "q": [0] * 7, "qd": [1] * 7}
        for argv, expected in [
            (["command", "preview", "--anchor", json.dumps(anchor)], {"type": "preview", "anchor": anchor}),
            (["profile", "activate", "trial", "--anchor", json.dumps(anchor)], {"profile_id": "trial", "anchor": anchor}),
        ]:
            with self.subTest(argv=argv):
                code, _, _, calls = self.invoke(argv)
                self.assertEqual(code, 0)
                self.assertEqual(calls[0][2], expected)

    def test_checkout_templates_are_sent_to_server_unexpanded(self):
        code, _, _, calls = self.invoke(["source", "apply", "/server/worktree", "--python", "<checkout>/.venv/bin/python"])
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][2], {"mpc_root": "/server/worktree", "python": "<checkout>/.venv/bin/python"})
        code, _, _, calls = self.invoke(["profile", "save", "trial", "/server/trial", "--name", "Trial"])
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][2], {"profile": {"id": "trial", "name": "Trial", "mpc_root": "/server/trial"}})

    def test_invalid_json_and_options_never_issue_request(self):
        for argv in (["patch", "live", "[]"], ["patch", "live", '{"config":{"dt_s":NaN}}'],
                     ["patch", "presentation", "{}", "--reset"],
                     ["command", "pause", "--anchor", "{}"],
                     ["patch", "live", "{}", "--anchor", "{}", "--reset"],
                     ["--timeout", "nan", "get", "live"]):
            with self.subTest(argv=argv):
                code, out, err, calls = self.invoke(argv)
                self.assertEqual((code, out, calls), (1, "", []))
                self.assertIn("error", json.loads(err))

    def test_all_snapshot_retains_independent_service_failures(self):
        calls = []

        def opener(request, timeout):
            calls.append(request.full_url)
            if request.full_url.endswith("/api/live/settings"):
                raise HTTPError(request.full_url, 503, "Unavailable", {}, io.BytesIO(b'{"error":"Live unavailable"}'))
            return io.BytesIO(b'{"ok":true}')

        out = io.StringIO()
        self.assertEqual(control.main(["get"], stdout=out, opener=opener), 0)
        snapshot = json.loads(out.getvalue())
        self.assertEqual(snapshot["live"], {"error": "Live unavailable", "status": 503})
        self.assertEqual(snapshot["presentation"], {"ok": True})
        self.assertEqual(len(calls), 4)


if __name__ == "__main__":
    unittest.main()
