from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request

from ..auth import resolve_mabel_user
from ..db import get_store
from ..models import PromptInboxItem, utcnow
from ..schemas import RunInboxRequest, RunInboxUpdateRequest, RunResumeRequest

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])


def _owned_run_or_404(run_id: str, request: Request):
    store = get_store(request.app.state.settings)
    user = resolve_mabel_user(request)
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    if run.user_email != user.email:
        raise HTTPException(status_code=403, detail="run does not belong to current user")
    return run


@router.get("/{run_id}")
def run_status(run_id: str, request: Request) -> dict:
    run = _owned_run_or_404(run_id, request)
    return {
        "run": {
            "id": run.id,
            "conversation_id": run.conversation_id,
            "surface": run.surface,
            "status": run.status,
            "model": run.model,
            "state_json": run.state_json or {},
            "created_at": run.created_at.isoformat() + "Z",
            "finished_at": run.finished_at.isoformat() + "Z" if run.finished_at else None,
        }
    }


@router.post("/{run_id}/stop")
def stop_run(run_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    store = get_store(settings)
    run = _owned_run_or_404(run_id, request)
    state = dict(run.state_json or {})
    control = dict(state.get("control") or {})
    control["stop_requested"] = True
    control["stopped_requested_at"] = utcnow().isoformat() + "Z"
    state["control"] = control
    store.update_run_state(run.id, state)
    store.update_run_status(run.id, "stopping")
    return {"status": "ok", "run_id": run.id, "run_status": "stopping"}


@router.post("/{run_id}/resume")
def resume_run(run_id: str, payload: RunResumeRequest, request: Request) -> dict:
    settings = request.app.state.settings
    store = get_store(settings)
    run = _owned_run_or_404(run_id, request)

    resume_prompt = (payload.prompt or "").strip()
    used_item_id: str | None = None
    if not resume_prompt:
        pending = [item for item in store.list_prompt_inbox_for_run(run.id) if item.status == "pending" and item.mode == "queue"]
        if pending:
            selected = pending[0]
            resume_prompt = selected.prompt.strip()
            selected.status = "applied"
            store.update_prompt_inbox_item(selected)
            used_item_id = selected.id
    if not resume_prompt:
        raise HTTPException(status_code=400, detail="resume prompt required or queue item pending")

    state = dict(run.state_json or {})
    control = dict(state.get("control") or {})
    control["stop_requested"] = False
    control["resume_prompt"] = resume_prompt
    control["resume_requested_at"] = utcnow().isoformat() + "Z"
    state["control"] = control
    store.update_run_state(run.id, state)
    store.update_run_status(run.id, "queued")
    return {
        "status": "ok",
        "run_id": run.id,
        "conversation_id": run.conversation_id,
        "surface": run.surface,
        "resume_prompt": resume_prompt,
        "consumed_queue_item_id": used_item_id,
    }


@router.get("/{run_id}/inbox")
def list_run_inbox(run_id: str, request: Request) -> dict:
    run = _owned_run_or_404(run_id, request)
    store = get_store(request.app.state.settings)
    rows = store.list_prompt_inbox_for_run(run.id)
    return {
        "run_id": run.id,
        "items": [
            {
                "id": row.id,
                "mode": row.mode,
                "prompt": row.prompt,
                "status": row.status,
                "created_at": row.created_at.isoformat() + "Z",
                "updated_at": row.updated_at.isoformat() + "Z",
            }
            for row in rows
        ],
    }


@router.post("/{run_id}/inbox")
def create_run_inbox_item(run_id: str, payload: RunInboxRequest, request: Request) -> dict:
    settings = request.app.state.settings
    store = get_store(settings)
    run = _owned_run_or_404(run_id, request)
    user = resolve_mabel_user(request)
    item = store.create_prompt_inbox_item(
        PromptInboxItem(
            id=f"inbox_{uuid.uuid4().hex[:12]}",
            run_id=run.id,
            conversation_id=run.conversation_id,
            owner_email=user.email,
            mode=payload.mode,
            prompt=payload.prompt.strip(),
            status="pending",
        )
    )

    if payload.mode == "steer":
        state = dict(run.state_json or {})
        control = dict(state.get("control") or {})
        control["steer_prompt"] = payload.prompt.strip()
        control["steer_prompt_item_id"] = item.id
        control["steer_updated_at"] = utcnow().isoformat() + "Z"
        state["control"] = control
        store.update_run_state(run.id, state)

    return {
        "item": {
            "id": item.id,
            "run_id": item.run_id,
            "mode": item.mode,
            "prompt": item.prompt,
            "status": item.status,
            "created_at": item.created_at.isoformat() + "Z",
            "updated_at": item.updated_at.isoformat() + "Z",
        }
    }


@router.patch("/{run_id}/inbox/{item_id}")
def update_run_inbox_item(run_id: str, item_id: str, payload: RunInboxUpdateRequest, request: Request) -> dict:
    run = _owned_run_or_404(run_id, request)
    store = get_store(request.app.state.settings)
    rows = store.list_prompt_inbox_for_run(run.id)
    item = next((row for row in rows if row.id == item_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="inbox item not found")
    item.status = payload.status
    item = store.update_prompt_inbox_item(item)
    return {
        "item": {
            "id": item.id,
            "run_id": item.run_id,
            "mode": item.mode,
            "prompt": item.prompt,
            "status": item.status,
            "created_at": item.created_at.isoformat() + "Z",
            "updated_at": item.updated_at.isoformat() + "Z",
        }
    }
