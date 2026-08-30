"""Bound MCP tool JSON payloads before they enter the agent session."""

from __future__ import annotations

import json
from typing import Any


def truncate_mcp_tool_response_for_agent(response: Any, *, max_chars: int) -> Any:
    """Shrink MCP JSON-RPC payloads before they enter the agent session.

    Connectors can return large transcripts or datasets; returning them verbatim
    can push the next model request over the provider context limit.
    """

    if max_chars <= 0 or response is None:
        return response
    try:
        normalized = json.loads(json.dumps(response, default=str))
    except (TypeError, ValueError):
        return response

    def _clip_str(s: str, cap: int) -> str:
        if cap <= 0 or len(s) <= cap:
            return s
        keep = max(120, cap - 96)
        return f"{s[:keep]}\n… [truncated {len(s) - keep} chars]"

    def _clip(obj: Any, cap: int) -> Any:
        if isinstance(obj, str):
            return _clip_str(obj, cap)
        if isinstance(obj, dict):
            return {str(k): _clip(v, cap) for k, v in obj.items()}
        if isinstance(obj, list):
            if len(obj) > 300:
                head = [_clip(v, cap) for v in obj[:300]]
                head.append({"_mabel_truncated_list_tail": len(obj) - 300})
                return head
            return [_clip(v, cap) for v in obj]
        return obj

    per = min(12_000, max(1_200, max_chars // 2))
    for _ in range(14):
        clipped = _clip(normalized, per)
        try:
            text = json.dumps(clipped, default=str)
        except (TypeError, ValueError):
            return response
        if len(text) <= max_chars:
            return clipped
        per = max(400, int(per * 0.55))

    try:
        tiny = _clip(normalized, 400)
        text2 = json.dumps(tiny, default=str)
    except (TypeError, ValueError):
        return response
    if len(text2) <= max_chars:
        return tiny
    msg = "Tool JSON exceeds max_chars after truncation."
    wrapper_overhead = len(json.dumps({"_mabel_mcp_truncated": True, "message": msg, "preview": ""}, default=str))
    preview_budget = max(0, max_chars - wrapper_overhead - 32)
    for preview_len in (preview_budget, max(0, preview_budget // 2), max(0, preview_budget // 4), 0):
        candidate = {"_mabel_mcp_truncated": True, "message": msg, "preview": text2[:preview_len]}
        try:
            dumped = json.dumps(candidate, default=str)
        except (TypeError, ValueError):
            return {"_mabel_mcp_truncated": True, "message": msg}
        if len(dumped) <= max_chars:
            return candidate
    return {"_mabel_mcp_truncated": True, "message": msg}
