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
import subprocess
import fcntl
from types import SimpleNamespace
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import numpy as np

from execution_bridge import ProcessLiveService
from execution_session import DEFAULT_EXECUTION, MultirateSession
from solver_process import SolverProcess, validate_contract, send_lease, receive_leased_message
from solver_adapter import SimulatorAdapter, RemoteController
from solver_profiles import SolverProfiles
from server import make_server
from tests.test_execution import FakeAdapter, FakeRenderer, fake_schema, fake_worker, MPC_ROOT
from tests.tiago_mpc_source import live_probe


class ProfileAdapter(FakeAdapter):
    def __init__(self, root):
        super().__init__(root)
        self.plant_identity = str(id(self))
        self.profile = "simulator"
        self.profile_schema = fake_schema(root)

    def preflight_profile(self, profile, config, task):
        n = config["N"]
        if profile["id"] == "unsupported_n":
            raise ValueError(f"No compatible prebuilt N={n}")
        return self.profile_schema

    def select_profile(self, profile, schema):
        self.close_solver()
        if profile["id"] == "broken":
            raise ValueError("incompatible native joint order")
        self.profile = profile["id"]
        self.profile_schema["available_N_by_friction"] = dict(off=[16], on=[32])
        self.profile_schema["friction"] = dict(source={"predictor": self.profile})

    def close_solver(self):
        self.profile = None

    def configure(self, config, task):
        if self.profile is None:
            raise ValueError("No active solver profile")
        super().configure(config, task)

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


def unresponsive_coordinator(root, commands, results, *args):
    results.put(dict(kind="ready", schema=fake_schema(root)))
    time.sleep(600)


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
        self.assertEqual(live.schema["available_N_by_friction"], dict(off=[16], on=[32]))
        self.assertEqual(live.schema["friction"]["source"]["predictor"], "second")
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

    def test_preflight_rejection_preserves_working_solver_and_paused_history(self):
        live = self.live
        path, generation = live.history_store.path, live.generation
        old_bytes = path.read_bytes()
        live.switch_solver_profile(dict(id="unsupported_n"))
        wait_until(lambda: live.profile_switch["state"] == "failed")
        self.assertEqual(live.active_profile_id, "simulator")
        self.assertEqual(live.generation, generation)
        self.assertEqual(live.history_store.path, path)
        self.assertEqual(path.read_bytes(), old_bytes)
        event = next(event for _, event in reversed(live.events) if event["type"] == "solver_profile")
        self.assertEqual(event["active_profile_id"], "simulator")
        live.command(dict(type="play"))
        wait_until(lambda: live.latest["state"]["sim_time_s"] > 0)
        live.command(dict(type="pause"))

    def test_new_segment_does_not_attribute_old_torque_to_new_profile(self):
        live = self.live
        live.command(dict(type="play"))
        wait_until(lambda: live.latest["state"].get("torque_nm") is not None)
        live.switch_solver_profile(dict(id="second"))
        wait_until(lambda: live.active_profile_id == "second" and "state" in live.latest)
        self.assertIsNone(live.latest["state"]["torque_nm"])
        self.assertNotIn("plan_seq", live.latest["state"])

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
    def test_explicit_backend_shutdown_bounds_unresponsive_coordinator(self):
        live = ProcessLiveService(MPC_ROOT, adapter_factory=ProfileAdapter,
            schema_factory=fake_schema, worker_target=unresponsive_coordinator, render_factory=FakeRenderer)
        started = time.monotonic()
        with patch("execution_bridge.SHUTDOWN_GRACE_SECONDS", .05):
            live.close()
        self.assertFalse(live._process.is_alive())
        self.assertLess(time.monotonic() - started, 3)

    def test_rejected_transport_closes_received_lock_descriptors(self):
        import socket
        import struct
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"lease.lock"
            handle = path.open("a")
            fcntl.flock(handle, fcntl.LOCK_EX)
            sender, receiver = socket.socketpair()
            try:
                send_lease(sender, [handle.fileno()])
                sender.sendall(struct.pack("!Q", 1) + b"{")
                handle.close()
                with self.assertRaises(ValueError):
                    receive_leased_message(receiver)
                with path.open("a") as contender:
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                sender.close()
                receiver.close()
                handle.close()

    def test_preflight_rejects_changed_parameter_shape_before_replacing_solver(self):
        adapter = SimulatorAdapter.__new__(SimulatorAdapter)
        adapter.contract = dict(joint_names=[str(i) for i in range(7)], nq=7, nv=7,
            coordinate_units="rad,rad/s,Nm", torque_semantics="actuator_joint_torque",
            reference_frame="torso", end_effector_frame="tcp",
            world_from_reference=np.eye(4).tolist(), tcp_offset=np.eye(4).tolist())
        profile = dict(mpc_root=str(MPC_ROOT), python=sys.executable, cache="unused")
        checked = dict(live_probe(), contract=adapter.contract, available_N=[32], available_N_by_friction=dict(off=[32], on=[]))
        with patch("source_runtime.probe_selection", return_value=checked):
            schema = adapter.preflight_profile(profile, dict(checked["defaults"], plant=dict(friction=False)),
                                               dict(kind="reach", target_offset_m=[0, 0, 0]))
            self.assertEqual(schema["available_N"], [32])
            checked["defaults"]["additional_setting"] = True
            with self.assertRaisesRegex(ValueError, "Complete config required"):
                adapter.preflight_profile(profile, schema["defaults"]["config"], schema["defaults"]["task"])
            del checked["defaults"]["additional_setting"]
            checked["contract"] = dict(adapter.contract, end_effector_frame="other")
            with self.assertRaisesRegex(ValueError, "end_effector_frame"):
                adapter.preflight_profile(profile, schema["defaults"]["config"], schema["defaults"]["task"])

    @staticmethod
    def blocking_child(directory):
        root = Path(__file__).resolve().parents[1]
        script = Path(directory)/"blocking_child.py"
        script.write_text(f'''import sys, os, socket, time, json
sys.path.insert(0, {str(root)!r})
from solver_lifecycle import arm_parent_death_signal
arm_parent_death_signal(int(sys.argv[sys.argv.index('--parent-pid')+1]))
from solver_process import receive_leased_message
fd = int(sys.argv[sys.argv.index('--fd')+1])
with socket.socket(fileno=fd) as channel:
    request, leases = receive_leased_message(channel)
    with open({str(Path(directory)/'child.json')!r}, 'w') as stream:
        json.dump(dict(pid=os.getpid(), leases=len(leases)), stream)
    time.sleep(600)
''')
        return script

    def test_bootstrap_timeout_stops_child_and_retains_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            script = self.blocking_child(directory)
            child = SolverProcess(dict(id="test", mpc_root=directory, python=sys.executable,
                cache=directory), script=script)
            try:
                with self.assertRaisesRegex(RuntimeError, "bootstrap timed out"):
                    child.request("bootstrap", timeout=1)
                self.assertIsNotNone(child.process.poll())
                self.assertIn("bootstrap exceeded", child.log_path.read_text())
            finally:
                child.close()

    def test_remote_reset_timeout_stops_stalled_child(self):
        with tempfile.TemporaryDirectory() as directory:
            child = SolverProcess(dict(id="test", mpc_root=directory, python=sys.executable,
                cache=directory), script=self.blocking_child(directory))
            controller = RemoteController(SimpleNamespace(remote=child))
            try:
                with patch("solver_adapter.RESET_TIMEOUT_SECONDS", 1):
                    with self.assertRaisesRegex(RuntimeError, "reset timed out"):
                        controller.reset(np.zeros(14))
                self.assertIsNotNone(child.process.poll())
                self.assertIn("reset exceeded", child.log_path.read_text())
            finally:
                child.close()

    def test_borrowed_lock_survives_parent_handle_close_until_child_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            script = self.blocking_child(directory)
            path = Path(directory)/"lease.lock"
            handle = path.open("a")
            fcntl.flock(handle, fcntl.LOCK_EX)
            child = SolverProcess(dict(id="test", mpc_root=directory, python=sys.executable,
                cache=directory), script=script, lease_fds=lambda: [handle.fileno()])
            errors = []
            def run():
                try:
                    child.request("block")
                except Exception as exc:
                    errors.append(exc)
            thread = threading.Thread(target=run)
            thread.start()
            try:
                wait_until(lambda: (Path(directory)/"child.json").exists())
                info = json.loads((Path(directory)/"child.json").read_text())
                self.assertEqual(info["leases"], 1)
                handle.close()
                with path.open("a") as contender:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    child._stop("CPU lease lifetime test")
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                child._stop("test cleanup")
                thread.join(timeout=3)
                child.close()
                handle.close()
            self.assertFalse(thread.is_alive())
            self.assertTrue(errors)

    def test_abrupt_coordinator_death_stops_inflight_child_and_releases_lease(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            script = self.blocking_child(directory)
            parent = Path(directory)/"coordinator.py"
            lock_path = Path(directory)/"lease.lock"
            parent.write_text(f'''import sys, fcntl
sys.path.insert(0, {str(root)!r})
from solver_process import SolverProcess
handle = open({str(lock_path)!r}, 'a')
fcntl.flock(handle, fcntl.LOCK_EX)
child = SolverProcess(dict(id='test', mpc_root={directory!r}, python=sys.executable,
    cache={directory!r}), script={str(script)!r}, lease_fds=lambda: [handle.fileno()])
child.request('block')
''')
            process = subprocess.Popen([sys.executable, str(parent)])
            try:
                info_path = Path(directory)/"child.json"
                wait_until(info_path.exists)
                child_pid = json.loads(info_path.read_text())["pid"]
                process.kill()
                process.wait(timeout=3)
                def child_stopped():
                    try:
                        return Path(f"/proc/{child_pid}/stat").read_text().split()[2] == "Z"
                    except FileNotFoundError:
                        return True
                wait_until(child_stopped)
                with lock_path.open("a") as contender:
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=3)

    def test_selected_interpreter_socket_protocol_and_native_stdout_are_independent(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory)/"echo_worker.py"
            script.write_text(f'''import sys, socket, os
sys.path.insert(0, {str(root)!r})
from solver_process import send_message, receive_leased_message
fd = int(sys.argv[sys.argv.index('--fd')+1])
with socket.socket(fileno=fd) as channel:
    while True:
        request, leases = receive_leased_message(channel)
        os.write(1, b'native diagnostic output\\n')
        result = dict(pid=os.getpid(), python=sys.executable, cache=os.environ['GATO_CACHE_DIR'], path=os.environ['PATH'])
        identity = {{k:request[k] for k in ('protocol','epoch','request_id')}}
        if request['operation'] == 'stale': identity['epoch'] = 'old'
        send_message(channel, dict(identity, ok=True, result=result))
        for lease in leases: os.close(lease)
        if request['operation'] == 'close': break
''')
            profile = dict(id="cpu", mpc_root=directory, python=sys.executable, cache=directory)
            child = SolverProcess(profile, script=script)
            try:
                result = child.request("echo")
                self.assertNotEqual(result["pid"], os.getpid())
                self.assertEqual(result["python"], sys.executable)
                self.assertEqual(result["cache"], directory)
                self.assertEqual(result["path"].split(os.pathsep)[0], str(Path(sys.executable).parent))
                with self.assertRaisesRegex(RuntimeError, "stale"):
                    child.request("stale")
            finally:
                child.close()
            self.assertEqual(child.process.returncode, 0)
            self.assertIn("native diagnostic output", child.log_path.read_text())

    def test_native_joint6_control_is_not_signed_by_the_simulator(self):
        # Plans cross the solver boundary in native coordinates (Plan.torques):
        # joint 6's native +3 Nm is applied as +3 Nm, whatever its GPU axis sign.
        adapter = FakeAdapter()
        torques = np.zeros((2, 7)); torques[:, 5] = 3.
        plan = dict(_states=np.zeros((3, 14)), _torques=torques, N=3, dt_s=.02,
                    seq=1, stats=dict(solve_time_ms=0.), sim_time_s=0., type="plan")
        adapter.solve_snapshot = lambda origin, version: deepcopy(plan)
        session = MultirateSession(adapter, dict(DEFAULT_EXECUTION,
            simulation_hz=100., control_hz=100., to_hz=100.))
        records = session.advance_interval(.01)
        control = next(record for record in records if record["type"] == "control")
        self.assertEqual(control["torque_nm"][5], 3.)
        self.assertAlmostEqual(adapter.x[5], .03)

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
