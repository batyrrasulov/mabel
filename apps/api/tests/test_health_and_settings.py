from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_healthz_and_deep_health_return_v2_identity(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "true")
    monkeypatch.setenv("MABEL_OPENAI_API_KEY", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("MABEL_LOCAL_MCP_ENDPOINTS_JSON", '{"local-example":"http://127.0.0.1:8111/mcp"}')
    monkeypatch.setenv("MABEL_MCP_GATEWAY_LOCAL_ENDPOINTS_JSON", "")
    monkeypatch.setenv("MABEL_MCP_GATEWAY_LOCAL_ENDPOINT_ANIKA", "")
    monkeypatch.setenv("MABEL_MCP_GATEWAY_LOCAL_ENDPOINT_ZARA", "")
    monkeypatch.setenv("MABEL_MCP_GATEWAY_LOCAL_BYPASS_ENABLED", "false")
    monkeypatch.setenv("MABEL_MCP_GATEWAY_LOCAL_BYPASS_ENABLED", "false")
    monkeypatch.setenv("MABEL_MCP_GATEWAY_PROXY_BASE_URL", "")
    monkeypatch.setenv("XRAY_MABEL_API_BASE_URL", "")
    monkeypatch.setenv("MABEL_API_BASE_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())

    healthz = client.get("/healthz")
    assert healthz.status_code == 200
    assert healthz.json() == {"status": "ok", "service": "mabel-api"}

    deep = client.get("/api/v1/health/deep")
    assert deep.status_code == 200
    payload = deep.json()
    assert payload["service"] == "mabel-api"
    assert payload["status"] == "ok"
    assert payload["database"]["status"] == "ok"
    assert payload["runtime"]["provider"] == "openai-agents-python"
    assert payload["runtime"]["sdk_package"] == "openai-agents"
    assert isinstance(payload["runtime"]["sdk_installed"], bool)
    assert payload["runtime"]["enabled"] is True
    assert payload["runtime"]["api_key_configured"] is False
    assert payload["runtime"]["ready"] is False
    assert payload["runtime"]["hosted_tools"] == {
        "web_search": True,
        "code_interpreter": True,
        "image_generation": False,
    }
    assert payload["runtime"]["sessions"]["history_limit"] == 80
    assert payload["remote_gateway"]["mcp_gateway_proxy_configured"] is False
    assert payload["remote_gateway"]["mcp_gateway_local_bypass_enabled"] is False
    assert payload["remote_gateway"]["local_endpoint_count"] == 1
    assert payload["remote_gateway"]["local_endpoints_configured"] is True
    assert payload["normalization"]["store"] == "memory"
    assert payload["normalization"]["strict_reads"] is False
    assert payload["normalization"]["ready_for_strict_reads"] is False

    normalization = client.get("/api/v1/health/normalization")
    assert normalization.status_code == 200
    n_payload = normalization.json()
    assert n_payload["store"] == "memory"
    assert n_payload["strict_reads"] is False
    assert "backfill_gap" in n_payload


def test_settings_use_env_driven_values(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_DB_URL", "postgresql://127.0.0.1:5432/mabel_api_test")
    monkeypatch.setenv("MABEL_STORE_MODE", "postgres")
    monkeypatch.setenv("MABEL_OPENAI_MODEL", "gpt-test-model")
    monkeypatch.setenv("MABEL_REMOTE_GATEWAY_ORG", "test-org")
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "true")
    monkeypatch.setenv("MABEL_OPENAI_API_KEY", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("MABEL_TRACE_INCLUDE_SENSITIVE_DATA", "false")

    from mabel_api.settings import MabelSettings

    settings = MabelSettings.load()

    assert settings.database_url == "postgresql://127.0.0.1:5432/mabel_api_test"
    assert settings.store_mode == "postgres"
    assert settings.openai_model == "gpt-test-model"
    assert settings.openai_api_key is None
    assert settings.remote_gateway_org == "test-org"
    assert settings.openai_agents_enabled is True
    assert settings.trace_include_sensitive_data is False


def test_settings_support_dedicated_skills_github_repo(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_SKILLS_GITHUB_REPO", "batyrrasulov/Mabel")
    monkeypatch.setenv("MABEL_SKILLS_GITHUB_REF", "release")
    monkeypatch.setenv("MABEL_SKILLS_GITHUB_BASE_PATH", "packages/skills")
    monkeypatch.setenv("MABEL_SKILLS_GITHUB_TOKEN", "skills-token")

    from mabel_api.settings import MabelSettings

    settings = MabelSettings.load()

    assert settings.skills_github_repo == "batyrrasulov/Mabel"
    assert settings.skills_github_ref == "release"
    assert settings.skills_github_base_path == "packages/skills"
    assert settings.skills_github_token == "skills-token"


def test_bootstrap_contract_includes_seeded_operational_collections(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    response = client.get("/api/v1/bootstrap", headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["user"]["email"] == "agent@example.com"
    assert payload["surfaces"] == ["chat", "rag", "mcp", "agents"]
    assert any(row["id"] == "local-example" for row in payload["connectors"])
    assert any(row["id"] == "skill.research-brief" for row in payload["skills"])
    assert any(row["id"] == "workflow-pack.start-my-day" for row in payload["starter_packs"])
    assert payload["approvals"] == []


def test_bootstrap_keeps_disabled_connectors_visible_for_reenable(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {
        "x-user-email": "admin@example.com",
        "x-user-id": "admin-1",
        "x-user-groups": "mabel-admins",
    }

    disable_response = client.post("/api/v1/mcp/local-example/state", headers=headers, json={"enabled": False})
    assert disable_response.status_code == 200

    bootstrap = client.get("/api/v1/bootstrap", headers=headers)
    assert bootstrap.status_code == 200
    connectors = bootstrap.json().get("connectors", [])
    connector = next((row for row in connectors if row.get("id") == "local-example"), None)
    assert connector is not None
    assert connector.get("enabled") is False
