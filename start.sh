#!/usr/bin/env bash
# Launch both servers for the demo. Ctrl-C kills both.
set -e
cd "$(dirname "$0")"

echo "==> WX Advisory — starting backend + frontend"
echo

# Kill anything on our ports first
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true

(cd backend && source .venv/bin/activate && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload) &
BACKEND_PID=$!

(cd frontend && npm run dev) &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM

echo
echo "==> Backend  → http://127.0.0.1:8000"
echo "==> Frontend → http://localhost:5173"
echo
echo "Press Ctrl-C to stop."
wait
