#!/usr/bin/env bash
set -euo pipefail
visualizer_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$visualizer_root"
# Resolve saved selection before importing numpy/pinocchio. CLI/environment
# overrides retain precedence; Source / Build Apply saves its own new selection.
if [[ "${1:-}" == "--prebuild" ]]; then
  shift
  python_bin="$(python3 scripts/launch_python.py "$@")"
  exec "$python_bin" scripts/prebuild.py "$@"
fi
python_bin="$(python3 scripts/launch_python.py "$@")"
# Temporary files (compiler intermediates of Build, Node's compile cache) are runtime
# scratch: RAM-backed like the Live history (runtime_files.py; Felix, 2026-10-23).
runtime_dir="${TIAGO_VISUALIZER_RUNTIME_DIR:-/dev/shm/tiago-mpc-visualizer-$(id -u)}"
(umask 077 && mkdir -p "$runtime_dir/tmp")
export TMPDIR="$runtime_dir/tmp"
export PYTHONPYCACHEPREFIX="$visualizer_root/.cache/pycache"
if [[ ! -d node_modules ]]; then
  npm --cache "$visualizer_root/.cache/npm" --logs-dir "$visualizer_root/_expr_data/npm-logs" ci
fi
npm run build
exec "$python_bin" server.py "$@"
