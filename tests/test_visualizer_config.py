"""Configuration path semantics, without imports of MPC or robot libraries."""
import json
from pathlib import Path
import tempfile
import unittest

from visualizer_config import DEFAULT_INGEST_DIRECTORY, load_visualizer_config


class VisualizerConfigTests(unittest.TestCase):
    def test_repository_default_is_shared_ingest(self):
        config = load_visualizer_config()
        self.assertEqual(config.ingest_directory, DEFAULT_INGEST_DIRECTORY)

    def test_relative_paths_follow_config_file_and_absolute_paths_stay_absolute(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "viewer.json"
            path.write_text(json.dumps(dict(ingest_directory="incoming/recordings")))
            self.assertEqual(load_visualizer_config(path).ingest_directory,
                             Path(folder) / "incoming/recordings")
            absolute = Path(folder) / "other"
            path.write_text(json.dumps(dict(ingest_directory=str(absolute))))
            self.assertEqual(load_visualizer_config(path).ingest_directory, absolute)
            path.write_text("{}")
            self.assertEqual(load_visualizer_config(path).ingest_directory,
                             DEFAULT_INGEST_DIRECTORY)

    def test_malformed_or_unknown_settings_fail_with_context(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "viewer.json"
            for value in ([], dict(unrecognized=True), dict(ingest_directory=""),
                          dict(ingest_directory=123)):
                path.write_text(json.dumps(value))
                with self.subTest(value=value), self.assertRaises(ValueError):
                    load_visualizer_config(path)
            path.write_text("invalid JSON")
            with self.assertRaisesRegex(ValueError, "Cannot read visualizer config"):
                load_visualizer_config(path)


if __name__ == "__main__":
    unittest.main()
