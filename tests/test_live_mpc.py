"""CPU-only validation and transport checks; no solver objects are constructed."""
from copy import deepcopy
import fcntl
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from live_mpc import GPULocks, LiveService, parameter_specs, validate_settings
from server import make_server

ROOT = Path(__file__).resolve().parents[1]
MPC_ROOT = ROOT.parent / "tiago_mpc"


class SettingsTests(unittest.TestCase):
    def setUp(self):
        config = json.loads((MPC_ROOT / "configs/reaching.json").read_text())
        self.config = {k: v for k, v in config.items() if k not in ("description", "save_plan_steps")}
        self.task = dict(kind="reach", target_offset_m=[0, 0, 0])
        self.schema = dict(parameters=parameter_specs(self.config, [16, 32]))

    def test_complete_config_and_runtime_choices(self):
        config, task = validate_settings(self.config, self.task, self.schema)
        self.assertEqual(config, self.config)
        self.assertIsNot(config, self.config)
        specs = {s["path"]: s for s in self.schema["parameters"]}
        self.assertEqual(specs["controller.warm_start"]["choices"], ["shift", "hold"])
        self.assertEqual(specs["controller.admm_linsys"]["choices"], ["pcg", "bdsv_factor", "auto"])
        self.assertTrue(specs["solver_params.exact_hessian"]["disabled"])
        self.assertTrue(specs["solver_params.linsys"]["disabled"])

    def test_nonfinite_limits_unknown_fields_and_unbuilt_n_rejected(self):
        cases = [("N", 128), ("N", True), ("N", 32.5), ("dt_s", float("nan")),
                 ("dt_s", -1), ("solver_params.max_sqp_iters", 10000),
                 ("solver_params.exact_hessian", True), ("solver_params.linsys", "qdldl"),
                 ("controller.warm_start", "repeat"), ("controller.limits_kw.rho", float("inf")),
                 ("limit_bounds.velocity_fraction", 0)]
        for path, value in cases:
            config = deepcopy(self.config)
            parts = path.split(".")
            target = config
            for part in parts[:-1]:
                target = target[part]
            target[parts[-1]] = value
            with self.subTest(path=path, value=value), self.assertRaises(ValueError):
                validate_settings(config, self.task, self.schema)
        with self.assertRaises(ValueError):
            validate_settings({**self.config, "save_plan_steps": 1}, self.task, self.schema)
        with self.assertRaises(ValueError):
            validate_settings(self.config, {**self.task, "target_offset_m": [True, 0, 0]}, self.schema)


class LockTests(unittest.TestCase):
    def test_failed_partial_acquisition_releases_previous_locks(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder) / "first", Path(folder) / "second"]
            with paths[1].open("a") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locks = GPULocks(MPC_ROOT)
                locks.paths = paths
                self.assertFalse(locks.acquire())
                self.assertEqual(locks.handles, [])
                with paths[0].open("a") as freed:
                    fcntl.flock(freed, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(locks.acquire())
            self.assertTrue(locks.acquire())
            locks.release()


class CommandTests(SettingsTests):
    def setUp(self):
        super().setUp()
        from collections import deque
        self.service = LiveService.__new__(LiveService)
        self.service.condition = threading.Condition()
        self.service.commands = deque()
        self.service.closed = False
        self.service.schema = self.schema
        self.service.next_version = 0

    def setting(self):
        return dict(type="set_settings", config=self.config, task=self.task)

    def test_settings_coalesce_only_consecutive_commands_and_keep_versions(self):
        self.assertEqual(self.service.command(self.setting()), 1)
        self.assertEqual(self.service.command(self.setting()), 2)
        self.service.command(dict(type="reset"))
        self.assertEqual(self.service.command(self.setting()), 3)
        self.assertEqual([c["type"] for c in self.service.commands], ["set_settings", "reset", "set_settings"])
        self.assertEqual(self.service.commands[0]["settings_version"], 2)
        self.assertEqual(self.service.commands[-1]["settings_version"], 3)
        with self.assertRaises(ValueError):
            self.service.command(dict(type="play", bad=True))


class WorkerTests(unittest.TestCase):
    def test_gpu_calls_are_locked_and_last_viewer_disconnect_pauses(self):
        from collections import deque
        from types import SimpleNamespace
        service = LiveService.__new__(LiveService)
        service.mpc_root = MPC_ROOT
        service.reach = object()
        defaults = json.loads((MPC_ROOT / "configs/reaching.json").read_text())
        service.config = {k: v for k, v in defaults.items() if k not in ("description", "save_plan_steps")}
        service.task = dict(kind="reach", target_offset_m=[0, 0, 0])
        service.schema = dict(parameters=parameter_specs(service.config, [32]))
        service.condition = threading.Condition()
        service.commands, service.events = deque(), deque(maxlen=256)
        service.latest = {}
        service.cursor = service.version = service.next_version = service.subscribers = 0
        service.closed = False
        owner = SimpleNamespace(held=False, busy=True, reset_calls=0, solve_calls=0)
        test = self
        class Locks:
            handles = []
            def __init__(self, root):
                pass
            def acquire(self):
                if owner.busy:
                    return False
                owner.held = True
                self.handles = [True]
                return True
            def release(self):
                owner.held = False
                self.handles = []
        class Controller:
            def reset(self, x):
                test.assertTrue(owner.held, "CUDA reset escaped the GPU lock")
                owner.reset_calls += 1
        class Adapter:
            def __init__(self, root, reach):
                test.assertTrue(owner.held)
                self.controller = Controller()
                self.solver = object()
                self.dt = .01
                self.x = __import__("numpy").zeros(14)
                self.state_signs = __import__("numpy").ones(14)
                self.t = 0
            def configure(self, path, task):
                test.assertTrue(owner.held)
                self.controller.reset(self.x)
            def solve(self, origin, version):
                test.assertTrue(owner.held, "CUDA solve escaped the GPU lock")
                owner.solve_calls += 1
                return dict(type="plan", origin=origin, settings_version=version)
            def advance(self):
                test.assertTrue(owner.held)
                self.t += self.dt
            def state_event(self, rtf=0):
                return dict(type="state", sim_time_s=self.t)
            def reset_state(self, reset_controller=True):
                test.assertFalse(reset_controller, "Command handling reset CUDA outside locks")
                self.t = 0
        service.adapter_factory = Adapter
        with patch("live_mpc.GPULocks", Locks):
            service.thread = threading.Thread(target=service._run, daemon=True)
            service.thread.start()
            service.subscribe()
            try:
                with service.condition:
                    self.assertTrue(service.condition.wait_for(
                        lambda: service.latest.get("status", {}).get("state") == "gpu_busy", timeout=2))
                self.assertEqual(owner.solve_calls, 0)
                owner.busy = False
                with service.condition:
                    service.condition.notify_all()
                    self.assertTrue(service.condition.wait_for(
                        lambda: service.latest.get("plan", {}).get("origin") == "preview", timeout=2))
                resets_after_preview = owner.reset_calls
                service.command(dict(type="play"))
                with service.condition:
                    self.assertTrue(service.condition.wait_for(
                        lambda: service.latest.get("plan", {}).get("origin") == "play", timeout=2))
                self.assertGreater(owner.reset_calls, resets_after_preview)
                service.unsubscribe()
                with service.condition:
                    self.assertTrue(service.condition.wait_for(
                        lambda: service.latest.get("status", {}).get("state") == "paused", timeout=2))
                self.assertFalse(owner.held)
                service.command(dict(type="reset"))
            finally:
                service.close()
            self.assertFalse(service.thread.is_alive())
            self.assertFalse(owner.held)


class FakeLive:
    closed = False
    schema = {"available_N": [32]}
    def __init__(self):
        self.commands = []
        self.subscribers = 0
    def command(self, body):
        self.commands.append(body)
        return 3
    def subscribe(self):
        self.subscribers += 1
        return 0, [dict(type="status", state="paused")]
    def read_events(self, cursor, timeout):
        self.closed = True
        return cursor, []
    def unsubscribe(self):
        self.subscribers -= 1


class HTTPTests(unittest.TestCase):
    def test_live_routes_commands_sse_and_cross_origin_guard(self):
        live = FakeLive()
        server = make_server(dict(trajectories=[]), b"<robot/>", {}, port=0, live=live)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base + "/api/live/schema") as response:
                self.assertEqual(json.load(response), live.schema)
            request = Request(base + "/api/live/command", data=b'{"type":"play"}',
                              headers={"Content-Type": "application/json"})
            with urlopen(request) as response:
                self.assertEqual(json.load(response), dict(accepted=True, settings_version=3))
            self.assertEqual(live.commands, [dict(type="play")])
            request.add_header("Origin", "https://unrelated.example")
            with self.assertRaises(HTTPError) as caught:
                urlopen(request)
            self.assertEqual(caught.exception.code, 403)
            with urlopen(base + "/api/live/events") as response:
                self.assertEqual(response.headers["Content-Type"], "text/event-stream")
                self.assertIn(b'"state":"paused"', response.read())
            self.assertEqual(live.subscribers, 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
