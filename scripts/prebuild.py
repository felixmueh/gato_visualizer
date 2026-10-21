#!/usr/bin/env python3
"""Explicitly build selected-source binaries; never locks or pauses GPU work."""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from source_runtime import build_command
from visualizer_config import DEFAULT_CONFIG, effective_source_selection, load_visualizer_config


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--mpc-root', type=Path)
    parser.add_argument('--N', type=int, nargs='+', default=[16, 32, 64, 128])
    parser.add_argument('--rebuild', action='store_true')
    args = parser.parse_args(argv)
    try:
        selection = effective_source_selection(load_visualizer_config(args.config), args.mpc_root)
        command, environment = build_command(selection, args.N, rebuild=args.rebuild)
        return subprocess.call(command, env=environment, cwd=ROOT)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'Build setup error: {exc}\n')


if __name__ == '__main__':
    raise SystemExit(main())
