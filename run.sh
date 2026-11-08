#!/usr/bin/env bash
# One-command start: creates venv, installs deps, runs the app on :8000
set -e
cd "$(dirname "$0")/backend"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
echo "→ http://localhost:8000   (share with friends: npx cloudflared tunnel --url http://localhost:8000)"
exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload
