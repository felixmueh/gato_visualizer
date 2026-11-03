#!/usr/bin/env bash
set -euo pipefail
visualizer_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$visualizer_root"
unset PYTHONPATH  # uv's selected environment owns GATO; no inherited source-tree override.
# Resolve saved selection before importing numpy/pinocchio. CLI/environment
# overrides retain precedence; Source / Build Apply saves its own new selection.
if [[ "${1:-}" == "--prebuild" ]]; then
  shift
  python_bin="$(python3 scripts/launch_python.py "$@")"
  exec "$python_bin" scripts/prebuild.py "$@"
fi
python_bin="$(python3 scripts/launch_python.py "$@")"
export PYTHONPYCACHEPREFIX="$visualizer_root/.cache/pycache"
if [[ ! -d node_modules ]]; then
  npm --cache "$visualizer_root/.cache/npm" --logs-dir "$visualizer_root/_expr_data/npm-logs" ci
fi
npm run build
exec "$python_bin" server.py "$@"
