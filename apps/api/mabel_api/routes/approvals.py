from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request

from ..auth import resolve_mabel_user
from ..db import get_store
from ..models import Approval, utcnow
from .mcp import execute_mcp_tool
from ..schemas import ApprovalCreateRequest, ApprovalDecisionRequest

router = APIRouter(prefix="/api/v1/approvals", tags=["approvals"])


def _approval_payload(row: Approval) -> dict:
    return {
        "id": row.id,
        "run_id": row.run_id,
        "status": row.status,
        "title": row.title,
        "summary": row.summary,
        "requested_by": row.requested_by,
        "decided_by": row.decided_by,
        "decision_reason": row.decision_reason,
        "payload": row.payload,
        "created_at": row.created_at.isoformat() + "Z",
        "updated_at": row.updated_at.isoformat() + "Z",
    }


@router.post("")
def create_approval(payload: ApprovalCreateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    actor = resolve_mabel_user(request).email
    approval = Approval(
        id=f"approval_{uuid.uuid4().hex}",
        run_id=payload.run_id,
        status="pending",
        title=payload.title,
        summary=payload.summary,
        requested_by=actor,
        payload=payload.payload,
    )
    approval = get_store(settings).create_approval(approval)
    return {"approval": _approval_payload(approval)}


@router.post("/{approval_id}/decision")
async def decide_approval(approval_id: str, payload: ApprovalDecisionRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    actor = user.email
    store = get_store(settings)
    approval = store.get_approval(approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="approval not found")
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail="approval is already decided")
    if payload.decision == "approved":
        if approval.requested_by == actor or not user.is_mabel_approver:
            raise HTTPException(status_code=403, detail="approval requires a separate approver")
    elif approval.requested_by != actor and not user.is_mabel_approver:
        raise HTTPException(status_code=403, detail="approval decision not permitted")

    approval.status = payload.decision
    approval.decided_by = actor
    approval.decision_reason = payload.reason
    approval.updated_at = utcnow()
    executed = None
    if payload.decision == "approved":
        server_slug = approval.payload.get("server_slug")
        tool_name = approval.payload.get("tool_name")
        arguments = approval.payload.get("arguments") or {}
        if isinstance(server_slug, str) and isinstance(tool_name, str) and isinstance(arguments, dict):
            executed = await execute_mcp_tool(
                settings,
                request,
                server_slug,
                tool_name,
                arguments,
                policy_approved=True,
            )
            approval.payload = {**approval.payload, "execution_result": executed}
    updated = store.update_approval(approval)
    response = {"approval": _approval_payload(updated)}
    if executed is not None:
        response["execution_result"] = executed
    return response
