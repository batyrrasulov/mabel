from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request

from ..auth import resolve_mabel_user
from ..db import MabelStore, get_store
from ..models import Conversation, MabelProject
from ..schemas import ProjectCreateRequest, ProjectUpdateRequest
from .files import serialize_uploaded_file

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])


def _owned_project(project_id: str, request: Request) -> tuple[MabelStore, MabelProject]:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    if project.owner_email != user.email:
        raise HTTPException(status_code=403, detail="project belongs to another user")
    return store, project


def _project_summary(
    project: MabelProject,
    *,
    conversation_count: int,
    file_count: int,
) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "instructions": project.instructions,
        "color": project.color,
        "conversation_count": conversation_count,
        "file_count": file_count,
        "created_at": project.created_at.isoformat() + "Z",
        "updated_at": project.updated_at.isoformat() + "Z",
    }


def _conversation_summary(conversation: Conversation, message_count: int, project_name: str) -> dict:
    return {
        "id": conversation.id,
        "title": conversation.title,
        "surface": conversation.surface,
        "project_id": conversation.project_id,
        "project_name": project_name,
        "message_count": message_count,
        "updated_at": conversation.updated_at.isoformat() + "Z",
    }


def _duplicate_name(store: MabelStore, owner_email: str, name: str, *, exclude_id: str | None = None) -> bool:
    normalized = name.strip().casefold()
    return any(
        project.id != exclude_id and project.name.strip().casefold() == normalized
        for project in store.list_projects_for_user(owner_email)
    )


@router.get("")
def list_projects(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    rows = store.list_projects_for_user(user.email)
    conversation_counts: dict[str, int] = {}
    for row in store.list_conversations(user.email):
        project_id = row["conversation"].project_id
        if project_id:
            conversation_counts[project_id] = conversation_counts.get(project_id, 0) + 1
    file_counts: dict[str, int] = {}
    for file in store.list_uploaded_files_for_user(user.email):
        if file.project_id:
            file_counts[file.project_id] = file_counts.get(file.project_id, 0) + 1
    return {
        "projects": [
            _project_summary(
                project,
                conversation_count=conversation_counts.get(project.id, 0),
                file_count=file_counts.get(project.id, 0),
            )
            for project in rows
        ]
    }


@router.post("")
def create_project(payload: ProjectCreateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    name = payload.name.strip()
    if _duplicate_name(store, user.email, name):
        raise HTTPException(status_code=409, detail="a project with this name already exists")
    try:
        project = store.create_project(
            MabelProject(
                id=f"project_{uuid.uuid4().hex[:12]}",
                owner_email=user.email,
                name=name,
                description=payload.description.strip(),
                instructions=payload.instructions.strip(),
                color=payload.color,
            )
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "project": _project_summary(
            project,
            conversation_count=0,
            file_count=0,
        )
    }


@router.get("/{project_id}")
def get_project(project_id: str, request: Request) -> dict:
    store, project = _owned_project(project_id, request)
    conversation_rows = [
        row
        for row in store.list_conversations(project.owner_email)
        if row["conversation"].project_id == project.id
    ]
    project_files = store.list_uploaded_files_for_project(project.id)
    return {
        "project": _project_summary(
            project,
            conversation_count=len(conversation_rows),
            file_count=len(project_files),
        ),
        "conversations": [
            _conversation_summary(row["conversation"], int(row["message_count"]), project.name)
            for row in conversation_rows
        ],
        "files": [
            serialize_uploaded_file(row)
            for row in project_files
        ],
    }


@router.patch("/{project_id}")
def update_project(project_id: str, payload: ProjectUpdateRequest, request: Request) -> dict:
    store, project = _owned_project(project_id, request)
    if payload.name is not None:
        next_name = payload.name.strip()
        if _duplicate_name(store, project.owner_email, next_name, exclude_id=project.id):
            raise HTTPException(status_code=409, detail="a project with this name already exists")
        project.name = next_name
    if payload.description is not None:
        project.description = payload.description.strip()
    if payload.instructions is not None:
        project.instructions = payload.instructions.strip()
    if payload.color is not None:
        project.color = payload.color
    try:
        updated = store.update_project(project)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    conversation_count = sum(
        1
        for row in store.list_conversations(updated.owner_email)
        if row["conversation"].project_id == updated.id
    )
    file_count = len(store.list_uploaded_files_for_project(updated.id))
    return {
        "project": _project_summary(
            updated,
            conversation_count=conversation_count,
            file_count=file_count,
        )
    }


@router.delete("/{project_id}")
def delete_project(project_id: str, request: Request) -> dict:
    store, project = _owned_project(project_id, request)
    result = store.delete_project_preserving_content(project.id)
    return {
        "deleted": project.id,
        **result,
    }
