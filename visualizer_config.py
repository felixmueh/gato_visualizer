"""Small, local server configuration, separate from the live MPC settings."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "visualizer.json"
DEFAULT_INGEST_DIRECTORY = ROOT.parent / "_expr_data/ingest"


@dataclass(frozen=True)
class VisualizerConfig:
    path: Path
    ingest_directory: Path


def load_visualizer_config(path=DEFAULT_CONFIG):
    """Resolve configured directory paths against the JSON file's directory.

    Loading the config does not create directories. The server's replay catalog
    scans the selected directory recursively whenever the browser polls it.
    An omitted field retains the shared workspace ingest default.
    """
    selected = Path(path).expanduser().resolve()
    try:
        settings = json.loads(selected.read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot read visualizer config {selected}: {exc}") from exc
    if not isinstance(settings, dict):
        raise ValueError("Visualizer config must be a JSON object")
    unknown = set(settings) - {"ingest_directory"}
    if unknown:
        raise ValueError(f"Unknown visualizer config fields: {sorted(unknown)}")
    value = settings.get("ingest_directory", str(DEFAULT_INGEST_DIRECTORY))
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError("ingest_directory must be a nonempty path string")
    directory = Path(value).expanduser()
    if not directory.is_absolute():
        directory = selected.parent / directory
    return VisualizerConfig(path=selected, ingest_directory=directory.resolve())
