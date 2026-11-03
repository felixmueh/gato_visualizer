"""Source selection, the CPU-only source probe and explicit builds.

The web process uses resolve_selection/probe_selection only. Source imports and
all GATO operations run in the explicitly selected Python subprocess.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
PROBE_SCRIPT = ROOT / "scripts/source_probe.py"


CHECKOUT_TOKEN = "<checkout>"
_TOKEN = re.compile(r"<[^<>]*>")
# Without an explicit override the visualizer chooses no cache: GATO_CACHE_DIR stays
# unset in every process it starts and tiago_mpc's cache_root() decides (the main
# checkout's .cache/gato, also from a worktree; Felix, 2026-10-23).
DEFAULT_CACHE_LABEL = "tiago_mpc's default"
# The knot counts the probe looks up with find_binary and Build accepts.
KNOT_COUNTS = (8, 16, 24, 32, 48, 64, 96, 128)


def in_container():
    return Path('/.dockerenv').is_file() or Path('/run/.containerenv').is_file()


def default_interpreter_template(root):
    """The checkout's uv environment; never fall back to the other platform's venv."""
    return f"{CHECKOUT_TOKEN}/{'.venv-container' if in_container() else '.venv'}/bin/python"


def expand_template(value, root):
    """Substitute `<checkout>` with the checkout root and expand `~`; unknown `<...>` tokens are errors."""
    for token in _TOKEN.findall(value):
        if token != CHECKOUT_TOKEN:
            raise ValueError(f"Unknown token {token} in {value!r}; only {CHECKOUT_TOKEN} is supported")
    expanded = Path(value.replace(CHECKOUT_TOKEN, str(root))).expanduser()
    return Path(os.path.abspath(expanded))


def has_token(value):
    return isinstance(value, str) and _TOKEN.search(value) is not None


def _check_interpreter(path):
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"Selected Python is not executable: {path}")


def _check_cache(path):
    if path.exists() and not path.is_dir():
        raise ValueError(f"GATO cache is not a directory: {path}")


_DEFAULT_CACHES = {}
_DEFAULT_CACHE_CODE = ("import os, sys; sys.path.insert(0, sys.argv[1]); os.environ.pop('GATO_CACHE_DIR', None); "
                       "from tiago_mpc.util import cache_root; print(cache_root())")


def default_cache(mpc_root, python=None):
    """tiago_mpc's own default cache for a checkout: util.cache_root() with GATO_CACHE_DIR
    unset, so its git lookup is not duplicated here. Use the selected environment:
    importing tiago_mpc also loads its Python dependencies. None if unavailable."""
    root = str(Path(mpc_root).expanduser().resolve())
    python = str(python or expand_template(default_interpreter_template(root), root))
    key = (root, python)
    if key not in _DEFAULT_CACHES:
        environment = {key: value for key, value in os.environ.items() if key not in ("GATO_CACHE_DIR", "PYTHONPATH")}
        try:
            result = subprocess.run([python, "-I", "-c", _DEFAULT_CACHE_CODE, root], capture_output=True,
                                    text=True, timeout=30, check=True, env=environment)
        except (OSError, subprocess.SubprocessError):
            return None
        _DEFAULT_CACHES[key] = result.stdout.strip().splitlines()[-1]
    return _DEFAULT_CACHES[key]


def cache_environment(selection, environment=None):
    """Selected environment's packages, without inherited PYTHONPATH or an implicit cache override."""
    environment = dict(os.environ if environment is None else environment)
    environment.pop("PYTHONPATH", None)
    if selection.get("cache"):
        environment["GATO_CACHE_DIR"] = selection["cache"]
    else:
        environment.pop("GATO_CACHE_DIR", None)
    return environment


def checkout_defaults(mpc_root):
    """Default interpreter template and cache of a checkout and their resolution; never raises
    for missing paths. The default cache is tiago_mpc's resolved path (None if unknown)."""
    root = Path(mpc_root).expanduser().resolve()
    python = default_interpreter_template(root)
    cache = default_cache(root, expand_template(python, root))
    return dict(mpc_root=str(root), python=python, cache=cache, cache_label=DEFAULT_CACHE_LABEL,
                resolved=dict(python=str(expand_template(python, root)), cache=cache))


def resolve_templates(mpc_root, python=None, cache=None):
    """Per field the resolved path or the reason it is invalid, for the UI tooltip and mark."""
    root = Path(mpc_root).expanduser().resolve()
    defaults = checkout_defaults(root)
    python = (python or "").strip() or defaults["python"]
    cache = (cache or "").strip() or None
    result = {}
    for key, value, check in (("python", python, _check_interpreter), ("cache", cache, _check_cache)):
        if value is None:  # no cache override: tiago_mpc's default
            result[key] = dict(path=defaults["cache"], default=True) if defaults["cache"] else \
                dict(error=f"{DEFAULT_CACHE_LABEL} is unknown: the checkout has no importable tiago_mpc.util")
            continue
        try:
            path = expand_template(value, root)
            check(path)
            result[key] = dict(path=str(path))
        except ValueError as exc:
            result[key] = dict(error=str(exc))
    return result


def stored_selection(selection):
    """Persisted form: the checkout plus templates that differ from the defaults (defaults keep following it)."""
    root = selection["mpc_root"]
    templates = selection.get("templates", {})
    defaults = dict(python=default_interpreter_template(Path(root).expanduser().resolve()), cache=None)
    return dict(mpc_root=root, **{key: value for key, value in templates.items() if value and value != defaults[key]})


def resolve_selection(mpc_root, python=None, cache=None):
    """Resolved absolute selection plus the `templates` it came from (default interpreter filled in).

    `cache` is the explicit override (absolute) or None, which leaves the choice to
    tiago_mpc; `effective_cache` is the cache in effect either way (None if unknown),
    for display, fingerprints and comparisons."""
    root = Path(mpc_root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Source checkout is not a directory: {root}")
    python = str(python) if python else default_interpreter_template(root)
    templates = dict(python=python, cache=str(cache) if cache else None)
    # Keep the virtualenv executable path: resolving the symlink loses its environment.
    interpreter = expand_template(templates["python"], root)
    _check_interpreter(interpreter)
    directory = None
    if templates["cache"]:
        directory = str(expand_template(templates["cache"], root).resolve())
        _check_cache(Path(directory))
    return dict(mpc_root=str(root), python=str(interpreter), cache=directory,
                effective_cache=directory or default_cache(root, interpreter), templates=templates)


_UNPINNED_SETTINGS = object()

def source_command(selection, operation="probe", ns=(), *, params=None, source_settings=None, source_settings_module=_UNPINNED_SETTINGS):
    """The selected interpreter runs scripts/source_probe.py (probe, model, or build ns)."""
    selected = resolve_selection(selection["mpc_root"], python=selection.get("python"), cache=selection.get("cache"))
    command = [selected["python"], str(PROBE_SCRIPT), operation,
               "--mpc-root", selected["mpc_root"], "--python", selected["python"]]
    if selected["cache"]:
        command += ["--cache", selected["cache"]]
    if ns:
        command += ["--N", *map(str, ns)]
    if params is not None:
        command += ["--params-json", json.dumps(params, allow_nan=False)]
    if source_settings is not None:
        command += ["--source-settings-json", json.dumps(source_settings, allow_nan=False)]
    if source_settings_module is not _UNPINNED_SETTINGS:
        command += ["--source-settings-module-json", json.dumps(source_settings_module, allow_nan=False)]
    return command


def build_command(selection, counts, rebuild=False, prediction_friction=False, *, params=None, source_settings=None, source_settings_module=_UNPINNED_SETTINGS):
    """Command/env for a parent-managed streaming build subprocess."""
    ns = list(counts)
    if not ns or any(isinstance(n, bool) or n not in KNOT_COUNTS for n in ns):
        raise ValueError(f"Build knot counts must be among {', '.join(map(str, KNOT_COUNTS))}")
    command = source_command(selection, "build", sorted(set(ns)), params=params, source_settings=source_settings,
                             source_settings_module=source_settings_module)
    if prediction_friction:
        command.append("--prediction-friction")
    if rebuild:
        command.append("--rebuild")
    return command, dict(cache_environment(selection), PYTHONUNBUFFERED="1")


def probe_selection(selection, timeout=120, *, operation="probe", params=None, source_settings=None, source_settings_module=_UNPINNED_SETTINGS):
    """The selected interpreter's import probe: tiago_mpc's API, the compiled modules
    (find_binary per KNOT_COUNTS and predictor friction), defaults and contract.
    operation='model' only resolves the draft and checks its exact native binaries.
    Never imports the source here."""
    try:
        command = source_command(selection, operation, params=params, source_settings=source_settings,
                             source_settings_module=source_settings_module)
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=timeout, check=False, env=cache_environment(selection))
        try:
            payload = json.loads(result.stdout)
        except ValueError as exc:
            detail = (result.stderr or result.stdout).strip()[-4000:]
            raise ValueError(f"Source probe exited {result.returncode}: {detail or 'no JSON response'}") from exc
        if not isinstance(payload, dict):
            raise ValueError("probe did not return an object")
        return payload
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        interpreter = command[0] if "command" in locals() else selection.get("python") or "automatic Python selection"
        return dict(compatible=False, available_N=[], modules=[], selection=selection,
                    error=f"Source probe using {interpreter}: {exc}")


def source_identity(root):
    def git(path, *args):
        try:
            return subprocess.check_output(["git", "-C", str(path), *args], text=True,
                                           stderr=subprocess.DEVNULL, timeout=10).strip()
        except (OSError, subprocess.SubprocessError):
            return None
    data = {}
    data["mpc_commit"] = git(root, "rev-parse", "HEAD")
    data["mpc_branch"] = git(root, "branch", "--show-current")
    status = git(root, "status", "--porcelain")
    data["mpc_dirty"] = None if status is None else bool(status)
    return data


def usable_cpu_count(cgroup_root=Path("/sys/fs/cgroup")):
    """Respect process affinity and the enclosing cgroup CPU quota."""
    count = float(os.cpu_count() or 1)
    if hasattr(os, "sched_getaffinity"):
        count = min(count, len(os.sched_getaffinity(0)) or 1)
    root = Path(cgroup_root)
    # Current group plus ancestors: v2 mounts often expose our group as root.
    locations = {root}
    try:
        for line in Path("/proc/self/cgroup").read_text().splitlines():
            hierarchy, controllers, group = line.split(":", 2)
            if hierarchy == "0" or "cpu" in controllers.split(","):
                current = root / group.lstrip("/")
                locations.add(current)
                locations.update(p for p in current.parents if p == root or root in p.parents)
    except (OSError, ValueError):
        pass
    for path in locations:
        try:
            quota, period = (path / "cpu.max").read_text().split()
            if quota != "max":
                count = min(count, int(quota) / int(period))
        except (OSError, ValueError, ZeroDivisionError):
            pass
        for base in (path, path / "cpu"):
            try:
                quota = int((base / "cpu.cfs_quota_us").read_text())
                period = int((base / "cpu.cfs_period_us").read_text())
                if quota > 0 and period > 0:
                    count = min(count, quota / period)
            except (OSError, ValueError):
                pass
    return max(1., count)


def build_jobs():
    return max(1, math.floor(usable_cpu_count() / 2))
