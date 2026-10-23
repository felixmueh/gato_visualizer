"""`<checkout>` path templates in saved visualizer config and solver profiles."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

from solver_profiles import SolverProfiles, validate_profile
from tests.test_source_runtime import checkout
from visualizer_config import load_visualizer_config


class PathTemplateConfigTests(unittest.TestCase):
    def make_checkout(self, folder):
        root = Path(folder).resolve() / "mpc"
        checkout(root)
        (root / "tools/bin").mkdir(parents=True)
        (root / "tools/bin/python").symlink_to(sys.executable)
        return root

    def test_config_keeps_templates_verbatim_but_absolutizes_relative_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "viewer.json"
            profile = dict(id="p", name="P", mpc_root="mpc", python="<checkout>/tools/bin/python", cache="cache")
            path.write_text(json.dumps(dict(source=dict(mpc_root="mpc", python="<checkout>/x", cache="rel"),
                                            solver_profiles=[profile])))
            config = load_visualizer_config(path)
            self.assertEqual(config.source["python"], "<checkout>/x")
            self.assertEqual(config.source["cache"], str(Path(folder) / "rel"))
            self.assertEqual(config.source["mpc_root"], str(Path(folder) / "mpc"))
            self.assertEqual(config.solver_profiles[0]["python"], "<checkout>/tools/bin/python")
            self.assertEqual(config.solver_profiles[0]["cache"], str(Path(folder) / "cache"))

    def test_profile_resolves_templates_and_saves_them_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.make_checkout(folder)
            validated = validate_profile(dict(id="p", name="P", mpc_root=str(root), python="<checkout>/tools/bin/python"))
            self.assertEqual(validated["python"], str(root / "tools/bin/python"))
            self.assertEqual(validated["templates"]["python"], "<checkout>/tools/bin/python")
            self.assertIsNone(validated["templates"]["cache"])  # no override: tiago_mpc's default
            with self.assertRaisesRegex(ValueError, "Unknown token <venv>"):
                validate_profile(dict(id="p", name="P", mpc_root=str(root), python="<venv>/bin/python"))

            config = Path(folder) / "viewer.json"
            config.write_text("{}")
            live = SimpleNamespace(condition=_Condition(), profile_switch=dict(state="idle"),
                                   active_profile_id="simulator", generation=0)
            simulator = {key: value for key, value in validated.items() if key not in ('id', 'name')}
            profiles = SolverProfiles(live, simulator, config)
            profiles.save(dict(profile=dict(id="p", name="P", mpc_root=str(root), python="<checkout>/tools/bin/python")))
            stored = json.loads(config.read_text())["solver_profiles"]
            # Only the non-default template is stored; the default cache keeps following the checkout.
            self.assertEqual(stored, [dict(id="p", name="P", mpc_root=str(root), python="<checkout>/tools/bin/python")])
            reloaded = SolverProfiles(live, simulator, config, profiles=load_visualizer_config(config).solver_profiles)
            self.assertEqual(reloaded.profiles["p"], profiles.profiles["p"])
            self.assertEqual(reloaded.status()["profiles"][1]["templates"]["python"], "<checkout>/tools/bin/python")


class _Condition:
    def __enter__(self): return self
    def __exit__(self, *exc): return False


if __name__ == "__main__":
    unittest.main()
