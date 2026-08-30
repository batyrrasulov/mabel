from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_truncate_mcp_tool_response_for_agent_bounds_payload() -> None:
    from mabel_api.mcp.tool_response_compact import truncate_mcp_tool_response_for_agent

    huge = "x" * 50_000
    resp = {"jsonrpc": "2.0", "result": {"content": [{"type": "text", "text": huge}]}}
    out = truncate_mcp_tool_response_for_agent(resp, max_chars=8_000)
    assert len(json.dumps(out)) <= 8_000
    inner = out["result"]["content"][0]["text"]
    assert len(inner) < len(huge)
    assert "truncated" in inner


def test_truncate_bounds_tools_list_shape() -> None:
    """tools/list style payloads (schemas per tool) must shrink under the cap."""

    from mabel_api.mcp.tool_response_compact import truncate_mcp_tool_response_for_agent

    schema = "z" * 5_000
    tools = [
        {"name": f"t{i}", "description": "d", "inputSchema": {"type": "object", "raw": schema}}
        for i in range(40)
    ]
    payload = {"status": "ok", "server_slug": "carlos", "tools": tools}
    out = truncate_mcp_tool_response_for_agent(payload, max_chars=6_144)
    assert len(json.dumps(out)) <= 6_144
