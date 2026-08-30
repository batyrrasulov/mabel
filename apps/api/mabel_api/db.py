from __future__ import annotations

import json
import threading
from dataclasses import asdict, replace
from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import (
    AgentRun,
    Approval,
    AuditEvent,
    ConnectorSnapshot,
    Conversation,
    ConversationFileLink,
    Message,
    PromptInboxItem,
    MabelDocument,
    MabelMemoryItem,
    MabelProject,
    ScheduledTask,
    ScheduledTaskRun,
    Skill,
    StarterPack,
    ToolCall,
    UploadedFile,
    utcnow,
)
from .settings import MabelSettings

_STORE: "MabelStore | None" = None
_STORE_KEY: tuple[str, str | None, str] | None = None


def _document_display_rank(document: MabelDocument) -> tuple[int, float]:
    kind_rank = {"dashboard": 0, "html": 0, "markdown": 1, "csv": 2, "text": 3}
    return (kind_rank.get(document.kind, 4), -document.created_at.timestamp())


def _sort_documents_for_display(rows: list[MabelDocument]) -> list[MabelDocument]:
    return sorted(rows, key=_document_display_rank)


class MabelStore:
    def init(self) -> None: ...
    def health(self) -> dict[str, str]: ...
    def reset(self) -> None: ...
    def create_project(self, project: MabelProject) -> MabelProject: ...
    def get_project(self, project_id: str) -> MabelProject | None: ...
    def touch_project(self, project_id: str) -> None: ...
    def update_project(self, project: MabelProject) -> MabelProject: ...
    def delete_project(self, project_id: str) -> None: ...
    def delete_project_preserving_content(self, project_id: str) -> dict[str, int]: ...
    def list_projects_for_user(self, user_email: str) -> list[MabelProject]: ...
    def create_conversation(self, conversation: Conversation) -> Conversation: ...
    def get_conversation(self, conversation_id: int) -> Conversation | None: ...
    def touch_conversation(self, conversation_id: int) -> None: ...
    def update_conversation(self, conversation: Conversation) -> Conversation: ...
    def delete_conversation(self, conversation_id: int) -> None: ...
    def add_message(self, message: Message) -> Message: ...
    def list_messages(self, conversation_id: int) -> list[Message]: ...
    def create_run(self, run: AgentRun) -> AgentRun: ...
    def get_run(self, run_id: str) -> AgentRun | None: ...
    def update_run_status(self, run_id: str, status: str) -> None: ...
    def update_run_state(self, run_id: str, state_json: dict[str, Any]) -> None: ...
    def record_run_usage(self, run_id: str, usage: dict[str, Any]) -> None: ...
    def list_runs(self, user_email: str | None = None) -> list[AgentRun]: ...
    def create_prompt_inbox_item(self, item: PromptInboxItem) -> PromptInboxItem: ...
    def list_prompt_inbox_for_run(self, run_id: str) -> list[PromptInboxItem]: ...
    def update_prompt_inbox_item(self, item: PromptInboxItem) -> PromptInboxItem: ...
    def list_usage_events(self, user_email: str | None = None) -> list[dict[str, Any]]: ...
    def list_audit_events(self, limit: int = 200) -> list[AuditEvent]: ...
    def list_tool_calls(self, limit: int = 200) -> list[ToolCall]: ...
    def add_tool_call(self, tool_call: ToolCall) -> ToolCall: ...
    def list_tool_calls_for_conversation(self, conversation_id: int) -> list[ToolCall]: ...
    def list_conversations(self, user_email: str) -> list[dict[str, Any]]: ...
    def list_connectors(self) -> list[ConnectorSnapshot]: ...
    def upsert_connector_snapshot(self, snapshot: ConnectorSnapshot) -> ConnectorSnapshot: ...
    def set_connector_enabled(self, server_slug: str, enabled: bool) -> ConnectorSnapshot | None: ...
    def create_approval(self, approval: Approval) -> Approval: ...
    def get_approval(self, approval_id: str) -> Approval | None: ...
    def update_approval(self, approval: Approval) -> Approval: ...
    def list_pending_approvals(self, user_email: str, is_approver: bool) -> list[Approval]: ...
    def create_skill(self, skill: Skill) -> Skill: ...
    def get_skill(self, skill_id: str) -> Skill | None: ...
    def update_skill(self, skill: Skill) -> Skill: ...
    def delete_skill(self, skill_id: str) -> None: ...
    def list_skills(self, query: str | None = None) -> list[Skill]: ...
    def ensure_starter_pack(self, starter_pack: StarterPack) -> StarterPack: ...
    def list_starter_packs(self) -> list[StarterPack]: ...
    def create_scheduled_task(self, task: ScheduledTask) -> ScheduledTask: ...
    def get_scheduled_task(self, task_id: str) -> ScheduledTask | None: ...
    def update_scheduled_task(self, task: ScheduledTask) -> ScheduledTask: ...
    def list_scheduled_tasks_for_user(self, user_email: str) -> list[ScheduledTask]: ...
    def list_due_scheduled_tasks(self, now: datetime) -> list[ScheduledTask]: ...
    def create_scheduled_task_run(self, run: ScheduledTaskRun) -> ScheduledTaskRun: ...
    def list_scheduled_task_runs_for_user(self, user_email: str) -> list[ScheduledTaskRun]: ...
    def add_audit_event(self, event: AuditEvent) -> AuditEvent: ...
    def create_uploaded_file(self, file: UploadedFile) -> UploadedFile: ...
    def create_uploaded_files_with_project_limit(
        self,
        files: list[UploadedFile],
        *,
        project_id: str | None,
        project_file_limit: int,
    ) -> list[UploadedFile]: ...
    def create_file_link(self, link: ConversationFileLink) -> ConversationFileLink: ...
    def get_uploaded_file(self, file_id: str) -> UploadedFile | None: ...
    def delete_uploaded_file(self, file_id: str) -> None: ...
    def list_uploaded_files_for_user(self, user_email: str) -> list[UploadedFile]: ...
    def list_uploaded_files_for_conversation(self, conversation_id: int) -> list[UploadedFile]: ...
    def list_uploaded_files_for_project(self, project_id: str) -> list[UploadedFile]: ...
    def list_uploaded_files_for_run(self, run_id: str) -> list[UploadedFile]: ...
    def create_document(self, document: MabelDocument) -> MabelDocument: ...
    def get_document(self, document_id: str) -> MabelDocument | None: ...
    def update_document(self, document: MabelDocument) -> MabelDocument: ...
    def delete_document(self, document_id: str) -> None: ...
    def list_documents_for_user(self, user_email: str) -> list[MabelDocument]: ...
    def list_documents_for_conversation(self, conversation_id: int) -> list[MabelDocument]: ...
    def create_memory_item(self, item: MabelMemoryItem) -> MabelMemoryItem: ...
    def get_memory_item(self, item_id: str) -> MabelMemoryItem | None: ...
    def update_memory_item(self, item: MabelMemoryItem) -> MabelMemoryItem: ...
    def delete_memory_item(self, item_id: str) -> None: ...
    def list_memory_items_for_user(self, user_email: str, query: str | None = None) -> list[MabelMemoryItem]: ...
    def search_memory_items_semantic(
        self, user_email: str, query: str, query_embedding: list[float], *, limit: int = 50
    ) -> list[MabelMemoryItem]: ...
    def backfill_normalized_tables(self) -> dict[str, int]: ...
    def normalization_status(self) -> dict[str, Any]: ...


class MemoryMabelStore(MabelStore):
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._ids: dict[str, int] = {}
        self.projects: dict[str, MabelProject] = {}
        self._project_lock = threading.RLock()
        self.conversations: dict[int, Conversation] = {}
        self.runs: dict[str, AgentRun] = {}
        self.prompt_inbox: dict[str, PromptInboxItem] = {}
        self.messages: dict[int, Message] = {}
        self.tool_calls: dict[int, ToolCall] = {}
        self.approvals: dict[str, Approval] = {}
        self.connectors: dict[tuple[str, str], ConnectorSnapshot] = {}
        self.skills: dict[str, Skill] = {}
        self.starter_packs: dict[str, StarterPack] = {}
        self.scheduled_tasks: dict[str, ScheduledTask] = {}
        self.scheduled_task_runs: dict[str, ScheduledTaskRun] = {}
        self.audit_events: dict[int, AuditEvent] = {}
        self.uploaded_files: dict[str, UploadedFile] = {}
        self.file_links: dict[str, ConversationFileLink] = {}
        self._file_batch_lock = threading.RLock()
        self.documents: dict[str, MabelDocument] = {}
        self.memory_items: dict[str, MabelMemoryItem] = {}

    def _next_id(self, key: str) -> int:
        self._ids[key] = self._ids.get(key, 0) + 1
        return self._ids[key]

    def init(self) -> None:
        return None

    def health(self) -> dict[str, str]:
        return {"status": "ok", "store": "memory"}

    def create_project(self, project: MabelProject) -> MabelProject:
        with self._project_lock:
            normalized_name = project.name.strip().casefold()
            if any(
                existing.id != project.id
                and existing.owner_email == project.owner_email
                and existing.name.strip().casefold() == normalized_name
                for existing in self.projects.values()
            ):
                raise ValueError("a project with this name already exists")
            if not project.id:
                seq = self._next_id("project")
                project.id = f"project_{seq:08x}"
            self.projects[project.id] = project
            return project

    def get_project(self, project_id: str) -> MabelProject | None:
        return self.projects.get(project_id)

    def touch_project(self, project_id: str) -> None:
        with self._project_lock:
            project = self.projects.get(project_id)
            if project is not None:
                project.updated_at = utcnow()

    def update_project(self, project: MabelProject) -> MabelProject:
        with self._project_lock:
            if project.id not in self.projects:
                raise LookupError(f"project {project.id} not found")
            normalized_name = project.name.strip().casefold()
            if any(
                existing.id != project.id
                and existing.owner_email == project.owner_email
                and existing.name.strip().casefold() == normalized_name
                for existing in self.projects.values()
            ):
                raise ValueError("a project with this name already exists")
            project.updated_at = utcnow()
            self.projects[project.id] = project
            return project

    def delete_project(self, project_id: str) -> None:
        with self._project_lock:
            self.projects.pop(project_id, None)

    def delete_project_preserving_content(self, project_id: str) -> dict[str, int]:
        with self._project_lock:
            conversations = [
                conversation
                for conversation in self.conversations.values()
                if conversation.project_id == project_id
            ]
            files = [
                file
                for file in self.uploaded_files.values()
                if file.project_id == project_id
            ]
            for conversation in conversations:
                conversation.project_id = None
                conversation.updated_at = utcnow()
            for file in files:
                file.project_id = None
            self.projects.pop(project_id, None)
            return {
                "retained_conversations": len(conversations),
                "retained_files": len(files),
            }

    def list_projects_for_user(self, user_email: str) -> list[MabelProject]:
        rows = [project for project in self.projects.values() if project.owner_email == user_email]
        return sorted(rows, key=lambda row: row.updated_at, reverse=True)

    def create_conversation(self, conversation: Conversation) -> Conversation:
        conversation.id = self._next_id("conversation")
        self.conversations[conversation.id] = conversation
        return conversation

    def get_conversation(self, conversation_id: int) -> Conversation | None:
        return self.conversations.get(conversation_id)

    def touch_conversation(self, conversation_id: int) -> None:
        if conversation_id in self.conversations:
            self.conversations[conversation_id].updated_at = utcnow()

    def update_conversation(self, conversation: Conversation) -> Conversation:
        if conversation.id is None or conversation.id not in self.conversations:
            raise LookupError(f"conversation {conversation.id} not found")
        conversation.updated_at = utcnow()
        self.conversations[conversation.id] = conversation
        return conversation

    def delete_conversation(self, conversation_id: int) -> None:
        self.conversations.pop(conversation_id, None)
        for message_id in [mid for mid, msg in self.messages.items() if msg.conversation_id == conversation_id]:
            self.messages.pop(message_id, None)
        for run_id in [rid for rid, run in self.runs.items() if run.conversation_id == conversation_id]:
            self.runs.pop(run_id, None)
        for link_id in [
            link_id
            for link_id, link in self.file_links.items()
            if link.conversation_id == conversation_id
        ]:
            self.file_links.pop(link_id, None)

    def add_message(self, message: Message) -> Message:
        message.id = self._next_id("message")
        self.messages[message.id] = message
        return message

    def list_messages(self, conversation_id: int) -> list[Message]:
        rows = [message for message in self.messages.values() if message.conversation_id == conversation_id]
        return sorted(rows, key=lambda row: row.created_at)

    def create_run(self, run: AgentRun) -> AgentRun:
        self.runs[run.id] = run
        return run

    def get_run(self, run_id: str) -> AgentRun | None:
        return self.runs.get(run_id)

    def update_run_status(self, run_id: str, status: str) -> None:
        run = self.runs.get(run_id)
        if run:
            run.status = status
            run.finished_at = utcnow()

    def update_run_state(self, run_id: str, state_json: dict[str, Any]) -> None:
        run = self.runs.get(run_id)
        if run is None:
            return
        run.state_json = dict(state_json or {})

    def record_run_usage(self, run_id: str, usage: dict[str, Any]) -> None:
        run = self.runs.get(run_id)
        if not run:
            return
        state = dict(run.state_json or {})
        state["usage"] = usage
        run.state_json = state

    def list_runs(self, user_email: str | None = None) -> list[AgentRun]:
        rows = list(self.runs.values())
        if user_email:
            rows = [run for run in rows if run.user_email == user_email]
        return sorted(rows, key=lambda row: row.created_at, reverse=True)

    def create_prompt_inbox_item(self, item: PromptInboxItem) -> PromptInboxItem:
        self.prompt_inbox[item.id] = item
        return item

    def list_prompt_inbox_for_run(self, run_id: str) -> list[PromptInboxItem]:
        rows = [row for row in self.prompt_inbox.values() if row.run_id == run_id]
        return sorted(rows, key=lambda row: row.created_at)

    def update_prompt_inbox_item(self, item: PromptInboxItem) -> PromptInboxItem:
        item.updated_at = utcnow()
        self.prompt_inbox[item.id] = item
        return item

    def list_usage_events(self, user_email: str | None = None) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for run in self.list_runs(user_email):
            usage = (run.state_json or {}).get("usage") if isinstance(run.state_json, dict) else None
            usage = usage if isinstance(usage, dict) else {}
            events.append(
                {
                    "run_id": run.id,
                    "conversation_id": run.conversation_id,
                    "user_email": run.user_email,
                    "surface": run.surface,
                    "status": run.status,
                    "model": run.model,
                    "created_at": run.created_at,
                    "finished_at": run.finished_at,
                    "usage": usage,
                }
            )
        return events

    def list_audit_events(self, limit: int = 200) -> list[AuditEvent]:
        rows = sorted(self.audit_events.values(), key=lambda row: row.created_at, reverse=True)
        return rows[: max(1, min(int(limit or 200), 1000))]

    def list_tool_calls(self, limit: int = 200) -> list[ToolCall]:
        rows = sorted(self.tool_calls.values(), key=lambda row: row.created_at, reverse=True)
        return rows[: max(1, min(int(limit or 200), 1000))]

    def add_tool_call(self, tool_call: ToolCall) -> ToolCall:
        tool_call.id = self._next_id("tool_call")
        self.tool_calls[tool_call.id] = tool_call
        return tool_call

    def list_tool_calls_for_conversation(self, conversation_id: int) -> list[ToolCall]:
        run_ids = {run.id for run in self.runs.values() if run.conversation_id == conversation_id}
        rows = [tc for tc in self.tool_calls.values() if tc.run_id in run_ids]
        return sorted(rows, key=lambda row: (row.created_at, row.id))

    def list_conversations(self, user_email: str) -> list[dict[str, Any]]:
        rows = []
        for conversation in self.conversations.values():
            if conversation.user_email != user_email:
                continue
            count = sum(1 for message in self.messages.values() if message.conversation_id == conversation.id)
            rows.append({"conversation": conversation, "message_count": count})
        return sorted(rows, key=lambda row: row["conversation"].updated_at, reverse=True)

    def list_connectors(self) -> list[ConnectorSnapshot]:
        return sorted(self.connectors.values(), key=lambda item: item.name)

    def upsert_connector_snapshot(self, snapshot: ConnectorSnapshot) -> ConnectorSnapshot:
        key = (snapshot.org_slug, snapshot.server_slug)
        existing_key = next((item_key for item_key, item in self.connectors.items() if item.server_slug == snapshot.server_slug), key)
        existing = self.connectors.get(existing_key)
        if existing and existing.id:
            snapshot.id = existing.id
            if not hasattr(snapshot, "enabled") or snapshot.enabled is None:
                snapshot.enabled = existing.enabled
            if not snapshot.tools and existing.tools:
                snapshot.tools = existing.tools
            if snapshot.last_error is None and existing.last_error:
                snapshot.last_error = existing.last_error
        else:
            snapshot.id = self._next_id("connector")
            if snapshot.enabled is None:
                snapshot.enabled = True
        self.connectors.pop(existing_key, None)
        self.connectors[key] = snapshot
        return snapshot

    def set_connector_enabled(self, server_slug: str, enabled: bool) -> ConnectorSnapshot | None:
        for key, snapshot in self.connectors.items():
            if snapshot.server_slug == server_slug:
                snapshot.enabled = enabled
                snapshot.refreshed_at = utcnow()
                self.connectors[key] = snapshot
                return snapshot
        return None

    def create_approval(self, approval: Approval) -> Approval:
        self.approvals[approval.id] = approval
        return approval

    def get_approval(self, approval_id: str) -> Approval | None:
        return self.approvals.get(approval_id)

    def update_approval(self, approval: Approval) -> Approval:
        approval.updated_at = utcnow()
        self.approvals[approval.id] = approval
        return approval

    def list_pending_approvals(self, user_email: str, is_approver: bool) -> list[Approval]:
        rows = [row for row in self.approvals.values() if row.status == "pending" and (is_approver or row.requested_by == user_email)]
        return sorted(rows, key=lambda row: row.created_at)

    def create_skill(self, skill: Skill) -> Skill:
        self.skills[skill.id] = skill
        return skill

    def update_skill(self, skill: Skill) -> Skill:
        if skill.id not in self.skills:
            raise LookupError(f"skill {skill.id} not found")
        skill.updated_at = utcnow()
        self.skills[skill.id] = skill
        return skill

    def delete_skill(self, skill_id: str) -> None:
        self.skills.pop(skill_id, None)

    def get_skill(self, skill_id: str) -> Skill | None:
        return self.skills.get(skill_id)

    def list_skills(self, query: str | None = None) -> list[Skill]:
        needle = (query or "").lower()
        rows = list(self.skills.values())
        if needle:
            rows = [row for row in rows if needle in row.id.lower() or needle in row.name.lower() or needle in row.owner_team.lower() or any(needle in tag.lower() for tag in row.tags)]
        return sorted(rows, key=lambda row: row.name)

    def ensure_starter_pack(self, starter_pack: StarterPack) -> StarterPack:
        existing = self.starter_packs.get(starter_pack.id)
        if existing:
            starter_pack.created_at = existing.created_at
            starter_pack.updated_at = utcnow()
            self.starter_packs[starter_pack.id] = starter_pack
            return starter_pack
        self.starter_packs[starter_pack.id] = starter_pack
        return starter_pack

    def list_starter_packs(self) -> list[StarterPack]:
        return sorted(self.starter_packs.values(), key=lambda row: row.name)

    def create_scheduled_task(self, task: ScheduledTask) -> ScheduledTask:
        if not task.id:
            seq = self._next_id("scheduled_task")
            task.id = f"sched_{seq:08x}"
        task.updated_at = utcnow()
        self.scheduled_tasks[task.id] = task
        return task

    def get_scheduled_task(self, task_id: str) -> ScheduledTask | None:
        return self.scheduled_tasks.get(task_id)

    def update_scheduled_task(self, task: ScheduledTask) -> ScheduledTask:
        if task.id not in self.scheduled_tasks:
            raise LookupError(f"scheduled task {task.id} not found")
        task.updated_at = utcnow()
        self.scheduled_tasks[task.id] = task
        return task

    def list_scheduled_tasks_for_user(self, user_email: str) -> list[ScheduledTask]:
        rows = [task for task in self.scheduled_tasks.values() if task.owner_email == user_email and task.status != "archived"]
        return sorted(rows, key=lambda row: (row.status != "active", row.next_run_at or row.updated_at, row.name))

    def list_due_scheduled_tasks(self, now: datetime) -> list[ScheduledTask]:
        rows = [
            task
            for task in self.scheduled_tasks.values()
            if task.status == "active" and task.next_run_at is not None and task.next_run_at <= now
        ]
        return sorted(rows, key=lambda row: row.next_run_at or row.updated_at)

    def create_scheduled_task_run(self, run: ScheduledTaskRun) -> ScheduledTaskRun:
        self.scheduled_task_runs[run.id] = run
        return run

    def list_scheduled_task_runs_for_user(self, user_email: str) -> list[ScheduledTaskRun]:
        rows = [run for run in self.scheduled_task_runs.values() if run.owner_email == user_email]
        return sorted(rows, key=lambda row: row.created_at, reverse=True)

    def add_audit_event(self, event: AuditEvent) -> AuditEvent:
        event.id = self._next_id("audit")
        self.audit_events[event.id] = event
        return event

    def create_uploaded_file(self, file: UploadedFile) -> UploadedFile:
        if not file.id:
            seq = self._next_id("uploaded_file")
            file.id = f"file_{seq:08x}"
        self.uploaded_files[file.id] = file
        return file

    def create_uploaded_files_with_project_limit(
        self,
        files: list[UploadedFile],
        *,
        project_id: str | None,
        project_file_limit: int,
    ) -> list[UploadedFile]:
        with self._project_lock, self._file_batch_lock:
            if project_id is not None:
                project = self.projects.get(project_id)
                if project is None:
                    raise LookupError("project not found")
                if any(file.owner_email != project.owner_email for file in files):
                    raise PermissionError("project belongs to another user")
                existing_count = sum(
                    1
                    for file in self.uploaded_files.values()
                    if file.project_id == project_id
                )
                if existing_count + len(files) > project_file_limit:
                    raise ValueError(f"projects support up to {project_file_limit} files")
                project.updated_at = utcnow()
            return [MemoryMabelStore.create_uploaded_file(self, file) for file in files]

    def create_file_link(self, link: ConversationFileLink) -> ConversationFileLink:
        self.file_links[link.id] = link
        return link

    def get_uploaded_file(self, file_id: str) -> UploadedFile | None:
        return self.uploaded_files.get(file_id)

    def delete_uploaded_file(self, file_id: str) -> None:
        self.uploaded_files.pop(file_id, None)
        for link_id in [
            link_id
            for link_id, link in self.file_links.items()
            if link.file_id == file_id
        ]:
            self.file_links.pop(link_id, None)

    def list_uploaded_files_for_user(self, user_email: str) -> list[UploadedFile]:
        rows = [f for f in self.uploaded_files.values() if f.owner_email == user_email]
        return sorted(rows, key=lambda row: row.created_at, reverse=True)

    def list_uploaded_files_for_conversation(self, conversation_id: int) -> list[UploadedFile]:
        links = [
            link
            for link in self.file_links.values()
            if link.conversation_id == conversation_id
        ]
        linked_file_ids = {link.file_id for link in links}
        rows = [
            file
            for file in self.uploaded_files.values()
            if file.conversation_id == conversation_id and file.id not in linked_file_ids
        ]
        for link in links:
            file = self.uploaded_files.get(link.file_id)
            if file is None or file.owner_email != link.owner_email:
                continue
            rows.append(
                replace(
                    file,
                    conversation_id=link.conversation_id,
                    run_id=link.run_id,
                    created_at=link.created_at,
                )
            )
        return sorted(rows, key=lambda row: row.created_at)

    def list_uploaded_files_for_project(self, project_id: str) -> list[UploadedFile]:
        rows = [f for f in self.uploaded_files.values() if f.project_id == project_id]
        return sorted(rows, key=lambda row: row.created_at, reverse=True)

    def list_uploaded_files_for_run(self, run_id: str) -> list[UploadedFile]:
        rows = [f for f in self.uploaded_files.values() if f.run_id == run_id]
        for link in self.file_links.values():
            if link.run_id != run_id:
                continue
            file = self.uploaded_files.get(link.file_id)
            if file is None or file.owner_email != link.owner_email:
                continue
            rows.append(
                replace(
                    file,
                    conversation_id=link.conversation_id,
                    run_id=link.run_id,
                    created_at=link.created_at,
                )
            )
        return sorted(rows, key=lambda row: row.created_at)

    def create_document(self, document: MabelDocument) -> MabelDocument:
        if not document.id:
            seq = self._next_id("document")
            document.id = f"doc_{seq:08x}"
        if not document.created_at:
            document.created_at = utcnow()
        document.updated_at = utcnow()
        self.documents[document.id] = document
        return document

    def get_document(self, document_id: str) -> MabelDocument | None:
        return self.documents.get(document_id)

    def update_document(self, document: MabelDocument) -> MabelDocument:
        if document.id not in self.documents:
            raise LookupError(f"document {document.id} not found")
        document.updated_at = utcnow()
        self.documents[document.id] = document
        return document

    def delete_document(self, document_id: str) -> None:
        self.documents.pop(document_id, None)

    def list_documents_for_user(self, user_email: str) -> list[MabelDocument]:
        rows = [doc for doc in self.documents.values() if doc.owner_email == user_email]
        return sorted(rows, key=lambda row: row.updated_at, reverse=True)

    def list_documents_for_conversation(self, conversation_id: int) -> list[MabelDocument]:
        rows = [doc for doc in self.documents.values() if doc.conversation_id == conversation_id]
        return _sort_documents_for_display(rows)

    def create_memory_item(self, item: MabelMemoryItem) -> MabelMemoryItem:
        if not item.id:
            seq = self._next_id("memory_item")
            item.id = f"mem_{seq:08x}"
        if not item.created_at:
            item.created_at = utcnow()
        item.updated_at = utcnow()
        self.memory_items[item.id] = item
        return item

    def get_memory_item(self, item_id: str) -> MabelMemoryItem | None:
        return self.memory_items.get(item_id)

    def update_memory_item(self, item: MabelMemoryItem) -> MabelMemoryItem:
        if item.id not in self.memory_items:
            raise LookupError(f"memory item {item.id} not found")
        item.updated_at = utcnow()
        self.memory_items[item.id] = item
        return item

    def delete_memory_item(self, item_id: str) -> None:
        self.memory_items.pop(item_id, None)

    def list_memory_items_for_user(self, user_email: str, query: str | None = None) -> list[MabelMemoryItem]:
        rows = [item for item in self.memory_items.values() if item.owner_email == user_email]
        needle = (query or "").strip().lower()
        if needle:
            rows = [
                item
                for item in rows
                if needle in item.key.lower()
                or needle in item.content.lower()
                or any(needle in str(tag).lower() for tag in item.tags)
            ]
        return sorted(
            rows,
            key=lambda row: (
                1 if not row.pinned else 0,
                -(row.last_used_at.timestamp() if row.last_used_at else row.updated_at.timestamp()),
                -row.updated_at.timestamp(),
                -float(row.confidence),
            ),
        )

    def search_memory_items_semantic(
        self, user_email: str, query: str, query_embedding: list[float], *, limit: int = 50
    ) -> list[MabelMemoryItem]:
        return self.list_memory_items_for_user(user_email, query)[: max(1, int(limit or 50))]

    def backfill_normalized_tables(self) -> dict[str, int]:
        # Memory store already uses in-process structures only.
        return {
            "projects": len(self.projects),
            "conversations": len(self.conversations),
            "messages": len(self.messages),
            "runs": len(self.runs),
            "tool_calls": len(self.tool_calls),
            "approvals": len(self.approvals),
            "connectors": len(self.connectors),
            "skills": len(self.skills),
            "scheduled_tasks": len(self.scheduled_tasks),
            "scheduled_task_runs": len(self.scheduled_task_runs),
            "documents": len(self.documents),
            "memory_items": len(self.memory_items),
            "usage_events": sum(
                1
                for run in self.runs.values()
                if isinstance(run.state_json, dict) and isinstance(run.state_json.get("usage"), dict)
            ),
        }

    def normalization_status(self) -> dict[str, Any]:
        return {
            "store": "memory",
            "strict_reads": False,
            "normalized_counts": {},
            "legacy_counts": self.backfill_normalized_tables(),
            "backfill_gap": {},
            "ready_for_strict_reads": False,
        }


class PostgresMabelStore(MemoryMabelStore):
    def __init__(self, dsn: str, *, strict_normalized_reads: bool = False) -> None:
        self.dsn = dsn
        self.strict_normalized_reads = strict_normalized_reads
        self.pgvector_available = False
        self._state_lock = threading.RLock()
        super().__init__()

    def _connect(self):
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def _allow_fallback(self) -> bool:
        return not self.strict_normalized_reads

    def init(self) -> None:
        ddl = """
        CREATE TABLE IF NOT EXISTS mabel_api_state (
            state_key text PRIMARY KEY,
            payload jsonb NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS mabel_api_projects (
            id text PRIMARY KEY,
            owner_email text NOT NULL,
            name text NOT NULL,
            description text NOT NULL DEFAULT '',
            instructions text NOT NULL DEFAULT '',
            color text NOT NULL DEFAULT 'slate',
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_projects_owner_updated
            ON mabel_api_projects (owner_email, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_mabel_api_projects_owner_name
            ON mabel_api_projects (lower(owner_email), lower(name));
        CREATE TABLE IF NOT EXISTS mabel_api_conversations (
            id integer PRIMARY KEY,
            user_email text NOT NULL,
            title text NOT NULL,
            surface text NOT NULL DEFAULT 'chat',
            project_id text NULL,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_conversations_user_updated
            ON mabel_api_conversations (user_email, updated_at DESC);
        CREATE TABLE IF NOT EXISTS mabel_api_messages (
            id integer PRIMARY KEY,
            conversation_id integer NOT NULL REFERENCES mabel_api_conversations(id) ON DELETE CASCADE,
            role text NOT NULL,
            content text NOT NULL,
            sources jsonb NOT NULL DEFAULT '[]'::jsonb,
            run_id text NULL,
            created_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_messages_conversation_created
            ON mabel_api_messages (conversation_id, created_at ASC, id ASC);
        CREATE TABLE IF NOT EXISTS mabel_api_tool_calls (
            id integer PRIMARY KEY,
            run_id text NOT NULL,
            tool_name text NOT NULL,
            status text NOT NULL,
            server_slug text NULL,
            scope text NOT NULL DEFAULT 'read',
            arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
            output_preview text NULL,
            created_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_tool_calls_run_created
            ON mabel_api_tool_calls (run_id, created_at ASC, id ASC);
        CREATE TABLE IF NOT EXISTS mabel_api_runs (
            id text PRIMARY KEY,
            conversation_id integer NULL,
            user_email text NOT NULL,
            surface text NOT NULL,
            status text NOT NULL,
            model text NOT NULL,
            state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
            trace_id text NULL,
            created_at timestamptz NOT NULL,
            finished_at timestamptz NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_runs_user_created
            ON mabel_api_runs (user_email, created_at DESC);
        CREATE TABLE IF NOT EXISTS mabel_api_approvals (
            id text PRIMARY KEY,
            status text NOT NULL,
            title text NOT NULL,
            summary text NOT NULL,
            requested_by text NOT NULL,
            payload jsonb NOT NULL DEFAULT '{}'::jsonb,
            run_id text NULL,
            decided_by text NULL,
            decision_reason text NULL,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_approvals_requested_status_created
            ON mabel_api_approvals (requested_by, status, created_at ASC);
        CREATE TABLE IF NOT EXISTS mabel_api_connectors (
            org_slug text NOT NULL,
            server_slug text NOT NULL,
            id integer NULL,
            name text NOT NULL,
            connection_status text NOT NULL,
            tools jsonb NOT NULL DEFAULT '[]'::jsonb,
            last_error text NULL,
            enabled boolean NULL,
            refreshed_at timestamptz NOT NULL,
            PRIMARY KEY (org_slug, server_slug)
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_connectors_server_slug
            ON mabel_api_connectors (server_slug);
        CREATE TABLE IF NOT EXISTS mabel_api_skills (
            id text PRIMARY KEY,
            name text NOT NULL,
            owner_team text NOT NULL,
            status text NOT NULL,
            current_version text NOT NULL,
            content_md text NOT NULL,
            mcp_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
            tags jsonb NOT NULL DEFAULT '[]'::jsonb,
            source jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_skills_name
            ON mabel_api_skills (name);
        CREATE TABLE IF NOT EXISTS mabel_api_documents (
            id text PRIMARY KEY,
            owner_email text NOT NULL,
            title text NOT NULL,
            kind text NOT NULL,
            content text NOT NULL,
            conversation_id integer NULL,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_documents_owner_updated
            ON mabel_api_documents (owner_email, updated_at DESC);
        CREATE TABLE IF NOT EXISTS mabel_api_memory_items (
            id text PRIMARY KEY,
            owner_email text NOT NULL,
            key text NOT NULL,
            content text NOT NULL,
            tags jsonb NOT NULL DEFAULT '[]'::jsonb,
            embedding jsonb NOT NULL DEFAULT '[]'::jsonb,
            pinned boolean NOT NULL DEFAULT false,
            confidence double precision NOT NULL DEFAULT 0.7,
            source text NOT NULL DEFAULT 'manual',
            conversation_id integer NULL,
            last_used_at timestamptz NULL,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_memory_owner_updated
            ON mabel_api_memory_items (owner_email, updated_at DESC);
        CREATE TABLE IF NOT EXISTS mabel_api_usage_events (
            run_id text PRIMARY KEY,
            conversation_id integer NULL,
            user_email text NOT NULL,
            surface text NOT NULL,
            status text NOT NULL,
            model text NOT NULL,
            input_tokens integer NOT NULL DEFAULT 0,
            output_tokens integer NOT NULL DEFAULT 0,
            total_tokens integer NOT NULL DEFAULT 0,
            estimated boolean NOT NULL DEFAULT false,
            cost_usd numeric NULL,
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz NULL
        );
        CREATE TABLE IF NOT EXISTS mabel_api_prompt_inbox (
            id text PRIMARY KEY,
            run_id text NOT NULL,
            conversation_id integer NULL,
            owner_email text NOT NULL,
            mode text NOT NULL,
            prompt text NOT NULL,
            status text NOT NULL DEFAULT 'pending',
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mabel_api_prompt_inbox_run_created
            ON mabel_api_prompt_inbox (run_id, created_at ASC);
        """
        with self._connect() as conn:
            conn.execute(ddl)
            conn.execute(
                "ALTER TABLE mabel_api_conversations ADD COLUMN IF NOT EXISTS project_id text NULL"
            )
            conn.execute(
                "ALTER TABLE mabel_api_memory_items ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false"
            )
            # Optional vector extension for semantic retrieval acceleration.
            try:
                conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            except Exception:
                pass
            try:
                row = conn.execute(
                    "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector"
                ).fetchone()
                self.pgvector_available = bool(row and row.get("has_vector"))
            except Exception:
                self.pgvector_available = False

    def create_project(self, project: MabelProject) -> MabelProject:
        saved = super().create_project(project)
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO mabel_api_projects (
                        id, owner_email, name, description, instructions, color, created_at, updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id)
                    DO UPDATE SET
                        owner_email = EXCLUDED.owner_email,
                        name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        instructions = EXCLUDED.instructions,
                        color = EXCLUDED.color,
                        created_at = EXCLUDED.created_at,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        saved.id,
                        saved.owner_email,
                        saved.name,
                        saved.description,
                        saved.instructions,
                        saved.color,
                        saved.created_at,
                        saved.updated_at,
                    ),
                )
        except psycopg.errors.UniqueViolation as exc:
            raise ValueError("a project with this name already exists") from exc
        return saved

    def get_project(self, project_id: str) -> MabelProject | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, owner_email, name, description, instructions, color, created_at, updated_at
                FROM mabel_api_projects
                WHERE id = %s
                """,
                (project_id,),
            ).fetchone()
        if row:
            return MabelProject(
                id=str(row["id"]),
                owner_email=str(row["owner_email"]),
                name=str(row["name"]),
                description=str(row.get("description") or ""),
                instructions=str(row.get("instructions") or ""),
                color=str(row.get("color") or "slate"),
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
        if self._allow_fallback():
            return super().get_project(project_id)
        return None

    def touch_project(self, project_id: str) -> None:
        super().touch_project(project_id)
        project = self.projects.get(project_id)
        if project is None:
            return
        with self._connect() as conn:
            conn.execute(
                "UPDATE mabel_api_projects SET updated_at = %s WHERE id = %s",
                (project.updated_at, project.id),
            )

    def update_project(self, project: MabelProject) -> MabelProject:
        saved = super().update_project(project)
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO mabel_api_projects (
                        id, owner_email, name, description, instructions, color, created_at, updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id)
                    DO UPDATE SET
                        owner_email = EXCLUDED.owner_email,
                        name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        instructions = EXCLUDED.instructions,
                        color = EXCLUDED.color,
                        created_at = EXCLUDED.created_at,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        saved.id,
                        saved.owner_email,
                        saved.name,
                        saved.description,
                        saved.instructions,
                        saved.color,
                        saved.created_at,
                        saved.updated_at,
                    ),
                )
        except psycopg.errors.UniqueViolation as exc:
            raise ValueError("a project with this name already exists") from exc
        return saved

    def delete_project(self, project_id: str) -> None:
        super().delete_project(project_id)
        with self._connect() as conn:
            conn.execute("DELETE FROM mabel_api_projects WHERE id = %s", (project_id,))

    def delete_project_preserving_content(self, project_id: str) -> dict[str, int]:
        with self._state_lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO mabel_api_state (state_key, payload, updated_at)
                    VALUES ('default', %s, now())
                    ON CONFLICT (state_key) DO NOTHING
                    """,
                    (Jsonb({}),),
                )
                row = conn.execute(
                    "SELECT payload FROM mabel_api_state WHERE state_key = 'default' FOR UPDATE"
                ).fetchone()
                payload = row["payload"] if row and isinstance(row.get("payload"), dict) else {}
                self._restore_state_payload(payload)
                result = MemoryMabelStore.delete_project_preserving_content(self, project_id)
                conn.execute(
                    "UPDATE mabel_api_state SET payload = %s, updated_at = now() WHERE state_key = 'default'",
                    (Jsonb(self._state_payload()),),
                )
                conn.execute(
                    "UPDATE mabel_api_conversations SET project_id = NULL, updated_at = now() WHERE project_id = %s",
                    (project_id,),
                )
                conn.execute("DELETE FROM mabel_api_projects WHERE id = %s", (project_id,))
                return result

    def list_projects_for_user(self, user_email: str) -> list[MabelProject]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, owner_email, name, description, instructions, color, created_at, updated_at
                FROM mabel_api_projects
                WHERE owner_email = %s
                ORDER BY updated_at DESC
                """,
                (user_email,),
            ).fetchall()
        projects = [
            MabelProject(
                id=str(row["id"]),
                owner_email=str(row["owner_email"]),
                name=str(row["name"]),
                description=str(row.get("description") or ""),
                instructions=str(row.get("instructions") or ""),
                color=str(row.get("color") or "slate"),
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
            for row in rows
        ]
        if projects or not self._allow_fallback():
            return projects
        return super().list_projects_for_user(user_email)

    def create_uploaded_files_with_project_limit(
        self,
        files: list[UploadedFile],
        *,
        project_id: str | None,
        project_file_limit: int,
    ) -> list[UploadedFile]:
        with self._state_lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO mabel_api_state (state_key, payload, updated_at)
                    VALUES ('default', %s, now())
                    ON CONFLICT (state_key) DO NOTHING
                    """,
                    (Jsonb({}),),
                )
                row = conn.execute(
                    "SELECT payload FROM mabel_api_state WHERE state_key = 'default' FOR UPDATE"
                ).fetchone()
                payload = row["payload"] if row and isinstance(row.get("payload"), dict) else {}
                self._restore_state_payload(payload)
                saved = MemoryMabelStore.create_uploaded_files_with_project_limit(
                    self,
                    files,
                    project_id=project_id,
                    project_file_limit=project_file_limit,
                )
                conn.execute(
                    "UPDATE mabel_api_state SET payload = %s, updated_at = now() WHERE state_key = 'default'",
                    (Jsonb(self._state_payload()),),
                )
                if project_id is not None:
                    project = self.projects.get(project_id)
                    if project is not None:
                        conn.execute(
                            "UPDATE mabel_api_projects SET updated_at = %s WHERE id = %s",
                            (project.updated_at, project.id),
                        )
                return saved

    def create_conversation(self, conversation: Conversation) -> Conversation:
        created = super().create_conversation(conversation)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_conversations (id, user_email, title, surface, project_id, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    user_email = EXCLUDED.user_email,
                    title = EXCLUDED.title,
                    surface = EXCLUDED.surface,
                    project_id = EXCLUDED.project_id,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    created.id,
                    created.user_email,
                    created.title,
                    created.surface,
                    created.project_id,
                    created.created_at,
                    created.updated_at,
                ),
            )
        return created

    def get_conversation(self, conversation_id: int) -> Conversation | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, user_email, title, surface, project_id, created_at, updated_at
                FROM mabel_api_conversations
                WHERE id = %s
                """,
                (conversation_id,),
            ).fetchone()
        if row:
            return Conversation(
                id=int(row["id"]),
                user_email=str(row["user_email"]),
                title=str(row["title"]),
                surface=str(row["surface"] or "chat"),
                project_id=str(row["project_id"]) if row.get("project_id") else None,
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
        if self._allow_fallback():
            return super().get_conversation(conversation_id)
        return None

    def touch_conversation(self, conversation_id: int) -> None:
        super().touch_conversation(conversation_id)
        conversation = self.conversations.get(conversation_id)
        if conversation is None:
            return
        with self._connect() as conn:
            conn.execute(
                "UPDATE mabel_api_conversations SET updated_at = %s WHERE id = %s",
                (conversation.updated_at, conversation_id),
            )

    def update_conversation(self, conversation: Conversation) -> Conversation:
        updated = super().update_conversation(conversation)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_conversations (id, user_email, title, surface, project_id, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    user_email = EXCLUDED.user_email,
                    title = EXCLUDED.title,
                    surface = EXCLUDED.surface,
                    project_id = EXCLUDED.project_id,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    updated.id,
                    updated.user_email,
                    updated.title,
                    updated.surface,
                    updated.project_id,
                    updated.created_at,
                    updated.updated_at,
                ),
            )
        return updated

    def delete_conversation(self, conversation_id: int) -> None:
        super().delete_conversation(conversation_id)
        with self._connect() as conn:
            conn.execute("DELETE FROM mabel_api_conversations WHERE id = %s", (conversation_id,))

    def add_message(self, message: Message) -> Message:
        created = super().add_message(message)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_messages (id, conversation_id, role, content, sources, run_id, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    conversation_id = EXCLUDED.conversation_id,
                    role = EXCLUDED.role,
                    content = EXCLUDED.content,
                    sources = EXCLUDED.sources,
                    run_id = EXCLUDED.run_id,
                    created_at = EXCLUDED.created_at
                """,
                (
                    created.id,
                    created.conversation_id,
                    created.role,
                    created.content,
                    Jsonb(created.sources or []),
                    created.run_id,
                    created.created_at,
                ),
            )
        return created

    def create_run(self, run: AgentRun) -> AgentRun:
        created = super().create_run(run)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_runs (
                    id, conversation_id, user_email, surface, status, model, state_json, trace_id, created_at, finished_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    conversation_id = EXCLUDED.conversation_id,
                    user_email = EXCLUDED.user_email,
                    surface = EXCLUDED.surface,
                    status = EXCLUDED.status,
                    model = EXCLUDED.model,
                    state_json = EXCLUDED.state_json,
                    trace_id = EXCLUDED.trace_id,
                    created_at = EXCLUDED.created_at,
                    finished_at = EXCLUDED.finished_at
                """,
                (
                    created.id,
                    created.conversation_id,
                    created.user_email,
                    created.surface,
                    created.status,
                    created.model,
                    Jsonb(created.state_json or {}),
                    created.trace_id,
                    created.created_at,
                    created.finished_at,
                ),
            )
        return created

    def get_run(self, run_id: str) -> AgentRun | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, conversation_id, user_email, surface, status, model, state_json, trace_id, created_at, finished_at
                FROM mabel_api_runs
                WHERE id = %s
                """,
                (run_id,),
            ).fetchone()
        if row:
            state_json = row.get("state_json")
            if not isinstance(state_json, dict):
                state_json = {}
            return AgentRun(
                id=str(row["id"]),
                conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                user_email=str(row["user_email"]),
                surface=str(row["surface"]),
                status=str(row["status"]),
                model=str(row["model"]),
                state_json=state_json,
                trace_id=str(row["trace_id"]) if row.get("trace_id") else None,
                created_at=_dt(row.get("created_at")),
                finished_at=_dt(row.get("finished_at")) if row.get("finished_at") else None,
            )
        if self._allow_fallback():
            return super().get_run(run_id)
        return None

    def update_run_status(self, run_id: str, status: str) -> None:
        super().update_run_status(run_id, status)
        run = self.runs.get(run_id)
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE mabel_api_runs
                SET status = %s,
                    finished_at = COALESCE(%s, finished_at)
                WHERE id = %s
                """,
                (status, run.finished_at if run else None, run_id),
            )
            conn.execute(
                """
                UPDATE mabel_api_usage_events
                SET status = %s,
                    finished_at = COALESCE(%s, finished_at)
                WHERE run_id = %s
                """,
                (status, run.finished_at if run else None, run_id),
            )

    def update_run_state(self, run_id: str, state_json: dict[str, Any]) -> None:
        super().update_run_state(run_id, state_json)
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE mabel_api_runs
                SET state_json = %s
                WHERE id = %s
                """,
                (Jsonb(state_json or {}), run_id),
            )

    def list_runs(self, user_email: str | None = None) -> list[AgentRun]:
        query = """
            SELECT
                id, conversation_id, user_email, surface, status, model,
                state_json, trace_id, created_at, finished_at
            FROM mabel_api_runs
        """
        params: tuple[Any, ...] = ()
        if user_email:
            query += " WHERE user_email = %s"
            params = (user_email,)
        query += " ORDER BY created_at DESC LIMIT 2000"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        runs: list[AgentRun] = []
        for row in rows:
            state_json = row.get("state_json")
            if not isinstance(state_json, dict):
                state_json = {}
            runs.append(
                AgentRun(
                    id=str(row["id"]),
                    conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                    user_email=str(row["user_email"]),
                    surface=str(row["surface"]),
                    status=str(row["status"]),
                    model=str(row["model"]),
                    state_json=state_json,
                    trace_id=str(row["trace_id"]) if row.get("trace_id") else None,
                    created_at=_dt(row.get("created_at")),
                    finished_at=_dt(row.get("finished_at")) if row.get("finished_at") else None,
                )
            )
        if len(runs) >= 2000 or not self._allow_fallback():
            return runs
        seen = {run.id for run in runs}
        for legacy in super().list_runs(user_email):
            if legacy.id in seen:
                continue
            runs.append(legacy)
        runs.sort(key=lambda row: row.created_at, reverse=True)
        return runs[:2000]

    def create_prompt_inbox_item(self, item: PromptInboxItem) -> PromptInboxItem:
        saved = super().create_prompt_inbox_item(item)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_prompt_inbox (
                    id, run_id, conversation_id, owner_email, mode, prompt, status, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    run_id = EXCLUDED.run_id,
                    conversation_id = EXCLUDED.conversation_id,
                    owner_email = EXCLUDED.owner_email,
                    mode = EXCLUDED.mode,
                    prompt = EXCLUDED.prompt,
                    status = EXCLUDED.status,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.run_id,
                    saved.conversation_id,
                    saved.owner_email,
                    saved.mode,
                    saved.prompt,
                    saved.status,
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def list_prompt_inbox_for_run(self, run_id: str) -> list[PromptInboxItem]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, run_id, conversation_id, owner_email, mode, prompt, status, created_at, updated_at
                FROM mabel_api_prompt_inbox
                WHERE run_id = %s
                ORDER BY created_at ASC
                """,
                (run_id,),
            ).fetchall()
        items = [
            PromptInboxItem(
                id=str(row["id"]),
                run_id=str(row["run_id"]),
                conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                owner_email=str(row["owner_email"]),
                mode=str(row["mode"]),
                prompt=str(row["prompt"]),
                status=str(row["status"]),
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
            for row in rows
        ]
        if items:
            return items
        if self._allow_fallback():
            return super().list_prompt_inbox_for_run(run_id)
        return []

    def update_prompt_inbox_item(self, item: PromptInboxItem) -> PromptInboxItem:
        saved = super().update_prompt_inbox_item(item)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_prompt_inbox (
                    id, run_id, conversation_id, owner_email, mode, prompt, status, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    run_id = EXCLUDED.run_id,
                    conversation_id = EXCLUDED.conversation_id,
                    owner_email = EXCLUDED.owner_email,
                    mode = EXCLUDED.mode,
                    prompt = EXCLUDED.prompt,
                    status = EXCLUDED.status,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.run_id,
                    saved.conversation_id,
                    saved.owner_email,
                    saved.mode,
                    saved.prompt,
                    saved.status,
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def add_tool_call(self, tool_call: ToolCall) -> ToolCall:
        created = super().add_tool_call(tool_call)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_tool_calls (
                    id, run_id, tool_name, status, server_slug, scope, arguments, output_preview, created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    run_id = EXCLUDED.run_id,
                    tool_name = EXCLUDED.tool_name,
                    status = EXCLUDED.status,
                    server_slug = EXCLUDED.server_slug,
                    scope = EXCLUDED.scope,
                    arguments = EXCLUDED.arguments,
                    output_preview = EXCLUDED.output_preview,
                    created_at = EXCLUDED.created_at
                """,
                (
                    created.id,
                    created.run_id,
                    created.tool_name,
                    created.status,
                    created.server_slug,
                    created.scope,
                    Jsonb(created.arguments or {}),
                    created.output_preview,
                    created.created_at,
                ),
            )
        return created

    def list_tool_calls_for_conversation(self, conversation_id: int) -> list[ToolCall]:
        run_ids = [run.id for run in self.runs.values() if run.conversation_id == conversation_id]
        if not run_ids:
            return []
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, run_id, tool_name, status, server_slug, scope, arguments, output_preview, created_at
                FROM mabel_api_tool_calls
                WHERE run_id = ANY(%s)
                ORDER BY created_at ASC, id ASC
                """,
                (run_ids,),
            ).fetchall()
        calls: list[ToolCall] = []
        for row in rows:
            arguments = row.get("arguments")
            if not isinstance(arguments, dict):
                arguments = {}
            calls.append(
                ToolCall(
                    id=int(row["id"]),
                    run_id=str(row["run_id"]),
                    tool_name=str(row["tool_name"]),
                    status=str(row["status"]),
                    server_slug=str(row["server_slug"]) if row.get("server_slug") else None,
                    scope=str(row.get("scope") or "read"),
                    arguments=arguments,
                    output_preview=str(row["output_preview"]) if row.get("output_preview") is not None else None,
                    created_at=_dt(row.get("created_at")),
                )
            )
        if calls:
            return calls
        if self._allow_fallback():
            return super().list_tool_calls_for_conversation(conversation_id)
        return []

    def list_tool_calls(self, limit: int = 200) -> list[ToolCall]:
        safe_limit = max(1, min(int(limit or 200), 1000))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, run_id, tool_name, status, server_slug, scope, arguments, output_preview, created_at
                FROM mabel_api_tool_calls
                ORDER BY created_at DESC, id DESC
                LIMIT %s
                """,
                (safe_limit,),
            ).fetchall()
        calls: list[ToolCall] = []
        for row in rows:
            arguments = row.get("arguments")
            if not isinstance(arguments, dict):
                arguments = {}
            calls.append(
                ToolCall(
                    id=int(row["id"]),
                    run_id=str(row["run_id"]),
                    tool_name=str(row["tool_name"]),
                    status=str(row["status"]),
                    server_slug=str(row["server_slug"]) if row.get("server_slug") else None,
                    scope=str(row.get("scope") or "read"),
                    arguments=arguments,
                    output_preview=str(row["output_preview"]) if row.get("output_preview") is not None else None,
                    created_at=_dt(row.get("created_at")),
                )
            )
        if len(calls) >= safe_limit or not self._allow_fallback():
            return calls
        seen = {call.id for call in calls if call.id is not None}
        for legacy in super().list_tool_calls(safe_limit):
            if legacy.id in seen:
                continue
            calls.append(legacy)
        calls.sort(key=lambda row: row.created_at, reverse=True)
        return calls[:safe_limit]

    def list_messages(self, conversation_id: int) -> list[Message]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, conversation_id, role, content, sources, run_id, created_at
                FROM mabel_api_messages
                WHERE conversation_id = %s
                ORDER BY created_at ASC, id ASC
                """,
                (conversation_id,),
            ).fetchall()
        if rows:
            result: list[Message] = []
            for row in rows:
                sources = row.get("sources")
                if not isinstance(sources, list):
                    sources = []
                result.append(
                    Message(
                        id=int(row["id"]),
                        conversation_id=int(row["conversation_id"]),
                        role=str(row["role"]),
                        content=str(row["content"]),
                        sources=[item for item in sources if isinstance(item, dict)],
                        run_id=str(row["run_id"]) if row.get("run_id") else None,
                        created_at=_dt(row.get("created_at")),
                    )
                )
            return result
        if self._allow_fallback():
            return super().list_messages(conversation_id)
        return []

    def list_conversations(self, user_email: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    c.id,
                    c.user_email,
                    c.title,
                    c.surface,
                    c.project_id,
                    c.created_at,
                    c.updated_at,
                    COUNT(m.id) AS message_count
                FROM mabel_api_conversations c
                LEFT JOIN mabel_api_messages m ON m.conversation_id = c.id
                WHERE c.user_email = %s
                GROUP BY c.id, c.user_email, c.title, c.surface, c.project_id, c.created_at, c.updated_at
                ORDER BY c.updated_at DESC
                """,
                (user_email,),
            ).fetchall()
        if rows:
            return [
                {
                    "conversation": Conversation(
                        id=int(row["id"]),
                        user_email=str(row["user_email"]),
                        title=str(row["title"]),
                        surface=str(row["surface"] or "chat"),
                        project_id=str(row["project_id"]) if row.get("project_id") else None,
                        created_at=_dt(row.get("created_at")),
                        updated_at=_dt(row.get("updated_at")),
                    ),
                    "message_count": int(row.get("message_count") or 0),
                }
                for row in rows
            ]
        if self._allow_fallback():
            return super().list_conversations(user_email)
        return []

    def health(self) -> dict[str, str]:
        try:
            with self._connect() as conn:
                conn.execute("SELECT 1")
            return {"status": "ok", "store": "postgres"}
        except Exception as exc:
            return {"status": "error", "store": "postgres", "message": str(exc)}

    def _restore_state_payload(self, payload: dict[str, Any]) -> None:
        super().reset()
        self._ids = payload.get("ids", {})
        self.projects = {k: _project(v) for k, v in payload.get("projects", {}).items()}
        self.conversations = {int(k): _conversation(v) for k, v in payload.get("conversations", {}).items()}
        self.runs = {k: _agent_run(v) for k, v in payload.get("runs", {}).items()}
        self.messages = {int(k): _message(v) for k, v in payload.get("messages", {}).items()}
        self.tool_calls = {int(k): _tool_call(v) for k, v in payload.get("tool_calls", {}).items()}
        self.approvals = {k: _approval(v) for k, v in payload.get("approvals", {}).items()}
        self.connectors = {tuple(k.split("::", 1)): _connector(v) for k, v in payload.get("connectors", {}).items()}
        self.skills = {k: _skill(v) for k, v in payload.get("skills", {}).items()}
        self.starter_packs = {k: _starter_pack(v) for k, v in payload.get("starter_packs", {}).items()}
        self.scheduled_tasks = {k: _scheduled_task(v) for k, v in payload.get("scheduled_tasks", {}).items()}
        self.scheduled_task_runs = {k: _scheduled_task_run(v) for k, v in payload.get("scheduled_task_runs", {}).items()}
        self.audit_events = {int(k): _audit_event(v) for k, v in payload.get("audit_events", {}).items()}
        self.uploaded_files = {k: _uploaded_file(v) for k, v in payload.get("uploaded_files", {}).items()}
        self.file_links = {k: _file_link(v) for k, v in payload.get("file_links", {}).items()}
        self.documents = {k: _document(v) for k, v in payload.get("documents", {}).items()}
        self.memory_items = {k: _memory_item(v) for k, v in payload.get("memory_items", {}).items()}

    def _load_state(self) -> None:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM mabel_api_state WHERE state_key = 'default'").fetchone()
        if not row:
            self._restore_state_payload({})
            return
        payload = row["payload"] if isinstance(row.get("payload"), dict) else {}
        self._restore_state_payload(payload)

    def _state_payload(self) -> dict[str, Any]:
        return {
            "ids": self._ids,
            "projects": {k: _dump(v) for k, v in self.projects.items()},
            "conversations": {str(k): _dump(v) for k, v in self.conversations.items()},
            "runs": {k: _dump(v) for k, v in self.runs.items()},
            "messages": {str(k): _dump(v) for k, v in self.messages.items()},
            "tool_calls": {str(k): _dump(v) for k, v in self.tool_calls.items()},
            "approvals": {k: _dump(v) for k, v in self.approvals.items()},
            "connectors": {f"{k[0]}::{k[1]}": _dump(v) for k, v in self.connectors.items()},
            "skills": {k: _dump(v) for k, v in self.skills.items()},
            "starter_packs": {k: _dump(v) for k, v in self.starter_packs.items()},
            "scheduled_tasks": {k: _dump(v) for k, v in self.scheduled_tasks.items()},
            "scheduled_task_runs": {k: _dump(v) for k, v in self.scheduled_task_runs.items()},
            "audit_events": {str(k): _dump(v) for k, v in self.audit_events.items()},
            "uploaded_files": {k: _dump(v) for k, v in self.uploaded_files.items()},
            "file_links": {k: _dump(v) for k, v in self.file_links.items()},
            "documents": {k: _dump(v) for k, v in self.documents.items()},
            "memory_items": {k: _dump(v) for k, v in self.memory_items.items()},
        }

    def _save_state(self) -> None:
        payload = self._state_payload()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_state (state_key, payload, updated_at)
                VALUES ('default', %s, now())
                ON CONFLICT (state_key)
                DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
                """,
                (Jsonb(payload),),
            )

    def backfill_normalized_tables(self) -> dict[str, int]:
        with self._state_lock:
            self._load_state()
            stats = {
                "projects": 0,
                "conversations": 0,
                "messages": 0,
                "runs": 0,
                "tool_calls": 0,
                "approvals": 0,
                "connectors": 0,
                "skills": 0,
                "documents": 0,
                "memory_items": 0,
                "usage_events": 0,
            }
            with self._connect() as conn:
                for row in self.projects.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_projects (
                            id, owner_email, name, description, instructions, color, created_at, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            owner_email = EXCLUDED.owner_email,
                            name = EXCLUDED.name,
                            description = EXCLUDED.description,
                            instructions = EXCLUDED.instructions,
                            color = EXCLUDED.color,
                            created_at = EXCLUDED.created_at,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (
                            row.id,
                            row.owner_email,
                            row.name,
                            row.description,
                            row.instructions,
                            row.color,
                            row.created_at,
                            row.updated_at,
                        ),
                    )
                    stats["projects"] += 1
                for row in self.conversations.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_conversations (id, user_email, title, surface, project_id, created_at, updated_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            user_email = EXCLUDED.user_email,
                            title = EXCLUDED.title,
                            surface = EXCLUDED.surface,
                            project_id = EXCLUDED.project_id,
                            created_at = EXCLUDED.created_at,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (
                            row.id,
                            row.user_email,
                            row.title,
                            row.surface,
                            row.project_id,
                            row.created_at,
                            row.updated_at,
                        ),
                    )
                    stats["conversations"] += 1
                for row in self.messages.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_messages (id, conversation_id, role, content, sources, run_id, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            conversation_id = EXCLUDED.conversation_id,
                            role = EXCLUDED.role,
                            content = EXCLUDED.content,
                            sources = EXCLUDED.sources,
                            run_id = EXCLUDED.run_id,
                            created_at = EXCLUDED.created_at
                        """,
                        (row.id, row.conversation_id, row.role, row.content, Jsonb(row.sources or []), row.run_id, row.created_at),
                    )
                    stats["messages"] += 1
                for row in self.runs.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_runs (
                            id, conversation_id, user_email, surface, status, model, state_json, trace_id, created_at, finished_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            conversation_id = EXCLUDED.conversation_id,
                            user_email = EXCLUDED.user_email,
                            surface = EXCLUDED.surface,
                            status = EXCLUDED.status,
                            model = EXCLUDED.model,
                            state_json = EXCLUDED.state_json,
                            trace_id = EXCLUDED.trace_id,
                            created_at = EXCLUDED.created_at,
                            finished_at = EXCLUDED.finished_at
                        """,
                        (
                            row.id,
                            row.conversation_id,
                            row.user_email,
                            row.surface,
                            row.status,
                            row.model,
                            Jsonb(row.state_json or {}),
                            row.trace_id,
                            row.created_at,
                            row.finished_at,
                        ),
                    )
                    stats["runs"] += 1
                    usage = (row.state_json or {}).get("usage") if isinstance(row.state_json, dict) else None
                    if isinstance(usage, dict):
                        input_tokens = int(usage.get("input_tokens") or 0)
                        output_tokens = int(usage.get("output_tokens") or 0)
                        total_tokens = int(usage.get("total_tokens") or (input_tokens + output_tokens))
                        metadata = usage.get("metadata") if isinstance(usage.get("metadata"), dict) else {}
                        cost_usd = usage.get("cost_usd")
                        conn.execute(
                            """
                            INSERT INTO mabel_api_usage_events (
                                run_id, conversation_id, user_email, surface, status, model,
                                input_tokens, output_tokens, total_tokens, estimated, cost_usd,
                                metadata, created_at, finished_at
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (run_id)
                            DO UPDATE SET
                                conversation_id = EXCLUDED.conversation_id,
                                user_email = EXCLUDED.user_email,
                                surface = EXCLUDED.surface,
                                status = EXCLUDED.status,
                                model = EXCLUDED.model,
                                input_tokens = EXCLUDED.input_tokens,
                                output_tokens = EXCLUDED.output_tokens,
                                total_tokens = EXCLUDED.total_tokens,
                                estimated = EXCLUDED.estimated,
                                cost_usd = EXCLUDED.cost_usd,
                                metadata = EXCLUDED.metadata,
                                finished_at = EXCLUDED.finished_at
                            """,
                            (
                                row.id,
                                row.conversation_id,
                                row.user_email,
                                row.surface,
                                row.status,
                                row.model,
                                input_tokens,
                                output_tokens,
                                total_tokens,
                                bool(usage.get("estimated", False)),
                                float(cost_usd) if isinstance(cost_usd, (int, float)) else None,
                                Jsonb(metadata),
                                row.created_at,
                                row.finished_at,
                            ),
                        )
                        stats["usage_events"] += 1
                for row in self.tool_calls.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_tool_calls (
                            id, run_id, tool_name, status, server_slug, scope, arguments, output_preview, created_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            run_id = EXCLUDED.run_id,
                            tool_name = EXCLUDED.tool_name,
                            status = EXCLUDED.status,
                            server_slug = EXCLUDED.server_slug,
                            scope = EXCLUDED.scope,
                            arguments = EXCLUDED.arguments,
                            output_preview = EXCLUDED.output_preview,
                            created_at = EXCLUDED.created_at
                        """,
                        (
                            row.id,
                            row.run_id,
                            row.tool_name,
                            row.status,
                            row.server_slug,
                            row.scope,
                            Jsonb(row.arguments or {}),
                            row.output_preview,
                            row.created_at,
                        ),
                    )
                    stats["tool_calls"] += 1
                for row in self.approvals.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_approvals (
                            id, status, title, summary, requested_by, payload, run_id,
                            decided_by, decision_reason, created_at, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            status = EXCLUDED.status,
                            title = EXCLUDED.title,
                            summary = EXCLUDED.summary,
                            requested_by = EXCLUDED.requested_by,
                            payload = EXCLUDED.payload,
                            run_id = EXCLUDED.run_id,
                            decided_by = EXCLUDED.decided_by,
                            decision_reason = EXCLUDED.decision_reason,
                            created_at = EXCLUDED.created_at,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (
                            row.id,
                            row.status,
                            row.title,
                            row.summary,
                            row.requested_by,
                            Jsonb(row.payload or {}),
                            row.run_id,
                            row.decided_by,
                            row.decision_reason,
                            row.created_at,
                            row.updated_at,
                        ),
                    )
                    stats["approvals"] += 1
                for row in self.connectors.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_connectors (
                            org_slug, server_slug, id, name, connection_status, tools, last_error, enabled, refreshed_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (org_slug, server_slug)
                        DO UPDATE SET
                            id = COALESCE(EXCLUDED.id, mabel_api_connectors.id),
                            name = EXCLUDED.name,
                            connection_status = EXCLUDED.connection_status,
                            tools = EXCLUDED.tools,
                            last_error = EXCLUDED.last_error,
                            enabled = EXCLUDED.enabled,
                            refreshed_at = EXCLUDED.refreshed_at
                        """,
                        (
                            row.org_slug,
                            row.server_slug,
                            row.id,
                            row.name,
                            row.connection_status,
                            Jsonb(row.tools or []),
                            row.last_error,
                            row.enabled,
                            row.refreshed_at,
                        ),
                    )
                    stats["connectors"] += 1
                for row in self.skills.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_skills (
                            id, name, owner_team, status, current_version, content_md, mcp_bindings, tags, source, created_at, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            name = EXCLUDED.name,
                            owner_team = EXCLUDED.owner_team,
                            status = EXCLUDED.status,
                            current_version = EXCLUDED.current_version,
                            content_md = EXCLUDED.content_md,
                            mcp_bindings = EXCLUDED.mcp_bindings,
                            tags = EXCLUDED.tags,
                            source = EXCLUDED.source,
                            created_at = EXCLUDED.created_at,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (
                            row.id,
                            row.name,
                            row.owner_team,
                            row.status,
                            row.current_version,
                            row.content_md,
                            Jsonb(row.mcp_bindings or []),
                            Jsonb(row.tags or []),
                            Jsonb(row.source or {}),
                            row.created_at,
                            row.updated_at,
                        ),
                    )
                    stats["skills"] += 1
                for row in self.documents.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_documents (
                            id, owner_email, title, kind, content, conversation_id, created_at, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            owner_email = EXCLUDED.owner_email,
                            title = EXCLUDED.title,
                            kind = EXCLUDED.kind,
                            content = EXCLUDED.content,
                            conversation_id = EXCLUDED.conversation_id,
                            created_at = EXCLUDED.created_at,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (
                            row.id,
                            row.owner_email,
                            row.title,
                            row.kind,
                            row.content,
                            row.conversation_id,
                            row.created_at,
                            row.updated_at,
                        ),
                    )
                    stats["documents"] += 1
                for row in self.memory_items.values():
                    conn.execute(
                        """
                        INSERT INTO mabel_api_memory_items (
                            id, owner_email, key, content, tags, embedding, pinned, confidence, source,
                            conversation_id, last_used_at, created_at, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            owner_email = EXCLUDED.owner_email,
                            key = EXCLUDED.key,
                            content = EXCLUDED.content,
                            tags = EXCLUDED.tags,
                            embedding = EXCLUDED.embedding,
                            pinned = EXCLUDED.pinned,
                            confidence = EXCLUDED.confidence,
                            source = EXCLUDED.source,
                            conversation_id = EXCLUDED.conversation_id,
                            last_used_at = EXCLUDED.last_used_at,
                            created_at = EXCLUDED.created_at,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (
                            row.id,
                            row.owner_email,
                            row.key,
                            row.content,
                            Jsonb(row.tags or []),
                            Jsonb(row.embedding or []),
                            bool(row.pinned),
                            float(row.confidence),
                            row.source,
                            row.conversation_id,
                            row.last_used_at,
                            row.created_at,
                            row.updated_at,
                        ),
                    )
                    stats["memory_items"] += 1
            return stats

    def reset(self) -> None:
        super().reset()

    def __getattribute__(self, name: str):
        attr = object.__getattribute__(self, name)
        mutators = {
            "create_project", "touch_project", "update_project", "delete_project",
            "create_conversation", "touch_conversation", "update_conversation", "delete_conversation",
            "add_message", "create_run", "update_run_status",
            "record_run_usage",
            "add_tool_call", "upsert_connector_snapshot", "set_connector_enabled", "create_approval",
            "update_approval", "create_skill", "update_skill", "delete_skill",
            "ensure_starter_pack", "create_scheduled_task", "update_scheduled_task", "create_scheduled_task_run", "add_audit_event",
            "create_uploaded_file", "create_file_link", "delete_uploaded_file",
            "create_document", "update_document", "delete_document",
            "create_memory_item", "update_memory_item", "delete_memory_item",
        }
        readers = {
            "get_project",
            "list_projects_for_user",
            "get_conversation",
            "list_conversations",
            "list_messages",
            "list_connectors",
            "get_approval",
            "list_pending_approvals",
            "get_skill",
            "list_skills",
            "list_starter_packs",
            "get_scheduled_task",
            "list_scheduled_tasks_for_user",
            "list_due_scheduled_tasks",
            "list_scheduled_task_runs_for_user",
            "list_tool_calls_for_conversation",
            "list_tool_calls",
            "list_runs",
            "list_usage_events",
            "list_audit_events",
            "get_uploaded_file",
            "list_uploaded_files_for_user",
            "list_uploaded_files_for_conversation",
            "list_uploaded_files_for_project",
            "list_uploaded_files_for_run",
            "get_document",
            "list_documents_for_user",
            "get_memory_item",
            "list_memory_items_for_user",
        }
        if name in mutators and callable(attr):
            def wrapped(*args, **kwargs):
                with self._state_lock:
                    self._load_state()
                    result = attr(*args, **kwargs)
                    self._save_state()
                    return result
            return wrapped
        if name in readers and callable(attr):
            def wrapped_reader(*args, **kwargs):
                with self._state_lock:
                    self._load_state()
                    return attr(*args, **kwargs)
            return wrapped_reader
        return attr

    def record_run_usage(self, run_id: str, usage: dict[str, Any]) -> None:
        super().record_run_usage(run_id, usage)
        run = self.runs.get(run_id)
        if run is None:
            return
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE mabel_api_runs
                SET state_json = %s
                WHERE id = %s
                """,
                (Jsonb(run.state_json or {}), run_id),
            )
        input_tokens = int(usage.get("input_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        total_tokens = int(usage.get("total_tokens") or (input_tokens + output_tokens))
        estimated = bool(usage.get("estimated", False))
        cost_usd = usage.get("cost_usd")
        metadata = usage.get("metadata") if isinstance(usage.get("metadata"), dict) else {}
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_usage_events (
                    run_id, conversation_id, user_email, surface, status, model,
                    input_tokens, output_tokens, total_tokens, estimated, cost_usd,
                    metadata, created_at, finished_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (run_id)
                DO UPDATE SET
                    conversation_id = EXCLUDED.conversation_id,
                    user_email = EXCLUDED.user_email,
                    surface = EXCLUDED.surface,
                    status = EXCLUDED.status,
                    model = EXCLUDED.model,
                    input_tokens = EXCLUDED.input_tokens,
                    output_tokens = EXCLUDED.output_tokens,
                    total_tokens = EXCLUDED.total_tokens,
                    estimated = EXCLUDED.estimated,
                    cost_usd = EXCLUDED.cost_usd,
                    metadata = EXCLUDED.metadata,
                    finished_at = EXCLUDED.finished_at
                """,
                (
                    run.id,
                    run.conversation_id,
                    run.user_email,
                    run.surface,
                    run.status,
                    run.model,
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    estimated,
                    float(cost_usd) if isinstance(cost_usd, (int, float)) else None,
                    Jsonb(metadata),
                    run.created_at,
                    run.finished_at,
                ),
            )

    def create_approval(self, approval: Approval) -> Approval:
        created = super().create_approval(approval)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_approvals (
                    id, status, title, summary, requested_by, payload, run_id,
                    decided_by, decision_reason, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    status = EXCLUDED.status,
                    title = EXCLUDED.title,
                    summary = EXCLUDED.summary,
                    requested_by = EXCLUDED.requested_by,
                    payload = EXCLUDED.payload,
                    run_id = EXCLUDED.run_id,
                    decided_by = EXCLUDED.decided_by,
                    decision_reason = EXCLUDED.decision_reason,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    created.id,
                    created.status,
                    created.title,
                    created.summary,
                    created.requested_by,
                    Jsonb(created.payload or {}),
                    created.run_id,
                    created.decided_by,
                    created.decision_reason,
                    created.created_at,
                    created.updated_at,
                ),
            )
        return created

    def get_approval(self, approval_id: str) -> Approval | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT
                    id, status, title, summary, requested_by, payload, run_id,
                    decided_by, decision_reason, created_at, updated_at
                FROM mabel_api_approvals
                WHERE id = %s
                """,
                (approval_id,),
            ).fetchone()
        if row:
            payload = row.get("payload")
            if not isinstance(payload, dict):
                payload = {}
            return Approval(
                id=str(row["id"]),
                status=str(row["status"]),
                title=str(row["title"]),
                summary=str(row["summary"]),
                requested_by=str(row["requested_by"]),
                payload=payload,
                run_id=str(row["run_id"]) if row.get("run_id") else None,
                decided_by=str(row["decided_by"]) if row.get("decided_by") else None,
                decision_reason=str(row["decision_reason"]) if row.get("decision_reason") else None,
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
        if self._allow_fallback():
            return super().get_approval(approval_id)
        return None

    def update_approval(self, approval: Approval) -> Approval:
        updated = super().update_approval(approval)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_approvals (
                    id, status, title, summary, requested_by, payload, run_id,
                    decided_by, decision_reason, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    status = EXCLUDED.status,
                    title = EXCLUDED.title,
                    summary = EXCLUDED.summary,
                    requested_by = EXCLUDED.requested_by,
                    payload = EXCLUDED.payload,
                    run_id = EXCLUDED.run_id,
                    decided_by = EXCLUDED.decided_by,
                    decision_reason = EXCLUDED.decision_reason,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    updated.id,
                    updated.status,
                    updated.title,
                    updated.summary,
                    updated.requested_by,
                    Jsonb(updated.payload or {}),
                    updated.run_id,
                    updated.decided_by,
                    updated.decision_reason,
                    updated.created_at,
                    updated.updated_at,
                ),
            )
        return updated

    def list_pending_approvals(self, user_email: str, is_approver: bool) -> list[Approval]:
        if is_approver:
            query = """
                SELECT
                    id, status, title, summary, requested_by, payload, run_id,
                    decided_by, decision_reason, created_at, updated_at
                FROM mabel_api_approvals
                WHERE status = 'pending'
                ORDER BY created_at ASC
                LIMIT 1000
            """
            params: tuple[Any, ...] = ()
        else:
            query = """
                SELECT
                    id, status, title, summary, requested_by, payload, run_id,
                    decided_by, decision_reason, created_at, updated_at
                FROM mabel_api_approvals
                WHERE status = 'pending' AND requested_by = %s
                ORDER BY created_at ASC
                LIMIT 1000
            """
            params = (user_email,)
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        approvals: list[Approval] = []
        for row in rows:
            payload = row.get("payload")
            if not isinstance(payload, dict):
                payload = {}
            approvals.append(
                Approval(
                    id=str(row["id"]),
                    status=str(row["status"]),
                    title=str(row["title"]),
                    summary=str(row["summary"]),
                    requested_by=str(row["requested_by"]),
                    payload=payload,
                    run_id=str(row["run_id"]) if row.get("run_id") else None,
                    decided_by=str(row["decided_by"]) if row.get("decided_by") else None,
                    decision_reason=str(row["decision_reason"]) if row.get("decision_reason") else None,
                    created_at=_dt(row.get("created_at")),
                    updated_at=_dt(row.get("updated_at")),
                )
            )
        if approvals:
            return approvals
        if self._allow_fallback():
            return super().list_pending_approvals(user_email, is_approver)
        return []

    def list_connectors(self) -> list[ConnectorSnapshot]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT org_slug, server_slug, id, name, connection_status, tools, last_error, enabled, refreshed_at
                FROM mabel_api_connectors
                ORDER BY name ASC
                """
            ).fetchall()
        snapshots: list[ConnectorSnapshot] = []
        for row in rows:
            tools = row.get("tools")
            if not isinstance(tools, list):
                tools = []
            snapshots.append(
                ConnectorSnapshot(
                    org_slug=str(row["org_slug"]),
                    server_slug=str(row["server_slug"]),
                    id=int(row["id"]) if row.get("id") is not None else None,
                    name=str(row["name"]),
                    connection_status=str(row["connection_status"]),
                    tools=[item for item in tools if isinstance(item, dict)],
                    last_error=str(row["last_error"]) if row.get("last_error") else None,
                    enabled=row.get("enabled"),
                    refreshed_at=_dt(row.get("refreshed_at")),
                )
            )
        if snapshots:
            if not self._allow_fallback():
                return sorted(snapshots, key=lambda item: item.name)
            seen = {(row.org_slug, row.server_slug) for row in snapshots}
            for legacy in super().list_connectors():
                key = (legacy.org_slug, legacy.server_slug)
                if key in seen:
                    continue
                snapshots.append(legacy)
            return sorted(snapshots, key=lambda item: item.name)
        if self._allow_fallback():
            return super().list_connectors()
        return []

    def upsert_connector_snapshot(self, snapshot: ConnectorSnapshot) -> ConnectorSnapshot:
        saved = super().upsert_connector_snapshot(snapshot)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_connectors (
                    org_slug, server_slug, id, name, connection_status, tools,
                    last_error, enabled, refreshed_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (org_slug, server_slug)
                DO UPDATE SET
                    id = COALESCE(EXCLUDED.id, mabel_api_connectors.id),
                    name = EXCLUDED.name,
                    connection_status = EXCLUDED.connection_status,
                    tools = EXCLUDED.tools,
                    last_error = EXCLUDED.last_error,
                    enabled = EXCLUDED.enabled,
                    refreshed_at = EXCLUDED.refreshed_at
                """,
                (
                    saved.org_slug,
                    saved.server_slug,
                    saved.id,
                    saved.name,
                    saved.connection_status,
                    Jsonb(saved.tools or []),
                    saved.last_error,
                    saved.enabled,
                    saved.refreshed_at,
                ),
            )
        return saved

    def set_connector_enabled(self, server_slug: str, enabled: bool) -> ConnectorSnapshot | None:
        snapshot = super().set_connector_enabled(server_slug, enabled)
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE mabel_api_connectors
                SET enabled = %s,
                    refreshed_at = now()
                WHERE server_slug = %s
                """,
                (enabled, server_slug),
            )
        if snapshot is not None:
            return snapshot
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT org_slug, server_slug, id, name, connection_status, tools, last_error, enabled, refreshed_at
                FROM mabel_api_connectors
                WHERE server_slug = %s
                ORDER BY refreshed_at DESC
                LIMIT 1
                """,
                (server_slug,),
            ).fetchone()
        if not row:
            return None
        tools = row.get("tools")
        if not isinstance(tools, list):
            tools = []
        return ConnectorSnapshot(
            org_slug=str(row["org_slug"]),
            server_slug=str(row["server_slug"]),
            id=int(row["id"]) if row.get("id") is not None else None,
            name=str(row["name"]),
            connection_status=str(row["connection_status"]),
            tools=[item for item in tools if isinstance(item, dict)],
            last_error=str(row["last_error"]) if row.get("last_error") else None,
            enabled=row.get("enabled"),
            refreshed_at=_dt(row.get("refreshed_at")),
        )

    def create_skill(self, skill: Skill) -> Skill:
        saved = super().create_skill(skill)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_skills (
                    id, name, owner_team, status, current_version, content_md,
                    mcp_bindings, tags, source, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    name = EXCLUDED.name,
                    owner_team = EXCLUDED.owner_team,
                    status = EXCLUDED.status,
                    current_version = EXCLUDED.current_version,
                    content_md = EXCLUDED.content_md,
                    mcp_bindings = EXCLUDED.mcp_bindings,
                    tags = EXCLUDED.tags,
                    source = EXCLUDED.source,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.name,
                    saved.owner_team,
                    saved.status,
                    saved.current_version,
                    saved.content_md,
                    Jsonb(saved.mcp_bindings or []),
                    Jsonb(saved.tags or []),
                    Jsonb(saved.source or {}),
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def get_skill(self, skill_id: str) -> Skill | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, name, owner_team, status, current_version, content_md,
                       mcp_bindings, tags, source, created_at, updated_at
                FROM mabel_api_skills
                WHERE id = %s
                """,
                (skill_id,),
            ).fetchone()
        if row:
            mcp_bindings = row.get("mcp_bindings")
            tags = row.get("tags")
            source = row.get("source")
            return Skill(
                id=str(row["id"]),
                name=str(row["name"]),
                owner_team=str(row["owner_team"]),
                status=str(row["status"]),
                current_version=str(row["current_version"]),
                content_md=str(row["content_md"]),
                mcp_bindings=[item for item in (mcp_bindings if isinstance(mcp_bindings, list) else []) if isinstance(item, dict)],
                tags=[str(item) for item in (tags if isinstance(tags, list) else [])],
                source=source if isinstance(source, dict) else {},
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
        if self._allow_fallback():
            return super().get_skill(skill_id)
        return None

    def update_skill(self, skill: Skill) -> Skill:
        saved = super().update_skill(skill)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_skills (
                    id, name, owner_team, status, current_version, content_md,
                    mcp_bindings, tags, source, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    name = EXCLUDED.name,
                    owner_team = EXCLUDED.owner_team,
                    status = EXCLUDED.status,
                    current_version = EXCLUDED.current_version,
                    content_md = EXCLUDED.content_md,
                    mcp_bindings = EXCLUDED.mcp_bindings,
                    tags = EXCLUDED.tags,
                    source = EXCLUDED.source,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.name,
                    saved.owner_team,
                    saved.status,
                    saved.current_version,
                    saved.content_md,
                    Jsonb(saved.mcp_bindings or []),
                    Jsonb(saved.tags or []),
                    Jsonb(saved.source or {}),
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def delete_skill(self, skill_id: str) -> None:
        super().delete_skill(skill_id)
        with self._connect() as conn:
            conn.execute("DELETE FROM mabel_api_skills WHERE id = %s", (skill_id,))

    def list_skills(self, query: str | None = None) -> list[Skill]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, owner_team, status, current_version, content_md,
                       mcp_bindings, tags, source, created_at, updated_at
                FROM mabel_api_skills
                ORDER BY name ASC
                """
            ).fetchall()
        skills: list[Skill] = []
        for row in rows:
            mcp_bindings = row.get("mcp_bindings")
            tags = row.get("tags")
            source = row.get("source")
            skills.append(
                Skill(
                    id=str(row["id"]),
                    name=str(row["name"]),
                    owner_team=str(row["owner_team"]),
                    status=str(row["status"]),
                    current_version=str(row["current_version"]),
                    content_md=str(row["content_md"]),
                    mcp_bindings=[item for item in (mcp_bindings if isinstance(mcp_bindings, list) else []) if isinstance(item, dict)],
                    tags=[str(item) for item in (tags if isinstance(tags, list) else [])],
                    source=source if isinstance(source, dict) else {},
                    created_at=_dt(row.get("created_at")),
                    updated_at=_dt(row.get("updated_at")),
                )
            )
        if not skills and self._allow_fallback():
            return super().list_skills(query)
        needle = (query or "").lower().strip()
        if needle:
            skills = [
                row
                for row in skills
                if needle in row.id.lower()
                or needle in row.name.lower()
                or needle in row.owner_team.lower()
                or any(needle in tag.lower() for tag in row.tags)
            ]
        return sorted(skills, key=lambda row: row.name)

    def create_document(self, document: MabelDocument) -> MabelDocument:
        saved = super().create_document(document)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_documents (
                    id, owner_email, title, kind, content, conversation_id, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    owner_email = EXCLUDED.owner_email,
                    title = EXCLUDED.title,
                    kind = EXCLUDED.kind,
                    content = EXCLUDED.content,
                    conversation_id = EXCLUDED.conversation_id,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.owner_email,
                    saved.title,
                    saved.kind,
                    saved.content,
                    saved.conversation_id,
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def get_document(self, document_id: str) -> MabelDocument | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, owner_email, title, kind, content, conversation_id, created_at, updated_at
                FROM mabel_api_documents
                WHERE id = %s
                """,
                (document_id,),
            ).fetchone()
        if row:
            return MabelDocument(
                id=str(row["id"]),
                owner_email=str(row["owner_email"]),
                title=str(row["title"]),
                kind=str(row["kind"]),
                content=str(row["content"]),
                conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
        if self._allow_fallback():
            return super().get_document(document_id)
        return None

    def update_document(self, document: MabelDocument) -> MabelDocument:
        saved = super().update_document(document)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_documents (
                    id, owner_email, title, kind, content, conversation_id, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    owner_email = EXCLUDED.owner_email,
                    title = EXCLUDED.title,
                    kind = EXCLUDED.kind,
                    content = EXCLUDED.content,
                    conversation_id = EXCLUDED.conversation_id,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.owner_email,
                    saved.title,
                    saved.kind,
                    saved.content,
                    saved.conversation_id,
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def delete_document(self, document_id: str) -> None:
        super().delete_document(document_id)
        with self._connect() as conn:
            conn.execute("DELETE FROM mabel_api_documents WHERE id = %s", (document_id,))

    def list_documents_for_user(self, user_email: str) -> list[MabelDocument]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, owner_email, title, kind, content, conversation_id, created_at, updated_at
                FROM mabel_api_documents
                WHERE owner_email = %s
                ORDER BY updated_at DESC
                """,
                (user_email,),
            ).fetchall()
        docs = [
            MabelDocument(
                id=str(row["id"]),
                owner_email=str(row["owner_email"]),
                title=str(row["title"]),
                kind=str(row["kind"]),
                content=str(row["content"]),
                conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
            for row in rows
        ]
        if docs:
            return docs
        if self._allow_fallback():
            return super().list_documents_for_user(user_email)
        return []

    def list_documents_for_conversation(self, conversation_id: int) -> list[MabelDocument]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, owner_email, title, kind, content, conversation_id, created_at, updated_at
                FROM mabel_api_documents
                WHERE conversation_id = %s
                """,
                (conversation_id,),
            ).fetchall()
        docs = [
            MabelDocument(
                id=str(row["id"]),
                owner_email=str(row["owner_email"]),
                title=str(row["title"]),
                kind=str(row["kind"]),
                content=str(row["content"]),
                conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
            for row in rows
        ]
        docs = _sort_documents_for_display(docs)
        if docs:
            return docs
        if self._allow_fallback():
            return super().list_documents_for_conversation(conversation_id)
        return []

    def create_memory_item(self, item: MabelMemoryItem) -> MabelMemoryItem:
        saved = super().create_memory_item(item)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_memory_items (
                    id, owner_email, key, content, tags, embedding, pinned, confidence, source,
                    conversation_id, last_used_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    owner_email = EXCLUDED.owner_email,
                    key = EXCLUDED.key,
                    content = EXCLUDED.content,
                    tags = EXCLUDED.tags,
                    embedding = EXCLUDED.embedding,
                    pinned = EXCLUDED.pinned,
                    confidence = EXCLUDED.confidence,
                    source = EXCLUDED.source,
                    conversation_id = EXCLUDED.conversation_id,
                    last_used_at = EXCLUDED.last_used_at,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.owner_email,
                    saved.key,
                    saved.content,
                    Jsonb(saved.tags or []),
                    Jsonb(saved.embedding or []),
                    bool(saved.pinned),
                    float(saved.confidence),
                    saved.source,
                    saved.conversation_id,
                    saved.last_used_at,
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def get_memory_item(self, item_id: str) -> MabelMemoryItem | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, owner_email, key, content, tags, embedding, confidence, source,
                       pinned, conversation_id, last_used_at, created_at, updated_at
                FROM mabel_api_memory_items
                WHERE id = %s
                """,
                (item_id,),
            ).fetchone()
        if row:
            tags = row.get("tags")
            embedding = row.get("embedding")
            return MabelMemoryItem(
                id=str(row["id"]),
                owner_email=str(row["owner_email"]),
                key=str(row["key"]),
                content=str(row["content"]),
                tags=[str(tag) for tag in (tags if isinstance(tags, list) else [])],
                embedding=[float(value) for value in (embedding if isinstance(embedding, list) else []) if isinstance(value, (int, float))],
                pinned=bool(row.get("pinned") or False),
                confidence=float(row.get("confidence") or 0.7),
                source=str(row.get("source") or "manual"),
                conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                last_used_at=_dt(row.get("last_used_at")) if row.get("last_used_at") else None,
                created_at=_dt(row.get("created_at")),
                updated_at=_dt(row.get("updated_at")),
            )
        if self._allow_fallback():
            return super().get_memory_item(item_id)
        return None

    def update_memory_item(self, item: MabelMemoryItem) -> MabelMemoryItem:
        saved = super().update_memory_item(item)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO mabel_api_memory_items (
                    id, owner_email, key, content, tags, embedding, pinned, confidence, source,
                    conversation_id, last_used_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id)
                DO UPDATE SET
                    owner_email = EXCLUDED.owner_email,
                    key = EXCLUDED.key,
                    content = EXCLUDED.content,
                    tags = EXCLUDED.tags,
                    embedding = EXCLUDED.embedding,
                    pinned = EXCLUDED.pinned,
                    confidence = EXCLUDED.confidence,
                    source = EXCLUDED.source,
                    conversation_id = EXCLUDED.conversation_id,
                    last_used_at = EXCLUDED.last_used_at,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    saved.id,
                    saved.owner_email,
                    saved.key,
                    saved.content,
                    Jsonb(saved.tags or []),
                    Jsonb(saved.embedding or []),
                    bool(saved.pinned),
                    float(saved.confidence),
                    saved.source,
                    saved.conversation_id,
                    saved.last_used_at,
                    saved.created_at,
                    saved.updated_at,
                ),
            )
        return saved

    def delete_memory_item(self, item_id: str) -> None:
        super().delete_memory_item(item_id)
        with self._connect() as conn:
            conn.execute("DELETE FROM mabel_api_memory_items WHERE id = %s", (item_id,))

    def list_memory_items_for_user(self, user_email: str, query: str | None = None) -> list[MabelMemoryItem]:
        with self._connect() as conn:
            if query and query.strip():
                needle = f"%{query.strip()}%"
                rows = conn.execute(
                    """
                    SELECT id, owner_email, key, content, tags, embedding, confidence, source,
                           pinned, conversation_id, last_used_at, created_at, updated_at
                    FROM mabel_api_memory_items
                    WHERE owner_email = %s
                      AND (key ILIKE %s OR content ILIKE %s OR tags::text ILIKE %s)
                    ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC, updated_at DESC, confidence DESC
                    """,
                    (user_email, needle, needle, needle),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, owner_email, key, content, tags, embedding, confidence, source,
                           pinned, conversation_id, last_used_at, created_at, updated_at
                    FROM mabel_api_memory_items
                    WHERE owner_email = %s
                    ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC, updated_at DESC, confidence DESC
                    """,
                    (user_email,),
                ).fetchall()
        items: list[MabelMemoryItem] = []
        for row in rows:
            tags = row.get("tags")
            embedding = row.get("embedding")
            items.append(
                MabelMemoryItem(
                    id=str(row["id"]),
                    owner_email=str(row["owner_email"]),
                    key=str(row["key"]),
                    content=str(row["content"]),
                    tags=[str(tag) for tag in (tags if isinstance(tags, list) else [])],
                    embedding=[float(value) for value in (embedding if isinstance(embedding, list) else []) if isinstance(value, (int, float))],
                    pinned=bool(row.get("pinned") or False),
                    confidence=float(row.get("confidence") or 0.7),
                    source=str(row.get("source") or "manual"),
                    conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                    last_used_at=_dt(row.get("last_used_at")) if row.get("last_used_at") else None,
                    created_at=_dt(row.get("created_at")),
                    updated_at=_dt(row.get("updated_at")),
                )
            )
        if items:
            return items
        if self._allow_fallback():
            return super().list_memory_items_for_user(user_email, query)
        return []

    def search_memory_items_semantic(
        self, user_email: str, query: str, query_embedding: list[float], *, limit: int = 50
    ) -> list[MabelMemoryItem]:
        if not query_embedding or not self.pgvector_available:
            return []
        dim = len(query_embedding)
        if dim <= 0:
            return []
        vector_literal = "[" + ",".join(f"{float(value):.8f}" for value in query_embedding) + "]"
        needle = f"%{(query or '').strip()}%"
        with self._connect() as conn:
            try:
                rows = conn.execute(
                    """
                    SELECT id, owner_email, key, content, tags, embedding, pinned, confidence, source,
                           conversation_id, last_used_at, created_at, updated_at,
                           (
                               CASE WHEN key ILIKE %s OR content ILIKE %s OR tags::text ILIKE %s THEN 1.0 ELSE 0.0 END
                               + (1.0 - ((embedding::text)::vector <=> (%s)::vector)) * 2.5
                               + confidence * 0.1
                               + CASE WHEN pinned THEN 2.0 ELSE 0.0 END
                           ) AS rank
                    FROM mabel_api_memory_items
                    WHERE owner_email = %s
                      AND jsonb_array_length(embedding) = %s
                      AND (
                        key ILIKE %s OR content ILIKE %s OR tags::text ILIKE %s
                        OR (1.0 - ((embedding::text)::vector <=> (%s)::vector)) >= 0.55
                      )
                    ORDER BY rank DESC, pinned DESC, confidence DESC, updated_at DESC
                    LIMIT %s
                    """,
                    (
                        needle, needle, needle,
                        vector_literal,
                        user_email,
                        dim,
                        needle, needle, needle,
                        vector_literal,
                        max(1, int(limit or 50)),
                    ),
                ).fetchall()
            except Exception:
                return []
        items: list[MabelMemoryItem] = []
        for row in rows:
            tags = row.get("tags")
            embedding = row.get("embedding")
            items.append(
                MabelMemoryItem(
                    id=str(row["id"]),
                    owner_email=str(row["owner_email"]),
                    key=str(row["key"]),
                    content=str(row["content"]),
                    tags=[str(tag) for tag in (tags if isinstance(tags, list) else [])],
                    embedding=[float(value) for value in (embedding if isinstance(embedding, list) else []) if isinstance(value, (int, float))],
                    pinned=bool(row.get("pinned") or False),
                    confidence=float(row.get("confidence") or 0.7),
                    source=str(row.get("source") or "manual"),
                    conversation_id=int(row["conversation_id"]) if row.get("conversation_id") is not None else None,
                    last_used_at=_dt(row.get("last_used_at")) if row.get("last_used_at") else None,
                    created_at=_dt(row.get("created_at")),
                    updated_at=_dt(row.get("updated_at")),
                )
            )
        return items

    def list_usage_events(self, user_email: str | None = None) -> list[dict[str, Any]]:
        query = """
            SELECT
                run_id,
                conversation_id,
                user_email,
                surface,
                status,
                model,
                input_tokens,
                output_tokens,
                total_tokens,
                estimated,
                cost_usd,
                metadata,
                created_at,
                finished_at
            FROM mabel_api_usage_events
        """
        params: tuple[Any, ...] = ()
        if user_email:
            query += " WHERE user_email = %s"
            params = (user_email,)
        query += " ORDER BY created_at DESC LIMIT 2000"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        events: list[dict[str, Any]] = []
        for row in rows:
            metadata = row.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            usage = {
                "input_tokens": int(row.get("input_tokens") or 0),
                "output_tokens": int(row.get("output_tokens") or 0),
                "total_tokens": int(row.get("total_tokens") or 0),
                "estimated": bool(row.get("estimated") or False),
                "cost_usd": float(row["cost_usd"]) if row.get("cost_usd") is not None else None,
            }
            if metadata:
                usage["metadata"] = metadata
            events.append(
                {
                    "run_id": row["run_id"],
                    "conversation_id": row.get("conversation_id"),
                    "user_email": row["user_email"],
                    "surface": row["surface"],
                    "status": row["status"],
                    "model": row["model"],
                    "created_at": row["created_at"].replace(tzinfo=None) if row.get("created_at") else utcnow(),
                    "finished_at": row["finished_at"].replace(tzinfo=None) if row.get("finished_at") else None,
                    "usage": usage,
                }
            )
        if len(events) >= 2000 or not self._allow_fallback():
            return events
        # Backward-compatible bridge: include legacy usage records that still
        # only exist in JSONB state until fully migrated to normalized rows.
        seen = {str(item.get("run_id") or "") for item in events}
        for legacy in super().list_usage_events(user_email):
            run_id = str(legacy.get("run_id") or "")
            if not run_id or run_id in seen:
                continue
            events.append(legacy)
        events.sort(key=lambda row: row.get("created_at") or utcnow(), reverse=True)
        return events[:2000]

    def normalization_status(self) -> dict[str, Any]:
        with self._state_lock:
            self._load_state()
            legacy_counts = {
                "projects": len(self.projects),
                "conversations": len(self.conversations),
                "messages": len(self.messages),
                "runs": len(self.runs),
                "tool_calls": len(self.tool_calls),
                "approvals": len(self.approvals),
                "connectors": len(self.connectors),
                "skills": len(self.skills),
                "documents": len(self.documents),
                "memory_items": len(self.memory_items),
                "usage_events": sum(
                    1
                    for run in self.runs.values()
                    if isinstance(run.state_json, dict) and isinstance(run.state_json.get("usage"), dict)
                ),
            }
        with self._connect() as conn:
            normalized_counts = {
                "projects": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_projects").fetchone()["c"]),
                "conversations": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_conversations").fetchone()["c"]),
                "messages": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_messages").fetchone()["c"]),
                "runs": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_runs").fetchone()["c"]),
                "tool_calls": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_tool_calls").fetchone()["c"]),
                "approvals": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_approvals").fetchone()["c"]),
                "connectors": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_connectors").fetchone()["c"]),
                "skills": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_skills").fetchone()["c"]),
                "documents": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_documents").fetchone()["c"]),
                "memory_items": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_memory_items").fetchone()["c"]),
                "usage_events": int(conn.execute("SELECT COUNT(*) AS c FROM mabel_api_usage_events").fetchone()["c"]),
            }
        backfill_gap = {
            key: max(legacy_counts.get(key, 0) - normalized_counts.get(key, 0), 0)
            for key in legacy_counts
        }
        return {
            "store": "postgres",
            "strict_reads": self.strict_normalized_reads,
            "normalized_counts": normalized_counts,
            "legacy_counts": legacy_counts,
            "backfill_gap": backfill_gap,
            "ready_for_strict_reads": all(value == 0 for value in backfill_gap.values()),
        }


def _dump(value: Any) -> dict[str, Any]:
    out = asdict(value)
    for key, item in list(out.items()):
        if isinstance(item, datetime):
            out[key] = item.isoformat()
    return out


def _dt(value: str | datetime | None) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, str):
        return datetime.fromisoformat(value).replace(tzinfo=None)
    return utcnow()


def _conversation(v: dict) -> Conversation:
    return Conversation(**{**v, "created_at": _dt(v.get("created_at")), "updated_at": _dt(v.get("updated_at"))})


def _project(v: dict) -> MabelProject:
    return MabelProject(**{**v, "created_at": _dt(v.get("created_at")), "updated_at": _dt(v.get("updated_at"))})


def _agent_run(v: dict) -> AgentRun:
    return AgentRun(**{**v, "created_at": _dt(v.get("created_at")), "finished_at": _dt(v.get("finished_at")) if v.get("finished_at") else None})


def _message(v: dict) -> Message:
    return Message(**{**v, "created_at": _dt(v.get("created_at"))})


def _tool_call(v: dict) -> ToolCall:
    return ToolCall(**{**v, "created_at": _dt(v.get("created_at"))})


def _approval(v: dict) -> Approval:
    return Approval(**{**v, "created_at": _dt(v.get("created_at")), "updated_at": _dt(v.get("updated_at"))})


def _connector(v: dict) -> ConnectorSnapshot:
    return ConnectorSnapshot(**{**v, "refreshed_at": _dt(v.get("refreshed_at"))})


def _skill(v: dict) -> Skill:
    return Skill(**{**v, "created_at": _dt(v.get("created_at")), "updated_at": _dt(v.get("updated_at"))})


def _starter_pack(v: dict) -> StarterPack:
    return StarterPack(**{**v, "created_at": _dt(v.get("created_at")), "updated_at": _dt(v.get("updated_at"))})


def _scheduled_task(v: dict) -> ScheduledTask:
    return ScheduledTask(
        **{
            **v,
            "last_run_at": _dt(v.get("last_run_at")) if v.get("last_run_at") else None,
            "next_run_at": _dt(v.get("next_run_at")) if v.get("next_run_at") else None,
            "created_at": _dt(v.get("created_at")),
            "updated_at": _dt(v.get("updated_at")),
        }
    )


def _scheduled_task_run(v: dict) -> ScheduledTaskRun:
    return ScheduledTaskRun(
        **{
            **v,
            "created_at": _dt(v.get("created_at")),
            "finished_at": _dt(v.get("finished_at")) if v.get("finished_at") else None,
        }
    )


def _audit_event(v: dict) -> AuditEvent:
    return AuditEvent(**{**v, "created_at": _dt(v.get("created_at"))})


def _uploaded_file(v: dict) -> UploadedFile:
    return UploadedFile(**{**v, "created_at": _dt(v.get("created_at"))})


def _file_link(v: dict) -> ConversationFileLink:
    return ConversationFileLink(**{**v, "created_at": _dt(v.get("created_at"))})


def _document(v: dict) -> MabelDocument:
    return MabelDocument(
        **{
            **v,
            "created_at": _dt(v.get("created_at")),
            "updated_at": _dt(v.get("updated_at")),
        }
    )


def _memory_item(v: dict) -> MabelMemoryItem:
    return MabelMemoryItem(
        **{
            **v,
            "last_used_at": _dt(v.get("last_used_at")) if v.get("last_used_at") else None,
            "created_at": _dt(v.get("created_at")),
            "updated_at": _dt(v.get("updated_at")),
        }
    )


def get_store(settings: MabelSettings | None = None) -> MabelStore:
    global _STORE, _STORE_KEY
    active = settings or MabelSettings.load()
    key = (active.store_mode, active.database_url, str(active.normalized_strict_reads))
    if _STORE is None or _STORE_KEY != key:
        if active.store_mode == "memory":
            _STORE = MemoryMabelStore()
        else:
            if not active.database_url:
                raise RuntimeError("MABEL_DB_URL is required for Mabel Postgres store")
            _STORE = PostgresMabelStore(active.database_url, strict_normalized_reads=active.normalized_strict_reads)
        _STORE.init()
        _STORE_KEY = key
    return _STORE


def reset_store() -> None:
    global _STORE, _STORE_KEY
    _STORE = None
    _STORE_KEY = None


def db_health(settings: MabelSettings | None = None) -> dict[str, str]:
    return get_store(settings).health()
