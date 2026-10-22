"""Source selection and CPU-only GATO compatibility checks.

The web process uses resolve_selection/probe_selection only. Source imports and
all GATO operations run in the explicitly selected Python subprocess.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
PROBE_SCRIPT = ROOT / "scripts/source_probe.py"


def resolve_selection(mpc_root, python=None, cache=None):
    root = Path(mpc_root).expanduser().resolve()
    if not (root / "examples/reach_sim.py").is_file():
        raise ValueError(f"Not a tiago_mpc checkout: {root} (missing examples/reach_sim.py)")
    if not (root / "external/gato/python/gato/_cache.py").is_file():
        raise ValueError(f"Selected checkout lacks GATO cache APIs: {root / 'external/gato'}")
    if python:
        interpreter = Path(os.path.abspath(Path(python).expanduser()))
    else:
        candidates = [root / name / "bin/python" for name in ("venv-host", ".venv")]
        interpreter = next((p for p in candidates if p.is_file() and os.access(p, os.X_OK)), candidates[0])
    # Keep the virtualenv executable path: resolving the symlink loses its environment.
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise ValueError(f"Selected Python is not executable: {interpreter}")
    directory = Path(cache).expanduser().resolve() if cache else root / ".cache/gato"
    if directory.exists() and not directory.is_dir():
        raise ValueError(f"GATO cache is not a directory: {directory}")
    return dict(mpc_root=str(root), python=str(interpreter), cache=str(directory))


def source_command(selection, operation="probe", ns=()):
    selected = resolve_selection(**selection)
    command = [selected["python"], str(PROBE_SCRIPT), operation,
               "--mpc-root", selected["mpc_root"], "--python", selected["python"],
               "--cache", selected["cache"]]
    if ns:
        command += ["--N", *map(str, ns)]
    return command


def build_command(selection, counts, rebuild=False, prediction_friction=False):
    """Command/env for a parent-managed streaming build subprocess."""
    ns = list(counts)
    if not ns or any(isinstance(n, bool) or not isinstance(n, int) or not 2 <= n <= 4096 for n in ns):
        raise ValueError("Build knot counts must be integers between 2 and 4096")
    command = source_command(selection, "build", sorted(set(ns)))
    if prediction_friction:
        command.append("--prediction-friction")
    if rebuild:
        command.append("--rebuild")
    return command, dict(os.environ, PYTHONUNBUFFERED="1")


def probe_selection(selection, timeout=120, operation="probe"):
    """Run source imports in the selected environment; never import them here."""
    try:
        command = source_command(selection, operation=operation)
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


@contextmanager
def prepared_model(reach, retain=False, losses=None):
    """Use upstream model preparation with local temporary outputs.

    Modern helpers accept the output directory explicitly. Legacy source
    wrappers retain their original ROOT redirection only for loss-free models.
    """
    directory = ROOT / "_expr_data/source-runtime"
    directory.mkdir(parents=True, exist_ok=True)
    folder = tempfile.mkdtemp(prefix="model-", dir=directory)
    try:
        old_root = reach.ROOT
        local = Path(folder)
        if (Path(old_root) / "tiago_mpc/model_runtime.py").is_file():
            import importlib
            runtime = importlib.import_module("tiago_mpc.model_runtime")
            if runtime.ROOT.resolve() != Path(old_root).resolve():
                raise ValueError("Model helpers imported from another selected checkout")
            path, gpu_path, signs, _, _ = runtime.runtime_urdf(local, losses)
            yield path, gpu_path, signs
        else:
            if losses is not None:
                raise ValueError("Selected source lacks shared friction-aware model helpers")
            (local / "models").symlink_to(Path(old_root) / "models", target_is_directory=True)
            reach.ROOT = local
            try:
                yield reach.runtime_urdf()
            finally:
                reach.ROOT = old_root
    finally:
        if not retain:
            shutil.rmtree(folder)


def package_binaries(package, plant, n=None):
    pattern = re.compile(rf"bsqpN(\d+)_{re.escape(plant)}(?:\.[^.]+)*\.so$")
    return [p for p in Path(package).glob(f"bsqpN*_{plant}*.so")
            if (match := pattern.fullmatch(p.name)) and (n is None or int(match[1]) == n)]


def candidate_ns(cache, plant):
    """Inspect filenames, including modules omitted by the latest manifest.N."""
    pattern = re.compile(rf"bsqpN(\d+)_{re.escape(plant)}(?:\.[^.]+)*\.so$")
    values = set()
    for path in (Path(cache) / "modules" / plant).glob("*/*.so"):
        match = pattern.fullmatch(path.name)
        if match:
            values.add(int(match[1]))
    return sorted(values)


def discover_compatible_modules(reach, requested_ns=(), losses=None):
    """CPU-only current-input cache lookup, callable inside the live worker.

    No registration, compilation, solver construction, GPU calls or locks.
    Current-key binaries are imported to check ABI/load and embedded constants;
    upstream module initialization registers classes without constructing them.
    GATO owns codegen/native/toolchain/Python-ABI/architecture key definitions.
    """
    from gato import _cache
    from gato.builder import _codegen_key

    plant = reach.PLANT + "_smooth" if losses is not None else reach.PLANT
    widths = losses["smoothing_rad_s"] if losses is not None else None
    cache = _cache.cache_dir()
    cached_ns = candidate_ns(cache, plant)
    package = Path(reach.gato.__file__).parent
    package_ns = {int(match[1]) for path in package_binaries(package, plant)
                  if (match := re.match(r"bsqpN(\d+)_", path.name))}
    ns = sorted(set(cached_ns) | package_ns | set(requested_ns))
    arch = _cache.detect_arch()
    result = dict(compatible=False, available_N=[], modules=[], cache=str(cache), arch=arch)
    with prepared_model(reach, losses=losses) as (_, gpu_path, signs):
        key = _codegen_key(gpu_path, reach.EE_FRAME, .15, None, False,
                           **({"joint_friction_smoothing": widths} if widths is not None else {}))
        result["model"] = dict(ee_frame=reach.EE_FRAME, codegen_key=key,
                              gpu_urdf_sha256=hashlib.sha256(Path(gpu_path).read_bytes()).hexdigest(),
                              signs=signs.tolist())
        result["toolchain"] = _cache.toolchain_identity(arch)
        entry = _cache.robot_entry(plant)
        reason = None
        if not arch:
            reason = "GPU architecture is unknown; current binary compatibility cannot be verified"
        elif not entry or entry.get("codegen_key") != key:
            reason = "Robot registration is missing or stale for the selected model/frame/generator"
        resolved = _cache.resolve(plant) if not reason else None
        for n in ns:
            item = dict(N=n, status="missing", path=None, key=None)
            problem = reason
            if not problem:
                robot, plant_root = resolved
                item["key"], inputs = _cache.module_key(robot, n, "default", plant_root, arch)
                item["inputs"] = inputs
                path = _cache.find_module(plant, n)
                # Upstream BSQP prefers package modules before the cache; a package
                # binary has no current cache-key proof and must not slip through.
                if package_binaries(package, plant, n):
                    problem = "A package binary shadows the validated cache; remove/select another checkout"
                elif path is not None:
                    try:
                        module = _cache.load_module(plant, n, build_if_missing=False)
                        if Path(module.__file__).resolve() != Path(path).resolve():
                            raise ValueError("A different module is already loaded")
                        if module.NATIVE_SOURCE_ID != inputs["native_source_id"]:
                            raise ValueError("Embedded native source identity mismatch")
                        if (module.KNOT_POINTS, module.NQ, module.NV, module.FLOATING_BASE) != (n, 7, 7, False):
                            raise ValueError("Binary shape differs from the seven-joint fixed TIAGo arm")
                    except Exception as exc:
                        problem = f"Binary load/identity check failed: {exc}"
                    else:
                        item.update(status="compatible", path=str(path))
                        result["available_N"].append(n)
                else:
                    problem = "No binary for the current GATO native/model/toolchain/Python ABI/architecture key"
            if problem:
                item["reason"] = problem
                item["status"] = "stale" if n in cached_ns or n in package_ns else "missing"
            result["modules"].append(item)
        result["compatible"] = bool(result["available_N"])
        if reason:
            result["error"] = reason
        elif not result["compatible"]:
            result["error"] = "; ".join(dict.fromkeys(item.get("reason", "") for item in result["modules"])) or "No compiled solver modules found in the selected cache"
    return result


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
