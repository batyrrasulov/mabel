from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _headers(email: str, user_id: str) -> dict[str, str]:
    return {"x-user-email": email, "x-user-id": user_id}


def test_start_my_day_workflow_is_publicly_visible(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())

    response = client.get("/api/v1/bootstrap", headers=_headers("agent@example.com", "agent-1"))
    assert response.status_code == 200
    packs = response.json().get("starter_packs") or []
    assert len(packs) == 1
    assert packs[0]["id"] == "workflow-pack.start-my-day"
    assert packs[0]["name"] == "Start My Day"
    assert "outlook-calendar" in packs[0]["connector_slugs"]
    assert "product-usage" not in packs[0]["connector_slugs"]


def test_start_my_day_demo_workflow_run_completes_with_simulated_events(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = _headers("agent@example.com", "agent-1")
    response = client.post(
        "/api/v1/workflows/workflow-pack.start-my-day/run",
        headers=headers,
        json={
            "objective": "Prepare today's customer meeting briefs from calendar, CRM, product usage, and meeting notes.",
            "dry_run": False,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["starter_pack"]["id"] == "workflow-pack.start-my-day"
    assert payload["outputs"]["demo_simulation"] is True
    assert len(payload["outputs"]["briefs"]) == 2
    events = payload["outputs"]["observability"]["events"]
    assert any(event.get("type") == "connector.demo" for event in events)
    assert any("Outlook Calendar" in str(event.get("message")) for event in events)
    assert any("Product usage summaries" in str(event.get("message")) for event in events)

def test_start_my_day_demo_stream_returns_chat_events(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = _headers("agent@example.com", "agent-1")
    with client.stream(
        "POST",
        "/api/v1/workflows/workflow-pack.start-my-day/demo-stream",
        headers=headers,
    ) as response:
        assert response.status_code == 200
        body = "".join(response.iter_text())
    assert "run_started" in body
    assert "outlook_calendar.list_events" in body
    assert "mabel_get_skill" in body
    assert "Your day is ready" in body
    assert "run_done" in body


def test_workflow_run_unknown_pack_returns_404(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = _headers("user@example.com", "user-1")
    response = client.post(
        "/api/v1/workflows/workflow-pack.unknown/run",
        headers=headers,
        json={"objective": "Do something"},
    )
    assert response.status_code == 404


def test_create_workflow_persists_new_pack(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = _headers("user@example.com", "user-1")

    create = client.post(
        "/api/v1/workflows",
        headers=headers,
        json={
            "name": "Renewal Risk Triage",
            "objective": "Assess upcoming renewals and draft next actions.",
        },
    )
    assert create.status_code == 200
    payload = create.json()
    pack = payload["starter_pack"]
    assert pack["id"].startswith("workflow-pack.custom-renewal-risk-triage")
    assert pack["status"] == "draft"

    bootstrap = client.get("/api/v1/bootstrap", headers=headers)
    assert bootstrap.status_code == 200
    packs = bootstrap.json().get("starter_packs") or []
    assert any(item["id"] == pack["id"] for item in packs)

    foreign_run = client.post(
        f"/api/v1/workflows/{pack['id']}/run",
        headers=_headers("other@example.com", "other-1"),
        json={"objective": "Run another user's workflow", "dry_run": True},
    )
    assert foreign_run.status_code == 404


def test_created_workflow_run_exposes_agent_loop_plan(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = _headers("agent@example.com", "agent-1")

    create = client.post(
        "/api/v1/workflows",
        headers=headers,
        json={
            "name": "Start My Day Agent",
            "objective": "Every morning, prepare my day, review account risks, and draft follow ups.",
        },
    )
    assert create.status_code == 200
    pack = create.json()["starter_pack"]
    assert pack["policies"]["orchestration_mode"] == "agent_loop"
    assert pack["policies"]["schedule"]["cadence"] == "daily"

    run = client.post(
        f"/api/v1/workflows/{pack['id']}/run",
        headers=headers,
        json={
            "objective": "Run the start-my-day agent with all selected skills and connectors.",
            "dry_run": False,
        },
    )
    assert run.status_code == 200
    payload = run.json()
    plan = payload["outputs"]["execution_plan"]
    assert plan["mode"] == "agent_loop"
    assert plan["schedule"]["cadence"] == "daily"
    assert plan["steps"][0]["uses_chat_runtime"] is True
    assert plan["steps"][0]["skill_ids"] == pack["skill_ids"]
    assert plan["steps"][0]["status"] == "completed"
    assert plan["steps"][0]["result"]["status"] == "completed"
    assert payload["outputs"]["step_results"][0]["status"] == "completed"
    assert payload["outputs"]["observability"]["events"][0]["type"] == "workflow.run.created"
    assert payload["outputs"]["observability"]["events"][0]["timestamp"].endswith("Z")
    assert payload["outputs"]["observability"]["events"][-1]["type"] == "workflow.step.completed"
    assert payload["outputs"]["observability"]["events"][-1]["timestamp"].endswith("Z")
    assert payload["outputs"]["next_actions"][0]["kind"] == "open_chat"

    persisted = client.get(f"/api/v1/workflows/runs/{payload['run_id']}", headers=headers)
    assert persisted.status_code == 200
    state = persisted.json()["run"]["state_json"]
    assert state["orchestration"]["mode"] == "agent_loop"
    assert state["outputs"]["execution_plan"]["steps"][0]["connector_slugs"] == pack["connector_slugs"]


def test_workflow_run_waits_for_approval_before_controlled_action(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_DB_URL", "")
    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = _headers("agent@example.com", "agent-1")

    create = client.post(
        "/api/v1/workflows",
        headers=headers,
        json={
            "name": "Approval Agent",
            "objective": "Review renewal context and prepare a draft update.",
        },
    )
    assert create.status_code == 200
    pack = create.json()["starter_pack"]

    run = client.post(
        f"/api/v1/workflows/{pack['id']}/run",
        headers=headers,
        json={
            "objective": "Send the renewal update to Salesforce.",
            "dry_run": False,
        },
    )
    assert run.status_code == 200
    payload = run.json()
    assert payload["status"] == "waiting_approval"
    assert payload["checkpoints"][3]["status"] == "approval_required"
    assert payload["outputs"]["execution_plan"]["steps"][0]["status"] == "waiting_approval"
    assert payload["outputs"]["step_results"][0]["status"] == "waiting_approval"
