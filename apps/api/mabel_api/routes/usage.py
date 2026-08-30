from __future__ import annotations

import os

from datetime import timedelta

from fastapi import APIRouter, Query, Request

from ..auth import resolve_mabel_user
from ..db import get_store
from ..models import utcnow

router = APIRouter(prefix="/api/v1/usage", tags=["usage"])


@router.get("/summary")
def usage_summary(
    request: Request,
    days: int = Query(default=7, ge=1, le=365),
) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    force_all = os.getenv("MABEL_USAGE_FORCE_ALL", "").strip().lower() in {"1", "true", "yes", "on"}
    include_all = user.is_mabel_approver or force_all
    since = utcnow() - timedelta(days=days)
    events = [
        event
        for event in store.list_usage_events(None if include_all else user.email)
        if event.get("created_at") and event["created_at"] >= since
    ]

    requests_by_user: dict[str, dict] = {}
    rows = []
    totals = {"requests": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
    for event in events:
        usage = event.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        input_tokens = int(usage.get("input_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        total_tokens = int(usage.get("total_tokens") or input_tokens + output_tokens)
        totals["requests"] += 1
        totals["input_tokens"] += input_tokens
        totals["output_tokens"] += output_tokens
        totals["total_tokens"] += total_tokens
        cost_usd = usage.get("cost_usd")
        if isinstance(cost_usd, (int, float)):
            totals["cost_usd"] = round(float(totals["cost_usd"]) + float(cost_usd), 6)
        user_row = requests_by_user.setdefault(
            str(event.get("user_email") or ""),
            {"user_email": str(event.get("user_email") or ""), "requests": 0, "total_tokens": 0, "cost_usd": 0.0},
        )
        user_row["requests"] += 1
        user_row["total_tokens"] += total_tokens
        if isinstance(cost_usd, (int, float)):
            user_row["cost_usd"] = round(float(user_row["cost_usd"]) + float(cost_usd), 6)
        rows.append(
            {
                "run_id": event.get("run_id"),
                "conversation_id": event.get("conversation_id"),
                "user_email": event.get("user_email"),
                "surface": event.get("surface"),
                "status": event.get("status"),
                "model": event.get("model"),
                "created_at": event["created_at"].isoformat() + "Z",
                "finished_at": event["finished_at"].isoformat() + "Z" if event.get("finished_at") else None,
                "usage": usage,
            }
        )

    leaderboard = sorted(requests_by_user.values(), key=lambda row: (row["total_tokens"], row["requests"]), reverse=True)
    return {
        "scope": "all" if include_all else "self",
        "days": days,
        "totals": totals,
        "leaderboard": leaderboard,
        "runs": rows[:200],
    }
