"""Runtime directory location and the RAM warning (Felix, 2026-10-23)."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import runtime_files

ROOT = Path(__file__).resolve().parents[1]


class RuntimeFilesTests(unittest.TestCase):
    def test_default_is_the_system_temp_directory_and_the_variable_overrides_it(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(tempfile, "tempdir", folder), \
                patch.dict(os.environ, {runtime_files.ENVIRONMENT: ""}):
            path = runtime_files.runtime_directory("history")
            self.assertEqual(path, Path(folder) / f"tiago-mpc-visualizer-{os.getuid()}" / "history")
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            override = Path(folder) / "elsewhere"
            with patch.dict(os.environ, {runtime_files.ENVIRONMENT: str(override)}):
                self.assertEqual(runtime_files.runtime_directory(), override)

    def test_warns_when_the_directory_is_not_ram_backed(self):
        parent = ROOT / "_expr_data/tests"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as folder, \
                patch.dict(os.environ, {runtime_files.ENVIRONMENT: folder}), \
                patch.object(Path, "read_text", lambda self, *a, **k: f"disk {folder} ext4 rw 0 0\n"):
            self.assertIn("not on tmpfs", runtime_files.runtime_warning())


if __name__ == "__main__":
    unittest.main()
