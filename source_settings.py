"""Local source selection and CPU build jobs, separate from numerical workers."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import signal
import threading
import uuid

from visualizer_config import save_source_selection

ROOT = Path(__file__).resolve().parent


def restart_arguments(argv, config_path):
    """UI Apply replaces launch-time source overrides; other server flags survive."""
    result = []
    skip = False
    for item in argv:
        if skip:
            skip = False
            continue
        if item in ("--mpc-root", "--config"):
            skip = True
        elif not item.startswith(("--mpc-root=", "--config=")):
            result.append(item)
    return [str(ROOT / "server.py"), "--config", str(config_path), *result]


def selection_from_request(body):
    from source_runtime import resolve_selection
    if not isinstance(body, dict) or set(body) - {"mpc_root", "python", "cache"}:
        raise ValueError("Select a source checkout, Python interpreter and binary cache")
    if not isinstance(body.get("mpc_root"), str) or not body["mpc_root"].strip():
        raise ValueError("Source checkout path is required")
    return resolve_selection(body["mpc_root"], python=body.get("python") or None,
                             cache=body.get("cache") or None)


class SourceSettings:
    """Probe in a fresh interpreter; compile explicitly without pausing Live."""
    def __init__(self, selection, config_path, request_restart, *, probe=None, popen=None):
        self.selection = selection
        self.config_path = config_path
        self.request_restart = request_restart
        if probe is None:
            from source_runtime import probe_selection
            probe = probe_selection
        self.probe = probe
        self.popen = popen or subprocess.Popen
        self.lock = threading.RLock()
        self.job = None
        self.restarting = False
        self.current = None
        self.closed = False
        self.build_thread = None

    def inspect(self, body=None):
        selection = selection_from_request(body) if body is not None else self.selection
        result = self.probe(selection)
        result.setdefault("selection", selection)
        if body is None:
            with self.lock:
                self.current = result
        return result

    def status(self):
        with self.lock:
            current = self.current
        if current is None:
            current = self.inspect()
        with self.lock:
            return dict(current=current, build=self._job_snapshot(), restarting=self.restarting)

    def _job_snapshot(self, job=None):
        job = self.job if job is None else job
        if job is None:
            return None
        snapshot = {key: value for key, value in job.items() if key != "process"}
        log = Path(snapshot["log_path"])
        try:
            with log.open("rb") as stream:
                stream.seek(max(0, log.stat().st_size - 65536))
                snapshot["log"] = stream.read().decode("utf-8", errors="replace")
        except OSError:
            snapshot["log"] = ""
        return snapshot

    def build(self, body):
        if not isinstance(body, dict) or set(body) - {"selection", "N", "rebuild"}:
            raise ValueError("Build requires selection, N and optional rebuild")
        selection = selection_from_request(body.get("selection"))
        counts = body.get("N")
        if not isinstance(counts, list) or not counts or any(type(n) is not int or n < 2 or n > 4096 for n in counts):
            raise ValueError("Choose integer knot counts between 2 and 4096")
        if type(body.get("rebuild", False)) is not bool:
            raise ValueError("rebuild must be a boolean")
        with self.lock:
            if self.restarting or self.closed:
                raise ValueError("Backend restart is already in progress")
            if self.job and self.job["state"] == "running":
                raise ValueError("A binary build is already running")
            # Compilation uses GATO's cache coordination; no GPU timing lock or
            # Live command belongs here. Numerical work retains its own locks.
            from source_runtime import build_command
            command, environment = build_command(selection, sorted(set(counts)),
                                                  rebuild=body.get("rebuild", False))
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            folder = ROOT / "_expr_data/source-builds" / stamp
            folder.mkdir(parents=True)
            log_path = folder / "build.log"
            self.job = dict(id=uuid.uuid4().hex, state="running", N=sorted(set(counts)),
                            started_at=stamp, log_path=str(log_path), selection=selection,
                            rebuild=body.get("rebuild", False))
            (folder / "request.json").write_text(json.dumps(self.job, indent=2) + "\n")
            thread = threading.Thread(target=self._build, args=(self.job, command, environment, log_path),
                                      name="source-binary-build", daemon=True)
            self.build_thread = thread
            thread.start()
            return self._job_snapshot()

    def _build(self, job, command, environment, log_path):
        final = {}
        try:
            with log_path.open("wb") as stream:
                with self.lock:
                    if self.closed:
                        raise RuntimeError("Backend stopped before the build started")
                    process = self.popen(command, cwd=ROOT, env=environment, stdout=stream,
                                         stderr=subprocess.STDOUT, start_new_session=True)
                    job["process"] = process
                code = process.wait()
            result = self.probe(job["selection"])
            final.update(state="complete" if code == 0 else "failed", returncode=code, result=result)
            with self.lock:
                self.current = None
        except Exception as exc:
            final.update(state="failed", error=str(exc))
        finally:
            with self.lock:
                # Keep this job running until both validation and its retained
                # receipt finish; Apply and a later build must wait for them.
                snapshot = dict(self._job_snapshot(job), **final)
                (log_path.parent / "result.json").write_text(json.dumps(snapshot, indent=2) + "\n")
                job.update(final)

    def apply(self, body):
        selection = selection_from_request(body)
        with self.lock:
            if self.restarting or self.closed:
                raise ValueError("Backend restart is already in progress")
            if self.job and self.job["state"] == "running":
                raise ValueError("Wait for the current build before applying a source")
            result = self.probe(selection)
            if not result.get("compatible", result.get("ok", False)):
                errors = result.get("errors") or [result.get("error", "Selected source is incompatible")]
                raise ValueError("; ".join(errors))
            save_source_selection(self.config_path, selection)
            self.restarting = True
            self.selection = selection
        return dict(accepted=True, restarting=True, selection=selection)

    def finish_apply(self):
        """Called only after the HTTP handler writes the accepted response."""
        self.request_restart()

    def close(self):
        """Stop an explicit CPU build together with its supervising backend."""
        with self.lock:
            self.closed = True
            process = self.job.get("process") if self.job else None
            thread = self.build_thread
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if thread is not None:
            thread.join(timeout=10)
