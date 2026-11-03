"""CPU model-status checks: native resolution and lookup, never compile or load a solver."""
from copy import deepcopy
from dataclasses import fields, replace
import importlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from live_mpc import import_tiago
from scripts import source_probe as script
import source_runtime
from tests.tiago_mpc_source import MPC_ROOT
from worktree_settings import describe_settings, resolve_predictor


class ModelStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import_tiago(MPC_ROOT)
        cls.mpc = importlib.import_module("tiago_mpc.mpc")
        cls.record = importlib.import_module("tiago_mpc.record")
        if not all(hasattr(cls.mpc, name) for name in ("MpcParams", "find_binary", "compile_binary")):
            raise unittest.SkipTest("Selected native source lacks the explicit binary API")
        cls.description = describe_settings(MPC_ROOT)

    def setUp(self):
        self.selection = dict(mpc_root=str(MPC_ROOT), python=sys.executable, cache=None)
        self.params = replace(self.mpc.TIAGO, N=32, max_sqp_time_s=None)
        # Guard both compilation entry points, solver construction and native
        # capture discovery; only the public native find_binary may be queried.
        gato = importlib.import_module("gato")
        for owner, name in ((self.mpc, "compile_binary"), (self.mpc, "Mpc"),
                            (gato, "register_robot"), (gato, "BSQP"), (script, "module_captures")):
            guard = patch.object(owner, name, side_effect=AssertionError(f"Unexpected {name}"))
            guard.start(); self.addCleanup(guard.stop)
        cache = patch("tiago_mpc.util.cache_root", return_value=Path("/model-status/cache"))
        cache.start(); self.addCleanup(cache.stop)

    def status(self, params=None, **kwargs):
        return script.model(self.selection, None, self.mpc, None, None,
                            params=self.record.to_dict(params or self.params), **kwargs)

    def test_uncompiled_draft_is_valid_and_keeps_requested_n(self):
        with patch.object(self.mpc, "find_binary", return_value=None) as find:
            result = self.status()
        self.assertTrue(result["compatible"])
        self.assertTrue(result["exact_availability"])
        self.assertEqual(result["available_N"], [])
        self.assertEqual(result["available_N_by_friction"], dict(off=[], on=[]))
        self.assertEqual(result["compilation"], dict(ready=False, N=32,
            supported_N=list(source_runtime.KNOT_COUNTS), available_N=[], binary_path=None))
        self.assertEqual(result["effective_settings"]["params"]["N"], 32)
        self.assertEqual(result["selection"]["effective_cache"], "/model-status/cache")
        self.assertEqual([call.args[0].N for call in find.call_args_list], list(source_runtime.KNOT_COUNTS))

    def test_exact_lookup_reports_current_mode_catalog_and_selected_binary(self):
        path = Path("/native-cache/existing.so")
        for friction in (None, importlib.import_module("tiago_mpc.tiago").urdf_friction()):
            with self.subTest(friction=friction):
                params = replace(self.params, friction=friction,
                                 friction_law=importlib.import_module("tiago_mpc.dynamics").Tanh(.217))
                with patch.object(self.mpc, "find_binary", side_effect=lambda p: path if p.N in (16,32) else None):
                    result = self.status(params)
                mode = "off" if friction is None else "on"
                self.assertEqual(result["available_N_by_friction"][mode], [16,32])
                self.assertEqual(result["available_N_by_friction"]["on" if mode == "off" else "off"], [])
                self.assertEqual(result["compilation"]["binary_path"], str(path))
                self.assertTrue(result["compilation"]["ready"])

    def test_source_values_are_resolved_before_all_native_lookups(self):
        native_fields = {field.name for field in fields(self.mpc.MpcParams)}
        specs = {spec["path"] for spec in self.description["predictor"]["parameters"]}
        if "armature" not in native_fields or not {"armature_on", "friction_on", "friction_width_rad_s"} <= specs:
            self.skipTest("Selected adapter lacks the armature/friction predictor controls")
        values = deepcopy(self.description["predictor"]["defaults"])
        values.update(armature_on=True, friction_on=True, friction_width_rad_s=.217)
        expected, _ = resolve_predictor(MPC_ROOT, values, self.params, self.record.to_dict,
                                        expected_module=self.description["module"])
        with patch.object(self.mpc, "find_binary", return_value=None) as find:
            result = self.status(source_settings=values, source_settings_module=self.description["module"])
        self.assertEqual(result["effective_settings"]["params"], self.record.to_dict(expected))
        self.assertEqual([call.args[0] for call in find.call_args_list],
                         [replace(expected,N=n) for n in source_runtime.KNOT_COUNTS])
        self.assertEqual(result["source_settings"]["predictor"]["module"], self.description["module"])
        self.assertEqual(result["effective_settings"]["modules"]["predictor"], self.description["module"])

    def test_runtime_params_reuse_the_native_path_without_a_visualizer_field_rule(self):
        modified = replace(self.params, dt_s=.03, solver=self.params.solver.replace(q_cost=27.))
        with patch.object(self.mpc, "find_binary", side_effect=lambda p: Path("/native/same.so") if p.N == 32 else None) as find:
            first, second = self.status(), self.status(modified)
        self.assertTrue(first["compilation"]["ready"] and second["compilation"]["ready"])
        self.assertEqual(first["compilation"]["binary_path"], second["compilation"]["binary_path"])
        self.assertNotEqual(first["effective_settings"]["params"], second["effective_settings"]["params"])
        self.assertEqual(find.call_args_list[-1].args[0].dt_s, .03)
        self.assertEqual(find.call_args_list[-1].args[0].solver.q_cost, 27.)

    def test_wrong_adapter_pin_is_rejected_before_lookup(self):
        wrong = dict(self.description["module"], sha256="0"*64)
        values = deepcopy(self.description["predictor"]["defaults"])
        with patch.object(self.mpc, "find_binary") as find, self.assertRaisesRegex(ValueError,"changed; Apply"):
            self.status(source_settings=values, source_settings_module=wrong)
        find.assert_not_called()

    def test_unsupported_n_is_rejected_before_lookup(self):
        with patch.object(self.mpc, "find_binary") as find, self.assertRaisesRegex(ValueError,"Requested N"):
            self.status(replace(self.params,N=3))
        find.assert_not_called()

    def test_captured_params_bypass_current_adapter(self):
        with patch("worktree_settings.describe_settings", side_effect=AssertionError("Current adapter imported")), \
                patch.object(self.mpc, "find_binary", return_value=None):
            result = self.status()
        self.assertIsNone(result["effective_settings"]["modules"]["predictor"])
        self.assertIsNone(result["source_settings"]["predictor"]["module"])


class ModelOperationTests(unittest.TestCase):
    def test_runtime_model_operation_forwards_draft_pin_to_selected_interpreter(self):
        selected = dict(mpc_root="/selected", python="/selected/.venv/bin/python", cache=None)
        params, values, pin = dict(type="MpcParams",N=32), {}, dict(path="/adapter.py",sha256="pin")
        response = dict(compatible=True,compilation=dict(ready=False))
        with patch.object(source_runtime,"resolve_selection",return_value=selected), \
                patch.object(source_runtime.subprocess,"run",return_value=subprocess.CompletedProcess([],0,json.dumps(response),"")) as run:
            result = source_runtime.probe_selection(selected,operation="model",params=params,
                source_settings=values,source_settings_module=pin)
        command = run.call_args.args[0]
        self.assertEqual(command[:3],[selected["python"],str(source_runtime.PROBE_SCRIPT),"model"])
        self.assertEqual(json.loads(command[command.index("--params-json")+1]),params)
        self.assertEqual(json.loads(command[command.index("--source-settings-json")+1]),values)
        self.assertEqual(json.loads(command[command.index("--source-settings-module-json")+1]),pin)
        self.assertEqual(result,response)

    def test_cli_model_uses_lookup_operation_and_plain_json_response(self):
        selection = dict(mpc_root="/selected",python=sys.executable,cache=None)
        expected = dict(compatible=True,compilation=dict(ready=False,N=32))
        stdout = io.StringIO()
        with patch.object(script,"resolve_selection",return_value=selection), \
                patch.object(script,"load_source",return_value=(None,None,None,None)), \
                patch.object(script,"model",return_value=expected) as model, \
                patch.object(script,"probe",side_effect=AssertionError("Capture-discovery probe used")), \
                patch.object(script,"build",side_effect=AssertionError("Compilation used")), \
                patch("sys.stdout",stdout):
            code = script.main(["model","--mpc-root","/selected","--params-json",'{"N":32}',
                                "--source-settings-json","{}","--source-settings-module-json","null"])
        self.assertEqual(code,0)
        self.assertEqual(json.loads(stdout.getvalue()),expected)
        self.assertEqual(model.call_args.kwargs,dict(params=dict(N=32),source_settings={},source_settings_module=None))


if __name__ == "__main__":
    unittest.main()
