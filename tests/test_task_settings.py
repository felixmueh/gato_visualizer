"""Layered defaults and checked, selective cross-task settings copies."""
from copy import deepcopy
import unittest

from native_cost import serialized_cost
from task_settings import (compatible_overrides, install_task_defaults, merge_settings,
                           resolve_task_settings, settings_diff, task_defaults,
                           transfer_differences, transfer_settings)


# A task with its own default overrides (a descriptor's settings_overrides), as a
# tracking task may declare; reach keeps the general defaults.
TRACKING_OVERRIDES = dict(config=dict(cost_weights=dict(position=500., terminal_position=1000.),
                                      solver=dict(max_sqp_iters=1)),
                          execution=dict(to_hz=500.))


def schema_fixture():
    weights = dict(position=4., terminal_position=8., velocity=.05, torque=.0001,
                   orientation=0., terminal_orientation=0.)
    return dict(defaults=dict(
        config=dict(type="MpcParams", N=32, cost_weights=weights, cost=serialized_cost(32, weights),
                    solver=dict(type="SolverSettings", max_sqp_iters=5, max_pcg_iters=120),
                    plant=dict(start_pose_rad=[0.] * 7), max_sqp_time_s=None),
        task=dict(kind="reach", target_offset_m=[.15, .2, .2]),
        execution=dict(to_hz=100., control_hz=500., calculation="manual", latency_compensation=True),
        source_settings=dict(simulation=dict(law="both"), predictor={})),
        tasks=[dict(kind="reach", defaults=dict(kind="reach", target_offset_m=[0., 0., 0.])),
               dict(kind="figure8", defaults=dict(kind="figure8", target_offset_m=[0., 0., 0.])),
               dict(kind="tracking", defaults=dict(kind="tracking", target_offset_m=[0., 0., 0.]),
                    settings_overrides=deepcopy(TRACKING_OVERRIDES))])


class TaskDefaultsTests(unittest.TestCase):
    def test_task_overrides_change_only_requested_general_settings(self):
        schema = schema_fixture()
        original = deepcopy(schema)
        actual = task_defaults(schema, "tracking")
        self.assertEqual(actual["config"]["cost_weights"]["position"], 500.)
        self.assertEqual(actual["config"]["cost_weights"]["terminal_position"], 1000.)
        self.assertEqual(actual["execution"]["to_hz"], 500.)
        self.assertEqual(actual["config"]["solver"]["max_sqp_iters"], 1)
        self.assertEqual(actual["config"]["cost_weights"]["torque"], .0001)
        self.assertEqual(actual["config"]["cost"], schema["defaults"]["config"]["cost"])
        for kind in ("reach", "figure8"):
            self.assertEqual(task_defaults(schema, kind)["execution"]["to_hz"], 100.)
            self.assertEqual(task_defaults(schema, kind)["config"]["solver"]["max_sqp_iters"], 5)
        for kind in ("reach", "figure8", "tracking"):
            self.assertEqual(task_defaults(schema, kind)["source_settings"]["simulation"]["law"], "both")
            self.assertTrue(task_defaults(schema, kind)["execution"]["latency_compensation"])
        self.assertEqual(schema, original)
        actual["config"]["solver"]["max_sqp_iters"] = 99
        self.assertEqual(schema, original)

    def test_install_advertises_effective_defaults_and_their_overrides(self):
        schema = schema_fixture()
        general = deepcopy(schema["defaults"])
        install_task_defaults(schema)
        self.assertEqual(schema["defaults"], general)
        self.assertEqual(schema["task_defaults"]["tracking"]["execution"]["to_hz"], 500.)
        self.assertEqual(schema["task_default_overrides"]["tracking"]["config"]["cost_weights"],
                         dict(position=500., terminal_position=1000.))
        self.assertEqual(schema["task_default_overrides"]["figure8"],
                         dict(task=dict(kind="figure8", target_offset_m=[0., 0., 0.])))
        with self.assertRaisesRegex(ValueError, "Unknown task"):
            task_defaults(schema, "unknown")

    def test_custom_source_objectives_keep_their_own_terms(self):
        schema = schema_fixture()
        del schema["defaults"]["config"]["cost_weights"]
        cost = schema["defaults"]["config"]["cost"]
        cost["frame_pos"]["activation"] = "pseudo_huber"
        cost["frame_pos"]["eps"] = .01
        actual = task_defaults(schema, "tracking")
        self.assertEqual(actual["config"]["cost"], cost)
        self.assertNotIn("cost_weights", actual["config"])
        self.assertEqual(actual["config"]["solver"]["max_sqp_iters"], 1)
        self.assertEqual(actual["execution"]["to_hz"], 500.)

    def test_session_override_reset_returns_to_task_default(self):
        base = task_defaults(schema_fixture(), "tracking")
        edited = merge_settings(base, dict(config=dict(cost_weights=dict(position=750.))))
        overrides = settings_diff(base, edited)
        self.assertEqual(overrides, dict(config=dict(cost_weights=dict(position=750.))))
        self.assertEqual(merge_settings(base, overrides), edited)
        self.assertEqual(settings_diff(base, base), {})
        self.assertEqual(base["config"]["cost_weights"]["position"], 500.)

    def test_explicit_law_and_solver_edits_remain_session_values_until_reset(self):
        for kind in ("reach", "figure8", "tracking"):
            with self.subTest(kind=kind):
                base = task_defaults(schema_fixture(), kind)
                edited = merge_settings(base, dict(config=dict(solver=dict(max_sqp_iters=7)),
                    source_settings=dict(simulation=dict(law="default"))))
                self.assertEqual(resolve_task_settings(base, settings_diff(base, edited)), edited)
                self.assertEqual(base["source_settings"]["simulation"]["law"], "both")
                self.assertEqual(base["config"]["solver"]["max_sqp_iters"], 1 if kind == "tracking" else 5)

    def test_null_and_whole_vectors_roundtrip_as_session_overrides(self):
        base = task_defaults(schema_fixture(), "reach")
        base["config"]["max_sqp_time_s"] = .01
        edited = merge_settings(base, dict(config=dict(max_sqp_time_s=None,
                                                       plant=dict(start_pose_rad=[.1] * 7))))
        self.assertEqual(merge_settings(base, settings_diff(base, edited)), edited)

    def test_source_rebase_drops_removed_fields_without_rewriting_native_objectives(self):
        base = task_defaults(schema_fixture(), "reach")
        custom = deepcopy(base["config"]["cost"])
        custom["frame_pos"]["activation"] = "pseudo_huber"
        overrides = dict(config=dict(removed=123, solver=dict(max_sqp_iters=-1, removed=456), cost=custom))
        retained = compatible_overrides(base, overrides)
        self.assertEqual(retained["config"], dict(solver=dict(max_sqp_iters=-1), cost=custom))
        # The normal validator must reject invalid retained values, rather than silently reset them.
        self.assertEqual(retained["config"]["solver"]["max_sqp_iters"], -1)


class TransferTests(unittest.TestCase):
    def setUp(self):
        schema = schema_fixture()
        self.source = task_defaults(schema, "tracking")
        self.current = task_defaults(schema, "reach")
        self.source["config"]["solver"].update(max_sqp_iters=1, max_pcg_iters=400)
        self.source["config"]["plant"]["start_pose_rad"] = [.1] * 7
        self.source["task"]["only_in_source"] = 123

    def test_tree_excludes_metadata_derived_menu_and_unavailable_task_fields(self):
        paths = {row["path"] for row in transfer_differences(self.source, self.current)}
        self.assertIn("config.cost_weights.position", paths)
        self.assertIn("config.plant.start_pose_rad", paths)
        self.assertIn("execution.to_hz", paths)
        self.assertNotIn("task.kind", paths)
        self.assertNotIn("task.only_in_source", paths)
        self.assertFalse(any(path.startswith("config.cost.") or path.endswith(".type") for path in paths))

    def test_selected_leaf_and_branch_leave_everything_else_and_source_unchanged(self):
        before = deepcopy(self.source)
        result = transfer_settings(self.source, self.current, ["config.solver", "execution.to_hz"])
        self.assertEqual(result["config"]["solver"], self.source["config"]["solver"])
        self.assertEqual(result["execution"]["to_hz"], 500.)
        self.assertEqual(result["config"]["cost_weights"], self.current["config"]["cost_weights"])
        self.assertEqual(result["config"]["plant"], self.current["config"]["plant"])
        self.assertEqual(result["task"], self.current["task"])
        self.assertEqual(self.source, before)

    def test_arrays_are_single_settings_and_overlapping_branches_are_idempotent(self):
        result = transfer_settings(self.source, self.current,
                                   ["config", "config.plant.start_pose_rad", "config.solver"])
        self.assertEqual(result["config"]["plant"]["start_pose_rad"], [.1] * 7)
        self.assertEqual(result["config"]["cost_weights"]["position"], 500.)
        self.assertEqual(result["execution"], self.current["execution"])
        result["config"]["plant"]["start_pose_rad"][0] = 99
        self.assertEqual(self.source["config"]["plant"]["start_pose_rad"][0], .1)

    def test_invalid_selection_cannot_mutate_destination(self):
        before = deepcopy(self.current)
        for paths in ([], [""], ["task.kind"], ["config.type"], ["task.only_in_source"],
                      ["config.solver.max_sqp_iters", "config.missing"], [".config"], [1]):
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                transfer_settings(self.source, self.current, paths)
            self.assertEqual(self.current, before)

    def test_custom_menu_is_one_indivisible_difference(self):
        del self.source["config"]["cost_weights"]
        self.source["config"]["cost"]["frame_pos"]["activation"] = "pseudo_huber"
        rows = transfer_differences(self.source, self.current)
        self.assertIn("config.cost", {row["path"] for row in rows})
        result = transfer_settings(self.source, self.current, ["config.cost"])
        self.assertEqual(result["config"]["cost"], self.source["config"]["cost"])
        self.assertNotIn("cost_weights", result["config"])

    def test_custom_objective_session_replay_cannot_resurrect_default_controls_or_terms(self):
        del self.source["config"]["cost_weights"]
        self.source["config"]["cost"]["frame_pos"]["activation"] = "pseudo_huber"
        copied = transfer_settings(self.source, self.current, ["config.cost"])
        overrides = settings_diff(self.current, copied)
        self.assertEqual(overrides["config"]["cost"], self.source["config"]["cost"])
        replayed = resolve_task_settings(self.current, overrides)
        self.assertEqual(replayed, copied)
        changed_defaults = deepcopy(self.current)
        changed_defaults["config"]["cost"]["new_native_term"] = {"weight": 123.}
        replayed = resolve_task_settings(changed_defaults, overrides)
        self.assertNotIn("cost_weights", replayed["config"])
        self.assertEqual(replayed["config"]["cost"], copied["config"]["cost"])


if __name__ == "__main__":
    unittest.main()
