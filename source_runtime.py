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
# tiago_mpc's convention (Felix, 2026-10-23): one cache for every interpreter, host and container.
DEFAULT_CACHE_TEMPLATE = f"{CHECKOUT_TOKEN}/.cache/gato"
# The knot counts the probe looks up with find_binary and Build accepts.
KNOT_COUNTS = (8, 16, 24, 32, 48, 64, 96, 128)


def default_interpreter_template(root):
    """Default interpreter template: the host `venv-host` when usable, else the container's `.venv`.

    This is the one place that decides the preference; change it here only.
    """
    host = Path(root) / "venv-host/bin/python"
    usable = host.is_file() and os.access(host, os.X_OK)
    return f"{CHECKOUT_TOKEN}/{'venv-host' if usable else '.venv'}/bin/python"


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


def checkout_defaults(mpc_root):
    """Default interpreter/cache templates of a checkout and their resolution; never raises for missing paths."""
    root = Path(mpc_root).expanduser().resolve()
    python = default_interpreter_template(root)
    cache = DEFAULT_CACHE_TEMPLATE
    return dict(mpc_root=str(root), python=python, cache=cache,
                resolved=dict(python=str(expand_template(python, root)), cache=str(expand_template(cache, root))))


def resolve_templates(mpc_root, python=None, cache=None):
    """Per field the resolved path or the reason it is invalid, for the UI tooltip and mark."""
    root = Path(mpc_root).expanduser().resolve()
    defaults = checkout_defaults(root)
    python = (python or "").strip() or defaults["python"]
    result = {}
    for key, value, check in (("python", python, _check_interpreter), ("cache", cache, _check_cache)):
        try:
            path = expand_template((value or "").strip() or defaults[key], root)
            check(path)
            result[key] = dict(path=str(path))
        except ValueError as exc:
            result[key] = dict(error=str(exc))
    return result


def stored_selection(selection):
    """Persisted form: the checkout plus templates that differ from the defaults (defaults keep following it)."""
    root = selection["mpc_root"]
    templates = selection.get("templates", {})
    python = checkout_defaults(root)["python"]
    defaults = dict(python=python, cache=DEFAULT_CACHE_TEMPLATE)
    return dict(mpc_root=root, **{key: value for key, value in templates.items() if value and value != defaults[key]})


def resolve_selection(mpc_root, python=None, cache=None):
    """Resolved absolute selection plus the `templates` it came from (defaults filled in)."""
    root = Path(mpc_root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Source checkout is not a directory: {root}")
    defaults = checkout_defaults(root)
    python = str(python) if python else defaults["python"]
    templates = dict(python=python, cache=str(cache) if cache else DEFAULT_CACHE_TEMPLATE)
    # Keep the virtualenv executable path: resolving the symlink loses its environment.
    interpreter = expand_template(templates["python"], root)
    _check_interpreter(interpreter)
    directory = expand_template(templates["cache"], root).resolve()
    _check_cache(directory)
    return dict(mpc_root=str(root), python=str(interpreter), cache=str(directory), templates=templates)


def source_command(selection, operation="probe", ns=()):
    """The selected interpreter runs scripts/source_probe.py (probe, or build ns)."""
    selected = resolve_selection(selection["mpc_root"], python=selection.get("python"), cache=selection.get("cache"))
    command = [selected["python"], str(PROBE_SCRIPT), operation,
               "--mpc-root", selected["mpc_root"], "--python", selected["python"],
               "--cache", selected["cache"]]
    if ns:
        command += ["--N", *map(str, ns)]
    return command


def build_command(selection, counts, rebuild=False, prediction_friction=False):
    """Command/env for a parent-managed streaming build subprocess."""
    ns = list(counts)
    if not ns or any(isinstance(n, bool) or n not in KNOT_COUNTS for n in ns):
        raise ValueError(f"Build knot counts must be among {', '.join(map(str, KNOT_COUNTS))}")
    command = source_command(selection, "build", sorted(set(ns)))
    if prediction_friction:
        command.append("--prediction-friction")
    if rebuild:
        command.append("--rebuild")
    return command, dict(os.environ, PYTHONUNBUFFERED="1")


def probe_selection(selection, timeout=120):
    """The selected interpreter's import probe: tiago_mpc's API, the compiled modules
    (find_binary per KNOT_COUNTS and predictor friction), defaults and contract.
    Never imports the source here."""
    try:
        command = source_command(selection)
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=timeout, check=False)
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
    for name, path in (("mpc", Path(root)), ("gato", Path(root) / "external/gato")):
        data[name + "_commit"] = git(path, "rev-parse", "HEAD")
        data[name + "_branch"] = git(path, "branch", "--show-current")
        status = git(path, "status", "--porcelain")
        data[name + "_dirty"] = None if status is None else bool(status)
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
