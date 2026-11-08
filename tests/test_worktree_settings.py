"""CPU checks for descriptor/builder ownership; the bundled adapter's descriptors need
the selected tiago_mpc (its collision covers)."""
from dataclasses import dataclass, fields, is_dataclass
import hashlib
from pathlib import Path
import tempfile
import unittest

from worktree_settings import (BUNDLED_ADAPTER, default_values, describe_settings, has_predictor_settings,
                               resolve_predictor, resolve_simulation,
                               validate_description, validate_values)

HERE = Path(__file__).resolve().parents[1]/"_expr_data/source-settings-20261027"


def serialized(value):
    if is_dataclass(value):
        return {"type": type(value).__name__, **{f.name: serialized(getattr(value, f.name)) for f in fields(value)}}
    if isinstance(value, dict):
        return {key: serialized(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [serialized(item) for item in value]
    return value


@dataclass(frozen=True)
class Params:
    armature: tuple = (0., 0.)
    cost: float = 4.
    collision: object = None


@dataclass(frozen=True)
class Friction:
    coulomb_nm: tuple = (1., 2.)
    width: float = .03


@dataclass(frozen=True)
class SimConfig:
    q: tuple = (1., 2.)
    qd: tuple = (0., 0.)
    substep: float = .001
    armature: tuple = (0., 0.)
    friction: Friction = Friction()


@dataclass(frozen=True)
class DefaultLaw:
    def __call__(self, plan, t, state):
        return (0., 0.)


DESCRIPTION = dict(predictor=dict(
    controls=["armature"], defaults=dict(on=True, armature=[.5, .7]), parameters=[
        dict(path="on", kind="bool", label="Armature"),
        dict(path="armature", kind="vector", length=2, min=0., unit="kg m²", enabled_if={"on": True}),
    ]))


class WorktreeSettingsTests(unittest.TestCase):
    def setUp(self):
        HERE.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=HERE)
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def provider(self, code):
        folder = self.root/"_visualizer"
        folder.mkdir(exist_ok=True)
        path = folder/"_settings.py"
        path.write_text(code)
        return path

    def test_absent_module_keeps_native_objects_and_ordinary_law(self):
        from tests.tiago_mpc_source import live_probe
        live_probe()  # the bundled adapter reads the selected tiago_mpc's stored covers
        description = describe_settings(self.root)
        self.assertEqual(description["module"], dict(path=str(BUNDLED_ADAPTER),
                         sha256=hashlib.sha256(BUNDLED_ADAPTER.read_bytes()).hexdigest(), origin="bundled"))
        # The standard adapter owns only the collision rows, off by default (MpcParams' default).
        self.assertTrue(has_predictor_settings(description))
        self.assertEqual(description["predictor"]["controls"], ["collision"])
        params = Params()
        values = default_values(description)["predictor"]
        actual, captured = resolve_predictor(self.root, values, params, serialized, expected_module=description["module"])
        self.assertEqual(actual, params)
        base, law = SimConfig(), DefaultLaw()
        actual, actual_law, captured = resolve_simulation(self.root, {}, base, law, serialized)
        self.assertIs(actual, base)
        self.assertIs(actual_law, law)
        self.assertEqual(captured["effective"]["plant"], serialized(base))

    def test_local_override_wins_over_bundled_and_uses_its_own_identity(self):
        path = self.provider("def describe(): return {}\n")
        self.assertEqual(describe_settings(self.root)["module"], dict(
            path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(), origin="worktree"))

    def test_symlink_pins_the_actual_visualizer_file_not_just_the_link(self):
        target = self.root / "adapter.py"
        target.write_text("def describe(): return {}\n")
        folder = self.root / "_visualizer"
        folder.mkdir()
        (folder / "_settings.py").symlink_to("../adapter.py")
        description = describe_settings(self.root)
        self.assertEqual(description["module"]["path"], str(target))
        self.assertEqual(description["module"]["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        target.write_text("def describe(): raise RuntimeError('not applied')\n")
        self.assertEqual(describe_settings(self.root), description)

    def test_broken_or_invalid_local_override_is_reported_without_fallback(self):
        folder = self.root / "_visualizer"
        folder.mkdir()
        link = folder / "_settings.py"
        link.symlink_to("missing.py")
        with self.assertRaisesRegex(ValueError, "not a readable file"):
            describe_settings(self.root)
        link.unlink()
        link.write_text("raise RuntimeError('bad local adapter')\n")
        with self.assertRaisesRegex(RuntimeError, "bad local adapter"):
            describe_settings(self.root)

    def test_predictor_toggle_is_explicit_and_cannot_modify_cost(self):
        self.provider("from dataclasses import replace\n"
                      f"def describe(): return {DESCRIPTION!r}\n"
                      "def build_predictor(v,b): return replace(b,armature=tuple(v['armature']) if v['on'] else (0.,0.))\n")
        description = describe_settings(self.root)
        actual, captured = resolve_predictor(self.root, dict(on=True, armature=[.5,.7]), Params(), serialized,
                                             expected_module=description["module"])
        self.assertEqual(actual.armature, (.5,.7))
        self.assertEqual(actual.cost, 4.)
        self.assertEqual(captured["module"], description["module"])
        off, _ = resolve_predictor(self.root, dict(on=False, armature=[.5,.7]), Params(), serialized)
        self.assertEqual(off.armature, (0.,0.))
        with self.assertRaisesRegex(ValueError, "changed; Apply"):
            resolve_predictor(self.root, dict(on=True, armature=[.5,.7]), Params(), serialized, expected_module=None)

    def test_unclaimed_native_change_fails(self):
        self.provider("from dataclasses import replace\n"
                      f"def describe(): return {DESCRIPTION!r}\n"
                      "def build_predictor(v,b): return replace(b,cost=99.)\n")
        with self.assertRaisesRegex(ValueError, "unclaimed native field cost"):
            resolve_predictor(self.root, dict(on=True, armature=[.5,.7]), Params(), serialized)

    def test_partial_friction_claim_preserves_law_and_captures_custom_law(self):
        description = dict(simulation=dict(controls=["friction.coulomb_nm", "law"],
                                           defaults=dict(c=[2.,3.]),
                                           parameters=[dict(path="c", kind="vector", length=2, min=0.)]))
        self.provider("from dataclasses import dataclass,replace\n"
                      "@dataclass(frozen=True)\nclass Feedback:\n"
                      "    gain:float=3.\n    def __call__(self,p,t,s): return p\n"
                      f"def describe(): return {description!r}\n"
                      "def build_simulation(v,b): return replace(b,friction=replace(b.friction,coulomb_nm=tuple(v['c']))),Feedback()\n")
        actual, law, captured = resolve_simulation(self.root, dict(c=[2.,3.]), SimConfig(), DefaultLaw(), serialized)
        self.assertEqual(actual.friction.coulomb_nm, (2.,3.))
        self.assertEqual(actual.friction.width, .03)
        self.assertEqual(captured["effective"]["law"], dict(type="Feedback", gain=3.))

    def test_runtime_state_is_protected_even_if_claimed(self):
        self.provider("from dataclasses import replace\n"
                      "def describe(): return {'simulation':{'controls':['q'],'defaults':{},'parameters':[]}}\n"
                      "def build_simulation(v,b): return replace(b,q=(9.,9.)),lambda p,t,s:p\n")
        with self.assertRaisesRegex(ValueError, "runtime q"):
            resolve_simulation(self.root, {}, SimConfig(), DefaultLaw(), serialized)

    def test_inactive_vector_is_still_finite_and_complete(self):
        description = validate_description(DESCRIPTION)
        for bad in (dict(on=False, armature=[True,.7]), dict(on=False, armature=[float('nan'),.7]),
                    dict(on=False, armature=[.7]), dict(on=False, armature=[-.1,.7]), dict(on=False)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_values(description, "predictor", bad)

    def test_description_rejects_invalid_visibility_and_duplicate_paths(self):
        for parameters in ([dict(path="x", kind="bool", visible_if={"unknown": True})],
                           [dict(path="x", kind="bool"), dict(path="x", kind="bool")]):
            with self.subTest(parameters=parameters), self.assertRaises(ValueError):
                validate_description(dict(predictor=dict(defaults=dict(x=True), parameters=parameters, controls=[])))

    def test_choice_can_hold_a_whole_serialized_native_object(self):
        value = dict(type="Tanh", width_rad_s=.2)
        description = validate_description(dict(predictor=dict(defaults=dict(loss=value), controls=[], parameters=[
            dict(path="loss", kind="choice", choices=[None, dict(value=value, label="Tanh .2")])])) )
        self.assertEqual(validate_values(description, "predictor", dict(loss=value)), dict(loss=value))
        with self.assertRaises(ValueError):
            validate_values(description, "predictor", dict(loss=dict(type="Tanh", width_rad_s=.03)))

    def test_open_bounds_reject_zero_width_even_when_the_control_is_hidden(self):
        description = validate_description(dict(simulation=dict(controls=[], defaults=dict(mode=False, width=.01),
            parameters=[dict(path="mode", kind="bool"),
                        dict(path="width", kind="float", min=0., min_exclusive=True, visible_if={"mode": True})])))
        self.assertEqual(validate_values(description, "simulation", dict(mode=False, width=.01))["width"], .01)
        with self.assertRaisesRegex(ValueError, "Invalid width"):
            validate_values(description, "simulation", dict(mode=False, width=0.))

    def test_effect_metadata_is_explicit_but_never_the_binary_lookup_authority(self):
        for effect in ("runtime", "compiled_model"):
            description = validate_description(dict(predictor=dict(defaults=dict(on=False), controls=[],
                parameters=[dict(path="on", kind="bool", effect=effect)])))
            self.assertEqual(description['predictor']['parameters'][0]['effect'], effect)
        with self.assertRaisesRegex(ValueError, 'effect must be'):
            validate_description(dict(predictor=dict(defaults=dict(on=False), controls=[],
                parameters=[dict(path="on", kind="bool", effect="always_compile")])))

    def test_same_process_pins_loaded_code_until_source_apply_restarts(self):
        path = self.provider("def describe(): return {}\n")
        before = describe_settings(self.root)
        path.write_text("def describe(): raise RuntimeError('new un-applied source')\n")
        self.assertEqual(describe_settings(self.root), before)

    def test_declared_controls_without_builder_do_not_silently_fallback(self):
        self.provider(f"def describe(): return {DESCRIPTION!r}\n")
        with self.assertRaisesRegex(ValueError, "needs build_predictor"):
            resolve_predictor(self.root, dict(on=True, armature=[.5,.7]), Params(), serialized)


if __name__ == "__main__":
    unittest.main()
