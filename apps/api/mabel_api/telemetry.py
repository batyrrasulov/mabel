from __future__ import annotations

import json
import math
import uuid
from typing import Any

from .db import MabelStore
from .models import AgentRun


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text or "") / 4)) if text else 0


def estimate_cost_usd(settings, model: str, input_tokens: int, output_tokens: int) -> float | None:
    try:
        prices = json.loads(settings.token_prices_json or "{}")
    except Exception:
        prices = {}
    if not isinstance(prices, dict):
        return None
    price = prices.get(model) or prices.get(model.split(":", 1)[0]) or prices.get("default")
    if not isinstance(price, dict):
        return _estimate_cost_from_registry(model, input_tokens, output_tokens)
    input_per_million = price.get("input_per_million", price.get("input_per_1m", price.get("prompt_per_million")))
    output_per_million = price.get("output_per_million", price.get("output_per_1m", price.get("completion_per_million")))
    if input_per_million is None and output_per_million is None:
        return _estimate_cost_from_registry(model, input_tokens, output_tokens)
    try:
        input_cost = (input_tokens / 1_000_000) * float(input_per_million or 0)
        output_cost = (output_tokens / 1_000_000) * float(output_per_million or 0)
    except (TypeError, ValueError):
        return _estimate_cost_from_registry(model, input_tokens, output_tokens)
    return round(input_cost + output_cost, 6)


def _estimate_cost_from_registry(model: str, input_tokens: int, output_tokens: int) -> float | None:
    del model, input_tokens, output_tokens
    return None


def usage_summary(
    *,
    settings,
    raw_usage: dict[str, Any] | None,
    message: str,
    assistant_text: str,
    model: str,
    user_email: str,
    surface: str,
    run_id: str,
    conversation_id: int | None,
) -> dict[str, Any]:
    usage = raw_usage if isinstance(raw_usage, dict) else {}
    input_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or estimate_tokens(message))
    output_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or estimate_tokens(assistant_text))
    total_tokens = int(usage.get("total_tokens") or (input_tokens + output_tokens))
    return {
        "run_id": run_id,
        "conversation_id": conversation_id,
        "user_email": user_email,
        "surface": surface,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "estimated": bool(usage.get("estimated", raw_usage is None)),
        "cost_usd": estimate_cost_usd(settings, model, input_tokens, output_tokens),
    }


def record_request_usage(
    *,
    store: MabelStore,
    settings,
    user_email: str,
    surface: str,
    prompt: str,
    output: str,
    status: str = "completed",
    model: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> AgentRun:
    run = AgentRun(
        id=f"run_{uuid.uuid4().hex}",
        conversation_id=None,
        user_email=user_email,
        surface=surface,
        status="running",
        model=model or settings.openai_model,
    )
    store.create_run(run)
    usage = usage_summary(
        settings=settings,
        raw_usage=None,
        message=prompt,
        assistant_text=output,
        model=run.model,
        user_email=user_email,
        surface=surface,
        run_id=run.id,
        conversation_id=None,
    )
    if metadata:
        usage["metadata"] = metadata
    store.record_run_usage(run.id, usage)
    store.update_run_status(run.id, status)
    return run
