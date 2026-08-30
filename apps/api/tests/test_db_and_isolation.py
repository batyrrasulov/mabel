from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_store_initializes_core_v2_records() -> None:
    from mabel_api.db import get_store
    from mabel_api.models import AuditEvent, Conversation, Skill

    store = get_store()
    conversation = store.create_conversation(Conversation(user_email="agent@example.com", title="First Mabel run"))
    store.create_skill(
        Skill(
            id="skill.account-prep",
            name="Account prep",
            owner_team="account-management",
            status="draft",
            current_version="0.1.0",
            content_md="# Account prep\n",
        )
    )
    store.add_audit_event(
        AuditEvent(
            actor_email="agent@example.com",
            event_type="conversation.created",
            status="ok",
            metadata={"conversation": "created"},
        )
    )

    assert conversation.id == 1
    assert len(store.list_conversations("agent@example.com")) == 1
    assert store.get_skill("skill.account-prep") is not None


def test_mabel_api_source_does_not_import_old_mabel_or_claude() -> None:
    v2_roots = [REPO_ROOT / "backend" / "mabel_api_backend", REPO_ROOT / "src" / "components" / "mabel"]
    forbidden = ("backend.mabel_backend", "mabel_api", "backend.xray_backend", "src/components/x-ray", "claude_agent_sdk")
    offenders: list[str] = []

    for root in v2_roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.suffix not in {".py", ".ts", ".tsx", ".css"}:
                continue
            if path.name.startswith("test_") or path.name.endswith(".test.ts") or path.name.endswith(".test.tsx"):
                continue
            text = path.read_text(encoding="utf-8")
            for needle in forbidden:
                if needle in text:
                    offenders.append(f"{path.relative_to(REPO_ROOT)} contains {needle}")

    assert offenders == []
