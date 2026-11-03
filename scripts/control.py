#!/usr/bin/env python3
"""Control an existing local visualizer through its JSON HTTP API (stdlib only)."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


READS = {
    "live": "/api/live/settings",
    "presentation": "/api/presentation/settings",
    "schema": "/api/live/schema",
    "source": "/api/source",
    "profiles": "/api/solver-profiles",
}


class ControlError(Exception):
    def __init__(self, message, *, status=None, payload=None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class Client:
    def __init__(self, url, timeout=30, opener=urlopen):
        self.url, self.timeout, self.opener = url.rstrip("/"), timeout, opener

    def request(self, path, body=None):
        data = None if body is None else json.dumps(body, allow_nan=False).encode()
        request = Request(self.url + path, data=data,
                          headers={} if data is None else {"Content-Type": "application/json"})
        try:
            with self.opener(request, timeout=self.timeout) as response:
                result = json.load(response)
        except HTTPError as error:
            try:
                payload = json.load(error)
            except (ValueError, UnicodeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            raise ControlError(payload.get("error", f"HTTP {error.code}"),
                               status=error.code, payload=payload) from None
        except (URLError, TimeoutError, OSError) as error:
            raise ControlError(f"Cannot reach {self.url}: {error}") from None
        except (ValueError, UnicodeError):
            raise ControlError("The server returned invalid JSON") from None
        if isinstance(result, dict) and result.get("accepted") is False:
            raise ControlError(result.get("error", "Command was rejected"), payload=result)
        return result


def json_object(value, stdin):
    if value == "-":
        text = stdin.read()
    elif value.startswith("@"):
        text = Path(value[1:]).read_text()
    else:
        text = value

    def invalid_constant(constant):
        raise ValueError(f"JSON must not contain {constant}")

    result = json.loads(text, parse_constant=invalid_constant)
    if not isinstance(result, dict):
        raise ValueError("Expected a JSON object")
    return result


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--url", default=os.environ.get("TIAGO_VISUALIZER_URL", "http://127.0.0.1:8090"),
                        help="existing visualizer URL (or TIAGO_VISUALIZER_URL)")
    result.add_argument("--timeout", type=float, default=30, help="HTTP timeout in seconds")
    commands = result.add_subparsers(dest="operation", required=True)
    read = commands.add_parser("get", help="read current accepted settings or source metadata")
    read.add_argument("group", choices=["all", *READS], default="all", nargs="?")

    patch = commands.add_parser("patch", help="change only supplied settings; JSON, @file or - for stdin")
    patch.add_argument("group", choices=["live", "presentation"])
    patch.add_argument("json")
    patch.add_argument("--expected-version", type=int, help="reject a stale Live settings version (HTTP 409)")
    patch.add_argument("--anchor", help="Live native {sim_time_s,q,qd} JSON object, @file or -")
    patch.add_argument("--reset", action="store_true", help="start Live at its configured start pose")

    command = commands.add_parser("command", help="enqueue a numerical command")
    command.add_argument("type", choices=["preview", "play", "pause", "cancel", "reset", "precalculate"])
    command.add_argument("--anchor", help="native anchor for preview or precalculate")

    source = commands.add_parser("source", help="select an existing MPC checkout; apply restarts the backend")
    source.add_argument("action", choices=["inspect", "apply"])
    source.add_argument("checkout", help="checkout path on the server")
    source.add_argument("--python", help="prepared Python path or <checkout> template")
    source.add_argument("--cache", help="optional binary cache path or template")

    profile = commands.add_parser("profile", help="save or activate a solver-only profile")
    profiles = profile.add_subparsers(dest="action", required=True)
    save = profiles.add_parser("save")
    save.add_argument("id")
    save.add_argument("checkout", help="checkout path on the server")
    save.add_argument("--name", help="display name, defaults to id")
    save.add_argument("--python")
    save.add_argument("--cache")
    activate = profiles.add_parser("activate")
    activate.add_argument("id")
    activate.add_argument("--anchor", help="optional native {sim_time_s,q,qd} JSON object")
    return result


def run(args, client, stdin):
    if args.operation == "get":
        if args.group != "all":
            return client.request(READS[args.group])
        # Each service has its own lifetime; preserve useful metadata when Live
        # is unavailable. This is a diagnostic snapshot, not an atomic transaction.
        snapshots = {}
        for name in ("live", "presentation", "source", "profiles"):
            try:
                snapshots[name] = client.request(READS[name])
            except ControlError as error:
                snapshots[name] = {"error": str(error), "status": error.status}
        return snapshots
    if args.operation == "patch":
        patch = json_object(args.json, stdin)
        if args.group == "presentation":
            if args.expected_version is not None or args.anchor is not None or args.reset:
                raise ValueError("Version, anchor and reset options apply only to Live settings")
            return client.request("/api/presentation/settings/patch", patch)
        body = {"type": "patch_settings", "patch": patch}
        if args.expected_version is not None:
            if args.expected_version < 0:
                raise ValueError("Expected version must be nonnegative")
            body["expected_settings_version"] = args.expected_version
        if args.anchor is not None:
            if args.reset:
                raise ValueError("Choose an anchor or reset, not both")
            body["anchor"] = json_object(args.anchor, stdin)
        if args.reset:
            body["reset"] = True
        return client.request("/api/live/command", body)
    if args.operation == "command":
        body = {"type": args.type}
        if args.anchor is not None:
            if args.type not in ("preview", "precalculate"):
                raise ValueError("Only preview and precalculate accept an anchor")
            body["anchor"] = json_object(args.anchor, stdin)
        return client.request("/api/live/command", body)
    if args.operation == "source":
        body = {"mpc_root": args.checkout}
        for key in ("python", "cache"):
            if getattr(args, key) is not None:
                body[key] = getattr(args, key)
        return client.request(f"/api/source/{args.action}", body)
    if args.operation == "profile":
        if args.action == "activate":
            body = {"profile_id": args.id}
            if args.anchor is not None:
                body["anchor"] = json_object(args.anchor, stdin)
            return client.request("/api/solver-profiles/activate", body)
        profile = {"id": args.id, "name": args.name or args.id, "mpc_root": args.checkout}
        for key in ("python", "cache"):
            if getattr(args, key) is not None:
                profile[key] = getattr(args, key)
        return client.request("/api/solver-profiles", {"profile": profile})
    raise ValueError("Unknown operation")


def main(argv=None, *, stdin=None, stdout=None, stderr=None, opener=urlopen):
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    args = parser().parse_args(argv)
    try:
        if not math.isfinite(args.timeout) or args.timeout <= 0:
            raise ValueError("Timeout must be finite and positive")
        if not args.url.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        result = run(args, Client(args.url, args.timeout, opener), stdin)
        print(json.dumps(result, indent=2, allow_nan=False), file=stdout)
        return 0
    except (ControlError, ValueError, OSError) as error:
        payload = {"error": str(error)}
        if isinstance(error, ControlError):
            if isinstance(error.payload, dict):
                payload.update(error.payload)
            if error.status is not None:
                payload["status"] = error.status
        print(json.dumps(payload, indent=2, allow_nan=False), file=stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
