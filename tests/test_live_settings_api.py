"""Shared settings transactions and HTTP inspection, using the CPU fake worker."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from execution_bridge import LiveSettingsConflict, ProcessLiveService
from server import make_server
from tests.test_execution import FakeAdapter, FakeRenderer, fake_schema, fake_worker
from tests.tiago_mpc_source import MPC_ROOT


class SharedSettingsTests(unittest.TestCase):
    def setUp(self):
        self.live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter,
            schema_factory=fake_schema, worker_target=fake_worker, render_factory=FakeRenderer)

    def tearDown(self):
        self.live.close()

    def submit(self, value, **options):
        return self.live.command(dict(type="patch_settings", patch=value, **options))

    def test_concurrent_disjoint_nested_patches_preserve_both_edits(self):
        barrier = threading.Barrier(2)
        def edit(field, value):
            barrier.wait()
            return self.submit(dict(config=dict(solver={field: value})))
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(edit, "max_sqp_iters", 7)
            second = pool.submit(edit, "max_pcg_iters", 313)
            self.assertEqual({first.result(), second.result()}, {1, 2})
        settings = self.live.settings_snapshot()
        self.assertEqual(settings["config"]["solver"]["max_sqp_iters"], 7)
        self.assertEqual(settings["config"]["solver"]["max_pcg_iters"], 313)
        self.assertEqual((settings["settings_version"], settings["generation"]), (2, 2))

    def test_rejected_patch_is_atomic_for_every_group(self):
        before = self.live.settings_snapshot()
        revision = self.live.revision.value
        for invalid in ({"config": {"solver": {"max_sqp_iters": -1}}},
                        {"config": {"unknown": 1}},
                        {"config": {"plant": {"stop_on_breach": {"unknown": True}}}},
                        {"execution": {"unknown": 1}}, {"task": {"kind": "custom"}},
                        {"task": {"target_offset_m": [0, 0]}},
                        {"config": None}, {"unknown": {}}, {}):
            with self.subTest(invalid=invalid), self.assertRaises((ValueError, TypeError)):
                self.submit(invalid)
            self.assertEqual(self.live.settings_snapshot(), before)
            self.assertEqual(self.live.revision.value, revision)
        self.assertNotIn("settings", self.live.latest)

    def test_arrays_replace_null_is_preserved_and_task_kind_uses_new_defaults(self):
        self.submit({"config": {"max_sqp_time_s": .1}})
        self.submit({"config": {"max_sqp_time_s": None},
                     "task": {"kind": "figure8", "period_s": 12,
                              "target_offset_m": [.12, -.1, .03]}})
        settings = self.live.settings_snapshot()
        self.assertIsNone(settings["config"]["max_sqp_time_s"])
        self.assertEqual(settings["task"]["target_offset_m"], [.12, -.1, .03])
        figure8 = next(task["defaults"] for task in self.live.schema["tasks"] if task["kind"] == "figure8")
        self.assertEqual(settings["task"]["width_m"], figure8["width_m"])
        self.assertEqual(settings["task"]["period_s"], 12)
        self.submit({"task": {"kind": "reach"}})
        reach = next(task["defaults"] for task in self.live.schema["tasks"] if task["kind"] == "reach")
        self.assertEqual(self.live.settings_snapshot()["task"], reach)

    def test_compare_and_set_rejects_stale_patch_and_legacy_replacement(self):
        initial = self.live.settings_snapshot()
        self.submit({"execution": {"duration_s": 11}}, expected_settings_version=0)
        accepted = self.live.settings_snapshot()
        commands = [dict(type="patch_settings", patch={"execution": {"duration_s": 12}}),
                    dict(type="set_settings", **{key: initial[key] for key in ("config", "task", "execution")})]
        for command in commands:
            with self.subTest(kind=command["type"]), self.assertRaises(LiveSettingsConflict) as conflict:
                self.live.command(dict(command, expected_settings_version=0))
            self.assertEqual(conflict.exception.settings, accepted)
            self.assertEqual(self.live.settings_snapshot(), accepted)
        for expected in (True, -1, 1.0, None):
            with self.subTest(expected=expected), self.assertRaisesRegex(ValueError, "nonnegative integer"):
                self.submit({"execution": {"duration_s": 12}}, expected_settings_version=expected)
        complete = {key: deepcopy(accepted[key]) for key in ("config", "task", "execution")}
        complete["execution"]["duration_s"] = 13
        self.assertEqual(self.live.command(dict(type="set_settings", **complete, expected_settings_version=1)), 2)
        self.assertEqual(self.live.settings_snapshot()["execution"]["duration_s"], 13)

    def test_settings_events_precede_notices_and_bootstrap_uses_current_snapshot(self):
        cursor = self.live.cursor
        self.submit({"config": {"solver": {"max_sqp_iters": 3}}})
        _, events = self.live.read_events(cursor, timeout=0)
        self.assertEqual(events[0], dict(type="settings", **self.live.settings_snapshot()))
        self.assertEqual(events[1]["type"], "history")
        _, initial = self.live.subscribe()
        self.assertEqual(initial[0], dict(type="settings", **self.live.settings_snapshot()))
        initial[0]["config"]["solver"]["max_sqp_iters"] = 99
        self.assertEqual(self.live.settings_snapshot()["config"]["solver"]["max_sqp_iters"], 3)

    def test_continue_at_end_patch_does_not_schedule_work_or_replace_history(self):
        before = self.live.settings_snapshot()
        revision, cursor = self.live.revision.value, self.live.cursor
        with patch.object(self.live.commands, "put_nowait", wraps=self.live.commands.put_nowait) as enqueue:
            version = self.submit({"execution": {"continue_at_end": True}}, expected_settings_version=0)
            enqueue.assert_not_called()
        settings = self.live.settings_snapshot()
        self.assertEqual(version, before["settings_version"])
        self.assertEqual(settings["generation"], before["generation"])
        self.assertEqual(self.live.revision.value, revision)
        self.assertTrue(settings["execution"]["continue_at_end"])
        _, events = self.live.read_events(cursor, timeout=0)
        self.assertEqual(events, [dict(type="settings", **settings)])
        self.assertNotIn("plan", self.live.latest)

    def test_http_get_has_no_command_or_subscription_and_conflict_is_409(self):
        server = make_server(dict(trajectories=[]), b"<robot/>", {}, port=0, live=self.live)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            before = self.live.settings_snapshot()
            with patch.object(self.live, "command", wraps=self.live.command) as command, \
                    patch.object(self.live, "subscribe", wraps=self.live.subscribe) as subscribe:
                with urlopen(base + "/api/live/settings") as response:
                    self.assertEqual(json.load(response), before)
                command.assert_not_called()
                subscribe.assert_not_called()
            self.assertEqual(self.live.settings_snapshot(), before)
            self.assertFalse(self.live._preview_requested)
            self.assertNotIn("plan", self.live.latest)
            payload = dict(type="patch_settings", patch={"execution": {"duration_s": 11}},
                           expected_settings_version=0)
            request = Request(base + "/api/live/command", json.dumps(payload).encode(),
                              {"Content-Type": "application/json"})
            with urlopen(request) as response:
                self.assertEqual(json.load(response), dict(accepted=True, settings_version=1))
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            self.assertEqual(error.exception.code, 409)
            self.assertEqual(json.load(error.exception), dict(accepted=False, error="Settings changed",
                             settings=self.live.settings_snapshot()))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
