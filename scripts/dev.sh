#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV="$ROOT/.venv"

if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$VENV"
fi

"$VENV/bin/pip" install -e "$ROOT/apps/api[dev]"
npm install

export MABEL_STORE_MODE="${MABEL_STORE_MODE:-memory}"
export MABEL_AUTH_MODE="${MABEL_AUTH_MODE:-development}"

"$VENV/bin/mabel-api" serve --host "${MABEL_HOST:-127.0.0.1}" --port "${MABEL_PORT:-8820}" &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

npm run dev --workspace @mabel/web
