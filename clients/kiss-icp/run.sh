#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$ROOT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing $ROOT_DIR/.venv; run $ROOT_DIR/setup.sh first" >&2
  exit 1
fi

exec "$PYTHON" -m pcv_kiss_icp.publisher "$@"

