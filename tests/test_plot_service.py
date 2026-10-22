"""Plotting transport/source correctness with CPU-only fixtures, no MPC imports."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from execution_bridge import HistoryStore
from plot_service import PlotService, reduce_spec
from plot_sources import SourceReader, scene_records, inspect_source, solve_iterations
from server import make_server
from visualizer_config import load_visualizer_config, save_source_selection


def fixture_scene():
    return dict(source={}, joint_names=[f"arm_right_{i}_joint" for i in range(1,8)], joint_limits={}, trajectories=[
        dict(id="recorded", kind="recorded", time_s=[20., 21., 22.],
             q=[[1.]*7, [2.]*7, [3.]*7], ee_xyz=[[0., 0., 0.], [1., 0., 0.], [2., 0., 0.]],
             reference_time_s=[20., 22.], reference_xyz=[[2., 0., 0.], [2., 0., 0.]]),
        dict(id="saved-plan", kind="prediction", time_s=[0., .1], q=[[2.]*7, [4.]*7],
             ee_xyz=[[1., 0., 0.], [2., 0., 0.]], metadata=dict(origin_time_s=21., stats={}))])


class SourceTests(unittest.TestCase):
    def test_live_reads_only_committed_append_and_resets_for_generation(self):
        with tempfile.TemporaryDirectory() as folder:
            store = HistoryStore(folder)
            reader = SourceReader()
            store.append([dict(type="state", sim_time_s=7., q=[1.]*7)])
            descriptor = store.plot_source(0)
            store.append([dict(type="state", sim_time_s=8., q=[2.]*7)])
            with patch("plot_sources.json.loads", wraps=json.loads) as decode:
                self.assertEqual(len(reader.read(descriptor)["states"]), 1)
                self.assertEqual(decode.call_count, 1)
                reader.read(descriptor)
                self.assertEqual(decode.call_count, 1)
                self.assertEqual(len(reader.read(store.plot_source(0))["states"]), 2)
                self.assertEqual(decode.call_count, 2)
            previous = store.path
            store.reset(1)
            store.append([dict(type="state", sim_time_s=3., q=[9.]*7)])
            self.assertEqual(reader.read(store.plot_source(1))["states"][0]["q"][0], 9)
            self.assertTrue(previous.exists())
            with self.assertRaisesRegex(ValueError, "History changed"):
                store.plot_source(0)
            store.close()

    def test_replay_elapsed_clock_preserves_original_and_missing_telemetry(self):
        raw = scene_records(fixture_scene())
        self.assertEqual([s["sim_time_s"] for s in raw["states"]], [0, 1, 2])
        self.assertEqual([s["recorded_time_s"] for s in raw["states"]], [20, 21, 22])
        self.assertEqual(raw["plans"][0]["sim_time_s"], 1)
        self.assertNotIn("qd_rad_s", raw["states"][0])
        self.assertNotIn("torque_samples", raw)
        self.assertEqual(raw["scene"]["trajectories"][0]["time_s"][0], 20)
        plan, info = inspect_source(raw, {}, dict(cursor_s=1.5))
        self.assertEqual(plan["id"], "saved-plan")
        self.assertEqual(info["association"], "timestamp fallback")
        self.assertFalse(info["selected_solve"]["capabilities"]["continue_sqp"])
        self.assertIsNone(inspect_source(raw, {}, dict(cursor_s=.5))[0])
        self.assertEqual(inspect_source(raw, dict(trajectory_index=0), dict(cursor_s=1.5))[0]["id"], "saved-plan")

    def test_replay_reference_interpolates_on_its_own_clock_for_long_recordings(self):
        times = [10 + i*.001 for i in range(20001)]
        scene = dict(trajectories=[dict(kind="recorded", time_s=times, q=[[0.]*7]*len(times),
                                        reference_time_s=[10., 30.], reference_xyz=[[0., 0., 0.], [2., 4., 6.]])])
        started = time.monotonic()
        states = scene_records(scene)["states"]
        self.assertLess(time.monotonic()-started, 5)
        self.assertEqual(states[0]["target_xyz"], [0., 0., 0.])
        self.assertEqual([round(v, 9) for v in states[10000]["target_xyz"]], [1., 2., 3.])
        self.assertEqual(states[-1]["sim_time_s"], times[-1]-10)

    def test_recorded_association_and_sparse_iteration_records(self):
        first = dict(seq=1, sim_time_s=0, q=[[0]*7], diagnostics=dict(
            pcg_iters=[[5], [0]], min_merit=[[12.]], step_size=[[-1.]]))
        second = dict(seq=2, sim_time_s=1, q=[[1]*7])
        raw = dict(states=[dict(sim_time_s=1.1, plan_seq=1)], plans=[first, second])
        selected, info = inspect_source(raw, {}, dict(cursor_s=1.1))
        self.assertEqual(selected["id"], "1")
        self.assertEqual(info["association"], "recorded")
        self.assertEqual(len(selected["iterations"]), 2)
        self.assertEqual(selected["iterations"][1]["status"], "zero-PCG shortcut")
        self.assertNotIn("merit", selected["iterations"][1]["stats"])
        self.assertTrue(all(not i["has_prediction"] for i in selected["iterations"]))

    def test_reduction_preserves_extrema_and_null_gap(self):
        values = [0.]*10000
        values[3001], values[3002], values[4000] = 500., -99., None
        original = dict(version=1, kind="lines", title="Peaks", series=[dict(label="x", x=list(range(10000)), y=values)])
        reduced = reduce_spec(original, 100)
        series = reduced["series"][0]
        self.assertLess(len(series["x"]), 1000)
        for value in (500, -99, None):
            self.assertIn(value, series["y"])
        self.assertIn(4000, series["x"])
        self.assertEqual(len(original["series"][0]["x"]), 10000)
        self.assertEqual(reduced["display_reduction"], [dict(series="x", original=10000, displayed=len(series["x"]))])
        self.assertNotIn("notes", reduced)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.config = self.folder/"viewer.json"
        self.config.write_text(json.dumps(dict(ingest_directory="incoming", source=dict(mpc_root="/tmp/source"))))
        self.service = PlotService(self.folder, self.config, fixture_scene(), timeout_s=5)

    def tearDown(self):
        self.service.close()
        self.temporary.cleanup()

    def wait_for(self, predicate, timeout=5):
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.01)
        self.fail("CPU plot job did not finish")

    def wait_job(self, identifier):
        return self.wait_for(lambda: (lambda j: j if j["state"] in ("complete", "failed", "superseded") else None)(self.service.job(identifier)))

    def request(self, **kwargs):
        return dict(source=dict(kind="replay", id="default"), context="episode", **kwargs)

    def test_real_worker_standard_plots_ranges_missing_iteration_and_no_solver(self):
        self.wait_for(lambda: self.service.settings()["ready"])
        job = self.service.submit(self.request(range=dict(mode="through_cursor", cursor_s=1), plots=[
            dict(instance_id="one", plot_id="episode.summary", inputs={}),
            dict(instance_id="two", plot_id="episode.joint", inputs={"quantity": "qd"})]))
        result = self.wait_job(job["job_id"])
        self.assertEqual(result["state"], "complete", result)
        summary = {r["label"]: r["value"] for r in result["results"][0]["spec"]["rows"]}
        self.assertEqual(summary["Retained states"], 2)
        self.assertEqual(summary["Analysis duration"], 1)
        self.assertEqual(result["context"]["time_origin_s"], 20)
        self.assertEqual(result["context"]["joint_names"], fixture_scene()["joint_names"])
        self.assertEqual(result["results"][1]["spec"]["kind"], "unavailable")
        window = self.wait_job(self.service.submit(self.request(range=dict(mode="window", start_s=1),
            plots=[dict(instance_id="one", plot_id="episode.summary", inputs={})]))["job_id"])
        rows = {r["label"]: r["value"] for r in window["results"][0]["spec"]["rows"]}
        self.assertEqual(rows["Retained states"], 2)
        with self.assertRaisesRegex(ValueError, "start_s <= end_s"):
            self.service.submit(self.request(range=dict(mode="window", start_s=2, end_s=1)))
        solve = dict(source=dict(kind="replay", id="default", trajectory_index=1), context="solve",
            selection=dict(iteration=1), plots=[dict(instance_id="p", plot_id="solve.prediction_joint", inputs={})])
        result = self.wait_job(self.service.submit(solve)["job_id"])
        self.assertEqual(result["results"][0]["spec"]["kind"], "unavailable")

    def test_iteration_paths_selector_is_an_index_and_absent_without_a_trace(self):
        self.wait_for(lambda: self.service.settings()["ready"])
        for bad in (-1, 1.5, "all", True):
            with self.assertRaisesRegex(ValueError, "iteration_paths"):
                self.service.submit(dict(self.request(), context="solve", selection=dict(iteration_paths=bad)), catalog=True)
        # Recorded episode solves carry no binary trace, so no paths are invented.
        job = self.service.submit(dict(source=dict(kind="replay", id="default", trajectory_index=1), context="solve",
                                       selection=dict(iteration_paths=0)), catalog=True)
        result = self.wait_job(job["job_id"])
        self.assertEqual(result["state"], "complete", result)
        self.assertNotIn("iteration_paths", result)

    def test_reload_settings_preserve_source_and_isolate_import_failures(self):
        project = self.folder/"custom"
        project.mkdir()
        (project/"broken.py").write_text("raise ValueError('bad custom plot')\n")
        (project/"good.py").write_text("from gato_visualizer.plotting import plot_episode,table\n@plot_episode(id='custom.raw',title='Raw')\ndef custom(data):\n assert data.solver is None\n return table('Raw',[dict(label='full raw',value=len(data.raw['states']))])\n")
        revision = self.service.registry_revision
        self.service.update_settings(dict(directory=str(project)))
        self.wait_for(lambda: self.service.settings()["ready"])
        self.assertGreater(self.service.registry_revision, revision)
        self.assertTrue(self.service.settings()["errors"])
        result = self.wait_job(self.service.submit(self.request(range=dict(mode="through_cursor", cursor_s=0),
            plots=[dict(instance_id="raw", plot_id="custom.raw", inputs={})]))["job_id"])
        self.assertEqual(result["results"][0]["spec"]["rows"][0]["value"], 3)
        config = load_visualizer_config(self.config)
        self.assertEqual(config.plotters_directory, project)
        self.assertEqual(config.source["mpc_root"], "/tmp/source")
        save_source_selection(self.config, dict(mpc_root="/tmp/other"))
        self.assertEqual(load_visualizer_config(self.config).plotters_directory, project)
        self.service.update_settings(dict(directory=None))
        self.assertIsNone(load_visualizer_config(self.config).plotters_directory)

    def test_source_joint_names_reach_catalog_context(self):
        scene = fixture_scene()
        scene["joint_names"] = ["shoulder", "wrist"]
        for trajectory in scene["trajectories"]:
            trajectory["q"] = [row[:2] for row in trajectory["q"]]
        self.service.default_scene = scene
        self.service.reload()
        result = self.wait_job(self.service.submit(self.request(), catalog=True)["job_id"])
        self.assertEqual(result["state"], "complete", result)
        self.assertEqual(result["context"]["joint_names"], ["shoulder", "wrist"])

    def test_pending_coalescing_stale_generation_and_http_stay_responsive(self):
        project = self.folder/"slow"
        project.mkdir()
        (project/"slow.py").write_text("import time\nfrom gato_visualizer.plotting import plot_episode,table\n@plot_episode(id='slow',title='Slow')\ndef slow(data):\n time.sleep(.25)\n return table('Slow',[])\n")
        self.service.update_settings(dict(directory=str(project)))
        self.wait_for(lambda: self.service.settings()["ready"])
        body = self.request(plots=[dict(instance_id="slow", plot_id="slow", inputs={})])
        first = self.service.submit(body)
        self.wait_for(lambda: self.service.job(first["job_id"])["state"] == "running")
        second = self.service.submit(body)
        third = self.service.submit(body)
        self.assertEqual(self.service.job(second["job_id"])["state"], "superseded")
        server = make_server(dict(trajectories=[]), b"<robot/>", {}, port=0, plots=self.service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with urlopen(base+"/api/health", timeout=.2) as response:
                self.assertEqual(response.status, 200)
            request = Request(base+"/api/plots/catalog", data=json.dumps(self.request()).encode(), headers={"Content-Type":"application/json"})
            with urlopen(request, timeout=.2) as response:
                self.assertEqual(response.status, 202)
                identifier = json.load(response)["job_id"]
            with urlopen(base+"/api/plots/jobs/"+identifier, timeout=.2) as response:
                self.assertIn(json.load(response)["state"], ("pending", "running", "complete"))
            self.assertEqual(self.wait_job(third["job_id"])["state"], "complete")
            self.assertEqual(self.service.job(first["job_id"])["state"], "superseded")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
        store = HistoryStore(self.folder/"history")
        store.append([dict(type="state", sim_time_s=0, q=[0]*7)])
        self.service.live = SimpleNamespace(history_store=store, condition=threading.RLock(), latest={}, generation=0)
        job = self.service.submit(dict(source=dict(kind="live",generation=0),context="episode"),catalog=True)
        self.service.live.generation = 1
        self.assertEqual(self.service.job(job["job_id"])["state"], "superseded")
        store.close()

    def test_worker_timeout_leaves_service_reloadable(self):
        project = self.folder/"blocking"
        project.mkdir()
        (project/"blocking.py").write_text("import time\nfrom gato_visualizer.plotting import plot_episode,table\n@plot_episode(id='blocking',title='Blocking')\ndef blocking(data):\n time.sleep(20)\n return table('Blocking',[])\n")
        self.service.update_settings(dict(directory=str(project)))
        self.wait_for(lambda: self.service.settings()["ready"])
        self.service.timeout_s = .2
        job = self.service.submit(self.request(plots=[dict(instance_id="blocking", plot_id="blocking", inputs={})]))
        result = self.wait_job(job["job_id"])
        self.assertEqual(result["state"], "failed")
        self.assertIn("timeout", result["error"])
        self.service.timeout_s = 5
        self.service.update_settings(dict(directory=None))
        self.wait_for(lambda: self.service.settings()["ready"])
        result = self.wait_job(self.service.submit(self.request(), catalog=True)["job_id"])
        self.assertEqual(result["state"], "complete")

    def test_pinned_preview_is_retained_separately_and_generation_scoped(self):
        history, solves = HistoryStore(self.folder/"episode"), HistoryStore(self.folder/"solves")
        try:
            history.append([dict(type="state", sim_time_s=4., q=[0.]*7)])
            first = dict(type="plan", seq=1, sim_time_s=4., origin="preview", q=[[1.]*7, [2.]*7],
                         knot_time_s=[0., .1], stats={})
            solves.append([first])
            self.service.live = SimpleNamespace(history_store=history, inspection_store=solves,
                condition=threading.RLock(), latest={}, generation=0)
            body = dict(source=dict(kind="live", generation=0), context="solve",
                        selection=dict(solve_seq="preview:1"), plots=[dict(instance_id="s", plot_id="solve.summary", inputs={})])
            result = self.wait_job(self.service.submit(body)["job_id"])
            self.assertEqual(result["state"], "complete", result)
            solves.append([dict(first, seq=2, q=[[3.]*7, [4.]*7])])
            result = self.wait_job(self.service.submit(body)["job_id"])
            self.assertEqual(result["context"]["selected_solve"]["seq"], "preview:1")
            self.assertEqual(result["context"]["selected_solve"]["final_prediction"]["q"][0][0], 1)
            self.assertEqual(history.metadata()["history_cursor"], 1)
            saved_path = solves.path
            history.reset(1); solves.reset(1)
            self.service.live.generation = 1
            body["source"]["generation"] = 1
            result = self.wait_job(self.service.submit(body)["job_id"])
            self.assertEqual(result["state"], "failed")
            self.assertIn("not retained", result["error"])
            self.assertTrue(saved_path.exists())
        finally:
            history.close(); solves.close()


if __name__ == "__main__":
    unittest.main()
