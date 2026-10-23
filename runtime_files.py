"""RAM-backed runtime scratch (Felix, 2026-10-23; Linux only).

Runtime scratch (Live history, preview captures, Run again results, solver-process
and coordinator logs, TMPDIR) lives on tmpfs, not on disk: the visualizer must run on
HDDs, and SSD wear. Only what must persist (uploads, config, builds and their logs,
exported replays) stays on disk.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil

ENVIRONMENT = "TIAGO_VISUALIZER_RUNTIME_DIR"
LOW_SPACE_BYTES = 512 * 1024 * 1024


def runtime_directory(*parts):
    """The runtime directory (created 0700), or a subdirectory of it. Default
    /dev/shm/tiago-mpc-visualizer-<uid>; TIAGO_VISUALIZER_RUNTIME_DIR overrides it."""
    base = Path(os.environ.get(ENVIRONMENT) or f"/dev/shm/tiago-mpc-visualizer-{os.getuid()}")
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = base.joinpath(*parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


def owner_tag():
    """Names a runtime file or directory owned by this server process."""
    return f"p{os.getpid()}"


def ended_owner(tag):
    """True when `tag` is not the owner tag of a running process (a leftover)."""
    if not (tag.startswith("p") and tag[1:].isdigit()):
        return True
    try:
        os.kill(int(tag[1:]), 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        pass
    return False


def runtime_warning():
    """A clear warning when the runtime directory is not RAM-backed or nearly full, else None."""
    path = runtime_directory().resolve()
    mounts = []
    try:
        for line in Path("/proc/mounts").read_text().splitlines():
            fields = line.split()
            mounts.append((Path(fields[1].replace("\\040", " ")), fields[2]))
    except OSError:
        pass
    mount = max((m for m in mounts if path.is_relative_to(m[0])), key=lambda m: len(m[0].parts), default=None)
    if mount is None or mount[1] not in ("tmpfs", "ramfs"):
        return (f"Runtime directory {path} is not on tmpfs ({mount[1] if mount else 'unknown'}): the Live "
                f"history is written to disk. Set {ENVIRONMENT} to a tmpfs directory such as /dev/shm.")
    free = shutil.disk_usage(path).free
    if free < LOW_SPACE_BYTES:
        return (f"Runtime directory {path} has only {free // 2**20} MiB free (RAM-backed); long Live runs "
                f"will fail. Enlarge it (a container's /dev/shm defaults to 64 MB) or set {ENVIRONMENT}.")
    return None
