from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _headers(email: str, user_id: str) -> dict[str, str]:
    return {"x-user-email": email, "x-user-id": user_id}


def test_memory_crud_and_query_filter(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    owner = _headers("owner@example.com", "owner-1")
    other = _headers("other@example.com", "other-1")

    create = client.post(
        "/api/v1/memory",
        headers=owner,
        json={
            "key": "account.voice",
            "content": "Customer prefers concise status updates.",
            "tags": ["preference", "account"],
            "confidence": 0.9,
            "source": "manual",
        },
    )
    assert create.status_code == 200
    item_id = create.json()["item"]["id"]

    owner_list = client.get("/api/v1/memory", headers=owner)
    assert owner_list.status_code == 200
    assert len(owner_list.json()["memory"]) == 1
    assert owner_list.json()["memory"][0]["pinned"] is False

    filtered = client.get("/api/v1/memory?q=concise", headers=owner)
    assert filtered.status_code == 200
    assert len(filtered.json()["memory"]) == 1

    other_list = client.get("/api/v1/memory", headers=other)
    assert other_list.status_code == 200
    assert other_list.json()["memory"] == []

    forbidden = client.patch(
        f"/api/v1/memory/{item_id}",
        headers=other,
        json={"content": "tamper"},
    )
    assert forbidden.status_code == 403

    update = client.patch(
        f"/api/v1/memory/{item_id}",
        headers=owner,
        json={"confidence": 1.0, "tags": ["reinforced"], "pinned": True},
    )
    assert update.status_code == 200
    assert update.json()["item"]["confidence"] == 1.0
    assert update.json()["item"]["tags"] == ["reinforced"]
    assert update.json()["item"]["pinned"] is True

    delete = client.delete(f"/api/v1/memory/{item_id}", headers=owner)
    assert delete.status_code == 200

    after_delete = client.get("/api/v1/memory", headers=owner)
    assert after_delete.status_code == 200
    assert after_delete.json()["memory"] == []


def test_memory_export_and_import_modes(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    owner = _headers("owner@example.com", "owner-1")
    other = _headers("other@example.com", "other-1")

    seed = client.post(
        "/api/v1/memory",
        headers=owner,
        json={
            "key": "account.tone",
            "content": "Use concise bullets.",
            "tags": ["style"],
            "confidence": 0.8,
            "source": "manual",
        },
    )
    assert seed.status_code == 200

    exported = client.get("/api/v1/memory/export", headers=owner)
    assert exported.status_code == 200
    body = exported.json()
    assert body["version"] == "mabel-memory.v1"
    assert body["count"] == 1
    assert body["items"][0]["key"] == "account.tone"

    upsert = client.post(
        "/api/v1/memory/import",
        headers=owner,
        json={
            "mode": "upsert",
            "items": [
                {
                    "key": "account.tone",
                    "content": "Use concise bullets and action verbs.",
                    "tags": ["style", "brief"],
                    "confidence": 1.0,
                    "source": "import",
                },
                {
                    "key": "account.product",
                    "content": "Customer is evaluating Connect.",
                    "tags": ["product"],
                    "pinned": True,
                    "confidence": 0.9,
                    "source": "import",
                },
            ],
        },
    )
    assert upsert.status_code == 200
    assert upsert.json()["updated"] == 1
    assert upsert.json()["created"] == 1

    after_upsert = client.get("/api/v1/memory", headers=owner).json()["memory"]
    assert len(after_upsert) == 2
    tone = next(item for item in after_upsert if item["key"] == "account.tone")
    product = next(item for item in after_upsert if item["key"] == "account.product")
    assert tone["confidence"] == 1.0
    assert tone["content"] == "Use concise bullets and action verbs."
    assert product["pinned"] is True

    replace = client.post(
        "/api/v1/memory/import",
        headers=owner,
        json={
            "mode": "replace",
            "items": [
                {
                    "key": "account.playbook",
                    "content": "Run discovery before proposal.",
                    "tags": ["process"],
                    "confidence": 0.7,
                    "source": "import",
                }
            ],
        },
    )
    assert replace.status_code == 200
    assert replace.json()["created"] == 1
    assert replace.json()["updated"] == 0

    final_items = client.get("/api/v1/memory", headers=owner).json()["memory"]
    assert len(final_items) == 1
    assert final_items[0]["key"] == "account.playbook"

    other_import = client.post(
        "/api/v1/memory/import",
        headers=other,
        json={
            "mode": "upsert",
            "items": [
                {
                    "key": "other.note",
                    "content": "Different user memory.",
                }
            ],
        },
    )
    assert other_import.status_code == 200
    owner_still_isolated = client.get("/api/v1/memory", headers=owner).json()["memory"]
    assert len(owner_still_isolated) == 1
