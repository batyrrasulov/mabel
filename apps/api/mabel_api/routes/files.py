"""User-uploaded + agent-generated files.

This module owns two concerns:

1. POST /api/v1/uploads — accept multipart files from the chat composer,
   save them to disk under ``settings.uploads_dir`` and (when the OpenAI SDK
   and API key are available) upload them to OpenAI's Files API so the agent
   can reference them as ``input_file`` parts on a subsequent ``/chat/stream``.

2. GET /api/v1/files/{file_id} — serve back either a user-uploaded file or
   one produced by the agent (image_generation, code_interpreter).  Access is
   guarded by ``owner_email``; only the user that owns the file may fetch it.

The same ``UploadedFile`` record covers both directions so the rest of the
app — chat history hydration, the activity panel, message rendering — never
has to know whether a file was originated by a person or by the agent.
"""

from __future__ import annotations

import mimetypes
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from html import escape
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

try:
    from openai import OpenAI as OpenAIClient
except ImportError:  # pragma: no cover - deployment guard for file-only local mode
    OpenAIClient = None

from ..auth import resolve_mabel_user
from ..db import get_store
from ..models import UploadedFile

router = APIRouter(prefix="/api/v1", tags=["files"])
PROJECT_FILE_LIMIT = 20


@dataclass(frozen=True)
class StagedUpload:
    path: Path
    name: str
    mime_type: str
    size_bytes: int

_DOCX_PREVIEW_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  color-scheme: light;
  --preview-bg: #e8eaed;
  --preview-page: #ffffff;
  --preview-ink: #0f172a;
  --preview-muted: #475467;
  --preview-accent: #1f4c7a;
  --preview-border: #d9dee7;
  --preview-table-head: #edf2f7;
  --preview-table-alt: #f8fafc;
}
* { box-sizing: border-box; }
html { min-height: 100%%; background: var(--preview-bg); }
body {
  margin: 0;
  padding: 18px 14px 30px;
  background: var(--preview-bg);
  color: var(--preview-ink);
  font-family: Aptos, Calibri, "Segoe UI", Arial, sans-serif;
}
.page {
  width: min(816px, calc(100%% - 2px));
  min-height: 1056px;
  margin: 0 auto;
  padding: 66px 72px 58px;
  background: var(--preview-page);
  border: 1px solid var(--preview-border);
  border-radius: 4px;
  box-shadow: 0 14px 40px rgba(16, 24, 40, 0.16);
  overflow: hidden;
  position: relative;
}
.page::before {
  content: "";
  position: absolute;
  top: 40px;
  left: 72px;
  right: 72px;
  height: 2px;
  background: color-mix(in srgb, var(--preview-accent) 45%%, #c7ced9);
}
.page::after {
  content: "Confidential";
  position: absolute;
  left: 72px;
  bottom: 28px;
  color: #98a2b3;
  font-size: 11px;
  letter-spacing: 0.02em;
}
.page > *:first-child { margin-top: 0; }
.page h1 {
  margin: 0 0 14px;
  color: #0f172a;
  font-size: 44px;
  line-height: 1.05;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.page h2 {
  margin: 28px 0 10px;
  color: var(--preview-accent);
  font-size: 36px;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.page h3 {
  margin: 22px 0 8px;
  color: var(--preview-accent);
  font-size: 24px;
  line-height: 1.3;
  font-weight: 700;
}
.page p, .page li {
  font-size: 18px;
  line-height: 1.52;
}
.page p { margin: 0 0 11px; }
.page ul, .page ol { margin: 8px 0 12px 24px; padding: 0; }
.page a { color: #2563eb; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.page table {
  width: 100%%;
  border-collapse: collapse;
  margin: 16px 0;
  table-layout: fixed;
}
.page th, .page td {
  border: 1px solid #d0d5dd;
  padding: 9px 10px;
  font-size: 15px;
  line-height: 1.45;
  text-align: left;
  vertical-align: top;
}
.page th {
  background: var(--preview-table-head);
  color: #334155;
  font-weight: 700;
}
.page tr:nth-child(even) td {
  background: var(--preview-table-alt);
}
.page blockquote {
  margin: 14px 0;
  padding: 0 0 0 14px;
  border-left: 3px solid #d0d5dd;
  color: var(--preview-muted);
}
.page #title-block-header {
  margin: 0 0 30px;
  text-align: center;
}
.page #title-block-header h1 {
  margin: 0;
  text-align: center;
}
.page #title-block-header p {
  margin: 10px 0 0;
  color: #475467;
  font-size: 18px;
  font-style: italic;
}
.page .date {
  color: #667085;
  font-size: 16px;
}
@media (max-width: 720px) {
  body { padding: 10px; }
  .page { width: 100%%; min-height: auto; padding: 30px 26px; }
  .page::before, .page::after { display: none; }
  .page h1 { font-size: 34px; }
  .page h2 { font-size: 26px; }
  .page h3 { font-size: 20px; }
  .page p, .page li { font-size: 16px; }
}
</style>
</head>
<body><main class="page">%s</main></body>
</html>"""

_PPTX_PREVIEW_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html { background: #0f172a; }
body { margin: 0; padding: 24px 14px; font-family: "Segoe UI", Arial, sans-serif; color: #f8fafc; }
.deck { display: grid; gap: 20px; max-width: 980px; margin: 0 auto; }
.slide {
  position: relative;
  aspect-ratio: 16 / 9;
  padding: 44px 54px 40px;
  background: linear-gradient(180deg, #ffffff 0%%, #f8fafc 100%%);
  color: #0f172a;
  border-radius: 8px;
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.38);
  overflow: hidden;
}
.slide::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 8px;
  background: linear-gradient(90deg, #1f4c7a, #2b6cb0);
}
.slide h1, .slide h2 {
  margin: 0 0 16px;
  color: #0f2a4a;
  font-size: clamp(28px, 4.2vw, 46px);
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.slide h3 {
  margin: 20px 0 10px;
  color: #1f4c7a;
  font-size: clamp(18px, 2.4vw, 30px);
}
.slide p, .slide li { font-size: clamp(14px, 1.9vw, 22px); line-height: 1.36; }
.slide ul, .slide ol { margin: 14px 0 0 24px; padding: 0; }
.slide table {
  width: 100%%;
  border-collapse: collapse;
  margin-top: 14px;
}
.slide th, .slide td {
  border: 1px solid #d0d5dd;
  padding: 6px 8px;
  font-size: clamp(12px, 1.4vw, 18px);
}
.slide th { background: #e9eff7; color: #12335a; }
.slide tr:nth-child(even) td { background: #f8fafc; }
.slide-num { position: absolute; right: 18px; bottom: 14px; color: #64748b; font-size: 12px; }
@media (max-width: 720px) { body { padding: 12px; } .slide { padding: 28px 30px; } }
</style>
</head>
<body><main class="deck">%s</main></body>
</html>"""


def _uploads_dir(settings) -> Path:
    """Ensure ``settings.uploads_dir`` exists and return it as a Path."""

    base = Path(settings.uploads_dir)
    base.mkdir(parents=True, exist_ok=True)
    return base


def serialize_uploaded_file(record: UploadedFile) -> dict:
    return {
        "id": record.id,
        "name": record.name,
        "mime_type": record.mime_type,
        "size_bytes": record.size_bytes,
        "openai_file_id": record.openai_file_id,
        "source": record.source,
        "conversation_id": record.conversation_id,
        "project_id": record.project_id,
        "run_id": record.run_id,
        "created_at": record.created_at.isoformat() + "Z",
    }


def _cleanup_prepared_uploads(settings, records: list[UploadedFile]) -> None:
    for record in records:
        if record.local_path:
            Path(record.local_path).unlink(missing_ok=True)
        _try_openai_delete(settings, record.openai_file_id)


def _persist_local(settings, file_id: str, source_path: Path) -> Path:
    """Move/copy bytes from a temp UploadFile into the persistent uploads dir."""

    base = _uploads_dir(settings)
    suffix = source_path.suffix or ""
    target = base / f"{file_id}{suffix}"
    shutil.copy(str(source_path), str(target))
    return target


def _try_openai_upload(settings, target_path: Path) -> str | None:
    """Best-effort: push the bytes to OpenAI's Files API and return the
    resulting ``file_id``. Returns None if the SDK isn't installed or no API
    key is configured — the file still works locally but the agent won't be
    able to attach it via ``input_file``.
    """

    if not settings.openai_api_key or OpenAIClient is None:
        return None
    try:
        client = OpenAIClient(api_key=settings.openai_api_key)
        with open(target_path, "rb") as handle:
            uploaded = client.files.create(file=handle, purpose="assistants")
        return getattr(uploaded, "id", None)
    except Exception:
        return None


def _try_openai_delete(settings, openai_file_id: str | None) -> None:
    if not settings.openai_api_key or not openai_file_id or OpenAIClient is None:
        return
    try:
        OpenAIClient(api_key=settings.openai_api_key).files.delete(openai_file_id)
    except Exception:
        pass


def _hydrate_remote_file_if_possible(settings, record: UploadedFile) -> Path | None:
    if not settings.openai_api_key or not record.openai_file_id or OpenAIClient is None:
        return None
    try:
        client = OpenAIClient(api_key=settings.openai_api_key)
        response = client.files.content(record.openai_file_id)
        content = response.read() if hasattr(response, "read") else bytes(response.content)  # type: ignore[attr-defined]
    except Exception:
        return None
    if not content:
        return None
    base = _uploads_dir(settings)
    suffix = Path(record.name).suffix or mimetypes.guess_extension(record.mime_type or "") or ".bin"
    target = base / f"{record.id}{suffix}"
    try:
        target.write_bytes(content)
    except Exception:
        return None
    return target


def _owned_file_record(file_id: str, request: Request) -> UploadedFile:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    record = store.get_uploaded_file(file_id)
    if record is None:
        raise HTTPException(status_code=404, detail="file not found")
    if record.owner_email != user.email:
        raise HTTPException(status_code=403, detail="file belongs to another user")
    path = Path(record.local_path)
    if not path.exists():
        hydrated = _hydrate_remote_file_if_possible(settings, record)
        if hydrated is None:
            raise HTTPException(status_code=410, detail="file no longer available")
        record.local_path = str(hydrated)
        get_store(settings).create_uploaded_file(record)
    return record


def _wrap_docx_preview(body_html: str) -> str:
    return _DOCX_PREVIEW_TEMPLATE % body_html


def _wrap_pptx_preview(body_html: str) -> str:
    parts = re.split(r"(<h[12][^>]*>.*?</h[12]>)", body_html, flags=re.IGNORECASE | re.DOTALL)
    slides: list[str] = []
    current_title = ""
    current_body: list[str] = []

    def flush() -> None:
        if not current_title and not current_body:
            return
        idx = len(slides) + 1
        title_html = current_title or f"<h2>Slide {idx}</h2>"
        body = "".join(current_body).strip()
        slides.append(f'<section class="slide">{title_html}{body}<span class="slide-num">{idx}</span></section>')

    for part in parts:
        if not part.strip():
            continue
        if re.match(r"<h[12][^>]*>", part, flags=re.IGNORECASE):
            flush()
            current_title = part
            current_body = []
        else:
            current_body.append(part)
    flush()
    if not slides:
        slides = [f'<section class="slide"><h2>Preview</h2>{body_html}<span class="slide-num">1</span></section>']
    return _PPTX_PREVIEW_TEMPLATE % "\n".join(slides)


def _extract_html_body(html: str) -> str:
    match = re.search(r"<body[^>]*>(?P<body>.*?)</body>", html, flags=re.IGNORECASE | re.DOTALL)
    return match.group("body").strip() if match else html


def _pandoc_preview(path: Path) -> str:
    pandoc = shutil.which("pandoc")
    if not pandoc:
        raise HTTPException(status_code=501, detail="pandoc is not installed on the server")
    suffix = path.suffix.lower()
    command = [pandoc, str(path), "-t", "html"]
    if suffix == ".docx":
        # Standalone mode preserves Word's Title style as a real header in
        # the HTML body. Without it, Pandoc only emits that text as metadata.
        command.append("--standalone")
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=35,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="pandoc conversion timed out") from exc
    if completed.returncode != 0:
        raise HTTPException(status_code=500, detail=f"pandoc conversion failed: {completed.stderr[:500]}")
    body_html = _extract_html_body(completed.stdout) or f"<p>{escape(path.name)}</p>"
    if suffix == ".docx":
        return _wrap_docx_preview(body_html)
    if suffix == ".pptx":
        return _wrap_pptx_preview(body_html)
    raise HTTPException(status_code=400, detail="preview supports .docx and .pptx files")


def _office_to_pdf_bytes(path: Path) -> bytes:
    """Convert office docs to PDF bytes via headless LibreOffice.

    This is closer to how Word/PowerPoint actually render than pandoc HTML.
    """
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise HTTPException(status_code=501, detail="LibreOffice is not installed on the server")
    with tempfile.TemporaryDirectory(prefix="mabel-office-preview-") as tmp:
        command = [
            soffice,
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            tmp,
            str(path),
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=45,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail="office PDF conversion timed out") from exc
        if completed.returncode != 0:
            stderr = (completed.stderr or "").strip()
            raise HTTPException(status_code=500, detail=f"office PDF conversion failed: {stderr[:500]}")
        pdf_path = Path(tmp) / f"{path.stem}.pdf"
        if not pdf_path.exists():
            raise HTTPException(status_code=500, detail="office PDF conversion did not produce output")
        return pdf_path.read_bytes()


def _office_preview_cache_path(path: Path) -> Path:
    """Sidecar cache path for converted Office previews."""
    return path.with_name(f"{path.name}.mabel-preview.pdf")


def _office_to_pdf_bytes_cached(path: Path) -> bytes:
    """Read cached PDF preview when fresh, otherwise regenerate via LibreOffice."""
    cache_path = _office_preview_cache_path(path)
    try:
        source_mtime = path.stat().st_mtime
    except OSError:
        source_mtime = 0.0
    try:
        cache_mtime = cache_path.stat().st_mtime
    except OSError:
        cache_mtime = -1.0
    if cache_mtime >= source_mtime:
        try:
            cached = cache_path.read_bytes()
            if cached:
                return cached
        except OSError:
            pass
    pdf_bytes = _office_to_pdf_bytes(path)
    try:
        tmp_cache = cache_path.with_suffix(f"{cache_path.suffix}.tmp")
        tmp_cache.write_bytes(pdf_bytes)
        tmp_cache.replace(cache_path)
    except OSError:
        # Cache write failures should not fail previews.
        pass
    return pdf_bytes


@router.post("/uploads")
async def upload_files(
    request: Request,
    files: list[UploadFile] = File(...),
    conversation_id: int | None = None,
    project_id: str | None = None,
) -> dict:
    """Accept one or more multipart files, persist them on disk, push to
    OpenAI's Files API when possible, and return refs the client can attach
    to a chat turn.
    """

    if not files:
        raise HTTPException(status_code=400, detail="no files provided")

    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    project = None

    if project_id is not None:
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="project not found")
        if project.owner_email != user.email:
            raise HTTPException(status_code=403, detail="project belongs to another user")

    # Validate ownership of conversation_id when provided.
    if conversation_id is not None:
        conversation = store.get_conversation(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        if conversation.user_email != user.email:
            raise HTTPException(status_code=403, detail="conversation belongs to another user")
        if project_id is not None and conversation.project_id != project_id:
            raise HTTPException(status_code=409, detail="conversation is not in the selected project")

    max_bytes = settings.uploads_max_bytes
    staged: list[StagedUpload] = []
    for upload in files:
        if upload.filename is None or upload.filename == "":
            continue
        safe_name = Path(upload.filename).name
        # Drain to a temp file inside the uploads dir so we never hold a
        # large file fully in memory.
        tmp_path = _uploads_dir(settings) / f".incoming-{uuid4().hex}-{safe_name}"
        size = 0
        with open(tmp_path, "wb") as handle:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    handle.close()
                    tmp_path.unlink(missing_ok=True)
                    for prior in staged:
                        prior.path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"{upload.filename} exceeds upload limit of {max_bytes} bytes",
                    )
                handle.write(chunk)

        mime_type = upload.content_type or mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
        staged.append(
            StagedUpload(
                path=tmp_path,
                name=safe_name,
                mime_type=mime_type,
                size_bytes=size,
            )
        )

    if not staged:
        raise HTTPException(status_code=400, detail="no valid files provided")

    pending_records = [
        UploadedFile(
            id=f"file_{uuid4().hex}",
            owner_email=user.email,
            name=item.name,
            mime_type=item.mime_type,
            size_bytes=item.size_bytes,
            source="user_upload",
            local_path="",
            conversation_id=conversation_id,
            project_id=project_id,
        )
        for item in staged
    ]
    try:
        for item, record in zip(staged, pending_records, strict=True):
            final_path = _persist_local(settings, record.id, item.path)
            record.local_path = str(final_path)
            record.openai_file_id = _try_openai_upload(settings, final_path)
        saved = store.create_uploaded_files_with_project_limit(
            pending_records,
            project_id=project_id,
            project_file_limit=PROJECT_FILE_LIMIT,
        )
    except LookupError as exc:
        _cleanup_prepared_uploads(settings, pending_records)
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        _cleanup_prepared_uploads(settings, pending_records)
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        _cleanup_prepared_uploads(settings, pending_records)
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception:
        _cleanup_prepared_uploads(settings, pending_records)
        raise
    finally:
        for item in staged:
            item.path.unlink(missing_ok=True)

    return {"files": [serialize_uploaded_file(row) for row in saved]}


@router.get("/files")
def list_files(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    rows = get_store(settings).list_uploaded_files_for_user(user.email)
    return {"files": [serialize_uploaded_file(row) for row in rows]}


@router.delete("/files/{file_id}")
def delete_file(file_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    record = store.get_uploaded_file(file_id)
    if record is None:
        raise HTTPException(status_code=404, detail="file not found")
    if record.owner_email != user.email:
        raise HTTPException(status_code=403, detail="file belongs to another user")

    if record.local_path:
        path = Path(record.local_path)
        path.unlink(missing_ok=True)
        _office_preview_cache_path(path).unlink(missing_ok=True)
    _try_openai_delete(settings, record.openai_file_id)
    store.delete_uploaded_file(file_id)
    if record.project_id:
        project = store.get_project(record.project_id)
        if project is not None and project.owner_email == user.email:
            store.touch_project(project.id)
    return {"deleted": file_id}


@router.get("/files/{file_id}")
async def get_file(file_id: str, request: Request) -> FileResponse:
    """Stream a file back to the caller. Only the owner may fetch it."""

    record = _owned_file_record(file_id, request)
    path = Path(record.local_path)
    return FileResponse(
        path=str(path),
        media_type=record.mime_type,
        filename=record.name,
    )


@router.get("/files/{file_id}/preview")
async def get_file_preview(file_id: str, request: Request) -> Response:
    """Return a browser-safe HTML preview for generated Office artifacts."""

    record = _owned_file_record(file_id, request)
    path = Path(record.local_path)
    if path.suffix.lower() not in {".docx", ".pptx"}:
        raise HTTPException(status_code=400, detail="preview supports .docx and .pptx files")
    html = _pandoc_preview(path)
    return Response(content=html, media_type="text/html")


@router.get("/files/{file_id}/preview/pdf")
async def get_file_preview_pdf(file_id: str, request: Request) -> Response:
    """Return an Office file preview as rendered PDF bytes.

    This powers high-fidelity docx/pptx preview in the Mabel right rail.
    """
    record = _owned_file_record(file_id, request)
    path = Path(record.local_path)
    if path.suffix.lower() not in {".docx", ".pptx"}:
        raise HTTPException(status_code=400, detail="PDF preview supports .docx and .pptx files")
    pdf_bytes = _office_to_pdf_bytes_cached(path)
    return Response(content=pdf_bytes, media_type="application/pdf")


@router.get("/files/{file_id}/meta")
async def get_file_meta(file_id: str, request: Request) -> dict:
    """Metadata-only lookup for chips and previews."""

    record = _owned_file_record(file_id, request)
    return {
        "id": record.id,
        "name": record.name,
        "mime_type": record.mime_type,
        "size_bytes": record.size_bytes,
        "openai_file_id": record.openai_file_id,
        "source": record.source,
        "conversation_id": record.conversation_id,
        "run_id": record.run_id,
        "created_at": record.created_at.isoformat() + "Z",
    }
