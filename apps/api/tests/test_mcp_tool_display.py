from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_infer_tool_description_for_connector_tools() -> None:
    from mabel_api.mcp.tool_display import infer_tool_description

    assert infer_tool_description("github_health_check", "github") == "Github MCP and upstream health check."
    assert infer_tool_description("github_get_issues", "github") == "Fetch issues from Github."
    assert infer_tool_description("github_get_repository", "github") == "Fetch repository from Github."


def test_normalize_preserves_upstream_description() -> None:
    from mabel_api.mcp.tool_display import normalize_mcp_tool_for_display

    tool = {
        "name": "github_health",
        "description": "GitHub MCP and upstream API health check.",
    }
    out = normalize_mcp_tool_for_display(tool, "github")
    assert out["description"] == tool["description"]


def test_normalize_fills_missing_description() -> None:
    from mabel_api.mcp.tool_display import normalize_mcp_tool_for_display

    out = normalize_mcp_tool_for_display({"name": "github_get_issues"}, "github")
    assert out["description"] == "Fetch issues from Github."


def test_normalize_replaces_long_upstream_with_short_infer() -> None:
    from mabel_api.mcp.tool_display import normalize_mcp_tool_for_display

    out = normalize_mcp_tool_for_display(
        {
            "name": "github_get_pull_request",
            "description": "Retrieve a complete pull request record with comments, reviews, checks, commits, and repository metadata.",
        },
        "github",
    )
    assert len(out["description"]) <= 72
    assert out["description"] == "Fetch pull request from Github."


def test_compact_tool_description_is_single_line() -> None:
    from mabel_api.mcp.tool_display import compact_tool_description

    text = "line one\nline two " + ("x" * 120)
    out = compact_tool_description(text, max_chars=96)
    assert "\n" not in out
    assert len(out) <= 96
