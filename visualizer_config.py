"""Small, local server configuration, separate from the live MPC settings."""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path

from source_runtime import has_token
from presentation_settings import DEFAULT_PRESENTATION, migrate_presentation, validate_presentation

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "visualizer.json"
DEFAULT_INGEST_DIRECTORY = ROOT.parent / "_expr_data/ingest"
DEFAULT_MPC_ROOT = ROOT.parent / "tiago_mpc"


@dataclass(frozen=True)
class VisualizerConfig:
    path: Path
    ingest_directory: Path
    source: dict | None = None
    plotters_directory: Path | None = None
    solver_profiles: tuple = ()
    presentation: dict = field(default_factory=lambda: dict(DEFAULT_PRESENTATION))


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
    unknown = set(settings) - {"ingest_directory", "source", "plotters_directory", "solver_profiles", "presentation"}
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
            if key != "mpc_root" and has_token(value):
                continue  # `<checkout>` template: resolved against the selected checkout later.
            source_path = Path(value).expanduser()
            if not source_path.is_absolute():
                source_path = selected.parent / source_path
            source[key] = str(source_path.absolute())
    plotters = settings.get("plotters_directory")
    if plotters is not None:
        if not isinstance(plotters, str) or not plotters.strip() or "\x00" in plotters:
            raise ValueError("plotters_directory must be null or a nonempty path string")
        plotters = Path(plotters).expanduser()
        if not plotters.is_absolute():
            plotters = selected.parent / plotters
        plotters = plotters.resolve()
    profiles = settings.get("solver_profiles", [])
    if not isinstance(profiles, list) or any(not isinstance(item, dict) for item in profiles):
        raise ValueError("solver_profiles must be a list of named profile objects")
    profiles = [dict(profile) for profile in profiles]
    for profile in profiles:
        for key in ("mpc_root", "python", "cache"):
            value = profile.get(key)
            if value is not None:
                if not isinstance(value, str) or not value.strip() or "\x00" in value:
                    raise ValueError(f"solver_profiles.{key} must be a path string")
                if key != "mpc_root" and has_token(value):
                    continue
                location = Path(value).expanduser()
                profile[key] = str(location if location.is_absolute() else selected.parent / location)
    return VisualizerConfig(path=selected, ingest_directory=directory.resolve(), source=source,
                            plotters_directory=plotters, solver_profiles=tuple(profiles),
                            presentation=validate_presentation({**DEFAULT_PRESENTATION, **migrate_presentation(settings.get("presentation", {}))}))


def save_source_selection(path, source):
    """Atomically retain other local settings while changing the source."""
    save_local_settings(path, source=source)


def save_local_settings(path, **updates):
    """Serialize atomic source/plot-setting edits while retaining other fields."""
    import tempfile
    with _SAVE_LOCK:
        selected = Path(path).expanduser().resolve()
        settings = json.loads(selected.read_text())
        if all(key in settings and settings[key] == value for key, value in updates.items()):
            return  # unchanged: no disk write
        settings.update(updates)
        descriptor, name = tempfile.mkstemp(prefix=selected.name + ".", suffix=".tmp", dir=selected.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w") as stream:
                stream.write(json.dumps(settings, indent=2) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, selected)
        finally:
            temporary.unlink(missing_ok=True)


import threading
_SAVE_LOCK = threading.RLock()


def effective_source_selection(config, mpc_root=None, environment=None):
    """CLI > source environment > saved selection > neighboring checkout."""
    from source_runtime import resolve_selection
    environment = os.environ if environment is None else environment
    saved = config.source or {}
    root = mpc_root or environment.get("TIAGO_MPC_ROOT") or saved.get("mpc_root") or DEFAULT_MPC_ROOT
    override = mpc_root is not None or bool(environment.get("TIAGO_MPC_ROOT"))
    return resolve_selection(root,
        python=environment.get("TIAGO_PYTHON") or (None if override else saved.get("python")),
        cache=environment.get("GATO_CACHE_DIR") or (None if override else saved.get("cache")))
