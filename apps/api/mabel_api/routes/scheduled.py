from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Request

from ..agents import runtime
from ..auth import MabelUser, resolve_mabel_user
from ..catalog import seed_builtin_catalog
from ..db import get_store
from ..models import AgentRun, Conversation, Message, ScheduledTask, ScheduledTaskRun, utcnow
from ..schemas import ScheduledTaskCreateRequest, ScheduledTaskUpdateRequest
from ..telemetry import record_request_usage

router = APIRouter(prefix="/api/v1/scheduled", tags=["scheduled"])

SCHEDULE_PRESETS = {
    "hourly": "0 * * * *",
    "daily": "0 9 * * *",
    "weekly": "0 9 * * MON",
    "morning": "0 9 * * *",
    "afternoon": "0 14 * * *",
    "evening": "0 18 * * *",
}


def _utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _task_payload(task: ScheduledTask) -> dict[str, Any]:
    return {
        "id": task.id,
        "name": task.name,
        "prompt": task.prompt,
        "schedule_kind": task.schedule_kind,
        "cron": task.cron,
        "timezone": task.timezone,
        "status": task.status,
        "mode": task.mode,
        "workflow_id": task.workflow_id,
        "notification_mode": task.notification_mode,
        "last_run_at": _utc_iso(task.last_run_at),
        "next_run_at": _utc_iso(task.next_run_at),
        "created_at": _utc_iso(task.created_at),
        "updated_at": _utc_iso(task.updated_at),
    }


def _run_payload(run: ScheduledTaskRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "task_id": run.task_id,
        "status": run.status,
        "summary": run.summary,
        "conversation_id": run.conversation_id,
        "workflow_run_id": run.workflow_run_id,
        "created_at": _utc_iso(run.created_at),
        "finished_at": _utc_iso(run.finished_at),
    }


def _normalize_cron(schedule_kind: str, cron: str | None) -> str:
    if schedule_kind == "cron":
        value = (cron or "").strip()
    else:
        value = SCHEDULE_PRESETS.get(schedule_kind, "0 9 * * *")
    if not value:
        raise HTTPException(status_code=422, detail="cron is required for custom schedules")
    parts = value.split()
    if len(parts) != 5:
        raise HTTPException(status_code=422, detail="cron must use 5 fields: minute hour day month weekday")
    if any(len(part) > 32 or not re.fullmatch(r"[A-Za-z0-9*,/\-]+", part) for part in parts):
        raise HTTPException(status_code=422, detail="cron contains unsupported characters")
    return value


def _schedule_zone(timezone_name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo((timezone_name or "UTC").strip() or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _as_utc_naive(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _estimate_next_run(schedule_kind: str, cron: str, timezone_name: str = "UTC") -> datetime:
    zone = _schedule_zone(timezone_name)
    now = utcnow().replace(tzinfo=timezone.utc).astimezone(zone)
    if schedule_kind == "hourly":
        return _as_utc_naive((now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0))
    if schedule_kind == "weekly":
        days_until_monday = (7 - now.weekday()) % 7 or 7
        return _as_utc_naive((now + timedelta(days=days_until_monday)).replace(hour=9, minute=0, second=0, microsecond=0))
    if schedule_kind in {"morning", "daily"}:
        hour = 9
    elif schedule_kind == "afternoon":
        hour = 14
    elif schedule_kind == "evening":
        hour = 18
    else:
        parts = cron.split()
        minute = int(parts[0]) if parts[0].isdigit() else 0
        hour = int(parts[1]) if parts[1].isdigit() else 9
        candidate = now.replace(hour=max(0, min(hour, 23)), minute=max(0, min(minute, 59)), second=0, microsecond=0)
        return _as_utc_naive(candidate if candidate > now else candidate + timedelta(days=1))
    candidate = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    return _as_utc_naive(candidate if candidate > now else candidate + timedelta(days=1))


async def _execute_prompt_in_chat(
    *,
    task: ScheduledTask,
    run_id: str,
    store,
    settings,
    user: MabelUser | None,
) -> tuple[str, int | None, str]:
    conversation = store.create_conversation(
        Conversation(
            user_email=task.owner_email,
            title=f"Scheduled: {task.name}",
            surface="chat",
        )
    )
    if conversation.id is None:
        raise RuntimeError("conversation id missing after creation")

    run = AgentRun(
        id=run_id,
        conversation_id=conversation.id,
        user_email=task.owner_email,
        surface="scheduled",
        status="running",
        model=settings.openai_model,
    )
    store.create_run(run)
    store.add_message(
        Message(
            conversation_id=conversation.id,
            role="user",
            content=task.prompt,
            run_id=run_id,
        )
    )

    user_identity = {
        "email": task.owner_email,
        "user_id": task.owner_email,
        "name": (user.name if user and user.name else task.owner_email.split("@")[0]) or "scheduled",
        "groups": list(user.groups) if user else [],
    }

    assistant_parts: list[str] = []
    latest_sources: list[dict[str, Any]] = []
    try:
        async for event in runtime.run_openai_agents_stream(
            message=task.prompt,
            settings=settings,
            model=run.model,
            conversation_id=conversation.id,
            user_identity=user_identity,
        ):
            event_type = event.get("type")
            if event_type == "token":
                assistant_parts.append(str(event.get("text") or ""))
            elif event_type == "sources":
                incoming = event.get("sources") or []
                if isinstance(incoming, list):
                    latest_sources = [row for row in incoming if isinstance(row, dict)]
    except Exception as exc:
        error_text = f"Scheduled run failed: {exc}"
        store.add_message(
            Message(
                conversation_id=conversation.id,
                role="assistant",
                content=error_text,
                run_id=run_id,
            )
        )
        store.update_run_status(run_id, "failed")
        store.touch_conversation(conversation.id)
        return "failed", conversation.id, error_text

    assistant_text = "".join(assistant_parts).strip() or "Mabel completed without text output."
    store.add_message(
        Message(
            conversation_id=conversation.id,
            role="assistant",
            content=assistant_text,
            sources=latest_sources,
            run_id=run_id,
        )
    )
    store.update_run_status(run_id, "completed")
    store.touch_conversation(conversation.id)
    return "completed", conversation.id, assistant_text


@router.get("")
def list_scheduled_tasks(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    tasks = store.list_scheduled_tasks_for_user(user.email)
    runs = store.list_scheduled_task_runs_for_user(user.email)
    return {"tasks": [_task_payload(task) for task in tasks], "runs": [_run_payload(run) for run in runs[:20]]}


@router.post("")
def create_scheduled_task(payload: ScheduledTaskCreateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    seed_builtin_catalog(store, settings)
    cron = _normalize_cron(payload.schedule_kind, payload.cron)
    task_timezone = payload.timezone.strip() or "UTC"
    task = store.create_scheduled_task(
        ScheduledTask(
            id=f"sched_{uuid.uuid4().hex[:12]}",
            owner_email=user.email,
            name=payload.name.strip(),
            prompt=payload.prompt.strip(),
            schedule_kind=payload.schedule_kind,
            cron=cron,
            timezone=task_timezone,
            mode=payload.mode,
            workflow_id=payload.workflow_id,
            notification_mode=payload.notification_mode,
            next_run_at=_estimate_next_run(payload.schedule_kind, cron, task_timezone),
        )
    )
    return {"task": _task_payload(task)}


@router.patch("/{task_id}")
def update_scheduled_task(task_id: str, payload: ScheduledTaskUpdateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    task = store.get_scheduled_task(task_id)
    if task is None or task.owner_email != user.email:
        raise HTTPException(status_code=404, detail="scheduled task not found")
    schedule_kind = payload.schedule_kind or task.schedule_kind
    cron = _normalize_cron(schedule_kind, payload.cron if payload.cron is not None else task.cron)
    if payload.name is not None:
        task.name = payload.name.strip()
    if payload.prompt is not None:
        task.prompt = payload.prompt.strip()
    task.schedule_kind = schedule_kind
    task.cron = cron
    if payload.timezone is not None:
        task.timezone = payload.timezone.strip() or "UTC"
    if payload.status is not None:
        task.status = payload.status
    if payload.mode is not None:
        task.mode = payload.mode
    if payload.workflow_id is not None:
        task.workflow_id = payload.workflow_id
    if payload.notification_mode is not None:
        task.notification_mode = payload.notification_mode
    task.next_run_at = None if task.status != "active" else _estimate_next_run(task.schedule_kind, task.cron, task.timezone)
    return {"task": _task_payload(store.update_scheduled_task(task))}


def _execute_scheduled_task(*, task: ScheduledTask, store, settings, user: MabelUser | None = None) -> tuple[ScheduledTask, ScheduledTaskRun]:
    run_id = f"scheduled_{uuid.uuid4().hex[:12]}"
    now = utcnow()
    status, conversation_id, assistant_text = asyncio.run(
        _execute_prompt_in_chat(task=task, run_id=run_id, store=store, settings=settings, user=user)
    )
    summary_prefix = "Scheduled task executed" if status == "completed" else "Scheduled task failed"
    summary = (
        f"{summary_prefix} in chat conversation {conversation_id}. "
        f"Cron {task.cron} ({task.timezone}); notification mode {task.notification_mode}. "
        f"Result: {assistant_text[:280]}"
    )
    scheduled_run = store.create_scheduled_task_run(
        ScheduledTaskRun(
            id=run_id,
            task_id=task.id,
            owner_email=task.owner_email,
            status=status,
            summary=summary,
            conversation_id=conversation_id,
            workflow_run_id=None,
            created_at=now,
            finished_at=now,
        )
    )
    task.last_run_at = now
    task.next_run_at = _estimate_next_run(task.schedule_kind, task.cron, task.timezone) if task.status == "active" else None
    store.update_scheduled_task(task)
    record_request_usage(
        store=store,
        settings=settings,
        user_email=task.owner_email,
        surface="scheduled",
        prompt=task.prompt,
        output=assistant_text,
        metadata={
            "task_id": task.id,
            "run_id": run_id,
            "conversation_id": conversation_id,
            "mode": task.mode,
            "workflow_id": task.workflow_id,
            "triggered_by": user.email if user else "due-runner",
        },
    )
    return task, scheduled_run


@router.post("/run-due")
def run_due_scheduled_tasks(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    seed_builtin_catalog(store, settings)
    due_tasks = store.list_due_scheduled_tasks(utcnow())
    completed: list[dict[str, Any]] = []
    for task in due_tasks:
        updated_task, scheduled_run = _execute_scheduled_task(task=task, store=store, settings=settings, user=user)
        completed.append({"task": _task_payload(updated_task), "run": _run_payload(scheduled_run)})
    return {"status": "completed", "due_count": len(due_tasks), "runs": completed}


@router.post("/{task_id}/run")
def run_scheduled_task(task_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    seed_builtin_catalog(store, settings)
    task = store.get_scheduled_task(task_id)
    if task is None or task.owner_email != user.email or task.status == "archived":
        raise HTTPException(status_code=404, detail="scheduled task not found")

    task, scheduled_run = _execute_scheduled_task(task=task, store=store, settings=settings, user=user)
    return {"run": _run_payload(scheduled_run), "task": _task_payload(task)}