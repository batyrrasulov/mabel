from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .db import MabelStore
from .mcp.manager import LocalMcpRegistry
from .models import ConnectorSnapshot, Skill, StarterPack
from .settings import MabelSettings, repo_root

# Agent launch readiness (strict).
LAUNCH_READY_CONNECTOR_STATUSES = {"connected", "remote_gateway_available"}

# Rows shown in /api/v1/bootstrap `connectors` (Connectors UI). Wider than launch readiness
# so internal stdio packages are listed with honest statuses instead of mislabeled Remote Gateway.
CONNECTOR_UI_LISTING_STATUSES = frozenset(
    {
        "connected",
        "remote_gateway_available",
        "local_package_available",
        "needs_validation",
        "not_configured",
    }
)

# Dropped from the Mabel connector list (still may exist in older stores; filtered on read).
CONNECTOR_UI_EXCLUDE_SLUGS = frozenset(
    {
        "remote_gateway",
        # Demo-only skill alias; never a real MCP connector.
        "product-usage",
        "product_usage",
    }
)

INTERNAL_LOCAL_CONNECTOR_SLUGS: frozenset[str] = frozenset()

# Legacy connector ids that map to one canonical slug (must match UI + MCP manager aliases).
CONNECTOR_SLUG_ALIASES: dict[str, str] = {
    "google-analytics": "google-analytics-mcp",
}

START_MY_DAY_WORKFLOW_ID = "workflow-pack.start-my-day"

CURATED_MABEL_SKILL_IDS = frozenset({"skill.research-brief"})
CURATED_MABEL_SKILL_ORDER = {"skill.research-brief": 0}


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _entry_status(payload: dict[str, Any]) -> str:
    lifecycle = payload.get("lifecycle")
    if isinstance(lifecycle, dict) and lifecycle.get("status"):
        return normalize_skill_status(str(lifecycle["status"]))
    return normalize_skill_status(str(payload.get("status") or "draft"))


def normalize_skill_status(status: str | None) -> str:
    """Mabel skills only use draft/published/archived — legacy review maps to published."""
    normalized = str(status or "draft").strip().lower()
    if normalized in {"approved", "published", "released", "active", "review", "pending", "proposed"}:
        return "published"
    if normalized == "archived":
        return "archived"
    if normalized == "draft":
        return "draft"
    return "published"


def _catalog_entry_launch_ready(status: str) -> bool:
    """Whether a catalog connector/skill row is approved for launch after status normalization."""

    return status == "published"


def _connector_slug(entry_id: str) -> str:
    return entry_id.removeprefix("connector.")


def _configured_local_slugs(settings: MabelSettings | None) -> set[str]:
    if settings is None:
        return set()
    try:
        return set(LocalMcpRegistry.from_settings(settings).endpoints.keys())
    except ValueError:
        return set()


def _remote_gateway_configured(settings: MabelSettings | None) -> bool:
    return bool(
        settings
        and (
            (settings.mcp_gateway_proxy_base_url and settings.remote_gateway_runtime_token)
            or (settings.remote_gateway_api_base_url and settings.remote_gateway_runtime_token)
        )
    )


def connector_snapshots_for_slug(store: MabelStore, server_slug: str) -> list[ConnectorSnapshot]:
    """All store rows that resolve to the same canonical connector slug."""

    from .mcp.manager import canonical_connector_slug

    canonical = canonical_connector_slug(server_slug)
    return [row for row in store.list_connectors() if canonical_connector_slug(row.server_slug) == canonical]


def resolve_connector_snapshot(store: MabelStore, server_slug: str) -> ConnectorSnapshot | None:
    """Best connector row for a slug, using the same dedupe rules as bootstrap/UI."""

    rows = connector_snapshots_for_slug(store, server_slug)
    if not rows:
        return None
    deduped = _dedupe_connector_snapshots(rows)
    return deduped[0] if deduped else None


def connector_is_enabled(store: MabelStore, server_slug: str) -> bool:
    snapshot = resolve_connector_snapshot(store, server_slug)
    return False if snapshot and snapshot.enabled is False else True


def set_all_connector_enabled(store: MabelStore, server_slug: str, enabled: bool) -> ConnectorSnapshot | None:
    """Toggle enabled on every alias row so UI and MCP routes stay in sync."""

    from .mcp.manager import canonical_connector_slug

    updated: ConnectorSnapshot | None = None
    for row in connector_snapshots_for_slug(store, server_slug):
        result = store.set_connector_enabled(row.server_slug, enabled)
        if result is not None:
            updated = result
    if updated is None:
        updated = store.set_connector_enabled(canonical_connector_slug(server_slug), enabled)
    return updated


def _skill_dependency_slugs(skill: Skill) -> set[str]:
    slugs: set[str] = set()
    for binding in skill.mcp_bindings or []:
        if not isinstance(binding, dict):
            continue
        raw = (
            binding.get("server_slug")
            or binding.get("connector_slug")
            or binding.get("server")
            or binding.get("connector")
            or binding.get("id")
        )
        if raw:
            slug = str(raw).removeprefix("connector.").strip().lower()
            slugs.add(CONNECTOR_SLUG_ALIASES.get(slug, slug))
    return slugs


def _connector_rank(row: ConnectorSnapshot) -> int:
    status_score = {
        "connected": 500,
        "local_package_available": 400,
        "remote_gateway_available": 300,
        "needs_validation": 200,
        "not_configured": 100,
    }.get(str(row.connection_status), 0)
    enabled_score = 10 if row.enabled is not False else 0
    tool_score = len(row.tools or [])
    return status_score + enabled_score + tool_score


def _connector_recency(row: ConnectorSnapshot) -> float:
    if row.refreshed_at is None:
        return 0.0
    return row.refreshed_at.timestamp()


def _dedupe_connector_snapshots(rows: list[ConnectorSnapshot]) -> list[ConnectorSnapshot]:
    """Collapse duplicate server slugs (often from multiple org snapshots)."""
    by_slug: dict[str, ConnectorSnapshot] = {}
    for row in rows:
        raw_slug = str(row.server_slug).strip().lower()
        slug = CONNECTOR_SLUG_ALIASES.get(raw_slug, raw_slug)
        existing = by_slug.get(slug)
        if existing is None:
            by_slug[slug] = row
            continue
        rank_existing = _connector_rank(existing)
        rank_current = _connector_rank(row)
        if rank_current > rank_existing:
            by_slug[slug] = row
            continue
        if rank_current == rank_existing:
            existing_slug = str(existing.server_slug).strip().lower()
            current_slug = str(row.server_slug).strip().lower()
            if current_slug == slug and existing_slug != slug:
                by_slug[slug] = row
                continue
        if rank_current == rank_existing and _connector_recency(row) > _connector_recency(existing):
            by_slug[slug] = row
    return sorted(by_slug.values(), key=lambda item: item.name.lower())


def launch_ready_connector_snapshots(store: MabelStore) -> list[ConnectorSnapshot]:
    rows = [
        row
        for row in store.list_connectors()
        if row.server_slug != "skills"
        and str(row.server_slug).lower() not in CONNECTOR_UI_EXCLUDE_SLUGS
        and row.enabled is not False
        and (
            row.connection_status == "connected"
            or row.connection_status == "local_package_available"
            or (row.connection_status == "remote_gateway_available" and len(row.tools or []) > 0)
        )
    ]
    return _dedupe_connector_snapshots(rows)


def launch_visible_connector_snapshots(store: MabelStore) -> list[ConnectorSnapshot]:
    rows = [
        row
        for row in store.list_connectors()
        if row.server_slug != "skills"
        and str(row.server_slug).lower() not in CONNECTOR_UI_EXCLUDE_SLUGS
        and row.connection_status in CONNECTOR_UI_LISTING_STATUSES
    ]
    return _dedupe_connector_snapshots(rows)


def launch_visible_starter_packs(
    store: MabelStore,
    *,
    viewer_email: str | None,
) -> list[StarterPack]:
    viewer = _normalized_email(viewer_email)
    demo_packs: list[StarterPack] = []
    custom_packs: list[StarterPack] = []
    for pack in store.list_starter_packs():
        policies = pack.policies if isinstance(pack.policies, dict) else {}
        demo_viewers = policies.get("demo_viewers")
        if isinstance(demo_viewers, list) and demo_viewers:
            allowed = {_normalized_email(str(email)) for email in demo_viewers}
            if viewer and viewer in allowed:
                demo_packs.append(pack)
            continue
        if pack.id.startswith("workflow-pack.custom") and _normalized_email(pack.owner_team) == viewer:
            custom_packs.append(pack)
        elif not pack.id.startswith("workflow-pack.custom"):
            demo_packs.append(pack)
    return sorted([*demo_packs, *custom_packs], key=lambda row: row.name)


def starter_pack_bootstrap_skill_ids(pack: StarterPack, ready_skill_ids: set[str]) -> list[str]:
    policies = pack.policies if isinstance(pack.policies, dict) else {}
    if policies.get("demo_mode"):
        demo_ids = [str(skill_id) for skill_id in (policies.get("demo_skill_ids") or pack.skill_ids or [])]
        return demo_ids
    return [skill_id for skill_id in pack.skill_ids if skill_id in ready_skill_ids]


def starter_pack_bootstrap_connector_slugs(pack: StarterPack, ready_connector_slugs: set[str]) -> list[str]:
    policies = pack.policies if isinstance(pack.policies, dict) else {}
    demo_skill_ids = {str(skill_id) for skill_id in (policies.get("demo_skill_ids") or [])}
    skill_ids = {str(skill_id) for skill_id in pack.skill_ids}
    excluded_slugs = demo_skill_ids | skill_ids | {"product-usage"}
    if policies.get("demo_mode"):
        return [slug for slug in pack.connector_slugs if slug not in excluded_slugs]
    return [slug for slug in pack.connector_slugs if slug in ready_connector_slugs]


def skill_missing_connector_slugs(skill: Skill, ready_connector_slugs: set[str]) -> list[str]:
    return sorted(slug for slug in _skill_dependency_slugs(skill) if slug not in ready_connector_slugs)


def skill_is_launch_ready(skill: Skill, ready_connector_slugs: set[str]) -> bool:
    if skill.status == "archived":
        return False
    return not skill_missing_connector_slugs(skill, ready_connector_slugs)


def _normalized_email(value: str | None) -> str:
    return str(value or "").strip().lower()


PLACEHOLDER_SKILL_OWNER_VALUES = frozenset(
    {
        "",
        "mabel",
        "mabel-user",
        "shared",
        "unknown",
        "unknown-default",
    }
)


class SkillOwnerAssignmentError(ValueError):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


def is_privileged_skill_actor(*, is_mabel_approver: bool = False, is_mabel_admin: bool = False) -> bool:
    return is_mabel_approver or is_mabel_admin


def _is_placeholder_skill_owner(owner_team: str | None) -> bool:
    normalized = _normalized_email(owner_team)
    if not normalized:
        return True
    return normalized in PLACEHOLDER_SKILL_OWNER_VALUES


def resolve_skill_owner_team(
    owner_team: str | None,
    *,
    requester_email: str,
    requester_is_privileged: bool,
) -> str:
    requester = _normalized_email(requester_email)
    if not requester:
        raise SkillOwnerAssignmentError("requester email is required")

    if _is_placeholder_skill_owner(owner_team):
        return requester

    candidate = _normalized_email(owner_team)
    if not requester_is_privileged and candidate != requester:
        raise SkillOwnerAssignmentError(
            "owner_team must match the authenticated user unless you are a Mabel approver or admin"
        )
    return candidate


def skill_create_conflict_detail(existing: Skill, *, requested_id: str, requested_owner_team: str) -> dict[str, str]:
    same_owner = _normalized_email(existing.owner_team) == _normalized_email(requested_owner_team)
    if same_owner and existing.status in {"draft", "review", "published"}:
        message = (
            f"Skill '{requested_id}' already exists for this owner with status '{existing.status}'. "
            f"Use PATCH /api/v1/skills/{requested_id} to update the existing draft instead of creating a new one."
        )
    else:
        message = (
            f"A skill with id '{requested_id}' already exists (owner={existing.owner_team}, status={existing.status}). "
            "Choose a different id or update the existing skill with PATCH."
        )
    return {
        "message": message,
        "skill_id": requested_id,
        "existing_owner_team": existing.owner_team,
        "existing_status": existing.status,
        "requested_owner_team": requested_owner_team,
    }


CUSTOM_SKILL_SOURCE_TYPES = frozenset(
    {
        "chat_created",
        "database_draft",
        "github",
        "custom",
    }
)

VALID_SKILL_SHARE_VISIBILITIES = frozenset({"private", "team", "org", "public"})


def _email_domain(value: str | None) -> str:
    normalized = _normalized_email(value)
    if "@" not in normalized:
        return ""
    return normalized.rsplit("@", 1)[-1]


def _skill_share_metadata(skill: Skill) -> dict[str, Any]:
    source = skill.source if isinstance(skill.source, dict) else {}
    share = source.get("share")
    return share if isinstance(share, dict) else {}


def _skill_share_visibility(skill: Skill) -> str | None:
    share = _skill_share_metadata(skill)
    raw = share.get("visibility")
    if raw is None:
        source = skill.source if isinstance(skill.source, dict) else {}
        raw = source.get("visibility")
    if raw is None:
        return None
    visibility = str(raw).strip().lower()
    if visibility not in VALID_SKILL_SHARE_VISIBILITIES:
        return None
    return visibility


def _skill_share_actor_email(skill: Skill) -> str:
    share = _skill_share_metadata(skill)
    shared_by = _normalized_email(str(share.get("shared_by") or ""))
    if shared_by and "@" in shared_by:
        return shared_by
    source = skill.source if isinstance(skill.source, dict) else {}
    owner = source.get("owner") if isinstance(source.get("owner"), dict) else {}
    contact = _normalized_email(str(owner.get("contact") or ""))
    if contact and "@" in contact:
        return contact
    return ""


def _skill_visibility_owner_email(skill: Skill) -> str:
    owner = _custom_skill_owner_email(skill)
    if owner and "@" in owner and not _is_placeholder_skill_owner(owner):
        return owner
    actor = _skill_share_actor_email(skill)
    if actor:
        return actor
    return owner


def _skill_explicitly_shared_with_viewer(skill: Skill, *, viewer_email: str | None) -> bool:
    visibility = _skill_share_visibility(skill)
    if not visibility:
        return False
    if visibility == "public":
        return bool(_normalized_email(viewer_email))
    if visibility in {"org", "team"}:
        viewer_domain = _email_domain(viewer_email)
        owner_domain = _email_domain(_skill_visibility_owner_email(skill))
        return bool(viewer_domain and owner_domain and viewer_domain == owner_domain)
    return False


def skill_visibility_kwargs_from_identity(user_identity: dict[str, Any] | None) -> dict[str, Any]:
    email = _normalized_email(str((user_identity or {}).get("email") or ""))
    raw_groups = (user_identity or {}).get("groups") or []
    if isinstance(raw_groups, str):
        groups = [group.strip() for group in raw_groups.split(",") if group.strip()]
    elif isinstance(raw_groups, list):
        groups = [str(group).strip() for group in raw_groups if str(group).strip()]
    else:
        groups = []
    is_admin = "mabel-admins" in groups
    return {
        "viewer_email": email or None,
        "viewer_is_approver": "mabel-approvers" in groups,
        "viewer_is_admin": is_admin,
    }


def _custom_skill_source_type(skill: Skill) -> str:
    source = skill.source if isinstance(skill.source, dict) else {}
    return str(source.get("type") or "").strip().lower()


def _custom_skill_owner_email(skill: Skill) -> str:
    return _normalized_email(skill.owner_team)


def mabel_skill_is_visible(
    skill: Skill,
    *,
    viewer_email: str | None = None,
    viewer_is_approver: bool = False,
    viewer_is_admin: bool = False,
) -> bool:
    if skill.id in CURATED_MABEL_SKILL_IDS:
        return True

    source_type = _custom_skill_source_type(skill)
    if source_type not in CUSTOM_SKILL_SOURCE_TYPES:
        return False

    if is_privileged_skill_actor(is_mabel_approver=viewer_is_approver, is_mabel_admin=viewer_is_admin):
        return True

    viewer = _normalized_email(viewer_email)
    owner = _custom_skill_owner_email(skill)
    if viewer and owner and viewer == owner:
        return True

    return _skill_explicitly_shared_with_viewer(skill, viewer_email=viewer_email)


def mabel_visible_skills(
    skills: list[Skill],
    *,
    viewer_email: str | None = None,
    viewer_is_approver: bool = False,
    viewer_is_admin: bool = False,
) -> list[Skill]:
    rows = [
        skill
        for skill in skills
        if mabel_skill_is_visible(
            skill,
            viewer_email=viewer_email,
            viewer_is_approver=viewer_is_approver,
            viewer_is_admin=viewer_is_admin,
        )
    ]
    seen: set[str] = set()
    deduped: list[Skill] = []
    for skill in rows:
        if skill.id in seen:
            continue
        seen.add(skill.id)
        deduped.append(skill)
    return sorted(
        deduped,
        key=lambda skill: (CURATED_MABEL_SKILL_ORDER.get(skill.id, 999), skill.name.lower()),
    )


def mabel_visible_skill_search_results(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    strong = [row for row in rows if float(row.get("score") or 0.0) >= 3.0 or row.get("matched_fields") != ["content"]]
    return strong or rows


def launch_ready_skills(
    store: MabelStore,
    *,
    ready_connector_slugs: set[str] | None = None,
) -> list[Skill]:
    ready_slugs = ready_connector_slugs or {row.server_slug for row in launch_ready_connector_snapshots(store)}
    return mabel_visible_skills([skill for skill in store.list_skills() if skill_is_launch_ready(skill, ready_slugs)])


def skill_description(skill: Skill) -> str:
    contract = skill.source.get("skill_contract") if isinstance(skill.source, dict) else None
    if isinstance(contract, dict) and contract.get("purpose"):
        return str(contract["purpose"])
    source_description = skill.source.get("description") if isinstance(skill.source, dict) else None
    if source_description:
        return str(source_description)
    for line in skill.content_md.splitlines():
        stripped = line.strip()
        if (
            stripped
            and stripped != "---"
            and not stripped.startswith("#")
            and not stripped.startswith("name:")
            and not stripped.startswith("description:")
        ):
            return stripped
    return "Mabel skill instruction package."


def _tokenize(text: str) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9]+", text.lower()) if token]


def _excerpt_with_query(content_md: str, tokens: list[str], *, max_chars: int = 240) -> str:
    text = " ".join(line.strip() for line in content_md.splitlines() if line.strip())
    if not text:
        return ""
    if not tokens:
        return text[:max_chars]
    lowered = text.lower()
    anchor = -1
    for token in tokens:
        idx = lowered.find(token)
        if idx >= 0 and (anchor < 0 or idx < anchor):
            anchor = idx
    if anchor < 0:
        return text[:max_chars]
    start = max(0, anchor - 80)
    end = min(len(text), anchor + max_chars)
    excerpt = text[start:end].strip()
    if start > 0:
        excerpt = "..." + excerpt
    if end < len(text):
        excerpt = excerpt + "..."
    return excerpt


def search_skills_ranked(skills: list[Skill], query: str, *, limit: int = 12) -> list[dict[str, Any]]:
    needle = query.strip().lower()
    tokens = _tokenize(needle)
    if not needle:
        rows = sorted(skills, key=lambda row: row.name)[: max(1, limit)]
        return [
            {"skill": row, "score": 0.0, "matched_fields": [], "snippet": _excerpt_with_query(row.content_md, [])}
            for row in rows
        ]

    ranked: list[dict[str, Any]] = []
    for skill in skills:
        title = skill.name.lower()
        skill_id = skill.id.lower()
        owner = skill.owner_team.lower()
        tags = [tag.lower() for tag in skill.tags]
        description = skill_description(skill).lower()
        content = skill.content_md.lower()

        score = 0.0
        matched_fields: set[str] = set()
        if needle in skill_id:
            score += 7.0
            matched_fields.add("id")
        if needle in title:
            score += 6.0
            matched_fields.add("name")
        if needle in owner:
            score += 3.0
            matched_fields.add("owner_team")
        if any(needle in tag for tag in tags):
            score += 4.0
            matched_fields.add("tags")
        if needle in description:
            score += 3.5
            matched_fields.add("description")
        if needle in content:
            score += 2.0
            matched_fields.add("content")

        for token in tokens:
            if token in title:
                score += 1.4
                matched_fields.add("name")
            if token in skill_id:
                score += 1.2
                matched_fields.add("id")
            if token in owner:
                score += 0.7
                matched_fields.add("owner_team")
            if any(token in tag for tag in tags):
                score += 0.9
                matched_fields.add("tags")
            if token in description:
                score += 0.8
                matched_fields.add("description")
            if token in content:
                score += 0.3
                matched_fields.add("content")

        if score <= 0:
            continue
        ranked.append(
            {
                "skill": skill,
                "score": round(score, 3),
                "matched_fields": sorted(matched_fields),
                "snippet": _excerpt_with_query(skill.content_md, tokens),
            }
        )

    ranked.sort(key=lambda row: (-float(row["score"]), str(row["skill"].name).lower()))
    return ranked[: max(1, limit)]


def _connector_status(payload: dict[str, Any], settings: MabelSettings | None = None) -> str:
    status = _entry_status(payload)
    entry_id = str(payload.get("id") or "")
    slug = _connector_slug(entry_id)
    if slug in _configured_local_slugs(settings):
        return "connected"
    mcp = payload.get("mcp") if isinstance(payload.get("mcp"), dict) else {}
    transport = str(mcp.get("transport") or "")
    if transport == "stdio":
        return "local_package_available" if _catalog_entry_launch_ready(status) else "needs_validation"
    endpoint = str(mcp.get("endpoint") or "")
    if "${" in endpoint or "placeholder" in endpoint or ".invalid" in endpoint:
        return "not_configured"
    return "connected" if _catalog_entry_launch_ready(status) else "needs_validation"


def _connector_display_name(slug: str, raw_name: str) -> str:
    simple_names = {
        "google-analytics-mcp": "Google Analytics",
    }
    if slug in simple_names:
        return simple_names[slug]
    cleaned = raw_name.strip()
    legacy_exact = {
        "Google Analytics MCP": "Google Analytics",
    }
    if cleaned in legacy_exact:
        return legacy_exact[cleaned]
    for suffix in (
        " Hosted MCP (Draft Read Foundation)",
        " (RAG Studio) Hosted MCP (Draft Read Foundation)",
        " Connector",
        " V2 Connector",
    ):
        cleaned = cleaned.replace(suffix, "")
    return cleaned or slug


def bootstrap_connector_label(server_slug: str, stored_name: str) -> str:
    """Stable `name` for /api/v1/bootstrap connectors (handles stale DB labels)."""
    return _connector_display_name(str(server_slug).lower().strip(), str(stored_name))


def bootstrap_connection_status(row: ConnectorSnapshot) -> str:
    """Normalize stale statuses for configured local connectors."""
    status = str(row.connection_status or "")
    slug = str(row.server_slug or "").lower().strip()
    if (
        status == "not_configured"
        and slug in INTERNAL_LOCAL_CONNECTOR_SLUGS
        and row.enabled is not False
        and len(row.tools or []) > 0
    ):
        return "connected"
    return status


def _seed_catalog_connectors(store: MabelStore, settings: MabelSettings | None = None) -> None:
    catalog_dir = repo_root() / "packages" / "catalog"
    index = _read_json(catalog_dir / "catalog.index.json") or {}
    entries = index.get("entries") if isinstance(index.get("entries"), list) else []
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("type") != "connector":
            continue
        path = catalog_dir / str(entry.get("path") or "")
        payload = _read_json(path)
        if not payload:
            continue
        entry_id = str(payload.get("id") or entry.get("id") or "")
        if not entry_id:
            continue
        status = _entry_status(payload)
        connection_status = _connector_status(payload, settings)
        launch_enabled = connection_status in {"connected", "remote_gateway_available", "local_package_available"} and _catalog_entry_launch_ready(status)
        store.upsert_connector_snapshot(
            ConnectorSnapshot(
                org_slug="catalog",
                server_slug=_connector_slug(entry_id),
                name=_connector_display_name(_connector_slug(entry_id), str(payload.get("name") or entry_id)),
                connection_status=connection_status,
                tools=[],
                enabled=launch_enabled,
                last_error=None if _catalog_entry_launch_ready(status) else f"catalog status: {status}",
            )
        )

    # Common Remote Gateway vendor slugs used by the Mabel UI and starter packs.
    vendor_status = "remote_gateway_available" if _remote_gateway_configured(settings) else "not_configured"
    configured_local_slugs = _configured_local_slugs(settings)
    connector_index = {row.server_slug: row for row in store.list_connectors()}
    for slug, name in {
        "asana": "Asana",
        "atlassian": "Atlassian",
        "datadog": "Datadog",
        "figma": "Figma",
        "github": "GitHub",
        "google-docs": "Google Docs",
        "salesforce": "Salesforce",
        "google-drive": "Google Drive",
        "google-sheets": "Google Sheets",
        "google-slides": "Google Slides",
        "microsoft-teams": "Microsoft Teams",
        "outlook-calendar": "Outlook Calendar",
        "outlook-email": "Outlook Email",
        "sharepoint": "SharePoint",
        "slack": "Slack",
        "skills": "SKILLS Registry",
    }.items():
        existing = connector_index.get(slug)
        if existing is None:
            connection_status = "connected" if slug in configured_local_slugs else vendor_status
            store.upsert_connector_snapshot(
                ConnectorSnapshot(
                    org_slug="catalog",
                    server_slug=slug,
                    name=name,
                    connection_status=connection_status,
                    tools=[],
                    enabled=connection_status in {"connected", "remote_gateway_available"},
                )
            )


def _manifest_to_skill(path: Path) -> Skill | None:
    payload = _read_json(path)
    if not payload:
        return None
    skill_id = str(payload.get("id") or "")
    if not skill_id:
        return None
    owner = payload.get("owner") if isinstance(payload.get("owner"), dict) else {}
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    content_path = path.parent / str(payload.get("entrypoints", {}).get("instruction_file") or "SKILL.md")
    if not content_path.exists():
        content_path = path.parent / str(payload.get("docs_path") or "README.md")
    try:
        content = content_path.read_text(encoding="utf-8")
    except Exception:
        content = f"# {payload.get('name') or skill_id}\n\nCatalog-backed skill package."
    dependencies = [str(item) for item in payload.get("dependencies", []) if str(item).startswith("connector.")]
    return Skill(
        id=skill_id,
        name=str(payload.get("name") or skill_id),
        owner_team=str(owner.get("primary_team") or (owner.get("teams") or ["mabel"])[0]),
        status=_entry_status(payload),
        current_version=str(payload.get("version") or "0.1.0"),
        content_md=content,
        tags=[str(tag) for tag in payload.get("tags", [])],
        mcp_bindings=[
            {"server_slug": dep.removeprefix("connector."), "tools": []}
            for dep in dependencies
        ],
        source={
            "type": source.get("type") or "local_package",
            "repo": source.get("repo"),
            "path": source.get("path") or str(path.parent.relative_to(repo_root())),
            "ref": source.get("ref"),
            "visibility": payload.get("visibility"),
            "supported_hosts": payload.get("supported_hosts") if isinstance(payload.get("supported_hosts"), list) else [],
            "skill_contract": payload.get("skill_contract") if isinstance(payload.get("skill_contract"), dict) else {},
        },
    )


def _package_skill_needs_update(existing: Skill, skill: Skill) -> bool:
    return (
        existing.name != skill.name
        or existing.owner_team != skill.owner_team
        or existing.status != skill.status
        or existing.current_version != skill.current_version
        or existing.content_md != skill.content_md
        or existing.tags != skill.tags
        or existing.mcp_bindings != skill.mcp_bindings
        or existing.source != skill.source
    )


def _seed_package_skills(store: MabelStore) -> None:
    skills_dir = repo_root() / "packages" / "skills"
    for manifest_path in sorted(skills_dir.glob("*/manifest.json")):
        skill = _manifest_to_skill(manifest_path)
        if not skill:
            continue
        existing = store.get_skill(skill.id)
        if existing is None:
            store.create_skill(skill)
            continue
        if existing.source.get("type") == "database_draft":
            continue
        if not _package_skill_needs_update(existing, skill):
            continue
        skill.created_at = existing.created_at
        store.update_skill(skill)


def _seed_workflow_packs(store: MabelStore) -> None:
    engine_policies = {
        "controlled_actions": ["create", "update", "delete", "admin"],
        "orchestration_mode": "agent_loop",
        "runtime": {
            "uses_chat_runtime": True,
            "supports_multiple_skills": True,
            "supports_multiple_connectors": True,
            "supports_resume": True,
        },
        "schedule": {
            "type": "manual",
            "cadence": None,
            "description": "Runs when a user starts the workflow from Mabel.",
            "unattended_until_approval": False,
        },
    }
    start_my_day_policies = {
        **engine_policies,
        "demo_mode": True,
        "demo_viewers": [],
        "demo_skill_ids": ["skill.start-my-day", "skill.product-usage"],
        "skill_display_names": {
            "skill.start-my-day": "Meeting prep briefing",
            "skill.product-usage": "Product usage summaries",
        },
        "schedule": {
            "type": "recurring",
            "cadence": "daily",
            "description": "Runs each morning to prepare customer meeting briefs.",
            "unattended_until_approval": True,
        },
    }
    store.ensure_starter_pack(
        StarterPack(
            id=START_MY_DAY_WORKFLOW_ID,
            name="Start My Day",
            owner_team="mabel",
            role_key="account-manager",
            status="approved",
            commands=[
                {"name": "/start-my-day", "description": "Load today's meetings and build customer briefs"},
            ],
            skill_ids=[],
            connector_slugs=[
                "outlook-calendar",
                "microsoft-teams",
                "salesforce",
            ],
            policies=start_my_day_policies,
        )
    )



def seed_builtin_catalog(store: MabelStore, settings: MabelSettings | None = None) -> None:
    _seed_catalog_connectors(store, settings)
    _seed_package_skills(store)
    _seed_workflow_packs(store)
