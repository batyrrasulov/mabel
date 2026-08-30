from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient


HEADERS = {
    "x-user-email": "developer@mabel.local",
    "x-user-id": "developer-1",
}
ADMIN_HEADERS = {
    **HEADERS,
    "x-user-groups": "mabel-admins",
}


def test_local_registry_accepts_only_loopback_endpoints(monkeypatch) -> None:
    monkeypatch.setenv(
        "MABEL_LOCAL_MCP_ENDPOINTS_JSON",
        json.dumps(
            {
                "local-example": "http://127.0.0.1:8111/mcp",
                "remote": "https://example.com/mcp",
            }
        ),
    )

    from mabel_api.mcp.manager import LocalMcpRegistry
    from mabel_api.settings import MabelSettings

    registry = LocalMcpRegistry.from_settings(MabelSettings.load())
    assert registry.endpoint_for("local-example") == "http://127.0.0.1:8111/mcp"
    with pytest.raises(ValueError, match="loopback"):
        registry.endpoint_for("remote")


def test_connector_aliases_are_canonicalized(monkeypatch) -> None:
    monkeypatch.setenv(
        "MABEL_LOCAL_MCP_ENDPOINTS_JSON",
        json.dumps({"google-analytics": "http://127.0.0.1:8333/mcp"}),
    )

    from mabel_api.mcp.manager import LocalMcpRegistry
    from mabel_api.settings import MabelSettings

    registry = LocalMcpRegistry.from_settings(MabelSettings.load())
    assert registry.endpoint_for("google-analytics-mcp") == "http://127.0.0.1:8333/mcp"


def test_remote_gateway_target_is_environment_driven(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_MCP_GATEWAY_PROXY_BASE_URL", "http://127.0.0.1:8811")
    monkeypatch.setenv("MABEL_MCP_GATEWAY_PROFILE", "default")
    monkeypatch.setenv("MABEL_REMOTE_GATEWAY_ORG", "mabel-labs")
    monkeypatch.setenv("MABEL_REMOTE_GATEWAY_RUNTIME_TOKEN", "runtime-token")

    from mabel_api.mcp.remote_gateway import mcp_target_for_server
    from mabel_api.settings import MabelSettings

    target = mcp_target_for_server(MabelSettings.load(), "github")
    assert target is not None
    assert target.endpoint == (
        "http://127.0.0.1:8811/v1/mcp_gateway/github"
        "?profile=default&org=mabel-labs"
    )
    assert target.headers == {"Authorization": "Bearer runtime-token"}


def test_tool_scope_and_policy_are_explicit(monkeypatch) -> None:
    monkeypatch.setenv(
        "MABEL_MCP_TOOL_POLICY_RULES_JSON",
        json.dumps(
            [
                {
                    "server": "github",
                    "tool": "*delete*",
                    "decision": "deny",
                }
            ]
        ),
    )

    from mabel_api.mcp.manager import evaluate_tool_policy, infer_tool_scope
    from mabel_api.settings import MabelSettings

    assert infer_tool_scope("github_get_issue") == "read"
    assert infer_tool_scope("github_create_issue") == "create"
    assert infer_tool_scope("github_delete_branch") == "delete"
    assert (
        evaluate_tool_policy(
            MabelSettings.load(),
            server_slug="github",
            tool_name="github_delete_branch",
            scope="delete",
        )
        == "deny"
    )


def test_default_tool_policy_fails_closed_for_mutations(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_MCP_TOOL_POLICY_RULES_JSON", "[]")

    from mabel_api.mcp.manager import evaluate_tool_policy
    from mabel_api.settings import MabelSettings

    settings = MabelSettings.load()
    assert evaluate_tool_policy(
        settings,
        server_slug="github",
        tool_name="github_get_issue",
        scope="read",
    ) == "allow"
    assert evaluate_tool_policy(
        settings,
        server_slug="github",
        tool_name="github_create_issue",
        scope="create",
    ) == "ask"
    assert evaluate_tool_policy(
        settings,
        server_slug="github",
        tool_name="github_delete_branch",
        scope="delete",
    ) == "deny"


def test_tools_list_uses_local_connector_and_updates_snapshot(monkeypatch) -> None:
    monkeypatch.setenv(
        "MABEL_LOCAL_MCP_ENDPOINTS_JSON",
        json.dumps({"github": "http://127.0.0.1:8111/mcp"}),
    )

    from mabel_api.main import build_app
    from mabel_api.mcp import manager

    async def fake_post_mcp_json(**kwargs):
        payload = kwargs["payload"]
        return {
            "jsonrpc": "2.0",
            "id": payload.get("id"),
            "result": {
                "tools": [
                    {
                        "name": "github_get_issue",
                        "description": "Get one issue.",
                        "inputSchema": {"type": "object"},
                    }
                ]
            },
        }

    monkeypatch.setattr(manager, "post_mcp_json", fake_post_mcp_json)
    client = TestClient(build_app())

    response = client.post("/api/v1/mcp/github/tools/list", headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["tools"][0]["name"] == "github_get_issue"

    bootstrap = client.get("/api/v1/bootstrap", headers=HEADERS).json()
    github = next(row for row in bootstrap["connectors"] if row["id"] == "github")
    assert github["connection_status"] == "connected"
    assert github["tool_count"] == 1


def test_tool_call_returns_connector_result(monkeypatch) -> None:
    monkeypatch.setenv(
        "MABEL_LOCAL_MCP_ENDPOINTS_JSON",
        json.dumps({"github": "http://127.0.0.1:8111/mcp"}),
    )

    from mabel_api.main import build_app
    from mabel_api.mcp import manager

    async def fake_post_mcp_json(**kwargs):
        payload = kwargs["payload"]
        return {
            "jsonrpc": "2.0",
            "id": payload.get("id"),
            "result": {"content": [{"type": "text", "text": '{"ok": true}'}]},
        }

    monkeypatch.setattr(manager, "post_mcp_json", fake_post_mcp_json)
    client = TestClient(build_app())
    response = client.post(
        "/api/v1/mcp/github/tools/call",
        headers=HEADERS,
        json={"name": "github_get_issue", "arguments": {"number": 1}},
    )

    assert response.status_code == 200
    assert response.json()["response"]["result"]["content"][0]["text"] == '{"ok": true}'


def test_disabled_connector_rejects_tool_call(monkeypatch) -> None:
    monkeypatch.setenv(
        "MABEL_LOCAL_MCP_ENDPOINTS_JSON",
        json.dumps({"github": "http://127.0.0.1:8111/mcp"}),
    )

    from mabel_api.main import build_app

    client = TestClient(build_app())
    forbidden = client.post(
        "/api/v1/mcp/github/state",
        headers=HEADERS,
        json={"enabled": False},
    )
    assert forbidden.status_code == 403

    disabled = client.post(
        "/api/v1/mcp/github/state",
        headers=ADMIN_HEADERS,
        json={"enabled": False},
    )
    assert disabled.status_code == 200

    response = client.post(
        "/api/v1/mcp/github/tools/call",
        headers=HEADERS,
        json={"name": "github_get_issue", "arguments": {"number": 1}},
    )
    assert response.status_code == 409


def test_ask_policy_creates_approval_without_executing_tool(monkeypatch) -> None:
    monkeypatch.setenv(
        "MABEL_LOCAL_MCP_ENDPOINTS_JSON",
        json.dumps({"github": "http://127.0.0.1:8111/mcp"}),
    )
    monkeypatch.setenv(
        "MABEL_MCP_TOOL_POLICY_RULES_JSON",
        json.dumps(
            [
                {
                    "server": "github",
                    "tool": "github_create_issue",
                    "scope": "create",
                    "decision": "ask",
                }
            ]
        ),
    )

    from mabel_api.main import build_app
    from mabel_api.mcp import manager

    async def fail_if_called(**_kwargs):
        raise AssertionError("ask policy must not execute before approval")

    monkeypatch.setattr(manager, "post_mcp_json", fail_if_called)
    client = TestClient(build_app())
    response = client.post(
        "/api/v1/mcp/github/tools/call",
        headers=HEADERS,
        json={
            "name": "github_create_issue",
            "arguments": {"title": "Approval test"},
        },
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["message"] == "approval required"
    assert detail["approval_id"].startswith("approval_")

    bootstrap = client.get("/api/v1/bootstrap", headers=HEADERS)
    approvals = bootstrap.json()["approvals"]
    assert len(approvals) == 1
    assert approvals[0]["id"] == detail["approval_id"]
