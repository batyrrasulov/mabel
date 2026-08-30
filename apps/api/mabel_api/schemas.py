from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class AttachmentRef(BaseModel):
    """Reference to a previously uploaded file (returned from /api/v1/uploads).
    The client never sends raw bytes through /chat/stream — it uploads first,
    then attaches the returned `id` to a chat turn.
    """

    id: str = Field(min_length=1, max_length=200)


class ChatStreamRequest(BaseModel):
    message: str = Field(default="", max_length=100_000)
    surface: Literal["chat", "rag", "mcp", "agents"] = "chat"
    conversation_id: int | None = None
    project_id: str | None = Field(default=None, max_length=80)
    model: str | None = None
    instructions: str | None = Field(default=None, max_length=20_000)
    attachments: list[AttachmentRef] = Field(default_factory=list)
    documents: list[AttachmentRef] = Field(default_factory=list)

    @model_validator(mode="after")
    def message_or_attachment_required(self) -> "ChatStreamRequest":
        if not self.message.strip() and not self.attachments and not self.documents:
            raise ValueError("message, attachment, or document is required")
        return self


class ApprovalCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    summary: str = Field(default="", max_length=4000)
    payload: dict[str, Any] = Field(default_factory=dict)
    run_id: str | None = None


class ApprovalDecisionRequest(BaseModel):
    decision: Literal["approved", "rejected", "dismissed"]
    reason: str | None = Field(default=None, max_length=4000)


class McpToolCallRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    arguments: dict[str, Any] = Field(default_factory=dict)


class SkillCreateRequest(BaseModel):
    id: str = Field(min_length=3, max_length=200)
    name: str = Field(min_length=1, max_length=255)
    owner_team: str | None = Field(default=None, max_length=120)
    content_md: str = Field(min_length=1)
    description: str | None = Field(default=None, max_length=4000)
    tags: list[str] = Field(default_factory=list)
    mcp_bindings: list[dict[str, Any]] = Field(default_factory=list)


class SkillUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    owner_team: str | None = Field(default=None, max_length=120)
    content_md: str | None = None
    description: str | None = Field(default=None, max_length=4000)
    tags: list[str] | None = None
    mcp_bindings: list[dict[str, Any]] | None = None
    status: Literal["draft", "review", "published", "archived"] | None = None


class SkillRunRequest(BaseModel):
    prompt: str = Field(default="", max_length=100_000)


class SkillMarketplaceSyncRequest(BaseModel):
    force: bool = False


class SkillShareRequest(BaseModel):
    target_repo: str | None = Field(default=None, max_length=200)
    base_ref: str | None = Field(default=None, max_length=120)
    visibility: Literal["private", "team", "org", "public"] = "team"
    message: str | None = Field(default=None, max_length=500)


class ConnectorStateRequest(BaseModel):
    enabled: bool


class ConversationUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    project_id: str | None = Field(default=None, max_length=80)


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    instructions: str = Field(default="", max_length=20_000)
    color: Literal["slate", "blue", "green", "amber", "rose", "violet"] = "slate"


class ProjectUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    instructions: str | None = Field(default=None, max_length=20_000)
    color: Literal["slate", "blue", "green", "amber", "rose", "violet"] | None = None


class StarterPackSignal(BaseModel):
    source: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=4000)


class StarterPackMeeting(BaseModel):
    time: str = Field(min_length=1, max_length=80)
    account_name: str = Field(min_length=1, max_length=255)
    attendees: list[str] = Field(default_factory=list)
    signals: list[StarterPackSignal] = Field(default_factory=list)


class StartMyDayRequest(BaseModel):
    date: str = Field(min_length=1, max_length=40)
    meetings: list[StarterPackMeeting] = Field(default_factory=list)


class WorkflowRunRequest(BaseModel):
    objective: str = Field(min_length=1, max_length=4000)
    dry_run: bool = False
    date: str | None = Field(default=None, max_length=40)
    meetings: list[StarterPackMeeting] = Field(default_factory=list)


class WorkflowCreateRequest(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    objective: str = Field(min_length=1, max_length=4000)
    role_key: str | None = Field(default=None, max_length=80)
    skill_ids: list[str] = Field(default_factory=list)
    connector_slugs: list[str] = Field(default_factory=list)


class ScheduledTaskCreateRequest(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    prompt: str = Field(min_length=1, max_length=20_000)
    schedule_kind: Literal["cron", "hourly", "daily", "weekly", "morning", "afternoon", "evening"] = "daily"
    cron: str | None = Field(default=None, max_length=120)
    timezone: str = Field(default="UTC", min_length=1, max_length=80)
    mode: Literal["standalone", "thread", "workflow"] = "standalone"
    workflow_id: str | None = Field(default=None, max_length=200)
    notification_mode: Literal["inbox", "notify_on_change", "silent"] = "inbox"


class ScheduledTaskUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=3, max_length=120)
    prompt: str | None = Field(default=None, min_length=1, max_length=20_000)
    schedule_kind: Literal["cron", "hourly", "daily", "weekly", "morning", "afternoon", "evening"] | None = None
    cron: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, min_length=1, max_length=80)
    status: Literal["active", "paused", "archived"] | None = None
    mode: Literal["standalone", "thread", "workflow"] | None = None
    workflow_id: str | None = Field(default=None, max_length=200)
    notification_mode: Literal["inbox", "notify_on_change", "silent"] | None = None


class DocumentCreateRequest(BaseModel):
    title: str = Field(default="Untitled document", min_length=1, max_length=200)
    kind: Literal["markdown", "html", "dashboard", "csv", "text"] = "markdown"
    content: str = Field(default="", max_length=2_000_000)
    conversation_id: int | None = None


class DocumentUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    kind: Literal["markdown", "html", "dashboard", "csv", "text"] | None = None
    content: str | None = Field(default=None, max_length=2_000_000)
    conversation_id: int | None = None


class MemoryCreateRequest(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    tags: list[str] = Field(default_factory=list)
    pinned: bool = False
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    source: str = Field(default="manual", max_length=100)
    conversation_id: int | None = None


class MemoryUpdateRequest(BaseModel):
    key: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1, max_length=20_000)
    tags: list[str] | None = None
    pinned: bool | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    source: str | None = Field(default=None, max_length=100)
    conversation_id: int | None = None


class MemoryImportItem(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    tags: list[str] = Field(default_factory=list)
    pinned: bool = False
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    source: str = Field(default="import", max_length=100)
    conversation_id: int | None = None


class MemoryImportRequest(BaseModel):
    mode: Literal["upsert", "replace"] = "upsert"
    items: list[MemoryImportItem] = Field(default_factory=list)


class RunResumeRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=100_000)


class RunInboxRequest(BaseModel):
    mode: Literal["steer", "queue"] = "queue"
    prompt: str = Field(min_length=1, max_length=100_000)


class RunInboxUpdateRequest(BaseModel):
    status: Literal["pending", "applied", "cancelled"]
