"""CPU-only checks of Live's collision rows: the standard adapter's collision
descriptors, the shapes descriptor kind, the solver's environment-only update, the captured limit rows with
an appended collision group, runtime-only model reuse and freezes of collision runs.

The selected tiago_mpc (TIAGO_MPC_ROOT) must have tiago_mpc.collision.
No cover is fitted and no module is loaded.
"""
from copy import deepcopy
from dataclasses import replace
import importlib
import json
import unittest
from types import SimpleNamespace

from inspection_problem import COLLISION_KIND, capture_constraint_bounds
from live_freeze import freeze_arguments
from live_mpc import body_joints, import_tiago, model_inputs, parameter_specs
from tests.tiago_mpc_source import MPC_ROOT
from worktree_settings import validate_description, validate_values

OBSTACLES = [[.342, -.42, -.484, .05], [.362, -.36, -.324, .05]]


def spheres_description(**changes):
    spec = dict(dict(path="obstacles", label="Obstacles", kind="shapes", shape="sphere", bound=2., min_size=.005,
                     max_size=.5, max_count=3, effect="runtime"), **changes)
    return validate_description(dict(predictor=dict(defaults=dict(obstacles=[]), parameters=[spec],
                                                    controls=["collision"])))


class SpheresKindTests(unittest.TestCase):
    def test_sphere_lists_validate_count_bounds_and_radii(self):
        description = spheres_description()
        self.assertEqual(validate_values(description, "predictor", dict(obstacles=OBSTACLES))["obstacles"], OBSTACLES)
        validate_values(description, "predictor", dict(obstacles=[]))
        for bad in ([[.1, .2, .3]], [[.1, .2, .3, 0.]], [[.1, .2, .3, .6]], [[3., 0, 0, .1]],
                    [[.1, .2, .3, float("nan")]], [[.1, .2, .3, True]], [OBSTACLES[0]] * 4, [.1, .2, .3, .05], None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                validate_values(description, "predictor", dict(obstacles=bad))

    def test_capsule_box_and_plane_layouts(self):
        for shape, good, bad in (
                ("capsule", [.1, .2, .3, .4, .5, .6, .05], ([.1, .2, .3, .4, .5, .6, 0.], [.1, .2, .3, .4, 5., .6, .05])),
                ("box", [.1, .2, .3, 0., 0., 0., 1., .1, .2, .3], ([.1, .2, .3, 0., 0., 0., 0., .1, .2, .3],
                                                                   [.1, .2, .3, 0., 0., 0., 1., .1, .2, .6])),
                ("plane", [0., 0., 1., -.6], ([0., 0., 0., -.6], [0., 0., 1., 3.]))):
            description = spheres_description(shape=shape)
            self.assertEqual(validate_values(description, "predictor", dict(obstacles=[good]))["obstacles"], [good])
            for value in bad:
                with self.assertRaises(ValueError, msg=f"{shape} {value}"):
                    validate_values(description, "predictor", dict(obstacles=[value]))

    def test_descriptor_rejects_invalid_sphere_bounds(self):
        for changes in (dict(max_count=0), dict(bound=-1.), dict(min_size=float("inf")), dict(max_count=1.5),
                        dict(shape="cone")):
            with self.assertRaises(ValueError, msg=repr(changes)):
                spheres_description(**changes)


class ModelInputTests(unittest.TestCase):
    def test_runtime_fields_never_change_the_model_inputs(self):
        schema = dict(parameters=[dict(path="N", effect="compiled_model"), dict(path="solver.q_cost", effect="runtime"),
                                  dict(path="plant.friction", effect="runtime")],
                      source_settings=dict(predictor=dict(parameters=[
                          dict(path="enabled", effect="compiled_model"), dict(path="obstacles", effect="runtime"),
                          dict(path="margin_m")])))
        config = dict(N=32, solver=dict(q_cost=4.), plant=dict(friction=True))
        values = dict(enabled=True, obstacles=OBSTACLES, margin_m=.005)
        base = model_inputs(config, values, schema)
        moved = model_inputs(dict(config, solver=dict(q_cost=8.), plant=dict(friction=False)),
                             dict(values, obstacles=[]), schema)
        self.assertEqual(base, moved)
        self.assertNotEqual(base, model_inputs(dict(config, N=48), values, schema))
        self.assertNotEqual(base, model_inputs(config, dict(values, enabled=False), schema))
        # Unannotated adapter fields stay conservative.
        self.assertNotEqual(base, model_inputs(config, dict(values, margin_m=.01), schema))


class CapturedRowsTests(unittest.TestCase):
    @staticmethod
    def group(kind, rows=7):
        return dict(kind=kind, block=0, mech=2, n_rows=rows, knot_lo=1, knot_hi=32, lo=[-1.] * rows, hi=[1.] * rows,
                    active=[127] * 32)

    def test_limit_rows_are_captured_beside_an_appended_collision_group(self):
        groups = [self.group(0), self.group(1), self.group(2), self.group(COLLISION_KIND, 38)]
        captured = capture_constraint_bounds(SimpleNamespace(get_row_groups=lambda: groups))
        self.assertEqual([group["kind"] for group in captured], [0, 1, 2])
        for groups in ([self.group(0), self.group(1)], [self.group(0), self.group(1), self.group(2), self.group(3, 3)]):
            with self.assertRaises(ValueError):
                capture_constraint_bounds(SimpleNamespace(get_row_groups=lambda: groups))


class FreezeTests(unittest.TestCase):
    def test_a_collision_segment_freezes_its_obstacles_and_covers_in_the_root_frame(self):
        arm = {"arm_right_2_link": [[0., 0., .1, .05]]}
        context = dict(settings=dict(task=dict(kind="reach")), source={}, simulator_identity={}, solver_profile={}, model_identity={},
                       position_tol_m=.05, speed_l1_tol_rad_s=1., problem_configuration=dict(N=3),
                       end_effector_frame="arm_right_grasp_joint", joint_limits={},
                       collision=dict(arm=arm, body=[[0., 0., -.5, .15]], obstacles=OBSTACLES))
        records = [dict(type="segment", generation=1, sim_time_s=0., context=context)] + [
            dict(type="state", generation=1, sim_time_s=t, q=[0.] * 7, qd=[0.] * 7, torque_nm=None,
                 target_xyz=[.3, -.2, .5]) for t in (0., .01)]
        arguments = freeze_arguments(records, generation=1, complete=False, fixed_joints=dict(torso_lift_joint=.0995),
                                     world_frame="base_footprint", label="Freeze")
        self.assertEqual(arguments["obstacles"], OBSTACLES)
        self.assertEqual(arguments["collision_spheres"], dict(environment=[[0., 0., -.5, .15], *OBSTACLES], arm=arm))
        self.assertNotIn("body_capsules", arguments)  # only non-empty lists
        context["collision"].update(body_capsules=[[0., 0., -.6, 0., .1, -.6, .05]], body_boxes=[])
        arguments = freeze_arguments(records, generation=1, complete=False, fixed_joints={}, world_frame="base_footprint",
                                     label="Freeze")
        self.assertEqual(arguments["body_capsules"], [[0., 0., -.6, 0., .1, -.6, .05]])
        self.assertNotIn("body_boxes", arguments)
        context["collision"].pop("body_capsules")
        context["collision"].update(capsules=[[0., 0., 0., 0., .2, 0., .05]], boxes=[], planes=[[0., 0., 1., -.6]])
        arguments = freeze_arguments(records, generation=1, complete=False, fixed_joints={}, world_frame="base_footprint",
                                     label="Freeze")
        self.assertEqual((arguments["obstacle_capsules"], arguments["obstacle_planes"]),
                         ([[0., 0., 0., 0., .2, 0., .05]], [[0., 0., 1., -.6]]))
        self.assertNotIn("obstacle_boxes", arguments)  # as tiago_mpc's exporter: only non-empty lists
        context["collision"] = None  # rows off
        self.assertNotIn("obstacles", freeze_arguments(records, generation=1, complete=False, fixed_joints={},
                                                       world_frame="base_footprint", label="Freeze"))


class CollisionSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import_tiago(MPC_ROOT)
        cls.collision = importlib.import_module("tiago_mpc.collision")
        cls.tm = importlib.import_module("tiago_mpc")
        cls.adapter = importlib.import_module("adapters.tiago")
        cls.worker = importlib.import_module("solver_worker")

    def test_descriptors_validate_and_defaults_are_the_native_collision_defaults(self):
        description = self.adapter.describe()
        json.dumps(description, allow_nan=False)
        checked = validate_description(description)
        native = self.collision.Collision()
        self.assertIsNone(self.tm.TIAGO.collision)  # the native default: no rows
        defaults = {key: value for key, value in checked["predictor"]["defaults"].items()
                    if key not in ("armature_on", "friction_on", "friction_width_rad_s")}
        self.assertEqual(defaults, dict(enabled=False, mechanism=native.mechanism, arm="exact",
                                                                body="balanced", margin_m=native.margin_m, obstacles=[],
                                                                capsules=[], boxes=[], planes=[]))
        self.assertEqual(checked["predictor"]["controls"], ["armature", "friction", "friction_law", "collision"])
        effects = {spec["path"]: spec["effect"] for spec in checked["predictor"]["parameters"]
                   if spec["path"] not in ("armature_on", "friction_on", "friction_width_rad_s")}
        self.assertEqual(effects, dict(enabled="compiled_model", mechanism="runtime", arm="compiled_model", body="runtime",
                                       margin_m="runtime", obstacles="runtime", capsules="runtime", boxes="runtime",
                                       planes="runtime"))
        choices = {spec["path"]: [choice["value"] for choice in spec["choices"]]
                   for spec in checked["predictor"]["parameters"] if spec["path"] in ("arm", "body")}
        self.assertEqual(choices, dict(arm=["exact"], body=["balanced", "tighter", None]))  # the stored covers
        shapes = {spec["path"]: spec["shape"] for spec in checked["predictor"]["parameters"] if spec["kind"] == "shapes"}
        self.assertEqual(shapes, dict(obstacles="sphere", capsules="capsule", boxes="box", planes="plane"))

    def test_values_build_the_native_collision_rows_and_off_is_no_rows(self):
        tm = self.tm
        values = dict(armature_on=True, friction_on=False, friction_width_rad_s=tm.TIAGO.friction_law.width_rad_s,
                      enabled=True, mechanism="telemetry", arm="exact", body=None, margin_m=.01, obstacles=OBSTACLES,
                      capsules=[[.3, -.5, -.2, .3, -.3, -.2, .04]], boxes=[[.3, -.4, -.2, 0., 0., 0., 1., .05, .1, .15]],
                      planes=[[0., 0., 2., -1.2]])
        params = self.adapter.build_predictor(values, tm.TIAGO)
        self.assertEqual(params.collision, self.collision.Collision(
            body=None, margin_m=.01, mechanism="telemetry", obstacles=tuple(map(tuple, OBSTACLES)),
            capsules=((.3, -.5, -.2, .3, -.3, -.2, .04),), boxes=((.3, -.4, -.2, 0., 0., 0., 1., .05, .1, .15),),
            planes=((0., 0., 2., -1.2),)))
        self.assertEqual(params.collision.planes, ((0., 0., 1., -.6),))  # tiago_mpc makes the normal unit
        self.assertEqual(replace(params, collision=None), tm.TIAGO)
        self.assertIsNone(self.adapter.build_predictor(dict(values, enabled=False), params).collision)
        self.assertEqual(self.adapter.build_predictor(dict(values, body="tighter"), params).collision.body, "tighter")
        for bad in (dict(body="missing"), dict(arm="greedy")):
            with self.assertRaises(ValueError):
                self.adapter.build_predictor(dict(values, **bad), params)

    def test_only_obstacles_and_body_are_an_environment_update(self):
        tm, Collision = self.tm, self.collision.Collision
        params = replace(tm.TIAGO, collision=Collision(obstacles=tuple(map(tuple, OBSTACLES))))
        update = self.worker.environment_only
        self.assertTrue(update(params, replace(params, collision=replace(params.collision, obstacles=()))))
        self.assertTrue(update(params, replace(params, collision=replace(params.collision, body=None))))
        for name, value in (("capsules", ((0., 0., 0., 0., .2, 0., .05),)), ("boxes", ((0., 0., 0., 0., 0., 0., 1., .1, .1, .1),)),
                            ("planes", ((0., 0., 1., -.6),))):
            self.assertTrue(update(params, replace(params, collision=replace(params.collision, **{name: value}))), name)
        arguments = self.worker.environment_arguments(replace(params.collision, body=None, planes=((0., 0., 1., -.6),)))
        self.assertEqual(set(arguments), {"spheres", "capsules", "cuboids", "planes"})
        self.assertEqual(arguments["planes"], ((0., 0., 1., -.6),))
        for changed in (replace(params, collision=replace(params.collision, margin_m=.02)),
                        replace(params, collision=replace(params.collision, mechanism="telemetry")),
                        replace(params, collision=None), replace(params, N=48),
                        replace(params, solver=replace(params.solver, max_sqp_iters=2))):
            self.assertFalse(update(params, changed))
        self.assertFalse(update(replace(params, collision=None), params))

    def test_live_body_is_the_rows_body_posture(self):
        self.assertEqual(body_joints(MPC_ROOT), self.collision.body_posture())

    def test_native_collision_field_is_one_fixed_choice_owned_by_the_adapter(self):
        config = dict(N=32, collision=None, friction=None)
        spec = next(spec for spec in parameter_specs(config, [32], {}, dict(lower=[], upper=[]))
                    if spec["path"] == "collision")
        self.assertEqual((spec["kind"], spec["choices"], spec["disabled"], spec["group"]),
                         ("choice", [dict(value=None, label="Off")], True, "Collision rows"))



class RecordedShapesTests(unittest.TestCase):
    def test_replays_validate_and_place_capsules_boxes_and_planes_in_the_world(self):
        import numpy as np
        import pinocchio as pin
        from replay_format import ReplayError, _collision
        from server import obstacles_in_world
        metadata = dict(obstacles=[[0., 0., 0., .1]], obstacle_capsules=[[0., 0., 0., 0., .2, 0., .05]],
                        obstacle_boxes=[[0., 0., 0., 0., 0., 0., 1., .1, .2, .3]], obstacle_planes=[[0., 0., 2., -1.2]])
        _collision(metadata, None)
        for name, value in (("obstacle_capsules", [[0., 0., 0., 0., .2, 0., 0.]]), ("obstacle_boxes", [[0.] * 10]),
                            ("obstacle_planes", [[0., 0., 0., 1.]]), ("obstacle_planes", [[0., 0., 1.]])):
            with self.assertRaises(ReplayError, msg=name):
                _collision({name: value}, None)
        turn = pin.SE3(pin.utils.rotate("z", np.pi / 2), np.array([.1, 0., .9]))
        self.assertTrue(np.allclose(obstacles_in_world("obstacle_capsules", metadata["obstacle_capsules"], turn),
                                    [[.1, 0., .9, -.1, 0., .9, .05]]))
        box = obstacles_in_world("obstacle_boxes", metadata["obstacle_boxes"], turn)[0]
        self.assertTrue(np.allclose(box[3:7], [0., 0., np.sin(np.pi / 4), np.cos(np.pi / 4)]) and np.allclose(box[7:], [.1, .2, .3]))
        self.assertTrue(np.allclose(obstacles_in_world("obstacle_planes", metadata["obstacle_planes"], turn), [[0., 0., 1., .3]]))


if __name__ == "__main__":
    unittest.main()
