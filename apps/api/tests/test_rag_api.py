from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_rag_search_returns_real_memory_snippets() -> None:
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "rag-user@example.com", "x-user-id": "rag-user-1"}

    created = client.post(
        "/api/v1/memory",
        headers=headers,
        json={
            "key": "Acme renewal",
            "content": "Renewal risk flagged for Q4 and onboarding delays.",
            "tags": ["renewal", "risk"],
            "confidence": 0.8,
        },
    )
    assert created.status_code == 200

    rag = client.post(
        "/api/v1/rag/search",
        headers=headers,
        json={"query": "renewal risk", "sources": ["memory"]},
    )
    assert rag.status_code == 200
    payload = rag.json()
    assert payload["source_backed"] is True
    assert len(payload["results"]) >= 1
    assert payload["results"][0]["source"] == "memory"
    assert payload["results"][0]["citation"]["kind"] == "memory_item"


def test_rag_search_reports_not_source_backed_on_no_hits() -> None:
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "rag-empty@example.com", "x-user-id": "rag-empty-1"}

    rag = client.post(
        "/api/v1/rag/search",
        headers=headers,
        json={"query": "qvxjmnplkghfdss", "sources": ["memory", "documents", "skills", "conversations"]},
    )
    assert rag.status_code == 200
    payload = rag.json()
    assert payload["source_backed"] is False
    assert payload["results"] == []


def test_rag_search_does_not_expose_private_skills() -> None:
    from mabel_api.main import build_app

    client = TestClient(build_app())
    owner = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}
    viewer = {"x-user-email": "viewer@example.com", "x-user-id": "viewer-1"}
    created = client.post(
        "/api/v1/skills",
        headers=owner,
        json={
            "id": "skill.private-rag",
            "name": "Private RAG",
            "owner_team": "owner@example.com",
            "content_md": "# Private RAG\n\nconfidential-needle-7429",
            "tags": [],
            "mcp_bindings": [],
        },
    )
    assert created.status_code == 200

    response = client.post(
        "/api/v1/rag/search",
        headers=viewer,
        json={"query": "confidential-needle-7429", "sources": ["skills"]},
    )
    assert response.status_code == 200
    assert response.json()["results"] == []
