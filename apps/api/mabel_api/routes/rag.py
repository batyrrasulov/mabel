from __future__ import annotations

import re

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..auth import resolve_mabel_user
from ..db import get_store
from .memory import _cosine_similarity, _embed_text

router = APIRouter(prefix="/api/v1/rag", tags=["rag"])


class RagSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    sources: list[str] = Field(default_factory=list)


def _tokens(text: str) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9]+", text.lower()) if token]


def _score(text: str, tokens: list[str]) -> float:
    lowered = text.lower()
    score = 0.0
    for token in tokens:
        if token in lowered:
            score += 1.0
        if lowered.startswith(token):
            score += 0.2
    return score


def _snippet(text: str, tokens: list[str], max_chars: int = 240) -> str:
    compact = " ".join(str(text).split())
    if not compact:
        return ""
    if not tokens:
        return compact[:max_chars]
    lowered = compact.lower()
    idx = min((lowered.find(token) for token in tokens if lowered.find(token) >= 0), default=-1)
    if idx < 0:
        return compact[:max_chars]
    start = max(0, idx - 70)
    end = min(len(compact), idx + max_chars)
    out = compact[start:end]
    if start > 0:
        out = "..." + out
    if end < len(compact):
        out = out + "..."
    return out


@router.post("/search")
def search(payload: RagSearchRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    query = payload.query.strip()
    query_tokens = _tokens(query)
    requested = {source.strip().lower() for source in payload.sources if source.strip()}
    allow_all = not requested

    def source_allowed(name: str) -> bool:
        lowered = name.strip().lower()
        if allow_all:
            return True
        aliases = {
            "memory": {"memory", "memories"},
            "skills": {"skills", "skill"},
            "documents": {"documents", "docs", "document"},
            "conversations": {"conversations", "messages", "chat"},
        }
        for canonical, values in aliases.items():
            if lowered == canonical:
                return canonical in requested or any(value in requested for value in values)
        return lowered in requested

    results: list[dict] = []

    if source_allowed("memory"):
        query_embedding = _embed_text(settings, query)
        memory_rows = []
        if (
            getattr(settings, "memory_pgvector_enabled", True)
            and query_embedding
            and hasattr(store, "search_memory_items_semantic")
        ):
            try:
                memory_rows = store.search_memory_items_semantic(user.email, query, query_embedding, limit=80)
            except Exception:
                memory_rows = []
        if not memory_rows:
            memory_rows = store.list_memory_items_for_user(user.email)

        for item in memory_rows:
            content = f"{item.key}\n{item.content}\n{' '.join(item.tags)}"
            keyword = _score(content, query_tokens)
            semantic = _cosine_similarity(query_embedding, item.embedding) if query_embedding and item.embedding else 0.0
            if keyword <= 0 and semantic < 0.55:
                continue
            results.append(
                {
                    "source": "memory",
                    "title": item.key,
                    "snippet": _snippet(content, query_tokens),
                    "citation": {"system": "memory", "kind": "memory_item", "id": item.id},
                    "_rank": keyword + (semantic * 2.5) + float(item.confidence) + (2.0 if item.pinned else 0.0),
                }
            )

    if source_allowed("skills"):
        for skill in store.list_skills():
            content = f"{skill.name}\n{skill.id}\n{skill.owner_team}\n{skill.content_md}"
            rank = _score(content, query_tokens)
            if rank <= 0:
                continue
            results.append(
                {
                    "source": "skills",
                    "title": skill.name,
                    "snippet": _snippet(content, query_tokens),
                    "citation": {"system": "skills", "kind": "skill", "id": skill.id},
                    "_rank": rank,
                }
            )

    if source_allowed("documents"):
        for doc in store.list_documents_for_user(user.email):
            content = f"{doc.title}\n{doc.content}"
            rank = _score(content, query_tokens)
            if rank <= 0:
                continue
            results.append(
                {
                    "source": "documents",
                    "title": doc.title,
                    "snippet": _snippet(content, query_tokens),
                    "citation": {"system": "documents", "kind": "document", "id": doc.id},
                    "_rank": rank,
                }
            )

    if source_allowed("conversations"):
        for row in store.list_conversations(user.email)[:10]:
            conversation = row.get("conversation")
            if conversation is None or conversation.id is None:
                continue
            for msg in store.list_messages(conversation.id)[-12:]:
                content = msg.content or ""
                rank = _score(content, query_tokens)
                if rank <= 0:
                    continue
                results.append(
                    {
                        "source": "conversations",
                        "title": conversation.title,
                        "snippet": _snippet(content, query_tokens),
                        "citation": {
                            "system": "conversations",
                            "kind": "message",
                            "conversation_id": conversation.id,
                            "message_id": msg.id,
                        },
                        "_rank": rank,
                    }
                )

    results.sort(key=lambda item: float(item.get("_rank", 0)), reverse=True)
    limited = [{k: v for k, v in row.items() if k != "_rank"} for row in results[:12]]
    return {
        "user": {"email": user.email},
        "query": query,
        "results": limited,
        "source_backed": bool(limited),
    }
