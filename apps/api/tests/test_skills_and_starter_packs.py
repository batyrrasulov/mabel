from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_skill_create_search_detail_and_run(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    create = client.post(
        "/api/v1/skills",
        headers={"x-user-email": "builder@example.com", "x-user-id": "builder-1"},
        json={
            "id": "skill.mabel-style-guide",
            "name": "Mabel Style Guide",
            "owner_team": "builder@example.com",
            "content_md": "# Mabel Style Guide\n\nUse Mabel voice, tone, and terminology.",
            "description": "Apply approved Mabel brand voice and terminology.",
            "tags": ["brand", "voice"],
            "mcp_bindings": [],
        },
    )

    assert create.status_code == 200
    assert create.json()["skill"]["status"] == "published"
    assert create.json()["skill"]["description"] == "Apply approved Mabel brand voice and terminology."
    assert create.json()["skill"]["created_at"]
    assert create.json()["skill"]["updated_at"]

    search = client.get("/api/v1/skills", headers={"x-user-email": "builder@example.com", "x-user-id": "builder-1"}, params={"query": "brand"})
    assert search.status_code == 200
    assert search.json()["skills"][0]["id"] == "skill.mabel-style-guide"
    assert search.json()["skills"][0]["created_at"]

    detail = client.get("/api/v1/skills/skill.mabel-style-guide", headers={"x-user-email": "builder@example.com", "x-user-id": "builder-1"})
    assert detail.status_code == 200
    assert detail.json()["skill"]["mcp_bindings"] == []
    assert detail.json()["skill"]["updated_at"]

    run = client.post(
        "/api/v1/skills/skill.mabel-style-guide/run",
        headers={"x-user-email": "builder@example.com", "x-user-id": "builder-1"},
        json={"prompt": "Make this copy sound like Mabel."},
    )
    assert run.status_code == 200
    payload = run.json()
    assert payload["status"] == "completed"
    assert payload["skill"]["id"] == "skill.mabel-style-guide"
    assert "Mabel Style Guide" in payload["assistant_text"]
    assert payload["sources_required"] is True


def test_skill_search_returns_ranked_matches_with_snippets(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "builder@example.com", "x-user-id": "builder-1"}
    payloads = [
        {
            "id": "skill.mabel-style-guide",
            "name": "Mabel Style Guide",
            "owner_team": "builder@example.com",
            "content_md": "# Mabel Style Guide\n\nUse approved brand voice for customer-facing renewal copy.",
            "tags": ["brand", "renewal"],
            "mcp_bindings": [],
        },
        {
            "id": "skill.general-notes",
            "name": "General Notes",
            "owner_team": "builder@example.com",
            "content_md": "# Notes\n\nGeneral checklist for internal handoff.",
            "tags": ["notes"],
            "mcp_bindings": [],
        },
    ]
    for row in payloads:
        created = client.post("/api/v1/skills", headers=headers, json=row)
        assert created.status_code == 200

    ranked = client.get("/api/v1/skills", headers=headers, params={"query": "brand renewal"})
    assert ranked.status_code == 200
    body = ranked.json()
    assert body["query"] == "brand renewal"
    assert body["skills"][0]["id"] == "skill.mabel-style-guide"
    assert body["skills"][0]["score"] > 0
    assert "snippet" in body["skills"][0]
    assert "content" in body["skills"][0]["matched_fields"]
    assert all(row["id"] != "skill.general-notes" for row in body["skills"])


def test_skills_marketplace_syncs_from_github_registry(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app
    from mabel_api.skill_registry import SkillRegistryEntry

    def fake_fetch(self):
        return [
            SkillRegistryEntry(
                id="skill.marketplace-demo",
                name="Marketplace Demo",
                owner_team="ai-ops",
                status="published",
                version="1.2.3",
                content_md="# Marketplace Demo\n\nUse GitHub.",
                tags=["marketplace"],
                mcp_bindings=[{"server_slug": "github"}],
                source={
                    "type": "github",
                    "repo": "batyrrasulov/Mabel",
                    "path": "packages/skills/marketplace-demo",
                    "visibility": "public",
                },
                description="Demo skill from GitHub.",
            )
        ]

    monkeypatch.setattr("mabel_api.skill_registry.GitHubSkillRegistry.fetch_marketplace", fake_fetch)

    client = TestClient(build_app())
    headers = {"x-user-email": "builder@example.com", "x-user-id": "builder-1"}
    marketplace = client.get("/api/v1/skills/marketplace", headers=headers)
    assert marketplace.status_code == 200
    assert marketplace.json()["skills"][0]["id"] == "skill.marketplace-demo"

    sync = client.post("/api/v1/skills/sync", headers=headers, json={})
    assert sync.status_code == 200
    assert sync.json()["synced"][0]["id"] == "skill.marketplace-demo"

    detail = client.get("/api/v1/skills/skill.marketplace-demo", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["skill"]["current_version"] == "1.2.3"
    assert detail.json()["skill"]["content_md"].startswith("# Marketplace Demo")


def test_github_registry_reads_skill_md_only_marketplace(monkeypatch) -> None:
    from mabel_api.settings import MabelSettings
    from mabel_api.skill_registry import GitHubSkillRegistry

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key=None,
        openai_model="gpt-5.5",
        openai_agents_enabled=False,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path="",
        uploads_dir="",
        uploads_max_bytes=1,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token="token",
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    skill_md = """---
name: bt-ai-champions
description: >
  BT AI Champions workflow orchestrator. Use with Teams and Jira.
---

# BT AI Champions

Run the workflow.
"""

    def fake_get_json(self, path: str):
        assert "Authorization" in self._headers()
        return {
            "tree": [
                {"type": "blob", "path": "library/bt-ai-champions/SKILL.md"},
                {"type": "blob", "path": "library/bt-ai-champions/CONFIGURATION.md"},
            ]
        }

    def fake_get_file_text(self, path: str, *, ref: str | None = None):
        assert path == "library/bt-ai-champions/SKILL.md"
        return skill_md, "sha-skill"

    monkeypatch.setattr(GitHubSkillRegistry, "_get_json", fake_get_json)
    monkeypatch.setattr(GitHubSkillRegistry, "_get_file_text", fake_get_file_text)

    entries = GitHubSkillRegistry(settings).fetch_marketplace()

    assert len(entries) == 1
    entry = entries[0]
    assert entry.id == "skill.bt-ai-champions"
    assert entry.name == "bt-ai-champions"
    assert entry.status == "published"
    assert entry.owner_team == "bt-ai-champions"
    assert entry.description == "BT AI Champions workflow orchestrator. Use with Teams and Jira."
    assert entry.source["repo"] == "batyrrasulov/Mabel"
    assert entry.source["path"] == "library/bt-ai-champions"
    assert entry.source["description"] == "BT AI Champions workflow orchestrator. Use with Teams and Jira."


def test_skills_marketplace_falls_back_to_local_workspace(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app
    from mabel_api.skill_registry import SkillRegistryError

    def fake_fetch(self):
        raise SkillRegistryError("GitHub resource not found for batyrrasulov/Mabel@main")

    monkeypatch.setattr("mabel_api.skill_registry.GitHubSkillRegistry.fetch_marketplace", fake_fetch)

    client = TestClient(build_app())
    headers = {"x-user-email": "builder@example.com", "x-user-id": "builder-1"}
    marketplace = client.get("/api/v1/skills/marketplace", headers=headers)
    assert marketplace.status_code == 200
    payload = marketplace.json()
    assert payload["status"] == "local_fallback"
    assert "GitHub resource not found" in payload["error"]
    assert any(skill["id"] == "skill.research-brief" for skill in payload["skills"])

    sync = client.post("/api/v1/skills/sync", headers=headers, json={})
    assert sync.status_code == 200
    assert sync.json()["status"] == "completed_local_fallback"

    detail = client.get("/api/v1/skills/skill.research-brief", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["skill"]["content_md"].startswith("# Research Brief")


def test_skill_share_requires_configured_github_token(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    monkeypatch.setenv("MABEL_SKILLS_GITHUB_TOKEN", "")
    monkeypatch.setenv("MABEL_GITHUB_TOKEN", "")
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.setenv("GH_TOKEN", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "builder@example.com", "x-user-id": "builder-1"}
    create = client.post(
        "/api/v1/skills",
        headers=headers,
        json={
            "id": "skill.share-me",
            "name": "Share Me",
            "owner_team": "builder@example.com",
            "content_md": "# Share Me\n\nUse source-backed answers.",
            "tags": ["share"],
            "mcp_bindings": [],
        },
    )
    assert create.status_code == 200

    share = client.post("/api/v1/skills/skill.share-me/share", headers=headers, json={})
    assert share.status_code == 409
    assert "GitHub token" in share.json()["detail"]


def test_account_manager_start_my_day_returns_source_backed_draft_brief(monkeypatch) -> None:
    
    from mabel_api.main import build_app

    client = TestClient(build_app())
    response = client.post(
        "/api/v1/starter-packs/account-manager/start-my-day",
        headers={"x-user-email": "am@example.com", "x-user-id": "am-1"},
        json={
            "date": "2026-05-18",
            "meetings": [
                {
                    "time": "10:00 AM",
                    "account_name": "Acme Hospital",
                    "attendees": ["customer@example.com"],
                    "signals": [
                        {"source": "Salesforce", "text": "Renewal in 45 days"},
                        {"source": "GitHub", "text": "Recent call mentioned SMS volume"},
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["starter_pack"]["id"] == "starter-pack.account-manager"
    assert payload["command"] == "/start-my-day"
    assert payload["status"] == "completed"
    assert payload["draft_first"] is True
    assert payload["briefs"][0]["account_name"] == "Acme Hospital"
    assert payload["briefs"][0]["sources_used"] == ["Salesforce", "GitHub"]
    assert "Human verification needed" in payload["briefs"][0]["sections"]
    assert payload["controlled_actions"][0]["requires_approval"] is True


def test_bootstrap_seeds_catalog_skills_connectors_and_workflows(monkeypatch) -> None:
    from mabel_api.main import build_app

    client = TestClient(build_app())
    client.post(
        "/api/v1/skills",
        headers={"x-user-email": "builder@example.com", "x-user-id": "builder-1"},
        json={
            "id": "skill.legacy-salesforce-draft",
            "name": "Legacy Salesforce Draft",
            "owner_team": "builder@example.com",
            "content_md": "# Legacy Salesforce Draft\n\nUse Salesforce.",
            "tags": ["legacy"],
            "mcp_bindings": [{"server": "salesforce", "tools": ["list_accounts"]}],
        },
    )
    response = client.get(
        "/api/v1/bootstrap",
        headers={"x-user-email": "builder@example.com", "x-user-id": "builder-1"},
    )

    assert response.status_code == 200
    payload = response.json()
    connector_ids = {row["id"] for row in payload["connectors"]}
    skill_ids = {row["id"] for row in payload["skills"]}
    starter_ids = {row["id"] for row in payload["starter_packs"]}
    assert "github" in connector_ids
    assert "skills" not in connector_ids
    assert "product-usage" not in connector_ids
    assert "product_usage" not in connector_ids
    assert all(
        row["connection_status"]
        in {
            "connected",
            "remote_gateway_available",
            "local_package_available",
            "needs_validation",
            "not_configured",
        }
        for row in payload["connectors"]
    )
    assert "skill.research-brief" in skill_ids
    assert "skill.legacy-salesforce-draft" not in skill_ids
    assert starter_ids == {"workflow-pack.start-my-day"}


def test_list_skills_includes_user_created_and_curated_not_marketplace(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app
    from mabel_api.skill_registry import SkillRegistryEntry

    client = TestClient(build_app())
    headers = {"x-user-email": "marco.burgarello@example.com", "x-user-id": "marco-1"}

    create = client.post(
        "/api/v1/skills",
        headers=headers,
        json={
            "id": "skill.internal_communication",
            "name": "Internal Communication",
            "owner_team": "marco.burgarello@example.com",
            "content_md": "# Internal Communication\n\nDraft and rewrite internal comms.",
            "description": "Help with internal communication drafts.",
            "tags": ["communication", "writing"],
            "mcp_bindings": [],
        },
    )
    assert create.status_code == 200

    def fake_fetch(self):
        return [
            SkillRegistryEntry(
                id="skill.marketplace-only",
                name="Marketplace Only",
                owner_team="ai-ops",
                status="published",
                version="1.0.0",
                content_md="# Marketplace Only\n\nSynced from GitHub.",
                tags=["marketplace"],
                mcp_bindings=[],
                source={"type": "github", "repo": "batyrrasulov/Mabel", "path": "packages/skills/marketplace-only"},
                description="Should not appear in default skills list.",
            )
        ]

    monkeypatch.setattr("mabel_api.skill_registry.GitHubSkillRegistry.fetch_marketplace", fake_fetch)
    sync = client.post("/api/v1/skills/sync", headers=headers, json={})
    assert sync.status_code == 200

    listed = client.get("/api/v1/skills", headers=headers)
    assert listed.status_code == 200
    skill_ids = [row["id"] for row in listed.json()["skills"]]

    assert "skill.internal_communication" in skill_ids
    assert "skill.research-brief" in skill_ids
    assert "skill.marketplace-only" not in skill_ids

    curated_index = skill_ids.index("skill.research-brief")
    user_index = skill_ids.index("skill.internal_communication")
    assert curated_index < user_index

    search = client.get(
        "/api/v1/skills",
        headers=headers,
        params={"query": "internal communication"},
    )
    assert search.status_code == 200
    assert any(row["id"] == "skill.internal_communication" for row in search.json()["skills"])

    other_headers = {
        "x-user-email": "someone@example.com",
        "x-user-id": "someone-1",
        "x-user-subject": "user_email:someone@example.com",
        "x-user-groups": "",
    }
    other_listed = client.get("/api/v1/skills", headers=other_headers)
    assert other_listed.status_code == 200
    other_skill_ids = [row["id"] for row in other_listed.json()["skills"]]
    assert "skill.internal_communication" not in other_skill_ids
    assert "skill.research-brief" in other_skill_ids


def test_skill_create_normalizes_placeholder_owner_team(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "user.a@example.com", "x-user-id": "user-a-1"}
    payload = {
        "id": "skill.owner-normalized",
        "name": "Owner Normalized",
        "owner_team": "mabel",
        "content_md": "# Owner Normalized\n\nDraft.",
        "tags": ["owner"],
        "mcp_bindings": [],
    }

    created = client.post("/api/v1/skills", headers=headers, json=payload)
    assert created.status_code == 200
    assert created.json()["skill"]["owner_team"] == "user.a@example.com"

    missing_owner = client.post(
        "/api/v1/skills",
        headers=headers,
        json={
            **payload,
            "id": "skill.owner-missing",
            "owner_team": None,
        },
    )
    assert missing_owner.status_code == 200
    assert missing_owner.json()["skill"]["owner_team"] == "user.a@example.com"


def test_skill_create_rejects_foreign_owner_for_non_privileged_user(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    response = client.post(
        "/api/v1/skills",
        headers={"x-user-email": "user.a@example.com", "x-user-id": "user-a-1"},
        json={
            "id": "skill.foreign-owner",
            "name": "Foreign Owner",
            "owner_team": "user.b@example.com",
            "content_md": "# Foreign Owner\n\nDraft.",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert response.status_code == 403
    assert "owner_team" in str(response.json()["detail"]).lower()


def test_skill_create_duplicate_returns_structured_conflict(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "user.a@example.com", "x-user-id": "user-a-1"}
    body = {
        "id": "skill.duplicate-me",
        "name": "Duplicate Me",
        "owner_team": "mabel",
        "content_md": "# Duplicate Me\n\nDraft.",
        "tags": [],
        "mcp_bindings": [],
    }
    first = client.post("/api/v1/skills", headers=headers, json=body)
    assert first.status_code == 200

    second = client.post("/api/v1/skills", headers=headers, json=body)
    assert second.status_code == 409
    detail = second.json()["detail"]
    assert detail["skill_id"] == "skill.duplicate-me"
    assert detail["existing_owner_team"] == "user.a@example.com"
    assert detail["existing_status"] == "published"
    assert "PATCH /api/v1/skills/skill.duplicate-me" in detail["message"]


def test_skill_create_allows_approver_to_set_foreign_owner(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {
        "x-user-email": "approver@example.com",
        "x-user-id": "approver-1",
        "x-user-groups": "mabel-approvers",
    }
    response = client.post(
        "/api/v1/skills",
        headers=headers,
        json={
            "id": "skill.approver-owned",
            "name": "Approver Owned",
            "owner_team": "user.b@example.com",
            "content_md": "# Approver Owned\n\nDraft.",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert response.status_code == 200
    assert response.json()["skill"]["owner_team"] == "user.b@example.com"


def _attach_skill_share(client, skill_id: str, *, visibility: str, shared_by: str) -> None:
    from mabel_api.db import get_store

    store = get_store(client.app.state.settings)
    skill = store.get_skill(skill_id)
    assert skill is not None
    skill.source = {
        **(skill.source or {}),
        "share": {
            "visibility": visibility,
            "shared_by": shared_by,
            "shared_at": "2026-07-27T00:00:00Z",
        },
    }
    store.update_skill(skill)


def test_published_custom_skill_hidden_until_explicitly_shared(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    creator_headers = {"x-user-email": "user.a@example.com", "x-user-id": "user-a-1"}
    viewer_headers = {"x-user-email": "user.b@example.com", "x-user-id": "user-b-1"}

    created = client.post(
        "/api/v1/skills",
        headers=creator_headers,
        json={
            "id": "skill.publish-policy-smoke",
            "name": "Publish Policy Smoke",
            "owner_team": "mabel",
            "content_md": "# Publish Policy Smoke\n\nPrivate until shared.",
            "tags": ["smoke"],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200
    assert created.json()["skill"]["status"] == "published"

    hidden = client.get("/api/v1/skills", headers=viewer_headers)
    assert hidden.status_code == 200
    hidden_ids = [row["id"] for row in hidden.json()["skills"]]
    assert "skill.publish-policy-smoke" not in hidden_ids

    _attach_skill_share(
        client,
        "skill.publish-policy-smoke",
        visibility="org",
        shared_by="user.a@example.com",
    )
    shared = client.get("/api/v1/skills", headers=viewer_headers)
    assert shared.status_code == 200
    shared_ids = [row["id"] for row in shared.json()["skills"]]
    assert "skill.publish-policy-smoke" in shared_ids


def test_private_share_does_not_expose_custom_skill_to_non_owner(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    creator_headers = {"x-user-email": "ayush.kumar@example.com", "x-user-id": "ayush-1"}
    viewer_headers = {"x-user-email": "seller@example.com", "x-user-id": "seller-1"}

    created = client.post(
        "/api/v1/skills",
        headers=creator_headers,
        json={
            "id": "skill.private-share-smoke",
            "name": "Email Generation v2",
            "owner_team": "mabel",
            "content_md": "# Email Generation v2\n\nPrivate skill.",
            "tags": ["email"],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200

    _attach_skill_share(
        client,
        "skill.private-share-smoke",
        visibility="private",
        shared_by="ayush.kumar@example.com",
    )

    viewer_list = client.get("/api/v1/skills", headers=viewer_headers)
    assert viewer_list.status_code == 200
    assert "skill.private-share-smoke" not in [row["id"] for row in viewer_list.json()["skills"]]


def test_private_skill_direct_routes_enforce_visibility_and_ownership(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    owner_headers = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}
    viewer_headers = {"x-user-email": "viewer@example.com", "x-user-id": "viewer-1"}
    created = client.post(
        "/api/v1/skills",
        headers=owner_headers,
        json={
            "id": "skill.owner-private",
            "name": "Owner Private",
            "owner_team": "owner@example.com",
            "content_md": "# Owner Private\n\nSensitive operating instructions.",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200

    assert client.get(
        "/api/v1/skills/skill.owner-private",
        headers=viewer_headers,
    ).status_code == 404
    assert client.patch(
        "/api/v1/skills/skill.owner-private",
        headers=viewer_headers,
        json={"content_md": "tampered"},
    ).status_code == 403
    assert client.post(
        "/api/v1/skills/skill.owner-private/run",
        headers=viewer_headers,
        json={"prompt": "Run it"},
    ).status_code == 404
    assert client.post(
        "/api/v1/skills/skill.owner-private/share",
        headers=viewer_headers,
        json={"visibility": "public"},
    ).status_code == 404


def test_public_share_exposes_custom_skill_to_other_users(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    creator_headers = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}
    viewer_headers = {"x-user-email": "viewer@elsewhere.com", "x-user-id": "viewer-1"}

    created = client.post(
        "/api/v1/skills",
        headers=creator_headers,
        json={
            "id": "skill.public-share",
            "name": "Public Share",
            "owner_team": "mabel",
            "content_md": "# Public Share\n\nShared globally.",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200

    _attach_skill_share(client, "skill.public-share", visibility="public", shared_by="owner@example.com")

    viewer_list = client.get("/api/v1/skills", headers=viewer_headers)
    assert viewer_list.status_code == 200
    assert "skill.public-share" in [row["id"] for row in viewer_list.json()["skills"]]


def test_approver_can_see_unshared_custom_skills(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    creator_headers = {"x-user-email": "user.a@example.com", "x-user-id": "user-a-1"}
    approver_headers = {
        "x-user-email": "approver@example.com",
        "x-user-id": "approver-1",
        "x-user-groups": "mabel-approvers",
    }

    created = client.post(
        "/api/v1/skills",
        headers=creator_headers,
        json={
            "id": "skill.approver-visible",
            "name": "Approver Visible",
            "owner_team": "mabel",
            "content_md": "# Approver Visible\n\nOwner-only by default.",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200

    approver_list = client.get("/api/v1/skills", headers=approver_headers)
    assert approver_list.status_code == 200
    assert "skill.approver-visible" in [row["id"] for row in approver_list.json()["skills"]]

def test_legacy_draft_custom_skill_remains_owner_scoped(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.catalog import mabel_skill_is_visible
    from mabel_api.main import build_app
    from mabel_api.models import Skill

    client = TestClient(build_app())
    headers = {"x-user-email": "user.a@example.com", "x-user-id": "user-a-1"}
    created = client.post(
        "/api/v1/skills",
        headers=headers,
        json={
            "id": "skill.legacy-draft-row",
            "name": "Legacy Draft Row",
            "owner_team": "user.a@example.com",
            "content_md": "# Legacy Draft Row\n\nWill be downgraded for test.",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200

    patched = client.patch(
        "/api/v1/skills/skill.legacy-draft-row",
        headers=headers,
        json={"status": "draft"},
    )
    assert patched.status_code == 200
    assert patched.json()["skill"]["status"] == "draft"

    skill = Skill(
        id=patched.json()["skill"]["id"],
        name=patched.json()["skill"]["name"],
        owner_team=patched.json()["skill"]["owner_team"],
        status=patched.json()["skill"]["status"],
        current_version=patched.json()["skill"]["current_version"],
        content_md="# Legacy Draft Row",
        tags=[],
        mcp_bindings=[],
        source={"type": "database_draft"},
    )

    assert mabel_skill_is_visible(skill, viewer_email="user.a@example.com") is True
    assert mabel_skill_is_visible(skill, viewer_email="user.b@example.com") is False


def test_org_share_visible_when_owner_team_is_placeholder(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    creator_headers = {"x-user-email": "ayush.kumar@example.com", "x-user-id": "ayush-1"}
    viewer_headers = {"x-user-email": "reviewer@example.com", "x-user-id": "reviewer-1"}

    created = client.post(
        "/api/v1/skills",
        headers=creator_headers,
        json={
            "id": "skill.email-generation",
            "name": "Email Generation",
            "owner_team": "mabel",
            "content_md": "# Email Generation\n\nDraft outbound email.",
            "tags": ["email"],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200
    assert created.json()["skill"]["owner_team"] == "ayush.kumar@example.com"

    _attach_skill_share(
        client,
        "skill.email-generation",
        visibility="org",
        shared_by="ayush.kumar@example.com",
    )

    viewer_list = client.get("/api/v1/skills", headers=viewer_headers)
    assert viewer_list.status_code == 200
    assert "skill.email-generation" in [row["id"] for row in viewer_list.json()["skills"]]


def test_marketplace_sync_exposes_org_visible_skill_to_same_domain_user(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app
    from mabel_api.skill_registry import SkillRegistryEntry

    client = TestClient(build_app())
    owner_headers = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}
    viewer_headers = {"x-user-email": "seller@example.com", "x-user-id": "seller-1"}

    def fake_fetch(self):
        return [
            SkillRegistryEntry(
                id="skill.call-intelligence",
                name="Call Intelligence",
                owner_team="sales",
                status="review",
                version="0.1.0",
                content_md="# Call Intelligence\n\nAnalyze calls.",
                tags=["calls"],
                mcp_bindings=[],
                source={
                    "type": "github",
                    "repo": "batyrrasulov/Mabel",
                    "path": "packages/skills/call-intelligence",
                    "visibility": "org",
                    "share": {
                        "visibility": "org",
                        "shared_by": "owner@example.com",
                    },
                    "owner": {"contact": "owner@example.com", "primary_team": "sales"},
                },
                description="Call coaching skill.",
            )
        ]

    monkeypatch.setattr("mabel_api.skill_registry.GitHubSkillRegistry.fetch_marketplace", fake_fetch)
    sync = client.post("/api/v1/skills/sync", headers=owner_headers, json={})
    assert sync.status_code == 200

    viewer_list = client.get("/api/v1/skills", headers=viewer_headers)
    assert viewer_list.status_code == 200
    viewer_ids = [row["id"] for row in viewer_list.json()["skills"]]
    assert "skill.call-intelligence" in viewer_ids
    shared = next(row for row in viewer_list.json()["skills"] if row["id"] == "skill.call-intelligence")
    assert shared["status"] == "published"


def test_owner_can_delete_shared_custom_skill(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}

    created = client.post(
        "/api/v1/skills",
        headers=headers,
        json={
            "id": "skill.delete-me",
            "name": "Delete Me",
            "owner_team": "owner@example.com",
            "content_md": "# Delete Me\n\nTemporary skill.",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200

    _attach_skill_share(client, "skill.delete-me", visibility="org", shared_by="owner@example.com")

    deleted = client.delete("/api/v1/skills/skill.delete-me", headers=headers)
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] == "skill.delete-me"

    listed = client.get("/api/v1/skills", headers=headers)
    assert "skill.delete-me" not in [row["id"] for row in listed.json()["skills"]]
