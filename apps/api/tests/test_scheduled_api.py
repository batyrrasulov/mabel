from __future__ import annotations

import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _headers(email: str = "ops@example.com") -> dict[str, str]:
    return {"x-user-email": email, "x-user-id": email}


def test_scheduled_task_create_pause_resume_and_run(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    create = client.post(
        "/api/v1/scheduled",
        headers=_headers(),
        json={
            "name": "Daily ops heartbeat",
            "prompt": "Review overnight workflow failures and summarize anything actionable.",
            "schedule_kind": "morning",
            "timezone": "America/Los_Angeles",
            "mode": "workflow",
            "workflow_id": "starter-pack.account-manager",
            "notification_mode": "notify_on_change",
        },
    )
    assert create.status_code == 200
    task = create.json()["task"]
    assert task["cron"] == "0 9 * * *"
    assert task["status"] == "active"
    assert task["next_run_at"].endswith("Z")

    paused = client.patch(f"/api/v1/scheduled/{task['id']}", headers=_headers(), json={"status": "paused"})
    assert paused.status_code == 200
    assert paused.json()["task"]["status"] == "paused"
    assert paused.json()["task"]["next_run_at"] is None

    resumed = client.patch(f"/api/v1/scheduled/{task['id']}", headers=_headers(), json={"status": "active"})
    assert resumed.status_code == 200
    assert resumed.json()["task"]["next_run_at"].endswith("Z")

    run = client.post(f"/api/v1/scheduled/{task['id']}/run", headers=_headers())
    assert run.status_code == 200
    run_payload = run.json()
    assert run_payload["run"]["status"] == "completed"
    assert run_payload["run"]["task_id"] == task["id"]
    assert run_payload["task"]["last_run_at"].endswith("Z")
    assert run_payload["run"]["conversation_id"] is not None

    conversations = client.get("/api/v1/conversations", headers=_headers())
    assert conversations.status_code == 200
    scheduled_conversations = [row for row in conversations.json().get("conversations") or [] if str(row.get("title", "")).startswith("Scheduled:")]
    assert scheduled_conversations

    latest_conversation_id = int(scheduled_conversations[0]["id"])
    messages = client.get(f"/api/v1/conversations/{latest_conversation_id}/messages", headers=_headers())
    assert messages.status_code == 200
    message_rows = messages.json().get("messages") or []
    assert any(str(row.get("content") or "") == "Review overnight workflow failures and summarize anything actionable." for row in message_rows)
    assert any(str(row.get("role") or "") == "assistant" for row in message_rows)

    listed = client.get("/api/v1/scheduled", headers=_headers())
    assert listed.status_code == 200
    payload = listed.json()
    assert payload["tasks"][0]["id"] == task["id"]
    assert payload["runs"][0]["id"] == run_payload["run"]["id"]

    usage = client.get("/api/v1/usage/summary", headers=_headers())
    assert usage.status_code == 200
    assert any(row.get("surface") == "scheduled" for row in usage.json().get("runs") or [])


def test_scheduled_custom_cron_validation(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    response = client.post(
        "/api/v1/scheduled",
        headers=_headers(),
        json={"name": "Bad cron", "prompt": "Check things", "schedule_kind": "cron", "cron": "*/10 * *"},
    )
    assert response.status_code == 422


def test_scheduled_cron_next_run_uses_task_timezone(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app
    from mabel_api.routes import scheduled as scheduled_route

    fixed_now = datetime(2026, 7, 1, 13, 0, 0, tzinfo=timezone.utc).replace(tzinfo=None)
    monkeypatch.setattr(scheduled_route, "utcnow", lambda: fixed_now)

    client = TestClient(build_app())
    create = client.post(
        "/api/v1/scheduled",
        headers=_headers(),
        json={
            "name": "Daily AI brief",
            "prompt": "Find top AI news",
            "schedule_kind": "cron",
            "cron": "0 7 * * *",
            "timezone": "America/Phoenix",
        },
    )
    assert create.status_code == 200, create.text
    task = create.json()["task"]
    assert task["next_run_at"] == "2026-07-01T14:00:00Z"

    paused = client.patch(f"/api/v1/scheduled/{task['id']}", headers=_headers(), json={"status": "paused"})
    assert paused.status_code == 200
    assert paused.json()["task"]["next_run_at"] is None

    resumed = client.patch(f"/api/v1/scheduled/{task['id']}", headers=_headers(), json={"status": "active"})
    assert resumed.status_code == 200
    assert resumed.json()["task"]["next_run_at"] == "2026-07-01T14:00:00Z"


def test_runtime_scheduled_helper_uses_task_timezone(monkeypatch) -> None:
    from mabel_api.agents import runtime

    fixed_now = datetime(2026, 7, 1, 13, 0, 0, tzinfo=timezone.utc).replace(tzinfo=None)
    monkeypatch.setattr(runtime, "utcnow", lambda: fixed_now)

    next_run = runtime._mabel_estimate_next_run("cron", "0 7 * * *", "America/Phoenix")
    assert next_run == datetime(2026, 7, 1, 14, 0, 0)


def test_scheduled_due_runner_executes_due_active_tasks(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.db import get_store
    from mabel_api.main import build_app
    from mabel_api.models import utcnow
    from mabel_api.settings import MabelSettings

    client = TestClient(build_app())
    headers = _headers("cron@example.com")
    create = client.post(
        "/api/v1/scheduled",
        headers=headers,
        json={"name": "Due heartbeat", "prompt": "Check due work", "schedule_kind": "hourly"},
    )
    assert create.status_code == 200
    task_id = create.json()["task"]["id"]

    store = get_store(MabelSettings.load())
    task = store.get_scheduled_task(task_id)
    assert task is not None
    task.next_run_at = utcnow() - timedelta(minutes=5)
    store.update_scheduled_task(task)

    forbidden = client.post("/api/v1/scheduled/run-due", headers=headers)
    assert forbidden.status_code == 403

    scheduler_headers = {
        **headers,
        "x-user-groups": "mabel-schedulers",
    }
    due = client.post("/api/v1/scheduled/run-due", headers=scheduler_headers)
    assert due.status_code == 200
    payload = due.json()
    assert payload["due_count"] == 1
    assert payload["runs"][0]["task"]["id"] == task_id
    assert payload["runs"][0]["run"]["status"] == "completed"

    listed = client.get("/api/v1/scheduled", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["tasks"][0]["last_run_at"].endswith("Z")