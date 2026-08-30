from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _headers(email: str, user_id: str = "user-1", groups: str = "") -> dict[str, str]:
    headers = {"x-user-email": email, "x-user-id": user_id}
    if groups:
        headers["x-user-groups"] = groups
    return headers


def test_bootstrap_requires_authenticated_identity(monkeypatch) -> None:
    
    from mabel_api.main import build_app

    client = TestClient(build_app())
    response = client.get("/api/v1/bootstrap")

    assert response.status_code == 401


def test_pending_approvals_are_user_scoped(monkeypatch) -> None:
    
    from mabel_api.main import build_app

    client = TestClient(build_app())
    create = client.post(
        "/api/v1/approvals",
        headers=_headers("requester@example.com", "requester-1"),
        json={"title": "Approve write", "summary": "Needs review", "payload": {"scope": "create"}},
    )
    assert create.status_code == 200

    requester_bootstrap = client.get("/api/v1/bootstrap", headers=_headers("requester@example.com", "requester-1"))
    other_bootstrap = client.get("/api/v1/bootstrap", headers=_headers("other@example.com", "other-1"))

    assert len(requester_bootstrap.json()["approvals"]) == 1
    assert other_bootstrap.json()["approvals"] == []


def test_only_separate_mabel_approver_can_approve(monkeypatch) -> None:
    
    from mabel_api.main import build_app

    client = TestClient(build_app())
    create = client.post(
        "/api/v1/approvals",
        headers=_headers("requester@example.com", "requester-1"),
        json={"title": "Approve write", "summary": "Needs review", "payload": {"scope": "create"}},
    )
    approval_id = create.json()["approval"]["id"]

    self_approval = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        headers=_headers("requester@example.com", "requester-1"),
        json={"decision": "approved", "reason": "self approval"},
    )
    assert self_approval.status_code == 403

    forbidden = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        headers=_headers("other@example.com", "other-1"),
        json={"decision": "approved", "reason": "not allowed"},
    )
    assert forbidden.status_code == 403

    allowed = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        headers=_headers("approver@example.com", "approver-1", "mabel-approvers"),
        json={"decision": "approved", "reason": "Approved by Mabel approver"},
    )
    assert allowed.status_code == 200
    assert allowed.json()["approval"]["decided_by"] == "approver@example.com"


def test_admin_logs_require_admin_group(monkeypatch) -> None:
    from mabel_api.db import get_store
    from mabel_api.main import build_app
    from mabel_api.models import AgentRun, AuditEvent, ToolCall

    app = build_app()
    store = get_store(app.state.settings)
    run = AgentRun(
        id="run-admin-logs-1",
        conversation_id=None,
        user_email="agent@example.com",
        surface="chat",
        status="running",
        model="gpt-test",
    )
    store.create_run(run)
    store.record_run_usage(
        run.id,
        {
            "input_tokens": 12,
            "output_tokens": 8,
            "total_tokens": 20,
        },
    )
    store.update_run_status(run.id, "completed")
    store.add_tool_call(ToolCall(run_id=run.id, tool_name="mabel_context", status="completed"))
    store.add_tool_call(ToolCall(run_id=run.id, tool_name="mabel_memory_search", status="completed"))
    store.add_audit_event(AuditEvent(actor_email="agent@example.com", event_type="tool_call", status="completed"))

    client = TestClient(app)
    non_admin_access = client.get("/api/v1/admin/check-access", headers=_headers("agent@example.com", "agent-1"))
    assert non_admin_access.status_code == 200
    assert non_admin_access.json() == {"is_admin": False}

    forbidden = client.get("/api/v1/admin/logs", headers=_headers("agent@example.com", "agent-1"))
    assert forbidden.status_code == 403

    admin_headers = _headers("admin@mabel.local", "admin-1", "mabel-admins")
    admin_access = client.get("/api/v1/admin/check-access", headers=admin_headers)
    assert admin_access.status_code == 200
    assert admin_access.json() == {"is_admin": True}

    allowed = client.get("/api/v1/admin/logs?limit=1", headers=admin_headers)
    assert allowed.status_code == 200
    payload = allowed.json()
    assert payload["scope"] == "admin"
    assert payload["totals"]["requests"] == 1
    assert payload["totals"]["total_tokens"] == 20
    assert payload["totals"]["cost_usd"] == 0
    assert payload["totals"]["tool_calls"] == 2
    assert payload["counts"]["audit_events"] == 1
    assert len(payload["recent"]["tool_calls"]) == 1
    assert payload["recent"]["usage"][0]["usage"]["cost_estimated"] is True
    assert payload["breakdowns"]["by_user"][0]["user_email"] == "agent@example.com"
