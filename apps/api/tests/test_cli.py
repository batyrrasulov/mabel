from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_cli_backfill_normalized_memory_mode(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    monkeypatch.setattr(sys, "argv", ["mabel-api", "backfill-normalized"])

    from mabel_api.cli import main

    main()
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["status"] == "ok"
    assert "backfilled" in payload
    assert "conversations" in payload["backfilled"]


def test_cli_normalized_status_memory_mode(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    monkeypatch.setattr(sys, "argv", ["mabel-api", "normalized-status"])

    from mabel_api.cli import main

    main()
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["status"] == "ok"
    assert payload["normalization"]["store"] == "memory"
    assert payload["normalization"]["ready_for_strict_reads"] is False


def test_cli_assert_normalized_ready_fails_in_memory_mode(monkeypatch, capsys) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    monkeypatch.setattr(sys, "argv", ["mabel-api", "assert-normalized-ready"])

    from mabel_api.cli import main

    try:
        main()
        raise AssertionError("expected assert-normalized-ready to exit non-zero for memory store")
    except SystemExit as exc:
        assert exc.code == 2
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["status"] == "not_ready"
