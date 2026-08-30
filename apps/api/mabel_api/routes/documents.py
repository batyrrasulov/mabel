from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request

from ..auth import resolve_mabel_user
from ..db import get_store
from ..models import MabelDocument
from ..schemas import DocumentCreateRequest, DocumentUpdateRequest

router = APIRouter(prefix="/api/v1", tags=["documents"])


def _serialize_document(document: MabelDocument) -> dict:
    return {
        "id": document.id,
        "title": document.title,
        "kind": document.kind,
        "content": document.content,
        "conversation_id": document.conversation_id,
        "created_at": f"{document.created_at.isoformat()}Z",
        "updated_at": f"{document.updated_at.isoformat()}Z",
    }


@router.get("/documents")
def list_documents(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    rows = get_store(settings).list_documents_for_user(user.email)
    return {"documents": [_serialize_document(row) for row in rows]}


@router.get("/artifacts")
def list_artifacts(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    rows = get_store(settings).list_documents_for_user(user.email)
    return {"artifacts": [_serialize_document(row) for row in rows]}


@router.post("/documents")
def create_document(payload: DocumentCreateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    document = store.create_document(
        MabelDocument(
            id=f"doc_{uuid.uuid4().hex[:12]}",
            owner_email=user.email,
            title=payload.title.strip() or "Untitled document",
            kind=payload.kind,
            content=payload.content,
            conversation_id=payload.conversation_id,
        )
    )
    return {"document": _serialize_document(document)}


@router.post("/artifacts")
def create_artifact(payload: DocumentCreateRequest, request: Request) -> dict:
    return {"artifact": create_document(payload, request)["document"]}


@router.get("/documents/{document_id}")
def get_document(document_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    document = store.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="document not found")
    if document.owner_email != user.email:
        raise HTTPException(status_code=403, detail="document does not belong to current user")
    return {"document": _serialize_document(document)}


@router.get("/artifacts/{document_id}")
def get_artifact(document_id: str, request: Request) -> dict:
    return {"artifact": get_document(document_id, request)["document"]}


@router.patch("/documents/{document_id}")
def update_document(document_id: str, payload: DocumentUpdateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    document = store.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="document not found")
    if document.owner_email != user.email:
        raise HTTPException(status_code=403, detail="document does not belong to current user")

    if payload.title is not None:
        document.title = payload.title.strip() or document.title
    if payload.kind is not None:
        document.kind = payload.kind
    if payload.content is not None:
        document.content = payload.content
    if payload.conversation_id is not None:
        document.conversation_id = payload.conversation_id

    updated = store.update_document(document)
    return {"document": _serialize_document(updated)}


@router.patch("/artifacts/{document_id}")
def update_artifact(document_id: str, payload: DocumentUpdateRequest, request: Request) -> dict:
    return {"artifact": update_document(document_id, payload, request)["document"]}


@router.delete("/documents/{document_id}")
def delete_document(document_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    document = store.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="document not found")
    if document.owner_email != user.email:
        raise HTTPException(status_code=403, detail="document does not belong to current user")
    store.delete_document(document_id)
    return {"deleted": document_id}


@router.delete("/artifacts/{document_id}")
def delete_artifact(document_id: str, request: Request) -> dict:
    return delete_document(document_id, request)
