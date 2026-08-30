from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_mabel_workspace_context_payload_fits_catalog_cap(monkeypatch) -> None:
    from mabel_api.agents.runtime import build_mabel_workspace_context_payload
    from mabel_api.db import get_store
    from mabel_api.mcp.tool_response_compact import truncate_mcp_tool_response_for_agent
    from mabel_api.settings import MabelSettings

    store = get_store(MabelSettings.load())
    payload = build_mabel_workspace_context_payload(store)
    compact = truncate_mcp_tool_response_for_agent(payload, max_chars=10_000)

    assert isinstance(compact, dict)
    assert not compact.get("_mabel_mcp_truncated")
    assert {"connectors", "skills", "starter_packs"} <= set(compact.keys())
    if compact["connectors"]:
        assert all({"id", "name", "status", "tool_count"} <= set(row.keys()) for row in compact["connectors"])
    assert len(json.dumps(compact, default=str)) <= 10_000
