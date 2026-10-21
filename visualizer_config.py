"""Small, local server configuration, separate from the live MPC settings."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "visualizer.json"
DEFAULT_INGEST_DIRECTORY = ROOT.parent / "_expr_data/ingest"


@dataclass(frozen=True)
class VisualizerConfig:
    path: Path
    ingest_directory: Path
    source: dict | None = None


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
    unknown = set(settings) - {"ingest_directory", "source"}
    if unknown:
        raise ValueError(f"Unknown visualizer config fields: {sorted(unknown)}")
    value = settings.get("ingest_directory", str(DEFAULT_INGEST_DIRECTORY))
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError("ingest_directory must be a nonempty path string")
    directory = Path(value).expanduser()
    if not directory.is_absolute():
        directory = selected.parent / directory
    source = settings.get("source")
    if source is not None:
        if not isinstance(source, dict) or set(source) - {"mpc_root", "python", "cache"}:
            raise ValueError("source must contain mpc_root and optional python/cache paths")
        source = dict(source)
        for key in ("mpc_root", "python", "cache"):
            value = source.get(key)
            if value is None and key != "mpc_root":
                continue
            if not isinstance(value, str) or not value.strip() or "\x00" in value:
                raise ValueError(f"source.{key} must be a nonempty path string")
            source_path = Path(value).expanduser()
            if not source_path.is_absolute():
                source_path = selected.parent / source_path
            source[key] = str(source_path.absolute())
    return VisualizerConfig(path=selected, ingest_directory=directory.resolve(), source=source)


def save_source_selection(path, source):
    """Atomically retain other local settings while changing the source."""
    selected = Path(path).expanduser().resolve()
    settings = json.loads(selected.read_text())
    settings["source"] = source
    temporary = selected.with_name(selected.name + ".tmp")
    try:
        temporary.write_text(json.dumps(settings, indent=2) + "\n")
        os.replace(temporary, selected)
    finally:
        temporary.unlink(missing_ok=True)


def effective_source_selection(config, mpc_root=None, environment=None):
    """CLI > source environment > saved selection > neighboring checkout."""
    from source_runtime import resolve_selection
    environment = os.environ if environment is None else environment
    saved = config.source or {}
    root = mpc_root or environment.get("TIAGO_MPC_ROOT") or saved.get("mpc_root") or ROOT.parent / "tiago_mpc"
    override = mpc_root is not None or bool(environment.get("TIAGO_MPC_ROOT"))
    return resolve_selection(root,
        python=environment.get("TIAGO_PYTHON") or (None if override else saved.get("python")),
        cache=environment.get("GATO_CACHE_DIR") or (None if override else saved.get("cache")))
