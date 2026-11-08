"""CPU/mock compatibility and subprocess boundary checks; no CUDA imports."""
from dataclasses import dataclass, replace
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


@dataclass(frozen=True)
class VirtualTimeSettings:
    command_period: float = .002
    update_period: float = .01
    solve_latency_s: object = "measured"


@dataclass(frozen=True)
class ExecutionSafety:
    max_plan_age_s: object = .1

    def validate(self, plan, t, state):
        return None


@dataclass(frozen=True)
class SolveCompleted:
    request_time_s: float
    initial: object
    reference: object
    updates: object
    plan: object


@dataclass(frozen=True)
class Tick:
    t: float
    state: object
    command: object
    plan: object
    plan_activated: bool
    update: bool
    requested_command: object
    clipped: bool


@dataclass(frozen=True)
class Diagnostic:
    t: float
    kind: str
    message: str
    data: dict


def run_virtual_time(*, settings, duration, compensation=None, safety=None, effort_handling=None,
                     tick_callbacks=(), solve_completed_callbacks=(), diagnostic_callbacks=(),
                     before_tick_callbacks=(), cancelled=None, start_time_s=0, initial_command=None):
    pass


def checkout(root):
    for name in ("venv-host/bin/python", ".venv/bin/python", ".venv-container/bin/python"):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(sys.executable)


class SourceSelectionTests(unittest.TestCase):
    def test_selection_uses_uv_environment_for_platform_without_cross_platform_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout(root)
            with patch.object(runtime, "in_container", return_value=False):
                selected = runtime.resolve_selection(root)
                self.assertEqual(selected["python"], str(root / ".venv/bin/python"))
                (root / ".venv/bin/python").unlink()
                with self.assertRaisesRegex(ValueError, "not executable"):
                    runtime.resolve_selection(root)
            with patch.object(runtime, "in_container", return_value=True):
                selected = runtime.resolve_selection(root)
                self.assertEqual(selected["python"], str(root / ".venv-container/bin/python"))
            # No override: the visualizer chooses no cache; without tiago_mpc it is unknown.
            self.assertIsNone(selected["cache"])
            self.assertIsNone(selected["effective_cache"])
            self.assertFalse((root / ".cache").exists())

    def test_default_cache_is_tiago_mpcs_main_checkout_cache_also_from_a_worktree(self):
        """tiago_mpc's own util.cache_root() decides; an explicit override still wins."""
        from tests.tiago_mpc_source import MPC_ROOT
        with tempfile.TemporaryDirectory() as directory:
            main, worktree = Path(directory).resolve() / "main", Path(directory).resolve() / "worktree"
            (main / "tiago_mpc").mkdir(parents=True)
            (main / "tiago_mpc/__init__.py").write_text("")
            (main / "tiago_mpc/util.py").write_text((MPC_ROOT / "tiago_mpc/util.py").read_text())
            git = lambda *args: subprocess.run(["git", "-C", str(main), "-c", "user.name=t", "-c", "user.email=t@t",
                                                *args], check=True, capture_output=True)
            git("init", "-q"); git("add", "."); git("commit", "-qm", "util")
            git("worktree", "add", "-q", "-b", "wt", str(worktree))
            checkout(worktree)
            with patch.dict(os.environ, GATO_CACHE_DIR="/launch/override/ignored/by/the/lookup"):
                selected = runtime.resolve_selection(worktree)
            self.assertIsNone(selected["cache"])
            self.assertEqual(selected["effective_cache"], str(main / ".cache/gato"))
            self.assertEqual(runtime.checkout_defaults(worktree)["cache"], str(main / ".cache/gato"))
            self.assertEqual(runtime.resolve_templates(worktree)["cache"], dict(path=str(main / ".cache/gato"), default=True))
            # Children see no GATO_CACHE_DIR, so tiago_mpc resolves the same default there.
            with patch.dict(os.environ, GATO_CACHE_DIR="/inherited"):
                self.assertNotIn("GATO_CACHE_DIR", runtime.cache_environment(selected))
                self.assertNotIn("GATO_CACHE_DIR", runtime.build_command(selected, [32])[1])
            self.assertNotIn("--cache", runtime.source_command(selected))
            override = runtime.resolve_selection(worktree, cache="<checkout>/.cache/gato")
            self.assertEqual(override["cache"], str(worktree / ".cache/gato"))
            self.assertEqual(override["effective_cache"], str(worktree / ".cache/gato"))
            self.assertEqual(runtime.cache_environment(override)["GATO_CACHE_DIR"], str(worktree / ".cache/gato"))
            self.assertEqual(runtime.source_command(override)[-2:], ["--cache", str(worktree / ".cache/gato")])

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

    def test_default_templates_follow_platform_and_store_only_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            checkout(root)
            default = runtime.default_interpreter_template(root)
            self.assertEqual(runtime.checkout_defaults(root)["python"], default)
            self.assertIsNone(runtime.checkout_defaults(root)["cache"])  # no tiago_mpc here
            override = "<checkout>/.venv/bin/python" if runtime.in_container() else "<checkout>/.venv-container/bin/python"
            container = runtime.resolve_selection(root, python=override)
            self.assertEqual(runtime.stored_selection(container), dict(mpc_root=str(root), python=override))
            self.assertEqual(runtime.resolve_templates(root, cache="<checkout>/c")["cache"]["path"], str(root / "c"))
            self.assertEqual(runtime.default_interpreter_template(root), default)
            selection = runtime.resolve_selection(root)
            self.assertEqual(runtime.stored_selection(selection), dict(mpc_root=str(root)))
            selection = runtime.resolve_selection(root, cache="<checkout>/other")
            self.assertEqual(runtime.stored_selection(selection), dict(mpc_root=str(root), cache="<checkout>/other"))

    def test_selected_children_do_not_inherit_pythonpath(self):
        selected = dict(cache=None)
        self.assertEqual(runtime.cache_environment(selected, dict(PYTHONPATH='/old/gato/python', OTHER='keep')),
                         dict(OTHER='keep'))
        self.assertEqual(runtime.cache_environment(dict(cache='/explicit'), dict(PYTHONPATH='/old')),
                         dict(GATO_CACHE_DIR='/explicit'))

    def test_invalid_selection_clear_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "not a directory"):
                runtime.resolve_selection(Path(directory) / "missing")
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
            self.assertNotIn("--cache", command)  # no override: tiago_mpc decides
            command, env = runtime.build_command(selection, [32, 48], rebuild=True)
            self.assertIn("--rebuild", command)
            self.assertEqual(command[-4:-1], ["--N", "32", "48"])
            self.assertEqual(env["PYTHONUNBUFFERED"], "1")
            smooth_command, _ = runtime.build_command(selection, [32], prediction_friction=True)
            self.assertIn("--prediction-friction", smooth_command)
            with self.assertRaisesRegex(ValueError, "among 8, 16"):
                runtime.build_command(selection, [40])

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


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, runtime.PROBE_SCRIPT)
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    return script


@dataclass(frozen=True)
class Params:
    N: int = 32
    friction: object = None


class ProbeTests(unittest.TestCase):
    def test_probe_imports_the_selected_mpc_api_and_never_compiles(self):
        from tests.tiago_mpc_source import MPC_ROOT, live_probe
        with tempfile.TemporaryDirectory() as cache:
            result = subprocess.run([sys.executable, str(runtime.PROBE_SCRIPT), "probe", "--mpc-root", str(MPC_ROOT),
                                     "--python", sys.executable, "--cache", cache], capture_output=True, text=True,
                                    env=dict(os.environ, CUDA_VISIBLE_DEVICES=""))
            data = json.loads(result.stdout)
            self.assertTrue(data["compatible"], data.get("error"))
            self.assertEqual(data["available_N_by_friction"], dict(off=[], on=[]))  # an empty cache
            self.assertEqual(len(data["modules"]), (1 if data.get("exact_availability") else 2)*len(runtime.KNOT_COUNTS))
            self.assertFalse(list(Path(cache).glob("modules/*/*/*.so")))
            expected = live_probe()
            for key in ("defaults", "friction", "contract"):
                self.assertEqual(data[key], expected[key], key)
            self.assertEqual(list(data["defaults"])[:3], ["type", "N", "dt_s"])  # native to_dict order


class BuilderTests(unittest.TestCase):
    def test_build_compiles_each_variant_with_half_cpu_jobs_then_probes(self):
        script = load_script("source_probe_test")
        from tests.tiago_mpc_source import live_probe
        live_probe()
        from tiago_mpc import TIAGO
        from native_cost import with_knot_count
        friction = SimpleNamespace(width_rad_s=.03)
        mpc = SimpleNamespace(TIAGO=TIAGO, compile_binary=Mock(side_effect=lambda params, **kw: Path(f"N{params.N}.so")))
        events, expected = [], dict(available_N=[32, 48], compatible=True)
        with patch.object(script, "build_jobs", return_value=3), patch.object(script, "probe", return_value=expected):
            result = script.build(dict(cache="unused"), (None, mpc, None, friction), [32, 48], events.append,
                                  rebuild=True, prediction_friction=True)
        self.assertEqual(result, expected)
        self.assertEqual([call.args[0] for call in mpc.compile_binary.call_args_list],
                         [replace(with_knot_count(TIAGO, n), friction=friction) for n in (32, 48)])
        self.assertEqual([call.kwargs for call in mpc.compile_binary.call_args_list],
                         [dict(use_cache=False, jobs=3)]*2)
        self.assertEqual([e["path"] for e in events if e["stage"] == "built"], ["N32.so", "N48.so"])
        mpc.compile_binary.reset_mock()
        with patch.object(script, "build_jobs", return_value=3), patch.object(script, "probe", return_value=expected):
            script.build(dict(cache="unused"), (None, mpc, None, friction), [16], events.append)
        self.assertEqual(mpc.compile_binary.call_args, ((with_knot_count(TIAGO, 16),), dict(use_cache=True, jobs=3)))

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
        self.assertIn("not a directory", data["error"])

    def test_cli_build_accepts_only_the_probed_knot_counts(self):
        result = subprocess.run([sys.executable, str(runtime.PROBE_SCRIPT), "build", "--mpc-root", str(Path.cwd()),
                                 "--python", sys.executable, "--N", "40"], capture_output=True, text=True)
        data = json.loads(result.stdout)
        self.assertEqual(data["event"], "error")
        self.assertIn("among 8, 16", data["error"])

class DisplaySourceTests(unittest.TestCase):
    def test_selected_mpc_api_model_assets_and_grasp_frame_validate_before_use(self):
        # Initialize package/C++ imports before mocking importlib.import_module;
        # Pinocchio itself uses it while importing its extension submodules.
        script = load_script('source_probe_display_test')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            selection = dict(mpc_root=str(root), python=sys.executable, cache=str(root/'cache'))
            friction = SimpleNamespace(coulomb_nm=(1.,)*7, viscous_nm_s_per_rad=(2.,)*7)
            tiago = SimpleNamespace(FULL_URDF=root/'full.urdf', arm_urdf=lambda: root/'reduced.urdf', GRASP_FRAME='grasp',
                                    urdf_friction=lambda: friction)
            class Plant:
                def __init__(self, config):
                    pass
                def start(self, clock):
                    pass
            @dataclass(frozen=True)
            class Config:
                q: tuple = ()
                qd: tuple = ()
                substep: float = .001
                integrator: str = "rk4"
                friction: object = None
                friction_law: object = None
                def build(self):
                    return Plant(self)
            @dataclass(frozen=True)
            class State:
                t: float
                q: object
                qd: object
            @dataclass(frozen=True)
            class Plan:
                t0: float
                dt: float
                states: object
                torques: object
                stats: object
            @dataclass(frozen=True)
            class MpcParams:
                friction_law: object = None
            from tests.tiago_mpc_source import live_probe
            live_probe()
            from tiago_mpc import SolverSettings, default_cost
            mpc = SimpleNamespace(MpcParams=MpcParams, SolverSettings=SolverSettings, default_cost=default_cost,
                                  TIAGO=SimpleNamespace(max_sqp_time_s=.01, solver=SolverSettings(), cost=default_cost()),
                                  Mpc=SimpleNamespace(warmup=3, request=4, result=5), find_binary=4, compile_binary=5,
                                  SimPlant=Plant, SimConfig=Config, VirtualClock=object, State=State, Plan=Plan,
                                  SolveCompleted=SolveCompleted, Tick=Tick, Diagnostic=Diagnostic, run_virtual_time=run_virtual_time,
                                  VirtualTimeSettings=VirtualTimeSettings,
                                  EffortClip=lambda: None, ExecutionSafety=ExecutionSafety,
                                  to_dict=lambda value: value, from_dict=lambda value: value, provenance=lambda: {})
            assets, kinematics = Mock(), Mock()
            with patch('live_mpc.import_tiago', return_value=tiago) as imported, \
                 patch.object(script.importlib, 'import_module', return_value=mpc), \
                 patch.dict(sys.modules, {'server': SimpleNamespace(canonical_model_assets=assets, RobotKinematics=kinematics)}), \
                 patch.dict(os.environ):
                loaded = script.load_source(selection)
                self.assertEqual(loaded[:2], (tiago, mpc))
                self.assertIs(loaded[3], friction)
                imported.assert_called_once_with(root)
                assets.assert_called_once_with(root)
                kinematics.assert_called_once_with(root/'full.urdf', {}, end_effector_frame='grasp', reduced_urdf=root/'reduced.urdf')
                self.assertEqual(os.environ['GATO_CACHE_DIR'], str(root/'cache'))
                del mpc.Mpc.request
                with self.assertRaisesRegex(ValueError, 'lacks Mpc.request or Mpc.result'):
                    script.load_source(selection)
                mpc.Mpc.request = 4
                mpc.SimPlant.start = lambda self: None
                with self.assertRaisesRegex(ValueError, 'SimPlant.start\\(clock\\)'):
                    script.load_source(selection)
                mpc.SimPlant.start = lambda self, clock: None
                del mpc.VirtualClock
                with self.assertRaisesRegex(ValueError, 'tiago_mpc.clock.VirtualClock'):
                    script.load_source(selection)
                mpc.VirtualClock = object
                del mpc.State
                with self.assertRaisesRegex(ValueError, 'tiago_mpc.interfaces.State and Plan'):
                    script.load_source(selection)
                mpc.State = State
                del mpc.from_dict
                with self.assertRaisesRegex(ValueError, 'record.to_dict, from_dict and provenance'):
                    script.load_source(selection)
                mpc.from_dict = lambda value: value
                assets.side_effect = ValueError('canonical mesh is missing')
                with self.assertRaisesRegex(ValueError, 'canonical mesh is missing'):
                    script.load_source(selection)
                mpc.SimPlant = lambda *, friction=None: None  # old constructor, without SimConfig
                with self.assertRaisesRegex(ValueError, 'SimConfig.*build.*SimPlant'):
                    script.load_source(selection)
                del mpc.Mpc.warmup  # tiago_mpc before 31c405a
                with self.assertRaisesRegex(ValueError, 'lacks Mpc.warmup'):
                    script.load_source(selection)
                del mpc.compile_binary
                with self.assertRaisesRegex(ValueError, 'lacks compile_binary'):
                    script.load_source(selection)

    def test_shared_loop_probe_rejects_missing_native_hooks_and_payloads(self):
        script = load_script('source_probe_shared_loop_test')
        loops = SimpleNamespace(run_virtual_time=run_virtual_time, VirtualTimeSettings=VirtualTimeSettings)
        interfaces = SimpleNamespace(SolveCompleted=SolveCompleted, Tick=Tick, Diagnostic=Diagnostic)
        laws = SimpleNamespace(EffortClip=lambda: None, ExecutionSafety=ExecutionSafety)
        script.require_shared_loop(loops, interfaces, laws)
        with self.assertRaisesRegex(ValueError, 'shared run_virtual_time API'):
            script.require_shared_loop(SimpleNamespace(run_virtual_time=lambda: None), interfaces, laws)
        def old_run(*, message_callbacks=(), before_tick=None, quiesce_at=None, cancelled=None,
                    max_plan_age_s=None, start_time_s=0, effort_handling=None):
            pass
        with self.assertRaisesRegex(ValueError, 'settings, duration'):
            script.require_shared_loop(SimpleNamespace(run_virtual_time=old_run), interfaces, laws)
        def message_run(*, settings, duration, compensation=None, safety=None, effort_handling=None,
                        message_callbacks=(), before_tick=None, quiesce_at=None,
                        cancelled=None, start_time_s=0, initial_command=None):
            pass
        with self.assertRaisesRegex(ValueError, 'tick, solve-completed and diagnostic callbacks'):
            script.require_shared_loop(SimpleNamespace(run_virtual_time=message_run), interfaces, laws)
        def optional_duration(*, settings, duration=None, compensation=None, safety=None, effort_handling=None,
                              tick_callbacks=(), solve_completed_callbacks=(), diagnostic_callbacks=(),
                              before_tick_callbacks=(), cancelled=None, start_time_s=0, initial_command=None):
            pass
        with self.assertRaisesRegex(ValueError, 'required finite duration'):
            script.require_shared_loop(SimpleNamespace(run_virtual_time=optional_duration), interfaces, laws)
        with self.assertRaisesRegex(ValueError, 'loops.VirtualTimeSettings'):
            script.require_shared_loop(SimpleNamespace(run_virtual_time=run_virtual_time), interfaces, laws)
        @dataclass(frozen=True)
        class MissingLatency:
            command_period: float = .002
            update_period: float = .01
        with self.assertRaisesRegex(ValueError, 'and solve latency'):
            script.require_shared_loop(SimpleNamespace(run_virtual_time=run_virtual_time,
                                                       VirtualTimeSettings=MissingLatency), interfaces, laws)
        def combined_run(*, settings, duration, message_callbacks=(), before_tick=None, quiesce_at=None,
                         cancelled=None, start_time_s=0, initial_command=None):
            pass
        with self.assertRaisesRegex(ValueError, 'compensation, safety, effort handling'):
            script.require_shared_loop(SimpleNamespace(run_virtual_time=combined_run), interfaces, laws)
        for safety in (None, SimpleNamespace(max_plan_age_s=.1),
                       dataclass(type('MissingValidate', (), {'__annotations__': {'max_plan_age_s': float}})),
                       dataclass(type('MissingAge', (), {'validate': lambda self, plan, t, state: None})),
                       dataclass(type('OldValidate', (), {'__annotations__': {'max_plan_age_s': float},
                                                         'validate': lambda self, plan: None}))):
            with self.subTest(safety=safety), self.assertRaisesRegex(ValueError, 'laws.ExecutionSafety'):
                script.require_shared_loop(loops, interfaces,
                                           SimpleNamespace(ExecutionSafety=safety, EffortClip=lambda: None))
        with self.assertRaisesRegex(ValueError, 'interfaces.SolveCompleted'):
            script.require_shared_loop(loops, SimpleNamespace(), laws)
        with self.assertRaisesRegex(ValueError, 'interfaces.Tick'):
            script.require_shared_loop(loops, SimpleNamespace(SolveCompleted=SolveCompleted), laws)
        with self.assertRaisesRegex(ValueError, 'interfaces.Diagnostic'):
            script.require_shared_loop(loops, SimpleNamespace(SolveCompleted=SolveCompleted, Tick=Tick), laws)
        with self.assertRaisesRegex(ValueError, 'laws.EffortClip'):
            script.require_shared_loop(loops, interfaces, SimpleNamespace(ExecutionSafety=ExecutionSafety))


if __name__ == "__main__":
    unittest.main()
