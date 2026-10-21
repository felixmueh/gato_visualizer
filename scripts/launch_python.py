#!/usr/bin/env python3
"""Resolve startup interpreter with stdlib only, before importing robot packages."""
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from visualizer_config import DEFAULT_CONFIG, effective_source_selection, load_visualizer_config

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
parser.add_argument('--mpc-root', type=Path)
args, _ = parser.parse_known_args()
try:
    print(effective_source_selection(load_visualizer_config(args.config), args.mpc_root)['python'])
except (ValueError, OSError) as exc:
    parser.exit(1, f'Source setup error: {exc}\n')
