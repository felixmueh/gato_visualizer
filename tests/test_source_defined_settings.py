"""CPU coverage of worktree-only model/law settings and exact native build requests."""
from copy import deepcopy
from dataclasses import replace
import importlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from execution_bridge import ProcessLiveService
from live_mpc import build_schema, validate_settings, mpc_params
from source_runtime import PROBE_SCRIPT, resolve_selection
from tests.test_execution import FakeAdapter, FakeRenderer, fake_schema, fake_worker
from tests.tiago_mpc_source import MPC_ROOT, live_probe, start_pose
from worktree_settings import describe_settings, resolve_predictor, resolve_simulation
from native_cost import with_knot_count


def exact_fake_schema(root):
    schema = fake_schema(root)
    schema["exact_availability"] = True
    return schema


def armature_fake_schema(root):
    schema = fake_schema(root)
    schema["defaults"]["config"]["armature"] = deepcopy(live_probe()["defaults"]["armature"])
    schema["parameters"].append(dict(path="armature", kind="vector", length=7, min=0., max=1e5))
    return schema


class SourceDefinedTests(unittest.TestCase):
    def test_uncompiled_draft_does_not_replace_accepted_values_or_availability(self):
        live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter, schema_factory=exact_fake_schema,
                                  worker_target=fake_worker, render_factory=FakeRenderer)
        try:
            before = live.settings_snapshot()
            requested = deepcopy(before["source_settings"])
            if requested["predictor"]:
                requested["predictor"]["armature_on"] = False
            unavailable = dict(compatible=True, available_N=[], available_N_by_friction=dict(off=[], on=[]),
                               exact_availability=True, effective_settings=dict(params=deepcopy(before["config"])))
            # Predictor friction is a compiled variant: the draft needs a native lookup.
            friction = next(spec for spec in live.schema["parameters"] if spec["path"] == "friction")["choices"][1]["value"]
            with patch("source_runtime.probe_selection", return_value=unavailable) as probe:
                with self.assertRaisesRegex(ValueError, "Not compiled.*requested predictor"):
                    live.command(dict(type="patch_settings", patch=dict(source_settings=requested,
                                                                         config=dict(friction=friction))))
            self.assertEqual(live.settings_snapshot(), before)
            self.assertEqual(probe.call_args.kwargs["source_settings"], requested["predictor"])
            self.assertIn("source_settings_module", probe.call_args.kwargs)
        finally:
            live.close()

    def test_runtime_only_edits_reuse_the_accepted_model_without_a_lookup(self):
        live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter, schema_factory=exact_fake_schema,
                                  worker_target=fake_worker, render_factory=FakeRenderer)
        try:
            before = live.settings_snapshot()
            with patch("source_runtime.probe_selection") as probe:
                live.command(dict(type="patch_settings", patch=dict(config=dict(cost_weights=dict(position=5.)))))
                probe.assert_not_called()
            self.assertEqual(live.settings_snapshot()["config"]["cost_weights"]["position"], 5.)
            self.assertEqual(live.settings_snapshot()["available_N"], before["available_N"])
        finally:
            live.close()

    def test_matching_draft_build_refreshes_only_the_still_accepted_model(self):
        live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter, schema_factory=exact_fake_schema,
                                  worker_target=fake_worker, render_factory=FakeRenderer)
        try:
            before = live.settings_snapshot()
            # The completed draft build has a different model/list; it must not
            # become accepted model state until the user draft is submitted.
            built = live_probe()
            built.update(available_N=[32], available_N_by_friction=dict(off=[32], on=[]), exact_availability=True)
            accepted = dict(built, available_N=[16], available_N_by_friction=dict(off=[16], on=[]))
            with patch("source_runtime.probe_selection", return_value=accepted) as probe:
                self.assertTrue(live.refresh_compiled(live.active_profile, built))
            after = live.settings_snapshot()
            self.assertEqual(after["source_settings"], before["source_settings"])
            self.assertEqual(after["effective_settings"], before["effective_settings"])
            self.assertEqual(after["available_N"], [16])
            self.assertEqual(probe.call_args.kwargs["source_settings"], before["source_settings"]["predictor"])
        finally:
            live.close()

    def test_exact_build_refresh_does_not_relabel_legacy_accepted_model(self):
        live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter, schema_factory=fake_schema,
                                  worker_target=fake_worker, render_factory=FakeRenderer)
        try:
            live.schema["exact_availability"] = False
            before = live.settings_snapshot()
            built = live_probe()
            built.update(available_N=[32], available_N_by_friction=dict(off=[32], on=[]), exact_availability=True)
            accepted = dict(built, available_N=[16], available_N_by_friction=dict(off=[16], on=[]))
            with patch("source_runtime.probe_selection", return_value=accepted) as probe:
                self.assertTrue(live.refresh_compiled(live.active_profile, built))
            self.assertEqual(live.settings_snapshot()["available_N"], [16])
            self.assertEqual(probe.call_args.kwargs["params"], mpc_params(before["config"]))
        finally:
            live.close()

    def test_native_armature_model_is_checked_exactly_without_provider_flag(self):
        if "armature" not in live_probe()["defaults"]:
            self.skipTest("Selected native MpcParams has no armature field")
        live = ProcessLiveService(MPC_ROOT, adapter_factory=FakeAdapter, schema_factory=armature_fake_schema,
                                  worker_target=fake_worker, render_factory=FakeRenderer)
        try:
            live.schema["exact_availability"] = False
            before = live.settings_snapshot()
            unavailable = dict(compatible=True, available_N=[], available_N_by_friction=dict(off=[], on=[]),
                               exact_availability=True, effective_settings=dict(params=deepcopy(before["config"])))
            with patch("source_runtime.probe_selection", return_value=unavailable) as probe:
                with self.assertRaisesRegex(ValueError, "Not compiled.*requested predictor"):
                    live.command(dict(type="patch_settings", patch=dict(config=dict(armature=[.1]*7))))
            self.assertEqual(live.settings_snapshot(), before)
            self.assertEqual(probe.call_args.kwargs["params"]["armature"], [.1]*7)
        finally:
            live.close()


class BundledAdapterTests(unittest.TestCase):
    def setUp(self):
        live_probe()
        self.tm = importlib.import_module("tiago_mpc")
        self.mpc = importlib.import_module("tiago_mpc.mpc")
        parent = Path(__file__).resolve().parents[1]/"_expr_data/adapter-ownership-20261027"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.selection = dict(mpc_root=self.temporary.name)
        spec = importlib.util.spec_from_file_location("bundled_source_probe_test", PROBE_SCRIPT)
        self.script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.script)

    def test_bundled_identity_preserves_explicit_legacy_friction_build(self):
        friction = self.tm.urdf_friction()
        events = []
        with patch.object(self.mpc, "compile_binary", return_value=Path("mock.so")) as compile_native, \
                patch.object(self.script, "probe", return_value={}):
            self.script.build(self.selection, (None, self.mpc, None, friction), [16], events.append,
                              prediction_friction=True)
        self.assertEqual(compile_native.call_args.args[0], replace(with_knot_count(self.mpc.TIAGO, 16), friction=friction))
        self.assertFalse(events[0]["exact_availability"])

    def test_explicit_bundled_values_and_pin_remain_exact_in_probe(self):
        description = describe_settings(self.selection["mpc_root"])
        with patch.object(self.mpc, "find_binary", return_value=None) as find, \
                patch.object(self.script, "KNOT_COUNTS", (16,)), \
                patch.object(self.script, "source_identity", return_value={}), \
                patch("solver_process.model_contract", return_value={}):
            result = self.script.probe(self.selection, importlib.import_module("tiago_mpc.tiago"),
                                       self.mpc, None, self.tm.urdf_friction(),
                                       source_settings={}, source_settings_module=description["module"])
        self.assertTrue(result["exact_availability"])
        self.assertEqual(find.call_count, 1)
        self.assertEqual(find.call_args.args[0], with_knot_count(self.mpc.TIAGO, 16))

    def test_custom_native_menu_only_checks_its_horizon_and_build_preserves_it(self):
        tm = self.tm
        from gato.cost_menu import Term
        custom = replace(tm.TIAGO, cost=replace(tm.TIAGO.cost, input=Term(.01, target=(.1,)*7)))
        with patch.object(self.mpc, "find_binary", return_value=Path("mock.so")) as find:
            self.assertIsNone(self.script.find_variant(self.mpc, custom, 16))
            find.assert_not_called()
            self.assertEqual(self.script.find_variant(self.mpc, custom, 32), Path("mock.so"))
            self.assertIs(find.call_args.args[0], custom)
        with patch.object(self.mpc, "compile_binary", return_value=Path("mock.so")) as compile_native, \
                patch.object(self.script, "probe", return_value={}):
            self.script.build(self.selection, (None, self.mpc, None, None), [32], lambda _: None,
                              params=tm.to_dict(custom))
            self.assertEqual(tm.to_dict(compile_native.call_args.args[0]), tm.to_dict(custom))
        with patch.object(self.mpc, "compile_binary") as compile_native, \
                self.assertRaisesRegex(ValueError, "custom CostMenu.*explicit menu"):
            self.script.build(self.selection, (None, self.mpc, None, None), [16], lambda _: None,
                              params=tm.to_dict(custom))
            compile_native.assert_not_called()

    def test_edited_custom_horizon_is_rejected_before_lookup_or_compile(self):
        tm = self.tm
        custom = replace(tm.TIAGO, N=16, cost=replace(tm.TIAGO.cost,
                         frame_pos=replace(tm.TIAGO.cost.frame_pos, activation="pseudo_huber", eps=.1)))
        # Changing params.N directly must not make the old menu claim its new N.
        with patch.object(self.mpc, "find_binary") as find, \
                patch.object(self.mpc, "compile_binary") as compile_native:
            for operation in ("model", "build"):
                with self.subTest(operation=operation), \
                        self.assertRaisesRegex(ValueError, "Invalid native CostMenu for N=16.*frame_pos.weight"):
                    if operation == "model":
                        self.script.model(self.selection, None, self.mpc, None, None, params=tm.to_dict(custom))
                    else:
                        self.script.build(self.selection, (None, self.mpc, None, None), [16], lambda _: None,
                                          params=tm.to_dict(custom))
            find.assert_not_called()
            compile_native.assert_not_called()

    def test_explicit_bundled_pin_is_checked_before_build(self):
        description = describe_settings(self.selection["mpc_root"])
        wrong = dict(description["module"], sha256="0"*64)
        with patch.object(self.mpc, "compile_binary") as compile_native, self.assertRaisesRegex(ValueError, "changed; Apply"):
            self.script.build(self.selection, (None, self.mpc, None, None), [16], lambda _: None,
                              source_settings={}, source_settings_module=wrong)
        compile_native.assert_not_called()

    def test_supported_knot_choices_are_independent_of_compiled_availability(self):
        probe = live_probe()
        probe.update(supported_N=[8,16,24,32], available_N=[32],
                     available_N_by_friction=dict(off=[32],on=[]), exact_availability=True)
        schema = build_schema(probe, MPC_ROOT, start_pose())
        spec = next(p for p in schema['parameters'] if p['path']=='N')
        self.assertEqual(spec['choices'], [8,16,24,32])
        self.assertEqual(spec['effect'], 'compiled_model')
        config = deepcopy(schema['defaults']['config']); config['N'] = 24
        task = schema['defaults']['task']
        validate_settings(config, task, schema, check_available=False)
        with self.assertRaisesRegex(ValueError, 'Not compiled'):
            validate_settings(config, task, schema)
        config['N'] = 21
        with self.assertRaisesRegex(ValueError, 'Invalid N'):
            validate_settings(config, task, schema, check_available=False)


class NativeProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        live_probe()  # import the selected native package before the source module
        cls.description = describe_settings(MPC_ROOT)
        if "armature_on" not in cls.description["predictor"]["defaults"]:
            raise unittest.SkipTest("Selected checkout does not select the experimental friction adapter")
        cls.tm = importlib.import_module("tiago_mpc")

    def test_native_objects_and_laws_match_both_independent_role_values(self):
        tm = self.tm
        predictor_values = deepcopy(self.description["predictor"]["defaults"])
        predictor_values.update(armature_on=False, friction_on=True, friction_width_rad_s=.217)
        params, captured = resolve_predictor(MPC_ROOT, predictor_values, tm.TIAGO, tm.to_dict)
        self.assertEqual(params.armature, (0.,)*7)
        self.assertEqual(params.friction_law.width_rad_s, .217)
        self.assertEqual(params.solver, tm.TIAGO.solver)
        simulation_values = deepcopy(self.description["simulation"]["defaults"])
        simulation_values["law"] = "both"
        base = tm.SimConfig(friction=tm.urdf_friction(), integrator="euler")
        plant, law, captured_sim = resolve_simulation(MPC_ROOT, simulation_values, base, tm.SampleKnot(), tm.to_dict)
        supplied = tm.ARMATURE_KG_M2
        self.assertEqual(plant.armature, supplied)
        self.assertIsInstance(plant.friction_law, tm.StickSlip)
        prior = importlib.import_module("experiments.controller_tuning").TUNED_FEEDFORWARD.friction
        self.assertEqual(plant.friction.coulomb_nm, prior.coulomb_nm)
        self.assertIsInstance(law, tm.FrictionFeedforward)
        self.assertIsInstance(law.base_law, tm.PlanFeedback)
        self.assertEqual(tm.from_dict(captured_sim["effective"]["law"]), law)

    def test_owned_native_controls_are_read_only_actual_model_paths(self):
        probe = live_probe()
        probe.update(available_N=[32], available_N_by_friction=dict(off=[32], on=[]), exact_availability=True)
        schema = build_schema(probe, MPC_ROOT, start_pose())
        specs = {item["path"]: item for item in schema["parameters"]}
        for path in ("armature", "friction", "friction_law"):
            self.assertTrue(specs[path]["controlled_by_source"])
            self.assertEqual(specs[path]["effective_path"], "params."+path)
        self.assertNotIn("controlled_by_source", specs["plant.friction"])
        self.assertNotIn("controlled_by_source", specs["plant.coulomb_law"])

    def script(self):
        spec = importlib.util.spec_from_file_location("source_probe_exact_test", PROBE_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_build_uses_frozen_exact_native_params_and_source_values(self):
        tm, script = self.tm, self.script()
        mpc = importlib.import_module("tiago_mpc.mpc")
        values = deepcopy(self.description["predictor"]["defaults"])
        values.update(armature_on=False, friction_on=True, friction_width_rad_s=.217)
        base = replace(tm.TIAGO, dt_s=.03, solver=replace(tm.TIAGO.solver, mu=1.),
                       cost=tm.default_cost(tm.TIAGO.N, velocity=.01))
        expected, _ = resolve_predictor(MPC_ROOT, values, base, tm.to_dict)
        selection = resolve_selection(MPC_ROOT)
        with patch.object(mpc, "compile_binary", return_value=Path("mock.so")) as compile_native, \
                patch.object(script, "probe", return_value=dict(compatible=True, available_N=[32,64])):
            script.build(selection, (None, mpc, None, None), [32,64], lambda event: None,
                         params=tm.to_dict(base), source_settings=values,
                         source_settings_module=self.description["module"])
        self.assertEqual([call.args[0] for call in compile_native.call_args_list],
                         [with_knot_count(expected, 32), with_knot_count(expected, 64)])

    def test_build_rejects_unapplied_provider_before_compilation(self):
        tm, script = self.tm, self.script()
        mpc = importlib.import_module("tiago_mpc.mpc")
        wrong = dict(self.description["module"], sha256="0"*64)
        with patch.object(mpc, "compile_binary") as compile_native, self.assertRaisesRegex(ValueError, "changed; Apply"):
            script.build(resolve_selection(MPC_ROOT), (None,mpc,None,None), [32], lambda event: None,
                         params=tm.to_dict(tm.TIAGO), source_settings=self.description["predictor"]["defaults"],
                         source_settings_module=wrong)
        compile_native.assert_not_called()

    def test_captured_native_model_bypasses_current_provider_defaults(self):
        tm, script = self.tm, self.script()
        mpc = importlib.import_module("tiago_mpc.mpc")
        captured = replace(tm.TIAGO, armature=(0.,)*7, friction=tm.urdf_friction(), friction_law=tm.Tanh(.217))
        with patch("worktree_settings.describe_settings", side_effect=RuntimeError("broken new provider")) as describe:
            params, resolution, description = script.requested_params(resolve_selection(MPC_ROOT), mpc,
                                                                      params=tm.to_dict(captured))
        describe.assert_not_called()
        self.assertIsNone(description["module"])
        self.assertEqual(description["predictor"]["parameters"], [])
        self.assertEqual(params, captured)
        self.assertIsNone(resolution["values"])
        self.assertIsNone(resolution["module"])


if __name__ == "__main__":
    unittest.main()
