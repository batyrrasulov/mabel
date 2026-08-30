"""One-line MCP tool descriptions for the Connectors UI."""

from __future__ import annotations

import re
from typing import Any

_DEFAULT_MAX_DESCRIPTION_CHARS = 72

_CONNECTOR_LABELS: dict[str, str] = {}


def connector_display_label(server_slug: str) -> str:
    slug = server_slug.strip().lower()
    if slug in _CONNECTOR_LABELS:
        return _CONNECTOR_LABELS[slug]
    return re.sub(r"\s+", " ", slug.replace("-", " ").replace("_", " ")).strip().title()


def compact_tool_description(description: str, *, max_chars: int = _DEFAULT_MAX_DESCRIPTION_CHARS) -> str:
    text = " ".join(description.split())
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    clipped = text[: max_chars - 1].rsplit(" ", 1)[0]
    return f"{clipped or text[: max_chars - 1]}…"


def _strip_connector_prefix(tool_name: str, server_slug: str) -> str:
    name = tool_name.strip()
    slug = server_slug.strip().lower()
    if not name or not slug:
        return name
    slug_variants = {slug, slug.replace("-", "_"), slug.replace("_", "-")}
    lowered = name.lower()
    for variant in slug_variants:
        for prefix in (f"{variant}_", f"{variant}-"):
            if lowered.startswith(prefix):
                return name[len(prefix) :]
    return name


def infer_tool_description(tool_name: str, server_slug: str) -> str:
    display = connector_display_label(server_slug)
    words = _strip_connector_prefix(tool_name, server_slug).replace("_", " ").strip()
    lower = words.lower()

    if not words:
        return f"{display} MCP tool."

    if lower in {"health", "health check"} or lower.endswith("health check"):
        return f"{display} MCP and upstream health check."
    if lower.startswith("get "):
        return f"Fetch {words[4:]} from {display}."
    if lower.startswith("list "):
        return f"List {words[5:]} from {display}."
    if lower.startswith("search "):
        return f"Search {words[7:]} via {display}."
    if lower.startswith("calculate "):
        return f"Calculate {words[10:]} via {display}."
    if lower.startswith("find "):
        return f"Find {words[5:]} via {display}."
    if lower == "chat" or lower.startswith("chat "):
        return f"Chat with {display}."

    return f"{words[0].upper()}{words[1:]} via {display}."


def normalize_mcp_tool_for_display(tool: dict[str, Any], server_slug: str) -> dict[str, Any]:
    name = str(tool.get("name") or "").strip()
    raw = tool.get("description")
    description = raw.strip() if isinstance(raw, str) else ""
    if not description or len(description) > _DEFAULT_MAX_DESCRIPTION_CHARS:
        description = infer_tool_description(name, server_slug)
    out = dict(tool)
    out["description"] = compact_tool_description(description)
    return out


def normalize_mcp_tools_for_display(tools: list[dict[str, Any]], server_slug: str) -> list[dict[str, Any]]:
    return [normalize_mcp_tool_for_display(tool, server_slug) for tool in tools if isinstance(tool, dict)]
