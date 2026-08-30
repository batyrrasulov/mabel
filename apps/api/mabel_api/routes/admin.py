from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from ..auth import MabelUser, resolve_mabel_user
from ..db import get_store
from ..models import AgentRun, AuditEvent, ToolCall, utcnow
from ..telemetry import estimate_cost_usd

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat() + "Z"


def _require_admin(request: Request) -> MabelUser:
    user = resolve_mabel_user(request)
    if not user.is_mabel_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _run_payload(run: AgentRun) -> dict[str, Any]:
    state = run.state_json if isinstance(run.state_json, dict) else {}
    usage = state.get("usage") if isinstance(state.get("usage"), dict) else {}
    return {
        "id": run.id,
        "conversation_id": run.conversation_id,
        "user_email": run.user_email,
        "surface": run.surface,
        "status": run.status,
        "model": run.model,
        "trace_id": run.trace_id,
        "created_at": _iso(run.created_at),
        "finished_at": _iso(run.finished_at),
        "usage": usage,
    }


def _tool_payload(call: ToolCall) -> dict[str, Any]:
    return {
        "id": call.id,
        "run_id": call.run_id,
        "tool_name": call.tool_name,
        "status": call.status,
        "server_slug": call.server_slug,
        "scope": call.scope,
        "arguments": call.arguments,
        "output_preview": call.output_preview,
        "created_at": _iso(call.created_at),
    }


def _audit_payload(event: AuditEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "actor_email": event.actor_email,
        "event_type": event.event_type,
        "status": event.status,
        "metadata": event.metadata,
        "created_at": _iso(event.created_at),
    }


def _event_cost(settings: Any, model: str, usage: dict[str, Any], input_tokens: int, output_tokens: int) -> tuple[float, bool]:
    cost_usd = usage.get("cost_usd")
    if isinstance(cost_usd, (int, float)):
        return float(cost_usd), False
    estimated = estimate_cost_usd(settings, model, input_tokens, output_tokens)
    return (float(estimated), True) if isinstance(estimated, (int, float)) else (0.0, True)


@router.get("/check-access")
def check_admin_access(request: Request) -> dict[str, bool]:
    user = resolve_mabel_user(request)
    return {"is_admin": user.is_mabel_admin}


@router.get("/logs")
def admin_logs(
    request: Request,
    days: int = Query(default=7, ge=1, le=365),
    limit: int = Query(default=200, ge=1, le=1000),
) -> dict[str, Any]:
    admin_user = _require_admin(request)
    settings = request.app.state.settings
    store = get_store(settings)
    since = utcnow() - timedelta(days=days)
    scan_limit = max(limit, 1000)

    usage_events = [event for event in store.list_usage_events(None) if event.get("created_at") and event["created_at"] >= since]
    runs = [run for run in store.list_runs(None) if run.created_at >= since]
    tool_calls = [call for call in store.list_tool_calls(scan_limit) if call.created_at >= since]
    audit_events = [event for event in store.list_audit_events(scan_limit) if event.created_at >= since]

    totals: dict[str, int | float] = {
        "requests": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "conversations": len({event.get("conversation_id") for event in usage_events if event.get("conversation_id") is not None}),
        "tool_calls": len(tool_calls),
        "users": len({event.get("user_email") for event in usage_events if event.get("user_email")}),
    }
    by_user: dict[str, dict[str, Any]] = {}
    by_surface: Counter[str] = Counter()
    by_status: Counter[str] = Counter()
    by_model: dict[str, dict[str, Any]] = {}
    spend_by_day: defaultdict[str, float] = defaultdict(float)
    requests_by_day: Counter[str] = Counter()
    recent_usage: list[dict[str, Any]] = []

    for event in usage_events:
        usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
        input_tokens = int(usage.get("input_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        total_tokens = int(usage.get("total_tokens") or input_tokens + output_tokens)
        model = str(event.get("model") or "unknown")
        cost, cost_estimated = _event_cost(settings, model, usage, input_tokens, output_tokens)
        created_at = event.get("created_at")
        day = created_at.date().isoformat() if isinstance(created_at, datetime) else "unknown"

        totals["requests"] = int(totals["requests"]) + 1
        totals["input_tokens"] = int(totals["input_tokens"]) + input_tokens
        totals["output_tokens"] = int(totals["output_tokens"]) + output_tokens
        totals["total_tokens"] = int(totals["total_tokens"]) + total_tokens
        totals["cost_usd"] = round(float(totals["cost_usd"]) + cost, 6)
        requests_by_day[day] += 1
        spend_by_day[day] = round(spend_by_day[day] + cost, 6)

        user_email = str(event.get("user_email") or "unknown")
        user_row = by_user.setdefault(
            user_email,
            {"user_email": user_email, "requests": 0, "total_tokens": 0, "cost_usd": 0.0, "last_seen_at": None},
        )
        user_row["requests"] += 1
        user_row["total_tokens"] += total_tokens
        user_row["cost_usd"] = round(float(user_row["cost_usd"]) + cost, 6)
        user_row["last_seen_at"] = _iso(created_at) if isinstance(created_at, datetime) else None
        model_row = by_model.setdefault(model, {"model": model, "requests": 0, "total_tokens": 0, "cost_usd": 0.0})
        model_row["requests"] += 1
        model_row["total_tokens"] += total_tokens
        model_row["cost_usd"] = round(float(model_row["cost_usd"]) + cost, 6)
        by_surface[str(event.get("surface") or "unknown")] += 1
        by_status[str(event.get("status") or "unknown")] += 1
        recent_usage.append(
            {
                "run_id": event.get("run_id"),
                "conversation_id": event.get("conversation_id"),
                "user_email": event.get("user_email"),
                "surface": event.get("surface"),
                "status": event.get("status"),
                "model": event.get("model"),
                "created_at": _iso(created_at) if isinstance(created_at, datetime) else None,
                "finished_at": _iso(event.get("finished_at")) if isinstance(event.get("finished_at"), datetime) else None,
                "usage": {**usage, "cost_usd": cost, "cost_estimated": cost_estimated},
            }
        )

    return {
        "scope": "admin",
        "admin": {"email": admin_user.email},
        "period": {"days": days, "since": _iso(since)},
        "store": store.health(),
        "totals": totals,
        "breakdowns": {
            "by_user": sorted(by_user.values(), key=lambda row: (row["total_tokens"], row["requests"]), reverse=True)[:100],
            "by_surface": [{"surface": key, "requests": value} for key, value in by_surface.most_common()],
            "by_status": [{"status": key, "requests": value} for key, value in by_status.most_common()],
            "by_model": sorted(by_model.values(), key=lambda row: row["total_tokens"], reverse=True)[:25],
            "daily": [
                {"date": day, "requests": requests_by_day[day], "cost_usd": spend_by_day[day]}
                for day in sorted(requests_by_day.keys())
            ],
        },
        "recent": {
            "usage": recent_usage[:limit],
            "runs": [_run_payload(run) for run in runs[:limit]],
            "tool_calls": [_tool_payload(call) for call in tool_calls[:limit]],
            "audit_events": [_audit_payload(event) for event in audit_events[:limit]],
        },
        "counts": {
            "runs": len(runs),
            "usage_events": len(usage_events),
            "tool_calls": len(tool_calls),
            "audit_events": len(audit_events),
        },
    }