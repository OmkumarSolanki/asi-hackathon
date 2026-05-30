#!/usr/bin/env bash
# Launch the "Don't Crash!" cockpit dashboard (single Flask app). Ctrl-C stops it.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-5000}"
echo "==> Don't Crash! — starting cockpit dashboard"

# Free the port if something is already on it.
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

# Prefer the project venv if present; fall back to system python.
PY="python3"
[ -x ".venv/bin/python" ] && PY=".venv/bin/python"

echo "==> http://127.0.0.1:${PORT}"
echo "Press Ctrl-C to stop."
PORT="$PORT" exec "$PY" webapp.py
