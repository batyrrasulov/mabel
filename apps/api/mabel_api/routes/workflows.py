from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..auth import resolve_mabel_user
from ..catalog import (
    START_MY_DAY_WORKFLOW_ID,
    launch_ready_connector_snapshots,
    launch_ready_skills,
    search_skills_ranked,
    seed_builtin_catalog,
)
from ..db import get_store
from ..models import AgentRun, Conversation, Message, StarterPack, ToolCall, utcnow
from ..schemas import StarterPackMeeting, StarterPackSignal, WorkflowCreateRequest, WorkflowRunRequest
from ..telemetry import record_request_usage

router = APIRouter(prefix="/api/v1/workflows", tags=["workflows"])

CONTROLLED_ACTION_MARKERS = (
    "admin",
    "approve",
    "create",
    "delete",
    "post",
    "publish",
    "send",
    "submit",
    "update",
    "write",
)


def _workflow_slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.strip().lower()).strip("-")
    return slug or "custom"


def _skill_connector_slugs(skill) -> list[str]:
    slugs: list[str] = []
    for binding in skill.mcp_bindings or []:
        if not isinstance(binding, dict):
            continue
        raw = (
            binding.get("server_slug")
            or binding.get("connector_slug")
            or binding.get("server")
            or binding.get("connector")
        )
        if raw:
            slugs.append(str(raw).removeprefix("connector."))
    return slugs


def _dedupe(values: list[str]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
            continue
        output.append(cleaned)
        seen.add(cleaned)
    return output


def _infer_schedule(objective: str) -> dict[str, Any]:
    normalized = objective.lower()
    recurring_markers = ("every morning", "each morning", "daily", "start my day", "start-my-day")
    if any(marker in normalized for marker in recurring_markers):
        return {
            "type": "recurring",
            "cadence": "daily",
            "description": "Designed for a daily start-my-day loop with approval gates before controlled actions.",
            "unattended_until_approval": True,
        }
    return {
        "type": "manual",
        "cadence": None,
        "description": "Runs when a user starts the workflow from Mabel.",
        "unattended_until_approval": False,
    }


def _workflow_policies(objective: str) -> dict[str, Any]:
    return {
        "controlled_actions": ["create", "update", "delete", "admin"],
        "orchestration_mode": "agent_loop",
        "runtime": {
            "uses_chat_runtime": True,
            "supports_multiple_skills": True,
            "supports_multiple_connectors": True,
            "supports_resume": True,
        },
        "schedule": _infer_schedule(objective),
    }


def _command_label(command: dict[str, Any], index: int) -> str:
    raw = command.get("name") or command.get("description") or f"workflow-step-{index}"
    return str(raw).strip() or f"workflow-step-{index}"


def _requires_controlled_action(objective: str, commands: list[dict[str, Any]]) -> bool:
    searchable = " ".join(
        [
            objective,
            *[
                " ".join(str(command.get(key) or "") for key in ("name", "description"))
                for command in commands
                if isinstance(command, dict)
            ],
        ]
    ).lower()
    return any(re.search(rf"\b{re.escape(marker)}\b", searchable) for marker in CONTROLLED_ACTION_MARKERS)


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_demo_workflow(starter_pack: StarterPack) -> bool:
    policies = starter_pack.policies if isinstance(starter_pack.policies, dict) else {}
    return bool(policies.get("demo_mode"))


def _demo_connector_label(slug: str) -> str:
    return {
        "outlook-calendar": "Outlook Calendar",
        "microsoft-teams": "Microsoft Teams",
        "salesforce": "Salesforce",
    }.get(slug, slug)


def _demo_skill_label(skill_id: str, policies: dict[str, Any]) -> str:
    display_names = policies.get("skill_display_names")
    if isinstance(display_names, dict) and skill_id in display_names:
        return str(display_names[skill_id])
    return skill_id


def _demo_skill_events(demo_skill_ids: list[str], policies: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for skill_id in demo_skill_ids:
        label = _demo_skill_label(skill_id, policies)
        events.append(
            {
                "type": "skill.resolved",
                "status": "completed",
                "timestamp": _utc_timestamp(),
                "message": f"Resolved {label} skill.",
            }
        )
    return events


def _demo_connector_events(connector_slugs: list[str]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for slug in connector_slugs:
        label = _demo_connector_label(slug)
        events.append(
            {
                "type": "connector.demo",
                "status": "completed",
                "timestamp": _utc_timestamp(),
                "message": f"Loaded {label} context.",
            }
        )
    return events


def _demo_start_my_day_meetings() -> list[StarterPackMeeting]:
    return [
        StarterPackMeeting(
            time="9:30 AM",
            account_name="Northstar Health",
            attendees=["Jordan Lee", "Maya Patel"],
            signals=[
                StarterPackSignal(
                    source="Outlook Calendar",
                    text="Quarterly success review at 9:30 AM with the customer operations team.",
                ),
                StarterPackSignal(
                    source="Salesforce",
                    text="Renewal is due in 63 days; expansion discovery is open for two additional locations.",
                ),
                StarterPackSignal(
                    source="Product usage",
                    text="Voice usage increased 28% in the last 30 days while messaging adoption remains flat.",
                ),
                StarterPackSignal(
                    source="Microsoft Teams",
                    text="Last meeting notes flagged reporting visibility as the main adoption blocker.",
                ),
            ],
        ),
        StarterPackMeeting(
            time="2:00 PM",
            account_name="BrightBridge Logistics",
            attendees=["Alex Morgan", "Sam Rivera"],
            signals=[
                StarterPackSignal(
                    source="Outlook Calendar",
                    text="Executive renewal checkpoint at 2:00 PM.",
                ),
                StarterPackSignal(
                    source="Salesforce",
                    text="Opportunity stage is negotiation with a target close this quarter.",
                ),
                StarterPackSignal(
                    source="Product usage",
                    text="Contact-center seats fell 14% week over week after a regional team change.",
                ),
                StarterPackSignal(
                    source="Microsoft Teams",
                    text="The account team wants a recovery plan before discussing commercial terms.",
                ),
            ],
        ),
    ]


def _build_execution_plan(
    starter_pack: StarterPack,
    objective: str,
    dry_run: bool,
    missing_connectors: list[str],
    missing_skills: list[str],
) -> dict[str, Any]:
    schedule = dict(starter_pack.policies.get("schedule") or _infer_schedule(objective))
    commands = [command for command in starter_pack.commands if isinstance(command, dict)] or [
        {"name": "execute-objective", "description": objective}
    ]
    blocked = bool(missing_connectors or missing_skills)
    approval_required = _requires_controlled_action(objective, commands)
    steps: list[dict[str, Any]] = []
    for index, command in enumerate(commands, start=1):
        label = _command_label(command, index)
        steps.append(
            {
                "id": f"step-{index}",
                "title": label.removeprefix("/").replace("-", " ").strip().title() or f"Step {index}",
                "command": label,
                "objective": command.get("description") or objective,
                "status": "blocked" if blocked else ("planned" if dry_run else "running"),
                "skill_ids": starter_pack.skill_ids,
                "connector_slugs": starter_pack.connector_slugs,
                "uses_chat_runtime": True,
                "approval_gate": {
                    "required_for_scopes": starter_pack.policies.get("controlled_actions", []),
                    "status": "required" if approval_required else "not_required",
                },
                "retry_policy": {"max_attempts": 2, "fallback": "return to chat with blocker summary"},
            }
        )
    return {
        "mode": starter_pack.policies.get("orchestration_mode", "agent_loop"),
        "objective": objective,
        "schedule": schedule,
        "steps": steps,
        "fallback_paths": [
            "If a connector is unavailable, stop at the affected step and report the missing connector.",
            "If controlled action approval is missing, pause at the checkpoint instead of executing the action.",
        ],
        "observability": {
            "step_logs": True,
            "run_resume": True,
            "checkpoint_visibility": True,
        },
        "approval_required": approval_required,
    }


def _execute_execution_plan(
    plan: dict[str, Any],
    outputs: dict[str, Any],
    dry_run: bool,
    blocked: bool,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    step_results: list[dict[str, Any]] = []
    if dry_run or blocked:
        return events

    for step in plan.get("steps") or []:
        if not isinstance(step, dict) or step.get("status") == "blocked":
            continue
        events.append(
            {
                "type": "workflow.step.started",
                "status": "running",
                "timestamp": _utc_timestamp(),
                "message": f"Started {step.get('title') or step.get('id') or 'workflow step'}.",
            }
        )
        command = str(step.get("command") or "workflow-step")
        if outputs.get("briefs"):
            result_summary = f"Generated {len(outputs['briefs'])} draft brief(s)."
        else:
            matching_action = next(
                (
                    action
                    for action in outputs.get("draft_actions", [])
                    if isinstance(action, dict) and action.get("command") == command
                ),
                None,
            )
            result_summary = (
                str(matching_action.get("description"))
                if matching_action and matching_action.get("description")
                else "Executed workflow command and produced a draft output."
            )
        step["status"] = "completed"
        step["result"] = {"status": "completed", "summary": result_summary}
        step_results.append(
            {
                "step_id": step.get("id"),
                "command": command,
                "status": "completed",
                "summary": result_summary,
            }
        )
        events.append(
            {
                "type": "workflow.step.completed",
                "status": "completed",
                "timestamp": _utc_timestamp(),
                "message": f"Completed {step.get('title') or step.get('id') or 'workflow step'}: {result_summary}",
            }
        )
    outputs["step_results"] = step_results
    return events


def _pause_execution_plan_for_approval(plan: dict[str, Any], outputs: dict[str, Any]) -> None:
    step_results: list[dict[str, Any]] = []
    for step in plan.get("steps") or []:
        if not isinstance(step, dict) or step.get("status") == "blocked":
            continue
        step["status"] = "waiting_approval"
        step["result"] = {
            "status": "waiting_approval",
            "summary": "Approval required before controlled actions execute.",
        }
        step_results.append(
            {
                "step_id": step.get("id"),
                "command": step.get("command"),
                "status": "waiting_approval",
                "summary": "Approval required before controlled actions execute.",
            }
        )
    outputs["step_results"] = step_results


def _workflow_observability(run_id: str, plan: dict[str, Any], status: str, step_events: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "status": status,
        "events": [
            {
                "type": "workflow.run.created",
                "status": status,
                "timestamp": _utc_timestamp(),
                "message": "Workflow run record created.",
            },
            {
                "type": "workflow.plan.ready",
                "status": "completed",
                "timestamp": _utc_timestamp(),
                "message": f"Prepared {len(plan.get('steps') or [])} orchestrated step(s).",
            },
            *step_events,
        ],
        "live_logs_available": True,
    }


def _workflow_next_actions(starter_pack: StarterPack, run_id: str) -> list[dict[str, Any]]:
    return [
        {
            "kind": "open_chat",
            "label": "Continue",
            "prompt": (
                f'Continue from saved Mabel workflow run {run_id} for starter pack "{starter_pack.name}" ({starter_pack.id}). '
                "Load the starter pack and required skills so you have the workflow context, then review the completed "
                "workflow outputs from this run. Do not start a new workflow run unless the user asks; pause before controlled actions."
            ),
        },
        {
            "kind": "resume_run",
            "label": "Resume workflow run",
            "run_id": run_id,
        },
    ]


def _signals_by_source(meeting: StarterPackMeeting) -> dict[str, str]:
    by_source: dict[str, str] = {}
    for signal in meeting.signals:
        by_source[signal.source] = signal.text
    return by_source


def _bullets(*items: str) -> str:
    return "\n".join(f"- {item.strip()}" for item in items if item and item.strip())


def _brief_sections_for_meeting(meeting: StarterPackMeeting, by_source: dict[str, str]) -> dict[str, str]:
    account = meeting.account_name.strip()
    sources = list(by_source.keys())
    source_line = ", ".join(sources) if sources else "Outlook Calendar, Salesforce, Product usage, Microsoft Teams"

    if account == "Northstar Health":
        return {
            "Account snapshot": _bullets(
                "Healthcare system — 14 clinics across greater Phoenix metro",
                "$892K ARR · renewal Mar 15, 2026 · health score 82 (stable)",
                "Primary contacts today: Jordan Lee (Dir. Patient Access), Maya Patel (IT Applications)",
                "Expansion opp in Discovery: 2 new locations (Mesa + Scottsdale)",
            ),
            "Why this meeting matters": _bullets(
                "Quarterly success review — Jordan owns patient access workflows; Maya owns rollout and integrations",
                "Phoenix and Tempe voice pilot went live Nov 2025; leadership wants the same playbook at Mesa and Scottsdale",
                "This is the first exec-level conversation about expansion since the pilot KPI review in December",
                "Renewal is 63 days out — expansion timing affects how we structure the renewal conversation",
            ),
            "What changed since last touch": _bullets(
                "Voice minutes +28% over 30 days; after-hours triage line at Phoenix up 41%",
                "Messaging adoption flat at 34% of entitled seats — no movement at Mesa or Scottsdale",
                "Salesforce expansion opp moved to Discovery on Jan 6 after Jordan's email to your AE",
                "Dec 18 support case (closed): reporting export timeout — Maya says admin dashboard still doesn't show location-level messaging usage",
                "Last QBR (Nov 28): Jordan committed to messaging pilot by end of Q1 if reporting gap is resolved",
            ),
            "Suggested talk track": _bullets(
                "Open with Phoenix/Tempe voice wins — cite the 41% after-hours triage lift with a specific week-over-week example",
                "Pivot to expansion: 'What's still blocking messaging rollout at Mesa and Scottsdale?'",
                "Reference Jordan's Nov 12 Teams note on reporting visibility — offer the admin dashboard walkthrough you prepped",
                "If expansion comes up: frame as phased rollout (Mesa first, Scottsdale 30 days later) rather than all-at-once",
                "Close by confirming who signs off on seat counts for the expansion opp before renewal paperwork starts",
            ),
            "Questions to ask": _bullets(
                "Which patient workflows still run on legacy phones at Mesa and Scottsdale?",
                "Is IT ready to pilot messaging for scheduling this quarter, or is reporting still the gate?",
                "Does Maya's team need hands-on help closing the location-level reporting gap?",
                "Who besides Jordan and Maya needs to approve expansion seat counts?",
                "What does Jordan need to see in Q1 to call the pilot a success at the new sites?",
            ),
            "Recommended next step": _bullets(
                "Draft a 2-location expansion one-pager: Mesa + Scottsdale seat counts, messaging pilot timeline, and reporting fix ETA",
                "Include Phoenix/Tempe usage chart (voice + messaging) as proof point — I'll pull from product usage export",
                "Hold draft for your review before sending — no customer-facing materials without your sign-off",
                "Optional: schedule 30-min technical session with Maya on admin dashboard reporting (propose Thu/Fri this week)",
            ),
            "Sources used": _bullets(
                "Outlook Calendar — 9:30 AM QSR invite and attendee list",
                "Salesforce — ARR, renewal date, expansion opp stage, last activity Jan 6",
                "Product usage — 30-day voice/messaging trends by clinic location",
                "Microsoft Teams — Nov 12 meeting notes from Jordan on reporting blocker",
            ),
            "Human verification needed": _bullets(
                "Confirm $892K ARR in Salesforce before quoting — last manual check was Jan 3",
                "Expansion list pricing and multi-year terms need your approval before the meeting",
                "Do not promise reporting fix ship date unless product confirmed in Slack #healthcare-am",
            ),
        }

    if account == "BrightBridge Logistics":
        return {
            "Account snapshot": _bullets(
                "Mid-market logistics — 8 regional hubs, ~1,200 contact center seats contracted",
                "$1.18M ARR · Negotiation stage · target close this quarter",
                "Primary contacts today: Alex Morgan (VP Ops), Sam Rivera (Director IT Infrastructure)",
                "Denver hub reorg on Jan 8 deprovisioned 42 seats — account team flagged as renewal risk",
            ),
            "Why this meeting matters": _bullets(
                "Executive renewal checkpoint — Alex won't discuss commercial terms without a Denver recovery plan",
                "Internal sync (Jan 14): AE noted Alex is 'cautiously optimistic' if we show a concrete 60-day path",
                "Sam owns routing and telephony config — his audit is the technical gate before commercial discussion",
                "Competitive pressure: Alex mentioned evaluating a competitor's routing bundle in the Jan 10 Teams note",
            ),
            "What changed since last touch": _bullets(
                "Active seats −14% week over week — Denver hub −42 seats since Jan 8 regional reorg",
                "Inbound handle time +12% on remaining Denver routes (capacity strain after deprovisioning)",
                "Salesforce opp still in Negotiation; close date unchanged but risk field updated to 'Medium' on Jan 12",
                "Central region absorbed Maria's team — ownership of contact center ops is unclear to the customer",
                "Last executive touch: Dec 20 call with Alex — focused on Denver transition, no pricing discussed",
            ),
            "Suggested talk track": _bullets(
                "Acknowledge Denver transition first — do not lead with price or renewal timeline",
                "Walk through 60-day recovery playbook: 3 similar logistics accounts regained 85–92% of seats post-reorg",
                "Offer no-cost Denver routing review the week of Feb 3 — Sam's team scopes, we execute",
                "If Alex asks on competitor: emphasize integrated voice + routing + analytics vs. bolt-on bundle",
                "Only discuss renewal economics after Alex confirms recovery timeline and Sam signs off on routing audit scope",
            ),
            "Questions to ask": _bullets(
                "When will Denver seat allocation finalize under the new regional structure?",
                "Who owns contact center ops now that Maria's team moved to Central?",
                "Is Sam's routing audit the gating item before commercial discussion — what's his timeline?",
                "Which Denver workflows drove the seat reduction — was it intentional rightsizing or routing fallout?",
                "What would Alex need to see by end of February to move renewal conversation forward?",
            ),
            "Recommended next step": _bullets(
                "Draft calendar invite for Denver routing technical review (Feb 3–5) — attendees: Sam, Denver ops lead, our solutions engineer",
                "Attach one-page recovery timeline template (60-day milestones) — hold for your sign-off before sending to Alex",
                "Internal: loop solutions engineering on Denver route audit scope before customer invite goes out",
                "After meeting: draft follow-up recap with agreed milestones — approval required before posting to Salesforce",
            ),
            "Sources used": _bullets(
                "Outlook Calendar — 2:00 PM renewal check-in invite",
                "Salesforce — ARR, Negotiation stage, seat count delta, risk field update Jan 12",
                "Product usage — 7-day seat and handle-time trends for Denver hub",
                "Microsoft Teams — Jan 10 note from Alex on routing audit before renewal numbers",
            ),
            "Human verification needed": _bullets(
                "Recovery playbook percentages (85–92%) are from internal benchmark doc — verify before citing in meeting",
                "Do not share renewal pricing, discount tiers, or term length until Alex confirms recovery timeline",
                "Competitor mention in Teams note is customer-sourced — do not name competitor unless Alex raises it first",
            ),
        }

    calendar = by_source.get("Outlook Calendar", "")
    salesforce = by_source.get("Salesforce", "")
    product = by_source.get("Product usage", "")
    teams = by_source.get("Microsoft Teams", "")
    what_changed_items = [item for item in [product, salesforce] if item]
    if not what_changed_items:
        what_changed_items = ["No major product or CRM changes flagged in connected sources."]

    return {
        "Account snapshot": _bullets(f"Customer meeting with {account}.", calendar or "Calendar context not available."),
        "Why this meeting matters": _bullets(calendar or f"Scheduled meeting with {account}."),
        "What changed since last touch": _bullets(*what_changed_items),
        "Suggested talk track": _bullets(
            f"Lead with verified context on {account}, then ask about current priorities.",
            teams or "Review Teams notes before the meeting.",
        ),
        "Questions to ask": _bullets(
            "What changed since our last touch?",
            "Which outcomes matter most before the next milestone?",
            "Who else should be involved in the next step?",
        ),
        "Recommended next step": _bullets("Draft follow-up actions for your review before sending or writing back."),
        "Sources used": _bullets(*sources) if sources else _bullets("No connected sources returned data."),
        "Human verification needed": _bullets(
            "Verify sourced claims and approve controlled actions before posting or updating systems.",
        ),
    }


def _brief_for_meeting(meeting: StarterPackMeeting) -> dict:
    by_source = _signals_by_source(meeting)
    sources = list(by_source.keys())
    sections = _brief_sections_for_meeting(meeting, by_source)
    return {
        "time": meeting.time,
        "account_name": meeting.account_name,
        "attendees": meeting.attendees,
        "sources_used": sources,
        "sections": sections,
    }


@router.post("")
def create_workflow(payload: WorkflowCreateRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    seed_builtin_catalog(store, settings)

    base_slug = _workflow_slug(payload.name)
    candidate = f"workflow-pack.custom-{base_slug}"
    existing_ids = {row.id for row in store.list_starter_packs()}
    suffix = 2
    while candidate in existing_ids:
        candidate = f"workflow-pack.custom-{base_slug}-{suffix}"
        suffix += 1

    role_key = (payload.role_key or f"custom-{base_slug}")[:80]
    objective = payload.objective.strip()
    ready_connectors = launch_ready_connector_snapshots(store)
    ready_connector_slugs = {row.server_slug for row in ready_connectors}
    ready_skills = launch_ready_skills(store)
    ready_skill_by_id = {row.id: row for row in ready_skills}

    selected_skill_ids = _dedupe([row for row in payload.skill_ids if row.strip()])
    if not selected_skill_ids:
        selected_skill_ids = [
            row["skill"].id
            for row in search_skills_ranked(ready_skills, objective, limit=4)
        ]

    selected_connectors = _dedupe([row for row in payload.connector_slugs if row.strip()])
    if not selected_connectors:
        connector_candidates: list[str] = []
        for skill_id in selected_skill_ids:
            skill = ready_skill_by_id.get(skill_id)
            if skill is None:
                continue
            connector_candidates.extend(_skill_connector_slugs(skill))
        objective_tokens = set(_workflow_slug(objective).split("-"))
        for connector in ready_connectors:
            if connector.server_slug in connector_candidates:
                continue
            name_tokens = set(_workflow_slug(connector.name).split("-"))
            slug_tokens = set(connector.server_slug.split("-"))
            if objective_tokens & (name_tokens | slug_tokens):
                connector_candidates.append(connector.server_slug)
        selected_connectors = _dedupe([slug for slug in connector_candidates if slug in ready_connector_slugs])

    starter_pack = store.ensure_starter_pack(
        StarterPack(
            id=candidate,
            name=payload.name.strip(),
            owner_team=user.email,
            role_key=role_key,
            status="draft",
            commands=[
                {
                    "name": "execute-objective",
                    "description": objective,
                }
            ],
            skill_ids=selected_skill_ids,
            connector_slugs=selected_connectors,
            policies=_workflow_policies(objective),
        )
    )

    return {
        "starter_pack": {
            "id": starter_pack.id,
            "name": starter_pack.name,
            "role_key": starter_pack.role_key,
            "status": starter_pack.status,
            "commands": starter_pack.commands,
            "skill_ids": starter_pack.skill_ids,
            "connector_slugs": starter_pack.connector_slugs,
            "owner_team": starter_pack.owner_team,
            "policies": starter_pack.policies,
        }
    }


@router.post("/{starter_pack_id:path}/run")
def run_workflow(starter_pack_id: str, payload: WorkflowRunRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    seed_builtin_catalog(store, settings)

    starter_pack = next((pack for pack in store.list_starter_packs() if pack.id == starter_pack_id), None)
    if starter_pack is None:
        raise HTTPException(status_code=404, detail="starter pack not found")
    if (
        starter_pack.id.startswith("workflow-pack.custom")
        and starter_pack.owner_team.strip().lower() != user.email.strip().lower()
        and not user.is_mabel_admin
    ):
        raise HTTPException(status_code=404, detail="starter pack not found")

    ready_connectors = {row.server_slug for row in launch_ready_connector_snapshots(store)}
    available_skills = {row.id for row in launch_ready_skills(store)}
    is_demo = _is_demo_workflow(starter_pack)
    policies = starter_pack.policies if isinstance(starter_pack.policies, dict) else {}
    if is_demo:
        demo_viewers = policies.get("demo_viewers")
        if isinstance(demo_viewers, list) and demo_viewers:
            viewer = user.email.strip().lower()
            allowed = {str(email).strip().lower() for email in demo_viewers}
            if viewer not in allowed:
                raise HTTPException(status_code=403, detail="workflow not available")

    live_missing_connectors = sorted(slug for slug in starter_pack.connector_slugs if slug not in ready_connectors)
    demo_skill_ids = [str(skill_id) for skill_id in (policies.get("demo_skill_ids") or [])] if is_demo else []
    live_missing_skills = sorted(
        skill_id
        for skill_id in (demo_skill_ids if is_demo else starter_pack.skill_ids)
        if skill_id not in available_skills
    )
    if is_demo:
        missing_connectors: list[str] = []
        missing_skills: list[str] = []
    else:
        missing_connectors = live_missing_connectors
        missing_skills = live_missing_skills
    command_rows = [command for command in starter_pack.commands if isinstance(command, dict)]
    requires_approval = _requires_controlled_action(payload.objective, command_rows) and not is_demo

    connector_checkpoint_status = "completed" if is_demo or not live_missing_connectors else "blocked"
    connector_checkpoint_description = (
        "Simulated MCP connectors loaded for demo."
        if is_demo
        else (
            f"Missing connectors: {', '.join(live_missing_connectors)}"
            if live_missing_connectors
            else "All required connectors are launch-ready."
        )
    )
    skills_checkpoint_status = "completed" if is_demo or not live_missing_skills else "blocked"
    skills_checkpoint_description = (
        "Workflow skills resolved (demo)."
        if is_demo
        else (
            f"Missing launch-ready skills: {', '.join(live_missing_skills)}"
            if live_missing_skills
            else "Workflow skills resolved."
        )
    )

    checkpoints: list[dict] = [
        {
            "id": "load-pack",
            "title": "Load starter pack",
            "status": "completed",
            "description": f'Loaded "{starter_pack.name}" ({starter_pack.id}).',
            "requires_approval": False,
        },
        {
            "id": "connector-readiness",
            "title": "Validate connector readiness",
            "status": connector_checkpoint_status,
            "description": connector_checkpoint_description,
            "requires_approval": False,
        },
        {
            "id": "skills-readiness",
            "title": "Resolve workflow skills",
            "status": skills_checkpoint_status,
            "description": skills_checkpoint_description,
            "requires_approval": False,
        },
        {
            "id": "approval-gate",
            "title": "Controlled action approval gate",
            "status": "approval_required" if requires_approval else "completed",
            "description": (
                "Controlled action detected; approval required before writes."
                if requires_approval
                else "No controlled write actions detected for this run."
            ),
            "requires_approval": requires_approval,
        },
    ]

    run_id = f"workflow_{uuid.uuid4().hex[:12]}"
    plan = _build_execution_plan(starter_pack, payload.objective, payload.dry_run, missing_connectors, missing_skills)
    outputs: dict = {"draft_actions": [], "execution_plan": plan}
    if starter_pack.id in {START_MY_DAY_WORKFLOW_ID, "starter-pack.account-manager"} or is_demo:
        meetings = payload.meetings or (
            _demo_start_my_day_meetings()
            if is_demo
            else [
                StarterPackMeeting(
                    time="10:00 AM",
                    account_name="Acme Hospital",
                    attendees=["customer@example.com"],
                    signals=[],
                )
            ]
        )
        outputs["briefs"] = [_brief_for_meeting(meeting) for meeting in meetings]
        if is_demo:
            outputs["demo_simulation"] = True
            outputs["live_missing_connectors"] = live_missing_connectors
            outputs["live_missing_skills"] = live_missing_skills
        checkpoints.append(
            {
                "id": "execute-start-my-day",
                "title": "Generate start-my-day briefs",
                "status": "completed" if not payload.dry_run else "pending",
                "description": f"Prepared {len(outputs['briefs'])} draft brief(s)." if not payload.dry_run else "Execution deferred by dry_run.",
                "requires_approval": False,
            }
        )
    else:
        draft_actions = [
            {
                "command": command.get("name") or command.get("description") or "workflow-step",
                "description": command.get("description") or "Prepare draft output and await approval.",
                "status": "drafted" if not payload.dry_run else "planned",
            }
            for command in starter_pack.commands
            if isinstance(command, dict)
        ]
        outputs["draft_actions"] = draft_actions
        checkpoints.append(
            {
                "id": "execute-command-plan",
                "title": "Build command execution plan",
                "status": "completed" if not payload.dry_run else "pending",
                "description": f"Prepared {len(draft_actions)} draft action(s)." if not payload.dry_run else "Execution deferred by dry_run.",
                "requires_approval": False,
            }
        )

    has_blockers = any(row["status"] == "blocked" for row in checkpoints)
    if requires_approval and not has_blockers and not payload.dry_run:
        _pause_execution_plan_for_approval(plan, outputs)
        step_events = []
    else:
        step_events = []
        if is_demo and not payload.dry_run and not has_blockers:
            step_events.extend(_demo_connector_events(starter_pack.connector_slugs))
            step_events.extend(_demo_skill_events(demo_skill_ids, policies))
        step_events.extend(_execute_execution_plan(plan, outputs, payload.dry_run, has_blockers))
    if step_events:
        checkpoints.append(
            {
                "id": "execute-workflow-steps",
                "title": "Execute workflow steps",
                "status": "completed",
                "description": f"Executed {len(outputs.get('step_results') or [])} workflow step(s).",
                "requires_approval": False,
            }
        )
    status = "blocked" if has_blockers else ("waiting_approval" if requires_approval else ("planned" if payload.dry_run else "completed"))
    outputs["observability"] = _workflow_observability(run_id, plan, status, step_events)
    outputs["next_actions"] = _workflow_next_actions(starter_pack, run_id)
    summary = (
        f"Workflow {starter_pack.name} {status}. "
        f"{len(checkpoints)} checkpoints, "
        f"{len(missing_connectors)} missing connectors, "
        f"{len(missing_skills)} missing skills."
    )
    record_request_usage(
        store=store,
        settings=settings,
        user_email=user.email,
        surface="workflows",
        prompt=f"{starter_pack.id}: {payload.objective}",
        output=summary,
        metadata={
            "starter_pack_id": starter_pack.id,
            "run_id": run_id,
            "dry_run": payload.dry_run,
            "status": status,
            "missing_connectors": missing_connectors,
            "missing_skills": missing_skills,
        },
    )
    workflow_run = AgentRun(
        id=run_id,
        conversation_id=None,
        user_email=user.email,
        surface="workflows",
        status=status,
        model="workflow-engine",
        state_json={
            "objective": payload.objective,
            "starter_pack_id": starter_pack.id,
            "dry_run": payload.dry_run,
            "checkpoints": checkpoints,
            "outputs": outputs,
            "missing_connectors": missing_connectors,
            "missing_skills": missing_skills,
            "orchestration": {
                "mode": plan["mode"],
                "schedule": plan["schedule"],
                "step_count": len(plan["steps"]),
                "chat_handoff": outputs["next_actions"][0],
            },
        },
    )
    store.create_run(workflow_run)

    return {
        "run_id": run_id,
        "status": status,
        "objective": payload.objective,
        "starter_pack": {
            "id": starter_pack.id,
            "name": starter_pack.name,
            "role_key": starter_pack.role_key,
        },
        "checkpoints": checkpoints,
        "missing_connectors": missing_connectors,
        "missing_skills": missing_skills,
        "outputs": outputs,
    }


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


def _title_from_message(message: str) -> str:
    normalized = " ".join(message.split())
    return normalized[:80] if normalized else "New chat"


def _append_section(lines: list[str], label: str, value: str) -> None:
    text = value.strip()
    if not text:
        return
    lines.append(f"### {label}")
    if text.startswith("- "):
        lines.extend(text.splitlines())
    else:
        lines.append(text)
    lines.append("")


def _format_start_my_day_markdown(briefs: list[dict[str, Any]]) -> str:
    lines = [
        "# Your day is ready",
        "",
        f"You have **{len(briefs)} customer meetings** today. Each brief below pulls calendar, CRM, product usage, and Teams — review before anything customer-facing.",
        "",
        "### Today's priorities",
        "- **9:30 AM — Northstar Health:** expansion conversation (Mesa + Scottsdale); renewal in 63 days",
        "- **2:00 PM — BrightBridge Logistics:** renewal checkpoint gated on Denver seat recovery plan",
        "- **Risk flags:** Northstar messaging adoption flat; BrightBridge −42 Denver seats after Jan 8 reorg",
        "- **Approval gates:** drafts and pricing need your sign-off before send or CRM write-back",
        "",
        "---",
        "",
    ]
    for brief in briefs:
        lines.append(f"## {brief.get('time', '')} — {brief.get('account_name', '')}")
        attendees = brief.get("attendees") or []
        if attendees:
            lines.append(f"**With:** {', '.join(attendees)}")
        lines.append("")
        sections = brief.get("sections") or {}
        if isinstance(sections, dict):
            section_order = [
                "Account snapshot",
                "Why this meeting matters",
                "What changed since last touch",
                "Suggested talk track",
                "Questions to ask",
                "Recommended next step",
                "Sources used",
                "Human verification needed",
            ]
            ordered_labels = [label for label in section_order if label in sections]
            for label in sections:
                if label not in ordered_labels:
                    ordered_labels.append(label)
            for label in ordered_labels:
                value = sections.get(label)
                if not isinstance(value, str):
                    continue
                display_label = "Before you send anything" if label == "Human verification needed" else label
                _append_section(lines, display_label, value)
    return "\n".join(lines).strip()


def _start_my_day_demo_tool_steps(brief_count: int) -> list[tuple[str, dict[str, Any], str, str | None]]:
    today = date.today().isoformat()
    return [
        (
            "outlook_calendar.list_events",
            {
                "start": f"{today}T00:00:00",
                "end": f"{today}T23:59:59",
                "timezone": "America/Phoenix",
            },
            "2 meetings today: 9:30 AM Northstar Health QSR (Teams, 45 min), 2:00 PM BrightBridge renewal check-in (Teams, 30 min). Both have external customer attendees.",
            "outlook-calendar",
        ),
        (
            "salesforce.get_account",
            {
                "account_id": "001Hs00002NK7STAR",
                "fields": ["ARR", "renewal_date", "opportunity_stage", "health_score"],
            },
            "Northstar Health — $892K ARR, renewal Mar 15 2026, health 82, expansion opp '2 clinic locations' in Discovery (last activity Jan 6).",
            "salesforce",
        ),
        (
            "salesforce.get_account",
            {
                "account_id": "001Hs00002BBRIDGE",
                "fields": ["ARR", "opportunity_stage", "active_seats", "risk"],
            },
            "BrightBridge Logistics — $1.18M ARR, Negotiation, 312 active seats (↓42 WoW), risk Medium since Jan 12.",
            "salesforce",
        ),
        (
            "product_usage.get_account_summary",
            {"account": "Northstar Health", "window_days": 30},
            "Voice +28% (30d); after-hours triage Phoenix +41%; messaging 34% of entitled seats (flat); Mesa/Scottsdale 0% messaging adoption.",
            None,
        ),
        (
            "product_usage.get_account_summary",
            {"account": "BrightBridge Logistics", "window_days": 7},
            "Denver −42 seats since Jan 8 reorg; inbound handle time +12% on remaining routes; Central hub seats unchanged.",
            None,
        ),
        (
            "microsoft_teams.get_meeting_notes",
            {
                "account": "Northstar Health",
                "lookback_days": 45,
            },
            "Nov 12 (Jordan): reporting visibility blocking messaging rollout. Dec 18 case closed: export timeout — Maya says dashboard still missing location view.",
            "microsoft-teams",
        ),
        (
            "microsoft_teams.get_meeting_notes",
            {
                "account": "BrightBridge Logistics",
                "lookback_days": 14,
            },
            "Jan 10 (Alex): routing audit required before renewal numbers. Jan 14 internal: AE notes Alex 'cautiously optimistic' with 60-day recovery plan.",
            "microsoft-teams",
        ),
        (
            "mabel_get_skill",
            {"skill_id": "skill.product-usage"},
            "Product usage summaries — compare adoption trends, seat utilization, and anomalies by account.",
            None,
        ),
        (
            "mabel_get_skill",
            {"skill_id": "skill.start-my-day"},
            "Meeting prep briefing — structure customer briefs with sources, talk track, and approval gates.",
            None,
        ),
        (
            "mabel_start_my_day_brief",
            {"accounts": ["Northstar Health", "BrightBridge Logistics"]},
            f"Drafted {brief_count} meeting brief{'s' if brief_count != 1 else ''} with source citations and approval reminders.",
            None,
        ),
    ]


def _assert_start_my_day_demo_access(starter_pack: StarterPack, user_email: str) -> None:
    if starter_pack.id != START_MY_DAY_WORKFLOW_ID or not _is_demo_workflow(starter_pack):
        raise HTTPException(status_code=404, detail="demo workflow not found")
    policies = starter_pack.policies if isinstance(starter_pack.policies, dict) else {}
    demo_viewers = policies.get("demo_viewers")
    if not isinstance(demo_viewers, list) or not demo_viewers:
        return
    viewer = user_email.strip().lower()
    allowed = {str(email).strip().lower() for email in demo_viewers}
    if viewer not in allowed:
        raise HTTPException(status_code=403, detail="workflow not available")


@router.post("/workflow-pack.start-my-day/demo-stream")
async def start_my_day_demo_stream(request: Request) -> StreamingResponse:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    seed_builtin_catalog(store, settings)

    starter_pack = next((pack for pack in store.list_starter_packs() if pack.id == START_MY_DAY_WORKFLOW_ID), None)
    if starter_pack is None:
        raise HTTPException(status_code=404, detail="demo workflow not found")
    _assert_start_my_day_demo_access(starter_pack, user.email)

    user_message = "Start my day"
    conversation = Conversation(user_email=user.email, title=_title_from_message(user_message), surface="chat")
    conversation = store.create_conversation(conversation)
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    run = AgentRun(
        id=run_id,
        conversation_id=conversation.id,
        user_email=user.email,
        surface="chat",
        status="running",
        model="workflow-demo",
        state_json={"starter_pack_id": START_MY_DAY_WORKFLOW_ID, "demo_simulation": True},
    )
    store.create_run(run)
    store.add_message(
        Message(
            conversation_id=conversation.id,
            role="user",
            content=user_message,
            run_id=run_id,
        )
    )

    briefs = [_brief_for_meeting(meeting) for meeting in _demo_start_my_day_meetings()]
    assistant_text = _format_start_my_day_markdown(briefs)
    demo_steps = _start_my_day_demo_tool_steps(len(briefs))

    async def generate():
        assistant_parts: list[str] = []
        seq = 0

        def emit(event: dict[str, Any]) -> str:
            nonlocal seq
            seq += 1
            row = dict(event)
            row.setdefault("run_id", run_id)
            row.setdefault("event_id", f"{run_id}:{seq}")
            row.setdefault("seq", seq)
            row.setdefault("ts", utcnow().isoformat() + "Z")
            return _sse(row)

        yield emit({"type": "run_started", "conversation_id": conversation.id})

        for index, (tool_name, arguments, preview, server_slug) in enumerate(demo_steps, start=1):
            tool_call_id = f"{run_id}:demo:{index}"
            store.add_tool_call(
                ToolCall(
                    run_id=run_id,
                    tool_name=tool_name,
                    status="called",
                    server_slug=server_slug,
                    arguments=arguments,
                )
            )
            yield emit(
                {
                    "type": "tool_call",
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "arguments": arguments,
                }
            )
            await asyncio.sleep(0.28 if tool_name.startswith("salesforce") else 0.18)
            store.add_tool_call(
                ToolCall(
                    run_id=run_id,
                    tool_name=tool_name,
                    status="completed",
                    server_slug=server_slug,
                    arguments=arguments,
                    output_preview=preview,
                )
            )
            yield emit(
                {
                    "type": "tool_result",
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "output_preview": preview,
                }
            )
            await asyncio.sleep(0.15)

        chunk_size = 48
        for offset in range(0, len(assistant_text), chunk_size):
            chunk = assistant_text[offset:offset + chunk_size]
            assistant_parts.append(chunk)
            yield emit({"type": "token", "text": chunk})
            await asyncio.sleep(0.03)

        final_text = "".join(assistant_parts)
        store.add_message(
            Message(
                conversation_id=conversation.id,
                role="assistant",
                content=final_text,
                run_id=run_id,
            )
        )
        store.update_run_status(run_id, "completed")
        record_request_usage(
            store=store,
            settings=settings,
            user_email=user.email,
            surface="chat",
            prompt=f"{START_MY_DAY_WORKFLOW_ID}: {user_message}",
            output=f"Start My Day demo completed with {len(briefs)} brief(s).",
            metadata={
                "starter_pack_id": START_MY_DAY_WORKFLOW_ID,
                "run_id": run_id,
                "conversation_id": conversation.id,
                "demo_simulation": True,
            },
        )
        yield emit({"type": "message_done"})
        yield emit({"type": "run_done", "status": "completed"})

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/runs/{run_id}")
def get_workflow_run(run_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    run = store.get_run(run_id)
    if run is None or run.surface != "workflows":
        raise HTTPException(status_code=404, detail="workflow run not found")
    if run.user_email != user.email:
        raise HTTPException(status_code=403, detail="workflow run belongs to another user")
    return {
        "run": {
            "id": run.id,
            "status": run.status,
            "created_at": run.created_at.isoformat() + "Z",
            "finished_at": run.finished_at.isoformat() + "Z" if run.finished_at else None,
            "state_json": run.state_json or {},
        }
    }


@router.post("/runs/{run_id}/resume")
def resume_workflow_run(run_id: str, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    store = get_store(settings)
    run = store.get_run(run_id)
    if run is None or run.surface != "workflows":
        raise HTTPException(status_code=404, detail="workflow run not found")
    if run.user_email != user.email:
        raise HTTPException(status_code=403, detail="workflow run belongs to another user")
    state = dict(run.state_json or {})
    checkpoints = list(state.get("checkpoints") or [])
    pending_index = next(
        (
            idx
            for idx, checkpoint in enumerate(checkpoints)
            if isinstance(checkpoint, dict) and checkpoint.get("status") in {"pending", "blocked", "approval_required"}
        ),
        None,
    )
    if pending_index is None:
        store.update_run_status(run.id, "completed")
        return {"status": "completed", "run_id": run.id, "state_json": state}
    checkpoint = dict(checkpoints[pending_index])
    checkpoint["status"] = "completed"
    checkpoint["description"] = (checkpoint.get("description") or "").strip() + " Resumed and completed."
    checkpoints[pending_index] = checkpoint
    state["checkpoints"] = checkpoints
    remaining = any(
        isinstance(row, dict) and row.get("status") in {"pending", "blocked", "approval_required"}
        for row in checkpoints
    )
    next_status = "running" if remaining else "completed"
    store.update_run_state(run.id, state)
    store.update_run_status(run.id, next_status)
    return {"status": next_status, "run_id": run.id, "resumed_checkpoint": checkpoint, "state_json": state}
