"""Bounded CPU-only MP4 encoding of browser-rendered PNG frames.

Frames stream directly to ffmpeg; only the MP4 and a small diagnostic tail are
retained. Runtime files follow the same pid-owned tmpfs convention as histories.
This module imports neither simulation nor solver code.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import select
import shutil
import struct
import subprocess
import threading
import time
import uuid

from runtime_files import ended_owner, owner_tag, runtime_directory

FPS = 30
MAX_FRAME_BYTES = 32 * 1024 * 1024
MAX_FRAME_COUNT = 108000
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
STDERR_BYTES = 16384


def resolve_ffmpeg(explicit=None):
    """Use an explicit executable, system ffmpeg, or the frontend dependency."""
    requested = explicit or os.environ.get("TIAGO_VISUALIZER_FFMPEG")
    candidates = ([requested] if requested else [shutil.which("ffmpeg"),
                  Path(__file__).resolve().parent / "node_modules/ffmpeg-static/ffmpeg"])
    for candidate in candidates:
        if candidate:
            resolved = shutil.which(str(candidate))
            if resolved:
                return resolved
    raise RuntimeError("MP4 export needs ffmpeg. Install frontend dependencies or set TIAGO_VISUALIZER_FFMPEG.")


def _png_dimensions(data):
    """Check one complete PNG, including the absence of concatenated frames."""
    if not isinstance(data, bytes) or not 45 <= len(data) <= MAX_FRAME_BYTES:
        raise ValueError("Expected one PNG frame under 32 MiB")
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[8:16] != b"\0\0\0\rIHDR":
        raise ValueError("Expected a PNG frame")
    dimensions = struct.unpack(">II", data[16:24])
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        offset += length + 12
        if offset > len(data):
            break
        if kind == b"IEND":
            if length == 0 and offset == len(data):
                return dimensions
            break
    raise ValueError("Expected one complete PNG frame")


@dataclass
class _Export:
    directory: Path
    width: int
    height: int
    frame_count: int
    process: subprocess.Popen
    next_index: int = 0
    encoded_frames: int = 0
    finished: bool = False
    touched: float = field(default_factory=time.monotonic)
    stderr: bytearray = field(default_factory=bytearray)
    lock: threading.Lock = field(default_factory=threading.Lock)
    cancelled: threading.Event = field(default_factory=threading.Event)
    readers: list = field(default_factory=list)

    @property
    def path(self):
        return self.directory / "animation.mp4"


class AnimationExportService:
    """At most two encoders/results; abandoned uploads/results expire after 15m.

    HTTP owners should stream download_path(id), then cancel(id) in a finally
    block. A result remains available until then; finish is safe to retry.
    Validation errors leave an upload usable; encoding failures discard it.
    """
    def __init__(self, ffmpeg=None, *, directory=None, max_jobs=2, ttl_s=900,
                 io_timeout_s=30, finish_timeout_s=60):
        if type(max_jobs) is not int or not 1 <= max_jobs <= 2 or ttl_s <= 0:
            raise ValueError("Expected one or two export slots and a positive expiry")
        self.ffmpeg = ffmpeg  # Resolve on first export so normal startup needs no encoder.
        base = Path(directory or runtime_directory("animation-exports")).resolve()
        base.mkdir(parents=True, exist_ok=True)
        for folder in base.iterdir():
            if folder.is_dir() and ended_owner(folder.name):
                shutil.rmtree(folder, ignore_errors=True)
        self.directory = base / owner_tag()
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.max_jobs, self.ttl_s = max_jobs, ttl_s
        self.io_timeout_s, self.finish_timeout_s = io_timeout_s, finish_timeout_s
        self.jobs = {}
        self.lock = threading.Lock()
        self.closed = threading.Event()
        self.janitor = threading.Thread(target=self._expire, name="animation-export-expiry", daemon=True)
        self.janitor.start()

    def start(self, width, height, fps=FPS, frame_count=None):
        if (type(width) is not int or type(height) is not int
                or not 16 <= width <= 3840 or not 16 <= height <= 3840
                or width % 2 or height % 2 or width * height > 3840 * 2160):
            raise ValueError("MP4 dimensions must be even, 16–3840 pixels, at most 3840×2160 pixels")
        if isinstance(fps, bool) or fps != FPS:
            raise ValueError("MP4 export uses 30 fps")
        if type(frame_count) is not int or not 1 <= frame_count <= MAX_FRAME_COUNT:
            raise ValueError(f"Expected 1–{MAX_FRAME_COUNT} frames")
        with self.lock:
            if self.closed.is_set():
                raise RuntimeError("Animation export service is closed")
            if len(self.jobs) >= self.max_jobs:
                raise RuntimeError("Another MP4 export is still active; finish or cancel it first")
            executable = resolve_ffmpeg(self.ffmpeg)
            identifier = uuid.uuid4().hex
            folder = self.directory / identifier
            folder.mkdir(mode=0o700)
            command = [executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                       "-threads", "2", "-filter_threads", "1", "-f", "image2pipe", "-vcodec", "png",
                       "-framerate", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264",
                       "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2",
                       "-frames:v", str(frame_count), "-fs", str(MAX_OUTPUT_BYTES),
                       "-movflags", "+faststart", "-progress", "pipe:1", str(folder / "animation.mp4")]
            process = None
            try:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, bufsize=0)
                os.set_blocking(process.stdin.fileno(), False)
            except OSError as exc:
                if process is not None:
                    process.kill()
                    process.wait()
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()
                shutil.rmtree(folder, ignore_errors=True)
                raise RuntimeError(f"Cannot start MP4 encoder: {exc}") from exc
            job = _Export(folder, width, height, frame_count, process)
            self.jobs[identifier] = job
            for target in (self._drain_stderr, self._read_progress):
                reader = threading.Thread(target=target, args=(job,), daemon=True)
                job.readers.append(reader)
                reader.start()
            return identifier

    @staticmethod
    def _drain_stderr(job):
        while chunk := job.process.stderr.read(4096):
            job.stderr.extend(chunk)
            if len(job.stderr) > STDERR_BYTES:
                del job.stderr[:-STDERR_BYTES]

    @staticmethod
    def _read_progress(job):
        # ffmpeg progress records contain only small key=value lines.
        for line in job.process.stdout:
            if line.startswith(b"frame="):
                try:
                    job.encoded_frames = int(line[6:].strip())
                except ValueError:
                    pass

    def _job(self, identifier):
        with self.lock:
            if not isinstance(identifier, str) or identifier not in self.jobs:
                raise KeyError("Animation export was not found or expired")
            return self.jobs[identifier]

    @staticmethod
    def _error(job, message):
        details = bytes(job.stderr).decode("utf-8", errors="replace").strip()
        return RuntimeError(message + (f": {details}" if details else ""))

    def append_frame(self, identifier, index, pngbytes):
        job = self._job(identifier)
        try:
            with job.lock:
                if job.cancelled.is_set() or job.finished:
                    raise ValueError("Animation export is no longer accepting frames")
                if type(index) is not int or index != job.next_index or index >= job.frame_count:
                    raise ValueError(f"Expected frame {job.next_index}")
                if _png_dimensions(pngbytes) != (job.width, job.height):
                    raise ValueError("PNG dimensions differ from the export dimensions")
                remaining = memoryview(pngbytes)
                deadline = time.monotonic() + self.io_timeout_s
                while remaining:
                    if job.cancelled.is_set():
                        raise RuntimeError("Animation export cancelled")
                    if job.process.poll() is not None:
                        raise self._error(job, "MP4 encoder stopped before accepting all frames")
                    if time.monotonic() >= deadline:
                        raise RuntimeError("MP4 encoder stopped accepting frames")
                    if not select.select([], [job.process.stdin], [], 0.1)[1]:
                        continue
                    try:
                        written = os.write(job.process.stdin.fileno(), remaining[:65536])
                    except BlockingIOError:
                        continue
                    remaining = remaining[written:]
                job.next_index += 1
                job.touched = time.monotonic()
                return job.next_index
        except (OSError, RuntimeError) as exc:
            self.cancel(identifier)
            if isinstance(exc, RuntimeError):
                raise
            raise self._error(job, "MP4 encoder failed") from exc

    def finish(self, identifier):
        job = self._job(identifier)
        try:
            with job.lock:
                if job.cancelled.is_set():
                    raise RuntimeError("Animation export cancelled")
                if job.finished:
                    return job.path
                if job.next_index != job.frame_count:
                    raise ValueError(f"Expected {job.frame_count} frames; received {job.next_index}")
                job.process.stdin.close()
                job.process.wait(timeout=self.finish_timeout_s)
                for reader in job.readers:
                    reader.join(timeout=2)
                if (job.process.returncode or job.encoded_frames != job.frame_count
                        or not job.path.is_file() or job.path.stat().st_size == 0
                        or job.path.stat().st_size >= MAX_OUTPUT_BYTES):
                    raise self._error(job, "MP4 encoding failed or exceeded the 512 MiB export limit")
                job.finished = True
                job.touched = time.monotonic()
                return job.path
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            self.cancel(identifier)
            if isinstance(exc, RuntimeError):
                raise
            raise self._error(job, "MP4 encoding failed or timed out") from exc

    def download_path(self, identifier):
        job = self._job(identifier)
        with job.lock:
            if not job.finished or job.cancelled.is_set():
                raise ValueError("Animation export is not finished")
            job.touched = time.monotonic()
            return job.path

    def cancel(self, identifier):
        with self.lock:
            job = self.jobs.pop(identifier, None)
        if job is None:
            return
        # Kill first: a concurrent writer or finish must unblock before cleanup.
        job.cancelled.set()
        try:
            job.process.kill()
        except ProcessLookupError:
            pass
        with job.lock:
            job.process.wait()
            for reader in job.readers:
                reader.join(timeout=2)
            for stream in (job.process.stdin, job.process.stdout, job.process.stderr):
                stream.close()
            shutil.rmtree(job.directory, ignore_errors=True)

    def _expire(self):
        while not self.closed.wait(min(30, self.ttl_s)):
            with self.lock:
                expired = [key for key, job in self.jobs.items()
                           if time.monotonic() - job.touched >= self.ttl_s]
            for identifier in expired:
                self.cancel(identifier)

    def close(self):
        self.closed.set()
        with self.lock:
            identifiers = list(self.jobs)
        for identifier in identifiers:
            self.cancel(identifier)
        self.janitor.join(timeout=2)
        shutil.rmtree(self.directory, ignore_errors=True)
