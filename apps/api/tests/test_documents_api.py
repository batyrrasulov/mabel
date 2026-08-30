from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _headers(email: str, user_id: str) -> dict[str, str]:
    return {"x-user-email": email, "x-user-id": user_id}


def test_documents_crud_and_user_isolation(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    owner_headers = _headers("owner@example.com", "owner-1")
    other_headers = _headers("other@example.com", "other-1")

    create_response = client.post(
        "/api/v1/documents",
        headers=owner_headers,
        json={
            "title": "Launch brief",
            "kind": "markdown",
            "content": "# Launch\n\nInitial notes",
        },
    )
    assert create_response.status_code == 200
    document = create_response.json()["document"]
    document_id = document["id"]
    assert document["title"] == "Launch brief"
    assert document["kind"] == "markdown"

    owner_list = client.get("/api/v1/documents", headers=owner_headers)
    assert owner_list.status_code == 200
    assert len(owner_list.json()["documents"]) == 1

    other_list = client.get("/api/v1/documents", headers=other_headers)
    assert other_list.status_code == 200
    assert other_list.json()["documents"] == []

    forbidden = client.get(f"/api/v1/documents/{document_id}", headers=other_headers)
    assert forbidden.status_code == 403

    patch_response = client.patch(
        f"/api/v1/documents/{document_id}",
        headers=owner_headers,
        json={"title": "Launch brief v2", "content": "Updated"},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["document"]["title"] == "Launch brief v2"
    assert patch_response.json()["document"]["content"] == "Updated"

    delete_response = client.delete(f"/api/v1/documents/{document_id}", headers=owner_headers)
    assert delete_response.status_code == 200
    assert delete_response.json()["deleted"] == document_id

    after_delete = client.get("/api/v1/documents", headers=owner_headers)
    assert after_delete.status_code == 200
    assert after_delete.json()["documents"] == []


def test_artifacts_alias_supports_dashboard_kind(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = _headers("owner@example.com", "owner-1")

    create_response = client.post(
        "/api/v1/artifacts",
        headers=headers,
        json={
            "title": "Call dashboard",
            "kind": "dashboard",
            "content": "<html><body><h1>Dashboard</h1></body></html>",
        },
    )
    assert create_response.status_code == 200
    artifact = create_response.json()["artifact"]
    assert artifact["kind"] == "dashboard"
    assert artifact["conversation_id"] is None

    list_response = client.get("/api/v1/artifacts", headers=headers)
    assert list_response.status_code == 200
    assert list_response.json()["artifacts"][0]["id"] == artifact["id"]


def test_document_cannot_link_to_foreign_conversation(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.db import get_store
    from mabel_api.main import build_app
    from mabel_api.models import Conversation

    app = build_app()
    store = get_store(app.state.settings)
    foreign = store.create_conversation(
        Conversation(
            user_email="other@example.com",
            title="Other user's conversation",
            surface="chat",
        )
    )
    assert foreign.id is not None

    client = TestClient(app)
    owner_headers = _headers("owner@example.com", "owner-1")
    response = client.post(
        "/api/v1/documents",
        headers=owner_headers,
        json={
            "title": "Invalid link",
            "kind": "markdown",
            "content": "Must not cross ownership.",
            "conversation_id": foreign.id,
        },
    )
    assert response.status_code == 404
