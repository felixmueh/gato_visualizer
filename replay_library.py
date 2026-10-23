"""A small recursively scanned replay catalog and atomic browser uploads."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import threading
import uuid

from replay_format import MAX_COMPRESSED_BYTES, ReplayError, load_replay

ROOT = Path(__file__).resolve().parent
DEFAULT_UPLOAD_DIRECTORY = ROOT / "_expr_data/uploads"


class UploadConflict(ReplayError):
    pass


def _safe_relative_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ReplayError("Upload path must be a nonempty relative POSIX .npz path")
    parts = value.split("/")
    if value.startswith("/") or any(not p or p in (".", "..") or p.startswith(".") for p in parts):
        raise ReplayError("Upload path cannot be absolute, hidden, empty, or contain . or .. components")
    path = PurePosixPath(value)
    if path.suffix.lower() != ".npz":
        raise ReplayError("Upload path must end in .npz")
    return parts


def _signature(path):
    stat = path.stat(follow_symlinks=False)
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


class ReplayLibrary:
    def __init__(self, *, ingest_directory, model_urdf, default_scene, scene_builder,
                 upload_directory=DEFAULT_UPLOAD_DIRECTORY):
        self.ingest_directory = Path(ingest_directory)
        self.upload_directory = Path(upload_directory)
        self.model_urdf = Path(model_urdf)
        self.default_scene = default_scene
        self.scene_builder = scene_builder
        self.lock = threading.RLock()
        self.cache = {}
        self.paths = {}
        self.items = []
        self.revision = 0
        self.loaded = {}
        # The most recently loaded recording (id, revision) is the current replay;
        # listeners learn when it changes (Run again results of other replays go).
        self.current = None
        self.listeners = []

    @staticmethod
    def identifier(source, relative):
        return source + "-" + hashlib.sha256(relative.encode()).hexdigest()[:24]

    def _files(self, root):
        if not root.is_dir() or root.is_symlink():
            return
        for directory, folders, files in os.walk(root, followlinks=False):
            folders[:] = sorted(folder for folder in folders if not folder.startswith(".") and
                                not (Path(directory) / folder).is_symlink())
            for name in sorted(files):
                path = Path(directory) / name
                if name.startswith(".") or path.suffix.lower() != ".npz" or path.is_symlink():
                    continue
                yield path

    def _scan(self):
        items = [dict(id="default", name="Start pose", path="", source="default",
                      status="ready", revision="default")]
        paths, retained = {}, {}
        for source, root in (("ingest", self.ingest_directory), ("upload", self.upload_directory)):
            for path in self._files(root):
                relative = path.relative_to(root).as_posix()
                identifier = self.identifier(source, relative)
                try:
                    signature = _signature(path)
                except OSError:
                    continue
                cached = self.cache.get(identifier)
                if cached is not None and cached[0] == signature:
                    item = cached[1]
                else:
                    revision = hashlib.sha256(repr(signature).encode()).hexdigest()[:16]
                    item = dict(id=identifier, name=str(PurePosixPath(relative).with_suffix("")),
                                path=relative, source=source, revision=revision, status="ready",
                                modified_time_s=signature[3]/1e9)
                    try:
                        replay = load_replay(path, model_urdf=self.model_urdf)
                        if replay.model_warning:
                            item["model_warning"] = dict(replay.model_warning)
                        if signature != _signature(path):
                            raise ReplayError("File changed while being read; the catalog will retry after it changes")
                    except (ReplayError, OSError) as exc:
                        item.update(status="error", error=str(exc))
                retained[identifier] = (signature, item)
                paths[identifier] = path
                items.append(item)
        # The default is a fallback, while recently written uploads and ingest
        # exports are the most useful library entries. Preserve path identity
        # and stable ordering for equal timestamps across both roots.
        default = items.pop(0)
        items.sort(key=lambda item: (-retained[item["id"]][0][3], item["name"], item["source"]))
        items.append(default)
        if items != self.items:
            self.revision += 1
            self.items = items
        self.paths, self.cache = paths, retained

    def catalog(self):
        """Polling this endpoint watches both roots recursively, without a daemon."""
        with self.lock:
            self._scan()
            # A response is a snapshot, independent of future scans or playback.
            return dict(items=[dict(item) for item in self.items], revision=self.revision)

    def scene(self, identifier):
        scene = self._scene(identifier)
        current = (identifier, "default" if identifier == "default" else scene["source"]["plot_revision"])
        with self.lock:
            changed, self.current = current != self.current, current
        if changed:
            for listener in self.listeners:
                listener(current)
        return scene

    def _scene(self, identifier):
        if identifier == "default":
            return self.default_scene
        with self.lock:
            self._scan()
            path = self.paths.get(identifier)
            if path is None:
                raise KeyError("Recording was not found; refresh the replay library")
            item = self.cache[identifier][1]
            if item["status"] != "ready":
                raise ReplayError(item["error"])
            before = _signature(path)
            replay = load_replay(path, model_urdf=self.model_urdf)
            scene = self.scene_builder(replay, path)
            if before != _signature(path):
                raise ReplayError("Recording changed while loading; select it again after the write completes")
            scene["source"]["plot_revision"] = item["revision"]
            self.loaded[identifier] = (before, dict(item), path)
            return scene

    def _upload_parent(self, parts):
        self.upload_directory.mkdir(parents=True, exist_ok=True)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        descriptor = os.open(self.upload_directory, flags)
        try:
            for component in parts[:-1]:
                try:
                    os.mkdir(component, mode=0o755, dir_fd=descriptor)
                except FileExistsError:
                    pass
                next_descriptor = os.open(component, flags, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = next_descriptor
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def upload(self, relative, payload):
        parts = _safe_relative_path(relative)
        if not isinstance(payload, bytes) or not 0 < len(payload) <= MAX_COMPRESSED_BYTES:
            raise ReplayError("Upload must contain one NPZ file no larger than 64 MiB")
        # Validate the preserved original bytes before making any recording public.
        import io
        load_replay(io.BytesIO(payload), model_urdf=self.model_urdf)
        temporary = ".upload-" + uuid.uuid4().hex + ".tmp"
        parent = None
        try:
            parent = self._upload_parent(parts)
            descriptor = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=parent)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                # A hard link publishes the complete file atomically, refusing to
                # replace any existing file or symlink, even under concurrent requests.
                os.link(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError as exc:
                raise UploadConflict(f"Upload already exists: {relative}; choose another filename") from exc
        except OSError as exc:
            raise ReplayError(f"Upload path is unavailable or contains a symlink: {exc}") from exc
        finally:
            if parent is not None:
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass
                os.close(parent)
        identifier = self.identifier("upload", PurePosixPath(*parts).as_posix())
        with self.lock:
            self._scan()
            item = next(dict(item) for item in self.items if item["id"] == identifier)
        return item
