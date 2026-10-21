"""CPU coverage of the process boundary and transactional profile switching."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import numpy as np

from execution_bridge import ProcessLiveService
from solver_process import SolverProcess, native_plan, validate_contract
from solver_profiles import SolverProfiles
from server import make_server
from tests.test_execution import FakeAdapter, FakeRenderer, fake_schema, fake_worker, MPC_ROOT


class ProfileAdapter(FakeAdapter):
    def __init__(self, root):
        super().__init__(root)
        self.plant_identity = str(id(self.model)) + str(id(self))
        self.profile = "simulator"
        self.profile_schema = fake_schema(root)

    def select_profile(self, profile):
        self.close_solver()
        if profile["id"] == "broken":
            raise ValueError("incompatible native joint order")
        self.profile = profile["id"]

    def close_solver(self):
        self.profile = None

    def configure(self, path, task):
        if self.profile is None:
            raise ValueError("No active solver profile")
        super().configure(path, task)

    def state_snapshot(self, *args):
        if self.profile == "state_failure":
            raise ValueError("state snapshot failed after configuration")
        return dict(super().state_snapshot(*args), simulator_identity=self.plant_identity,
                    solver_profile=self.profile)


def wait_until(predicate, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError("Timed out waiting for coordinator")


class SwitchTests(unittest.TestCase):
    def setUp(self):
        self.live = ProcessLiveService(MPC_ROOT, adapter_factory=ProfileAdapter,
            schema_factory=fake_schema, worker_target=fake_worker, render_factory=FakeRenderer)
        self.live.subscribe()
        wait_until(lambda: "plan" in self.live.latest)

    def tearDown(self):
        self.live.close()

    def test_switch_retains_native_anchor_plant_and_old_files(self):
        live = self.live
        old_path = live.history_store.path
        old_bytes = old_path.read_bytes()
        old_generation = live.generation
        plant = live.latest["state"]["simulator_identity"]
        pid = live._process.pid
        anchor = dict(sim_time_s=3.5, q=[.25]*7, qd=[-.4]*7)
        live.switch_solver_profile(dict(id="second"), anchor)
        wait_until(lambda: live.profile_switch["state"] == "idle" and live.generation > old_generation)
        wait_until(lambda: "state" in live.latest)
        self.assertEqual(live._process.pid, pid)
        self.assertEqual(live.latest["state"]["simulator_identity"], plant)
        self.assertEqual(live.latest["state"]["sim_time_s"], 3.5)
        self.assertEqual(live.latest["state"]["q"], [.25]*7)
        self.assertEqual(live.latest["state"]["qd"], [-.4]*7)
        self.assertEqual(live.active_profile_id, "second")
        self.assertEqual(old_path.read_bytes(), old_bytes)
        self.assertNotEqual(live.history_store.path, old_path)
        self.assertEqual(live.latest["status"]["state"], "paused")

    def test_failed_switch_keeps_history_and_rejects_old_profile_packets(self):
        live = self.live
        path, generation = live.history_store.path, live.generation
        old_token = live.revision.value
        old_bytes = path.read_bytes()
        live.switch_solver_profile(dict(id="broken"), dict(sim_time_s=5., q=[1.]*7, qd=[0.]*7))
        wait_until(lambda: live.profile_switch["state"] == "failed")
        self.assertIsNone(live.active_profile_id)
        self.assertEqual(live.generation, generation)
        self.assertEqual(live.history_store.path, path)
        self.assertEqual(path.read_bytes(), old_bytes)
        live.results.put(dict(kind="records", generation=generation, token=old_token,
            records=[dict(type="control", sim_time_s=999)], complete=True))
        live.results.put(dict(kind="events", generation=generation, token=old_token,
            events=[dict(type="status", state="playing")]))
        time.sleep(.1)
        self.assertEqual(path.read_bytes(), old_bytes)
        self.assertEqual(live.latest["status"]["state"], "paused")
        live.switch_solver_profile(dict(id="recovered"))
        wait_until(lambda: live.active_profile_id == "recovered")
        wait_until(lambda: "state" in live.latest)
        self.assertEqual(live.latest["state"]["sim_time_s"], 0.)
        self.assertEqual(live.latest["state"]["q"], [0.]*7)

    def test_failure_after_configuration_does_not_commit_a_history_segment(self):
        live = self.live
        path, generation = live.history_store.path, live.generation
        old_bytes = path.read_bytes()
        live.switch_solver_profile(dict(id="state_failure"))
        wait_until(lambda: live.profile_switch["state"] == "failed")
        self.assertEqual(live.generation, generation)
        self.assertEqual(live.history_store.path, path)
        self.assertEqual(path.read_bytes(), old_bytes)

    def test_http_profile_save_activate_keeps_simulator_source_and_other_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory)/"viewer.json"
            config.write_text(json.dumps(dict(ingest_directory="original", source=dict(mpc_root=str(MPC_ROOT)))))
            selection = dict(mpc_root=str(MPC_ROOT), python=sys.executable, cache=str(MPC_ROOT/".cache/gato"))
            profiles = SolverProfiles(self.live, selection, config)
            server = make_server(dict(trajectories=[]), b"", {}, port=0, live=self.live,
                                 solver_profiles=profiles)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            def post(route, payload, **headers):
                request = Request(base+route, json.dumps(payload).encode(),
                    headers={"Content-Type":"application/json", **headers})
                with urlopen(request) as response:
                    return response.status, json.load(response)
            try:
                with urlopen(base+"/api/solver-profiles") as response:
                    self.assertEqual(json.load(response)["active_profile_id"], "simulator")
                profile = dict(id="other", name="Other implementation", **selection)
                status, result = post("/api/solver-profiles", dict(profile=profile))
                self.assertEqual(status, 200)
                self.assertEqual(result["simulator_source"], selection)
                saved = json.loads(config.read_text())
                self.assertEqual(saved["ingest_directory"], "original")
                self.assertEqual(saved["source"]["mpc_root"], str(MPC_ROOT))
                self.assertEqual(saved["solver_profiles"], [profile])
                status, result = post("/api/solver-profiles/activate", dict(profile_id="other"))
                self.assertEqual(status, 202)
                self.assertEqual(result, dict(state="switching", profile_id="other"))
                wait_until(lambda: self.live.active_profile_id == "other")
                with self.assertRaises(HTTPError) as rejected:
                    post("/api/solver-profiles/activate", dict(profile_id="other"), Origin="http://other.invalid")
                self.assertEqual(rejected.exception.code, 403)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


class TransportTests(unittest.TestCase):
    def test_selected_interpreter_socket_protocol_and_native_stdout_are_independent(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory)/"echo_worker.py"
            script.write_text(f'''import sys, socket, os
sys.path.insert(0, {str(root)!r})
from solver_process import send_message, receive_message
fd = int(sys.argv[sys.argv.index('--fd')+1])
with socket.socket(fileno=fd) as channel:
    while True:
        request = receive_message(channel)
        os.write(1, b'native diagnostic output\\n')
        result = dict(pid=os.getpid(), python=sys.executable, cache=os.environ['GATO_CACHE_DIR'])
        identity = {{k:request[k] for k in ('protocol','epoch','request_id')}}
        if request['operation'] == 'stale': identity['epoch'] = 'old'
        send_message(channel, dict(identity, ok=True, result=result))
        if request['operation'] == 'close': break
''')
            profile = dict(id="cpu", mpc_root=directory, python=sys.executable, cache=directory)
            child = SolverProcess(profile, script=script)
            try:
                result = child.request("echo")
                self.assertNotEqual(result["pid"], os.getpid())
                self.assertEqual(result["python"], sys.executable)
                self.assertEqual(result["cache"], directory)
                with self.assertRaisesRegex(RuntimeError, "stale"):
                    child.request("stale")
            finally:
                child.close()
            self.assertEqual(child.process.returncode, 0)
            self.assertIn("native diagnostic output", child.log_path.read_text())

    def test_prediction_conversion_covers_positions_velocities_and_torque(self):
        signs = np.array([1,1,1,1,1,-1,1])
        raw = np.arange(56, dtype=np.float32)
        result = native_plan(dict(_xu=raw, _signs=signs, N=3))
        expected = raw*np.tile(signs, 8)
        np.testing.assert_array_equal(result["_xu"], expected)
        self.assertEqual(result["_signs"], [1.]*7)

    def test_coordinate_compatibility_is_separate_from_physical_model_identity(self):
        contract = dict(joint_names=[str(i) for i in range(7)], nq=7, nv=7,
            coordinate_units="rad,rad/s,Nm", torque_semantics="actuator_joint_torque",
            reference_frame="torso", end_effector_frame="tcp",
            world_from_reference=np.eye(4).tolist(), tcp_offset=np.eye(4).tolist())
        validate_contract(contract, dict(contract, model_sha="different physical predictor"))
        bad = deepcopy(contract)
        bad["joint_names"].reverse()
        with self.assertRaisesRegex(ValueError, "joint_names"):
            validate_contract(contract, bad)
        bad = deepcopy(contract)
        bad["tcp_offset"][0][3] = .1
        with self.assertRaisesRegex(ValueError, "tcp_offset"):
            validate_contract(contract, bad)
