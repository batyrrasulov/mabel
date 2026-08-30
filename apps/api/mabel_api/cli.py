from __future__ import annotations

import argparse
import json

import uvicorn

from .db import get_store
from .settings import MabelSettings


def main() -> None:
    parser = argparse.ArgumentParser(prog="mabel-api")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)

    sub.add_parser("init-db")
    sub.add_parser("backfill-normalized")
    sub.add_parser("normalized-status")
    sub.add_parser("assert-normalized-ready")

    args = parser.parse_args()
    settings = MabelSettings.load()

    if args.command == "init-db":
        get_store(settings).init()
        return

    if args.command == "backfill-normalized":
        stats = get_store(settings).backfill_normalized_tables()
        print(json.dumps({"status": "ok", "backfilled": stats}, separators=(",", ":")))
        return

    if args.command == "normalized-status":
        status = get_store(settings).normalization_status()
        print(json.dumps({"status": "ok", "normalization": status}, separators=(",", ":")))
        return

    if args.command == "assert-normalized-ready":
        status = get_store(settings).normalization_status()
        ready = bool(status.get("ready_for_strict_reads"))
        print(json.dumps({"status": "ok" if ready else "not_ready", "normalization": status}, separators=(",", ":")))
        if not ready:
            raise SystemExit(2)
        return

    if args.command == "serve":
        uvicorn.run(
            "mabel_api.main:app",
            host=args.host or settings.host,
            port=args.port or settings.port,
            reload=False,
        )
        return

    raise SystemExit(f"Unsupported command: {args.command}")
