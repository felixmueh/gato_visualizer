"""CPU/mock compatibility and subprocess boundary checks; no CUDA imports."""
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import source_runtime as runtime


def checkout(root):
    for name in ("examples/reach_sim.py", "external/gato/python/gato/_cache.py"):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    for name in ("venv-host/bin/python", ".venv/bin/python"):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(sys.executable)


class SourceSelectionTests(unittest.TestCase):
    def test_selection_defaults_to_host_environment_and_selected_checkout_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout(root)
            selected = runtime.resolve_selection(root)
            self.assertEqual(selected["python"], str(root / "venv-host/bin/python"))
            self.assertEqual(selected["cache"], str(root / ".cache/gato"))
            (root / "venv-host/bin/python").unlink()
            self.assertEqual(runtime.resolve_selection(root)["python"], str(root / ".venv/bin/python"))
            self.assertFalse((root / ".cache").exists())

    def test_checkout_token_is_substituted_for_interpreter_and_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            checkout(root)
            (root / "tools/bin").mkdir(parents=True)
            (root / "tools/bin/python").symlink_to(sys.executable)
            selected = runtime.resolve_selection(root, python="<checkout>/tools/bin/python", cache="<checkout>/c/../cache")
            self.assertEqual(selected["python"], str(root / "tools/bin/python"))
            self.assertEqual(selected["cache"], str(root / "cache"))
            self.assertEqual(selected["templates"], dict(python="<checkout>/tools/bin/python", cache="<checkout>/c/../cache"))
            # Absolute paths without the token keep working; the template is the path itself.
            absolute = runtime.resolve_selection(root, python=str(root / "tools/bin/python"))
            self.assertEqual(absolute["python"], str(root / "tools/bin/python"))
            self.assertEqual(absolute["templates"]["python"], str(root / "tools/bin/python"))
            # The same template follows a different checkout.
            other = Path(directory).resolve() / "other"
            checkout(other); (other / "tools/bin").mkdir(parents=True); (other / "tools/bin/python").symlink_to(sys.executable)
            self.assertEqual(runtime.resolve_selection(other, python="<checkout>/tools/bin/python")["python"], str(other / "tools/bin/python"))
            with patch.dict(os.environ, HOME=str(root)):
                self.assertEqual(runtime.resolve_selection(root, python="~/tools/bin/python")["python"], str(root / "tools/bin/python"))

    def test_unknown_tokens_are_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout(root)
            for value in ("<home>/python", "<Checkout>/.venv/bin/python", "<checkout>/<x>/python"):
                with self.assertRaisesRegex(ValueError, "Unknown token"):
                    runtime.resolve_selection(root, python=value)
            with self.assertRaisesRegex(ValueError, "Unknown token <root>"):
                runtime.resolve_selection(root, cache="<root>/cache")

    def test_default_templates_prefer_host_environment_and_store_only_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            checkout(root)
            self.assertEqual(runtime.checkout_defaults(root)["python"], "<checkout>/venv-host/bin/python")
            self.assertEqual(runtime.checkout_defaults(root)["cache"], "<checkout>/.cache/gato")
            (root / "venv-host/bin/python").unlink()
            self.assertEqual(runtime.default_interpreter_template(root), "<checkout>/.venv/bin/python")
            selection = runtime.resolve_selection(root)
            self.assertEqual(runtime.stored_selection(selection), dict(mpc_root=str(root)))
            selection = runtime.resolve_selection(root, cache="<checkout>/other")
            self.assertEqual(runtime.stored_selection(selection), dict(mpc_root=str(root), cache="<checkout>/other"))

    def test_invalid_selection_clear_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "Not a tiago_mpc checkout"):
                runtime.resolve_selection(directory)
            checkout(Path(directory))
            with self.assertRaisesRegex(ValueError, "not executable"):
                runtime.resolve_selection(directory, python=Path(directory) / "absent")

    def test_probe_runs_only_selected_interpreter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout(root)
            selection = runtime.resolve_selection(root)
            response = dict(compatible=True, available_N=[48], modules=[])
            with patch.object(runtime.subprocess, "run", return_value=SimpleNamespace(
                    stdout=json.dumps(response), returncode=0)) as run:
                self.assertEqual(runtime.probe_selection(selection), response)
            command = run.call_args.args[0]
            self.assertEqual(command[0], selection["python"])
            self.assertIn(str(runtime.PROBE_SCRIPT), command)
            self.assertIn("--cache", command)
            command, env = runtime.build_command(selection, [32, 48], rebuild=True)
            self.assertIn("--rebuild", command)
            self.assertEqual(command[-4:-1], ["--N", "32", "48"])
            self.assertEqual(env["PYTHONUNBUFFERED"], "1")
            smooth_command, _ = runtime.build_command(selection, [32], prediction_friction=True)
            self.assertIn("--prediction-friction", smooth_command)

    def test_probe_failure_is_structured(self):
        with patch.object(runtime, "source_command", return_value=["unused"]), patch.object(
                runtime.subprocess, "run", side_effect=subprocess.TimeoutExpired("unused", 1)):
            result = runtime.probe_selection({})
        self.assertFalse(result["compatible"])
        self.assertIn("timed out", result["error"])

    def test_malformed_probe_reports_selected_python_and_last_stderr(self):
        interpreter = "/selected/venv/bin/python"
        stderr = "x" * 5000 + "missing host library"
        with patch.object(runtime, "source_command", return_value=[interpreter]), patch.object(
                runtime.subprocess, "run", return_value=SimpleNamespace(
                    stdout="", stderr=stderr, returncode=127)):
            result = runtime.probe_selection(dict(python=interpreter))
        self.assertIn(interpreter, result["error"])
        self.assertIn("127", result["error"])
        self.assertIn("missing host library", result["error"])
        self.assertLess(len(result["error"]), 4200)

    def test_half_cpu_jobs_respects_affinity_and_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cpu.max").write_text("600000 100000")
            with patch.object(os, "cpu_count", return_value=32), patch.object(
                    os, "sched_getaffinity", return_value=set(range(12))):
                self.assertEqual(runtime.usable_cpu_count(root), 6)
            with patch.object(runtime, "usable_cpu_count", return_value=7.5):
                self.assertEqual(runtime.build_jobs(), 3)
            with patch.object(runtime, "usable_cpu_count", return_value=1):
                self.assertEqual(runtime.build_jobs(), 1)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        package = self.root / "package"
        package.mkdir()
        self.reach = SimpleNamespace(PLANT="arm", EE_FRAME="grasp", gato=SimpleNamespace(__file__=str(package / "__init__.py")))
        self.gpu = self.root / "model.urdf"
        self.gpu.write_text("<robot/>")
        self.cache = Mock()
        self.cache.cache_dir.return_value = self.root
        self.cache.detect_arch.return_value = "120"
        self.cache.robot_entry.return_value = dict(codegen_key="correct", N=[32])
        self.cache.resolve.return_value = ({"codegen_key": "correct"}, self.root / "robots")
        self.cache.module_key.side_effect = lambda robot, n, *args: (f"current-{n}", {"N": n, "toolchain": "current ABI", "native_source_id": "native-id"})
        self.cache.load_module.side_effect = lambda plant, n, **kwargs: SimpleNamespace(
            __file__=str(self.root / f"current-{n}.so"), NATIVE_SOURCE_ID="native-id",
            KNOT_POINTS=n, NQ=7, NV=7, FLOATING_BASE=False)
        self.cache.toolchain_identity.return_value = {"arch": "120", "python_ext_suffix": ".so"}
        self.cache.find_module.side_effect = lambda plant, n: self.root / f"current-{n}.so" if n == 48 else None
        @contextmanager
        def model(_reach, losses=None):
            yield self.gpu, self.gpu, SimpleNamespace(tolist=lambda: [1, -1])
        self.addCleanup(patch.stopall)
        patch.object(runtime, "prepared_model", model).start()
        patch.dict(sys.modules, {"gato": SimpleNamespace(_cache=self.cache),
                               "gato.builder": SimpleNamespace(_codegen_key=lambda *args: "correct")}).start()

    def binary(self, n, filename=None):
        path = self.root / "modules/arm/old-key" / (filename or f"bsqpN{n}_arm.cpython-310-x86_64-linux-gnu.so")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()

    def test_discovers_N_absent_from_manifest_then_calls_actual_key_and_find(self):
        self.binary(32)
        self.binary(48)
        self.binary(64, "bsqpN64_arm_eh.so")
        result = runtime.discover_compatible_modules(self.reach)
        self.assertEqual(result["available_N"], [48])
        self.assertEqual([entry["N"] for entry in result["modules"]], [32, 48])
        self.assertEqual(result["modules"][0]["status"], "stale")
        self.assertEqual(self.cache.find_module.call_count, 2)
        self.cache.ensure_module.assert_not_called()
        self.cache.register_robot.assert_not_called()

    def test_smooth_mode_qualifies_separate_namespace_without_building(self):
        key = Mock(return_value="correct")
        losses = dict(model="coulomb_tanh_viscous", smoothing_rad_s=.07)
        with patch.dict(sys.modules, {"gato.builder": SimpleNamespace(_codegen_key=key)}):
            result = runtime.discover_compatible_modules(self.reach, [48], losses=losses)
        self.assertEqual(result["available_N"], [48])
        self.cache.robot_entry.assert_called_with("arm_smooth")
        self.cache.load_module.assert_called_with("arm_smooth", 48, build_if_missing=False)
        self.assertEqual(key.call_args.kwargs, dict(joint_friction_smoothing=.07))
        self.cache.ensure_module.assert_not_called()
        self.cache.register_robot.assert_not_called()

    def test_stale_model_frame_blocks_existing_binary_without_lookup(self):
        self.binary(48)
        self.cache.robot_entry.return_value = dict(codegen_key="historical-flange")
        result = runtime.discover_compatible_modules(self.reach)
        self.assertEqual(result["available_N"], [])
        self.assertIn("model/frame", result["error"])
        self.cache.find_module.assert_not_called()

    def test_unknown_architecture_fails_closed(self):
        self.cache.detect_arch.return_value = None
        result = runtime.discover_compatible_modules(self.reach, [48])
        self.assertFalse(result["compatible"])
        self.assertIn("architecture", result["error"])
        self.cache.find_module.assert_not_called()

    def test_corrupt_or_wrong_embedded_binary_fails_closed(self):
        self.binary(48)
        self.cache.load_module.side_effect = ImportError("ELF header invalid")
        result = runtime.discover_compatible_modules(self.reach)
        self.assertEqual(result["available_N"], [])
        self.assertIn("ELF header", result["modules"][0]["reason"])
        self.cache.load_module.assert_called_once_with("arm", 48, build_if_missing=False)
        self.cache.ensure_module.assert_not_called()

    def test_package_binary_cannot_bypass_cache_identity(self):
        (Path(self.reach.gato.__file__).parent / "bsqpN48_arm.so").touch()
        result = runtime.discover_compatible_modules(self.reach)
        self.assertEqual(result["available_N"], [])
        self.assertIn("shadows", result["modules"][0]["reason"])

    def test_prepared_model_restores_root_and_keeps_original_asset_paths(self):
        original = self.root / "source"
        (original / "models").mkdir(parents=True)
        reach = SimpleNamespace(ROOT=original, URDF=original / "original.urdf")
        def generate():
            self.assertTrue((reach.ROOT / "models").is_symlink())
            self.assertEqual(reach.URDF, original / "original.urdf")
            return 1, 2, 3
        reach.runtime_urdf = generate
        # Retrieve real helper after this fixture's patch.
        patch.stopall()
        with patch.object(runtime, "ROOT", self.root / "visualizer"):
            with runtime.prepared_model(reach) as model:
                self.assertEqual(model, (1, 2, 3))
            self.assertEqual(reach.ROOT, original)
        self.assertFalse((original / ".cache").exists())


class BuilderTests(unittest.TestCase):
    def test_build_uses_only_gato_cache_coordination_and_half_cpu_jobs(self):
        spec = importlib.util.spec_from_file_location("source_probe_test", runtime.PROBE_SCRIPT)
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            reach = SimpleNamespace(PLANT="arm", EE_FRAME="grasp", gato=Mock(__file__=str(package / "__init__.py")))
            cache = Mock()
            cache.detect_arch.return_value = "120"
            cache.resolve.return_value = ({}, root / "robots")
            cache.module_key.return_value = ("current", {})
            cache.ensure_module.side_effect = lambda plant, n, **kwargs: root / f"module-{n}.so"
            @contextmanager
            def model(_reach, retain=False, losses=None):
                self.assertTrue(retain)
                yield root / "native.urdf", root / "gpu.urdf", None
            events = []
            expected = dict(available_N=[32, 48], compatible=True)
            with patch.dict(sys.modules, {"gato": SimpleNamespace(_cache=cache)}), patch.object(
                    script, "prepared_model", model), patch.object(script, "build_jobs", return_value=3), patch.object(
                    script, "probe", return_value=expected):
                result = script.build(dict(cache=str(root)), reach, [32, 48], events.append)
            self.assertEqual(result, expected)
            self.assertEqual([call.kwargs["jobs"] for call in cache.ensure_module.call_args_list], [3, 3])
            reach.gato.register_robot.assert_called_once_with("arm", root / "gpu.urdf", N=[32, 48], ee_frame="grasp", build=False)
            self.assertTrue(any(e["stage"] == "built" for e in events))
            cache._locked.assert_not_called()  # ensure_module owns its own lock

    def test_rebuild_lookup_and_archive_hold_only_gato_cache_lock(self):
        spec = importlib.util.spec_from_file_location("source_probe_rebuild_test", runtime.PROBE_SCRIPT)
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / "current.so"
            current.write_bytes(b"old binary")
            (root / "meta.json").write_text('{"old": true}')
            reach = SimpleNamespace(PLANT="arm", EE_FRAME="grasp", gato=Mock(__file__=str(root / "__init__.py")))
            cache = Mock()
            cache.cache_dir.return_value = root
            cache.detect_arch.return_value = "120"
            cache.resolve.return_value = ({}, root / "robots")
            cache.module_key.return_value = ("current", {})
            locked = []
            @contextmanager
            def lock(path):
                self.assertEqual(path, root)
                locked.append(True)
                try:
                    yield
                finally:
                    locked.pop()
            def find(*args):
                self.assertEqual(locked, [True])
                return current
            def ensure(*args, **kwargs):
                self.assertEqual(locked, [])
                self.assertFalse(current.exists())
                return current
            cache._locked.side_effect = lock
            cache.find_module.side_effect = find
            cache.ensure_module.side_effect = ensure
            @contextmanager
            def model(*args, **kwargs):
                yield root / "native.urdf", root / "gpu.urdf", None
            events = []
            with patch.dict(sys.modules, {"gato": SimpleNamespace(_cache=cache)}), patch.object(
                    script, "prepared_model", model), patch.object(script, "build_jobs", return_value=2), patch.object(
                    script, "ROOT", root / "visualizer"), patch.object(script, "probe", return_value={}):
                script.build(dict(cache=str(root)), reach, [32], events.append, rebuild=True)
            cache._locked.assert_called_once_with(root)
            archived = next(Path(e["path"]) for e in events if e["stage"] == "archived")
            self.assertEqual((archived / "current.so").read_bytes(), b"old binary")
            self.assertEqual(json.loads((archived / "meta.json").read_text()), dict(old=True))

    def test_cli_import_error_retains_resolved_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout(root)
            result = subprocess.run([sys.executable, str(runtime.PROBE_SCRIPT), "probe", "--mpc-root", str(root),
                                     "--python", sys.executable], capture_output=True, text=True)
            data = json.loads(result.stdout)
            self.assertFalse(data["compatible"])
            self.assertEqual(data["selection"]["mpc_root"], str(root))
            # Selection normalizes ".." (os.path.abspath) but keeps the venv symlink.
            self.assertEqual(data["selection"]["python"], os.path.abspath(sys.executable))
            self.assertIn("source", data)

    def test_cli_invalid_source_emits_json_without_source_imports(self):
        result = subprocess.run([sys.executable, str(runtime.PROBE_SCRIPT), "probe", "--mpc-root", "/definitely-missing-mpc"],
                                capture_output=True, text=True)
        data = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(data["compatible"])
        self.assertIn("Not a tiago_mpc checkout", data["error"])


if __name__ == "__main__":
    unittest.main()

class DisplaySourceTests(unittest.TestCase):
    def test_selected_model_assets_grasp_frame_and_configuration_validate_before_use(self):
        spec = importlib.util.spec_from_file_location('source_probe_display_test', runtime.PROBE_SCRIPT)
        script = importlib.util.module_from_spec(spec); spec.loader.exec_module(script)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            selection = dict(mpc_root=str(root), python=sys.executable, cache=str(root/'cache'))
            reach = SimpleNamespace(ROOT=root, EE_FRAME='grasp', URDF=root/'reduced.urdf', gato=SimpleNamespace(__file__=str(root/'external/gato/python/gato/__init__.py')))
            assets, kinematics, configuration = Mock(), Mock(), Mock()
            def imported(name):
                return reach if name == 'reach_sim' else configuration
            with patch.object(script.importlib, 'import_module', side_effect=imported), patch.dict(sys.modules, {'server':SimpleNamespace(canonical_model_assets=assets, RobotKinematics=kinematics)}), patch.dict(os.environ), patch.object(sys, 'path', list(sys.path)):
                self.assertIs(script.load_source(selection), reach)
                assets.assert_called_once_with(root)
                kinematics.assert_called_once_with(root/'models/tiago_pro/tiago_pro.urdf', end_effector_frame='grasp', reduced_urdf=root/'reduced.urdf')
                configuration.load_configuration.assert_called_once()
                assets.side_effect = ValueError('canonical mesh is missing')
                with self.assertRaisesRegex(ValueError, 'canonical mesh is missing'):
                    script.load_source(selection)
