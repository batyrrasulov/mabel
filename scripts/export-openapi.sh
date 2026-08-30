#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MABEL_STORE_MODE=memory \
MABEL_AUTH_MODE=development \
"$ROOT/.venv/bin/python" -c '
import json
from pathlib import Path

from mabel_api.main import build_app

Path("docs/openapi.json").write_text(
    json.dumps(build_app().openapi(), indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
'
