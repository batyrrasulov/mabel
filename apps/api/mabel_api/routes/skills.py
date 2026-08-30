from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, HTTPException, Query, Request

from ..agents import runtime
from ..auth import resolve_mabel_user
from ..catalog import (
    CUSTOM_SKILL_SOURCE_TYPES,
    SkillOwnerAssignmentError,
    is_privileged_skill_actor,
    normalize_skill_status,
    mabel_visible_skill_search_results,
    mabel_visible_skills,
    resolve_skill_owner_team,
    search_skills_ranked,
    skill_create_conflict_detail,
    skill_description,
)
from ..db import get_store
from ..models import AgentRun, AuditEvent, Conversation, Message, Skill, ToolCall, utcnow
from ..schemas import SkillCreateRequest, SkillMarketplaceSyncRequest, SkillRunRequest, SkillShareRequest, SkillUpdateRequest
from ..skill_registry import (
    GitHubSkillRegistry,
    LocalSkillRegistry,
    SkillRegistryAuthError,
    SkillRegistryConfigError,
    SkillRegistryError,
    SkillRegistryEntry,
    upsert_marketplace_skills,
)
from ..telemetry import record_request_usage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/skills", tags=["skills"])


def _skill_payload(row: Skill, *, include_content: bool = False) -> dict:
    payload = {
        "id": row.id,
        "name": row.name,
        "owner_team": row.owner_team,
        "status": normalize_skill_status(row.status),
        "current_version": row.current_version,
        "tags": row.tags,
        "mcp_bindings": row.mcp_bindings,
        "description": skill_description(row),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }
    if include_content:
        payload["content_md"] = row.content_md
    return payload


def _github_token_configured(settings) -> bool:
    return bool(settings.skills_github_token or settings.github_token)


def _marketplace_entries(settings) -> tuple[list[SkillRegistryEntry], str, str | None]:
    try:
        return GitHubSkillRegistry(settings).fetch_marketplace(), "ok", None
    except SkillRegistryError as github_error:
        try:
            return LocalSkillRegistry(settings).fetch_marketplace(), "local_fallback", str(github_error)
        except SkillRegistryError as local_error:
            raise SkillRegistryError(f"{github_error}; local fallback failed: {local_error}") from local_error


@router.post("")
def create_skill(payload: SkillCreateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    privileged = is_privileged_skill_actor(
        is_mabel_approver=user.is_mabel_approver,
        is_mabel_admin=user.is_mabel_admin,
    )
    try:
        owner_team = resolve_skill_owner_team(
            payload.owner_team,
            requester_email=user.email,
            requester_is_privileged=privileged,
        )
    except SkillOwnerAssignmentError as exc:
        raise HTTPException(status_code=403, detail=exc.message) from exc

    existing = store.get_skill(payload.id)
    if existing is not None:
        conflict = skill_create_conflict_detail(
            existing,
            requested_id=payload.id,
            requested_owner_team=owner_team,
        )
        logger.warning(
            "mabel.skills.create_conflict requester=%s skill_id=%s requested_owner=%s existing_owner=%s existing_status=%s",
            user.email,
            payload.id,
            owner_team,
            existing.owner_team,
            existing.status,
        )
        raise HTTPException(status_code=409, detail=conflict)

    skill = store.create_skill(
        Skill(
            id=payload.id,
            name=payload.name,
            owner_team=owner_team,
            status="published",
            current_version="0.1.0",
            content_md=payload.content_md,
            tags=payload.tags,
            mcp_bindings=payload.mcp_bindings,
            source={"type": "database_draft", "description": payload.description or ""},
        )
    )
    logger.info(
        "mabel.skills.created requester=%s skill_id=%s owner_team=%s",
        user.email,
        skill.id,
        skill.owner_team,
    )
    return {"skill": _skill_payload(skill, include_content=True)}


@router.get("")
def list_skills(request: Request, query: str | None = Query(None)) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    needle = (query or "").strip()
    store = get_store(settings)
    visible_skills = mabel_visible_skills(
        store.list_skills(),
        viewer_email=user.email,
        viewer_is_approver=user.is_mabel_approver,
        viewer_is_admin=user.is_mabel_admin,
    )
    if not needle:
        return {"skills": [_skill_payload(row) for row in visible_skills]}
    ranked = mabel_visible_skill_search_results(search_skills_ranked(visible_skills, needle))
    return {
        "query": needle,
        "skills": [
            {
                **_skill_payload(row["skill"]),
                "score": row["score"],
                "matched_fields": row["matched_fields"],
                "snippet": row["snippet"],
            }
            for row in ranked
        ],
    }


@router.get("/marketplace")
def skill_marketplace(request: Request) -> dict:
    settings = request.app.state.settings
    resolve_mabel_user(request)
    try:
        entries, status, error = _marketplace_entries(settings)
    except SkillRegistryError as exc:
        return {
            "status": "error",
            "repo": settings.skills_github_repo,
            "ref": settings.skills_github_ref,
            "base_path": settings.skills_github_base_path,
            "token_configured": _github_token_configured(settings),
            "skills": [],
            "error": str(exc),
        }
    return {
        "status": status,
        "repo": settings.skills_github_repo,
        "ref": settings.skills_github_ref,
        "base_path": settings.skills_github_base_path,
        "token_configured": _github_token_configured(settings),
        "skills": [entry.to_payload() for entry in entries],
        "error": error,
    }


@router.post("/sync")
def sync_skill_marketplace(payload: SkillMarketplaceSyncRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    try:
        entries, source_status, source_error = _marketplace_entries(settings)
    except SkillRegistryConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SkillRegistryAuthError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SkillRegistryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    selected = [entry for entry in entries if payload.force or entry.status in {"published", "review"}]
    synced = upsert_marketplace_skills(store, selected)
    store.add_audit_event(
        AuditEvent(
            actor_email=user.email,
            event_type="skills.marketplace.sync",
            status="completed",
            metadata={
                "repo": settings.skills_github_repo,
                "ref": settings.skills_github_ref,
                "source_status": source_status,
                "source_error": source_error,
                "available": len(entries),
                "synced": len(synced),
                "force": payload.force,
            },
        )
    )
    return {
        "status": "completed" if source_status == "ok" else "completed_local_fallback",
        "repo": settings.skills_github_repo,
        "ref": settings.skills_github_ref,
        "source_status": source_status,
        "source_error": source_error,
        "available": len(entries),
        "synced": [_skill_payload(row) for row in synced],
        "skipped": [entry.id for entry in entries if entry not in selected],
    }


@router.get("/{skill_id:path}")
def skill_detail(skill_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    resolve_mabel_user(request)
    skill = get_store(settings).get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return {"skill": _skill_payload(skill, include_content=True)}


@router.patch("/{skill_id:path}")
def update_skill(skill_id: str, payload: SkillUpdateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    resolve_mabel_user(request)
    store = get_store(settings)
    skill = store.get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="skill not found")

    if payload.name is not None:
        skill.name = payload.name
    if payload.owner_team is not None:
        skill.owner_team = payload.owner_team
    if payload.content_md is not None:
        skill.content_md = payload.content_md
    if payload.tags is not None:
        skill.tags = payload.tags
    if payload.mcp_bindings is not None:
        skill.mcp_bindings = payload.mcp_bindings
    if payload.status is not None:
        skill.status = normalize_skill_status(payload.status)
    if payload.description is not None:
        skill.source = {**(skill.source or {}), "description": payload.description}

    skill = store.update_skill(skill)
    return {"skill": _skill_payload(skill, include_content=True)}


@router.delete("/{skill_id:path}")
def delete_skill(skill_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    skill = store.get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="skill not found")
    prior_source = skill.source if isinstance(skill.source, dict) else {}
    prior_type = str(prior_source.get("type") or "").strip().lower()
    if prior_type not in CUSTOM_SKILL_SOURCE_TYPES:
        raise HTTPException(status_code=409, detail="curated skills cannot be deleted")
    privileged = is_privileged_skill_actor(
        is_mabel_approver=user.is_mabel_approver,
        is_mabel_admin=user.is_mabel_admin,
    )
    owner = (skill.owner_team or "").strip().lower()
    requester = (user.email or "").strip().lower()
    if not privileged and owner != requester:
        raise HTTPException(status_code=403, detail="only the skill owner can delete this skill")
    store.delete_skill(skill_id)
    return {"deleted": skill_id}


@router.post("/{skill_id:path}/share")
def share_skill(skill_id: str, payload: SkillShareRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    skill = store.get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="skill not found")
    try:
        result = GitHubSkillRegistry(settings).push_skill(
            skill,
            requested_by=user.email,
            target_repo=payload.target_repo,
            base_ref=payload.base_ref,
            visibility=payload.visibility,
            commit_message=payload.message,
        )
    except SkillRegistryConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SkillRegistryAuthError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SkillRegistryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    share_record = {
        "visibility": payload.visibility,
        "shared_by": user.email,
        "shared_at": utcnow().isoformat() + "Z",
        **result,
    }
    prior_source = skill.source if isinstance(skill.source, dict) else {}
    prior_type = str(prior_source.get("type") or "").strip().lower()
    skill.source = {
        **prior_source,
        "visibility": payload.visibility,
        "share": share_record,
        "repo": result["repo"],
        "ref": result["branch"],
        "path": result["path"],
    }
    if prior_type not in {"chat_created", "database_draft"}:
        skill.source["type"] = "github"
    if prior_type in CUSTOM_SKILL_SOURCE_TYPES:
        skill.status = "published"
    skill = store.update_skill(skill)
    store.add_audit_event(
        AuditEvent(
            actor_email=user.email,
            event_type="skills.share",
            status="completed",
            metadata={"skill_id": skill.id, "repo": result["repo"], "branch": result["branch"], "path": result["path"], "visibility": payload.visibility},
        )
    )
    return {"status": "shared", "skill": _skill_payload(skill, include_content=True), "share": result}


@router.post("/{skill_id:path}/run")
async def run_skill(skill_id: str, payload: SkillRunRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    skill = store.get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="skill not found")

    prompt = payload.prompt.strip() or f"Run {skill.name} and summarize outcomes."
    conversation = store.create_conversation(
        Conversation(
            user_email=user.email,
            title=f"{skill.name} run",
            surface="agents",
        )
    )
    if conversation.id is None:
        raise RuntimeError("conversation id missing after creation")

    run_id = f"run_{uuid.uuid4().hex}"
    store.create_run(
        AgentRun(
            id=run_id,
            conversation_id=conversation.id,
            user_email=user.email,
            surface="skills",
            status="running",
            model=settings.openai_model,
        )
    )
    store.add_message(
        Message(
            conversation_id=conversation.id,
            role="user",
            content=prompt,
            run_id=run_id,
        )
    )

    execution_prompt = (
        f'Use Mabel skill "{skill.name}" ({skill.id}). '
        f'First call mabel_get_skill with skill_id="{skill.id}", then follow that skill\'s instructions. '
        "Keep outputs source-backed. When the skill asks for an artifact, create and save it with mabel_save_artifact directly.\n\n"
        f"User request:\n{prompt}"
    )
    assistant_parts: list[str] = []
    latest_sources: list[dict] = []
    latest_usage: dict | None = None
    try:
        async for event in runtime.run_openai_agents_stream(
            message=execution_prompt,
            settings=settings,
            model=settings.openai_model,
            conversation_id=conversation.id,
            user_identity={
                "email": user.email,
                "user_id": user.user_id,
                "name": user.name,
                "groups": list(user.groups),
            },
        ):
            event_type = event.get("type")
            if event_type == "token":
                assistant_parts.append(str(event.get("text") or ""))
            elif event_type == "sources":
                incoming = event.get("sources") or []
                if isinstance(incoming, list):
                    latest_sources = [item for item in incoming if isinstance(item, dict)]
            elif event_type == "usage":
                incoming_usage = event.get("usage")
                if isinstance(incoming_usage, dict):
                    latest_usage = incoming_usage
            elif event_type == "tool_call":
                store.add_tool_call(
                    ToolCall(
                        run_id=run_id,
                        tool_name=str(event.get("tool_name") or "tool"),
                        status="called",
                        arguments=event.get("arguments") if isinstance(event.get("arguments"), dict) else {},
                    )
                )
            elif event_type == "tool_result":
                store.add_tool_call(
                    ToolCall(
                        run_id=run_id,
                        tool_name=str(event.get("tool_name") or "tool"),
                        status="completed",
                        output_preview=str(event.get("output_preview") or "")[:2000],
                    )
                )
    except Exception as exc:
        store.update_run_status(run_id, "failed")
        store.record_run_usage(run_id, {"error": str(exc), "skill_id": skill.id})
        raise HTTPException(status_code=500, detail=f"skill run failed: {exc}") from exc

    assistant_text = "\n".join(
        part
        for part in [
            f"{skill.name} run completed.",
            "".join(assistant_parts).strip(),
        ]
        if part
    )
    store.add_message(
        Message(
            conversation_id=conversation.id,
            role="assistant",
            content=assistant_text,
            run_id=run_id,
            sources=latest_sources,
        )
    )
    store.record_run_usage(run_id, {"usage": latest_usage or {}, "skill_id": skill.id, "sources": len(latest_sources)})
    store.update_run_status(run_id, "completed")
    store.touch_conversation(conversation.id)

    record_request_usage(
        store=store,
        settings=settings,
        user_email=user.email,
        surface="skills",
        prompt=prompt,
        output=assistant_text,
        metadata={"skill_id": skill.id, "conversation_id": conversation.id, "run_id": run_id},
    )
    return {
        "status": "completed",
        "skill": _skill_payload(skill),
        "assistant_text": assistant_text,
        "conversation_id": conversation.id,
        "run_id": run_id,
        "sources": latest_sources,
        "sources_required": True,
        "controlled_actions": [
            {"scope": "create", "requires_approval": True},
            {"scope": "update", "requires_approval": True},
            {"scope": "delete", "requires_approval": True},
        ],
        "prompt": prompt,
    }
