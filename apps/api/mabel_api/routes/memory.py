from __future__ import annotations

import math
import re
import uuid

from fastapi import APIRouter, HTTPException, Query, Request

from ..auth import resolve_mabel_user
from ..db import get_store
from ..models import MabelMemoryItem, utcnow
from ..schemas import MemoryCreateRequest, MemoryImportRequest, MemoryUpdateRequest

router = APIRouter(prefix="/api/v1", tags=["memory"])


def _serialize_memory(item: MabelMemoryItem) -> dict:
    return {
        "id": item.id,
        "key": item.key,
        "content": item.content,
        "tags": item.tags,
        "pinned": item.pinned,
        "confidence": item.confidence,
        "source": item.source,
        "conversation_id": item.conversation_id,
        "last_used_at": f"{item.last_used_at.isoformat()}Z" if item.last_used_at else None,
        "created_at": f"{item.created_at.isoformat()}Z",
        "updated_at": f"{item.updated_at.isoformat()}Z",
    }


def _clean_tags(tags: list[str]) -> list[str]:
    seen: set[str] = set()
    cleaned: list[str] = []
    for raw in tags:
        tag = str(raw).strip()
        if not tag:
            continue
        lowered = tag.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        cleaned.append(tag)
    return cleaned


def _tokenize(text: str) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9]+", text.lower()) if token]


def _keyword_score(item: MabelMemoryItem, query_tokens: list[str]) -> float:
    if not query_tokens:
        return 0.0
    text = f"{item.key}\n{item.content}\n{' '.join(item.tags)}".lower()
    score = 0.0
    for token in query_tokens:
        if token in text:
            score += 1.0
        if text.startswith(token):
            score += 0.2
    return score


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _embed_text(settings, text: str) -> list[float]:
    if not settings.memory_semantic_enabled:
        return []
    if not settings.openai_api_key:
        return []
    clean = text.strip()
    if not clean:
        return []
    try:
        from openai import OpenAI
    except Exception:
        return []
    try:
        client = OpenAI(api_key=settings.openai_api_key)
        result = client.embeddings.create(
            model=settings.memory_embedding_model,
            input=clean[: max(1, settings.memory_embedding_max_chars)],
        )
        data = result.data[0].embedding if result and result.data else []
        if not isinstance(data, list):
            return []
        return [float(value) for value in data]
    except Exception:
        return []


@router.get("/memory")
def list_memory(request: Request, q: str | None = Query(default=None, max_length=200)) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    if not q or not q.strip():
        rows = store.list_memory_items_for_user(user.email, None)
        return {"memory": [_serialize_memory(row) for row in rows]}

    query = q.strip()
    tokens = _tokenize(query)
    rows = store.list_memory_items_for_user(user.email, None)
    query_embedding = _embed_text(settings, query)
    pgvector_rows: list[MabelMemoryItem] = []
    if (
        getattr(settings, "memory_pgvector_enabled", True)
        and query_embedding
        and hasattr(store, "search_memory_items_semantic")
    ):
        try:
            pgvector_rows = store.search_memory_items_semantic(user.email, query, query_embedding, limit=120)
        except Exception:
            pgvector_rows = []
    if pgvector_rows:
        return {"memory": [_serialize_memory(row) for row in pgvector_rows]}

    ranked: list[tuple[float, MabelMemoryItem]] = []
    for row in rows:
        keyword = _keyword_score(row, tokens)
        semantic = _cosine_similarity(query_embedding, row.embedding) if query_embedding and row.embedding else 0.0
        if keyword <= 0 and semantic < 0.55:
            continue
        rank = keyword + (semantic * 2.5) + (float(row.confidence) * 0.1) + (2.0 if row.pinned else 0.0)
        ranked.append((rank, row))
    ranked.sort(key=lambda item: item[0], reverse=True)
    rows = [row for _, row in ranked]
    return {"memory": [_serialize_memory(row) for row in rows]}


@router.post("/memory")
def create_memory(payload: MemoryCreateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    item = store.create_memory_item(
        MabelMemoryItem(
            id=f"mem_{uuid.uuid4().hex[:12]}",
            owner_email=user.email,
            key=payload.key.strip(),
            content=payload.content.strip(),
            tags=[str(tag).strip() for tag in payload.tags if str(tag).strip()],
            embedding=_embed_text(settings, f"{payload.key.strip()}\n{payload.content.strip()}"),
            pinned=payload.pinned,
            confidence=payload.confidence,
            source=payload.source.strip() or "manual",
            conversation_id=payload.conversation_id,
            last_used_at=utcnow(),
        )
    )
    return {"item": _serialize_memory(item)}


@router.patch("/memory/{item_id}")
def update_memory(item_id: str, payload: MemoryUpdateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    item = store.get_memory_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="memory item not found")
    if item.owner_email != user.email:
        raise HTTPException(status_code=403, detail="memory item does not belong to current user")

    if payload.key is not None:
        item.key = payload.key.strip() or item.key
    if payload.content is not None:
        item.content = payload.content.strip() or item.content
    if payload.tags is not None:
        item.tags = [str(tag).strip() for tag in payload.tags if str(tag).strip()]
    if payload.pinned is not None:
        item.pinned = payload.pinned
    if payload.confidence is not None:
        item.confidence = payload.confidence
    if payload.source is not None:
        item.source = payload.source.strip() or item.source
    if payload.conversation_id is not None:
        item.conversation_id = payload.conversation_id
    if payload.key is not None or payload.content is not None:
        item.embedding = _embed_text(settings, f"{item.key}\n{item.content}")
    item.last_used_at = utcnow()

    updated = store.update_memory_item(item)
    return {"item": _serialize_memory(updated)}


@router.post("/memory/{item_id}/touch")
def touch_memory(item_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    item = store.get_memory_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="memory item not found")
    if item.owner_email != user.email:
        raise HTTPException(status_code=403, detail="memory item does not belong to current user")
    item.last_used_at = utcnow()
    updated = store.update_memory_item(item)
    return {"item": _serialize_memory(updated)}


@router.delete("/memory/{item_id}")
def delete_memory(item_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    item = store.get_memory_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="memory item not found")
    if item.owner_email != user.email:
        raise HTTPException(status_code=403, detail="memory item does not belong to current user")
    store.delete_memory_item(item_id)
    return {"deleted": item_id}


@router.get("/memory/export")
def export_memory(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    rows = get_store(settings).list_memory_items_for_user(user.email)
    return {
        "version": "mabel-memory.v1",
        "count": len(rows),
        "items": [
            {
                "key": row.key,
                "content": row.content,
                "tags": row.tags,
                "pinned": row.pinned,
                "confidence": row.confidence,
                "source": row.source,
                "conversation_id": row.conversation_id,
                "created_at": f"{row.created_at.isoformat()}Z",
                "updated_at": f"{row.updated_at.isoformat()}Z",
            }
            for row in rows
        ],
    }


@router.post("/memory/import")
def import_memory(payload: MemoryImportRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    existing = store.list_memory_items_for_user(user.email)

    if payload.mode == "replace":
        for row in existing:
            store.delete_memory_item(row.id)
        existing = []

    by_key = {row.key.strip().lower(): row for row in existing}
    created = 0
    updated = 0
    skipped = 0
    imported_ids: list[str] = []

    for incoming in payload.items:
        normalized_key = incoming.key.strip().lower()
        if not normalized_key:
            skipped += 1
            continue
        target = by_key.get(normalized_key)
        if target is None:
            target = store.create_memory_item(
                MabelMemoryItem(
                    id=f"mem_{uuid.uuid4().hex[:12]}",
                    owner_email=user.email,
                    key=incoming.key.strip(),
                    content=incoming.content.strip(),
                    tags=_clean_tags(incoming.tags),
                    embedding=_embed_text(settings, f"{incoming.key.strip()}\n{incoming.content.strip()}"),
                    pinned=incoming.pinned,
                    confidence=incoming.confidence,
                    source=incoming.source.strip() or "import",
                    conversation_id=incoming.conversation_id,
                    last_used_at=utcnow(),
                )
            )
            by_key[normalized_key] = target
            created += 1
            imported_ids.append(target.id)
            continue

        target.key = incoming.key.strip() or target.key
        target.content = incoming.content.strip() or target.content
        target.tags = _clean_tags(incoming.tags)
        target.embedding = _embed_text(settings, f"{target.key}\n{target.content}")
        target.pinned = incoming.pinned
        target.confidence = incoming.confidence
        target.source = incoming.source.strip() or target.source
        target.conversation_id = incoming.conversation_id
        target.last_used_at = utcnow()
        target = store.update_memory_item(target)
        updated += 1
        imported_ids.append(target.id)

    return {
        "status": "ok",
        "mode": payload.mode,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "imported_ids": imported_ids,
    }
