#!/usr/bin/env bash
set -euo pipefail
visualizer_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mpc_root="${TIAGO_MPC_ROOT:-$(dirname -- "$visualizer_root")/tiago_mpc}"
# The host uses venv-host; the container's .venv is the fallback there, because
# venv-host's interpreter links to a host-only Python that the container lacks.
default_python="$mpc_root/venv-host/bin/python"
[[ -x "$default_python" ]] || default_python="$mpc_root/.venv/bin/python"
python_bin="${TIAGO_PYTHON:-$default_python}"
if [[ ! -x "$python_bin" ]]; then
  echo "Python environment missing: $python_bin" >&2
  echo "Set TIAGO_MPC_ROOT to a prepared tiago_mpc checkout, or TIAGO_PYTHON to Python with numpy and pinocchio." >&2
  exit 1
fi
cd -- "$visualizer_root"
mkdir -p "$visualizer_root/_expr_data/tmp"
export TMPDIR="$visualizer_root/_expr_data/tmp"
export PYTHONPYCACHEPREFIX="$visualizer_root/.cache/pycache"
if [[ "${1:-}" == "--prebuild" ]]; then
  shift
  exec "$python_bin" scripts/prebuild.py --mpc-root "$mpc_root" "$@"
fi
if [[ ! -d node_modules ]]; then
  npm --cache "$visualizer_root/.cache/npm" --logs-dir "$visualizer_root/_expr_data/npm-logs" ci
fi
npm run build
exec "$python_bin" server.py --mpc-root "$mpc_root" "$@"
