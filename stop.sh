#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/.runtime/server.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Server is not running"
  exit 0
fi

PID="$(cat "$PID_FILE")"

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped point-cloud-visualizer server (PID $PID)"
else
  echo "Process $PID was not running"
fi

rm -f "$PID_FILE"
