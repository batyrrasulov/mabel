from __future__ import annotations

import importlib.util
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .auth import resolve_mabel_user
from .catalog import (
    bootstrap_connection_status,
    bootstrap_connector_label,
    launch_ready_connector_snapshots,
    launch_ready_skills,
    launch_visible_connector_snapshots,
    launch_visible_starter_packs,
    normalize_skill_status,
    seed_builtin_catalog,
    skill_description,
    starter_pack_bootstrap_connector_slugs,
    starter_pack_bootstrap_skill_ids,
)
from .db import db_health, get_store, reset_store
from .mcp.manager import LocalMcpRegistry
from .routes.admin import router as admin_router
from .routes.approvals import router as approvals_router
from .routes.chat import router as chat_router
from .routes.documents import router as documents_router
from .routes.files import router as files_router
from .routes.memory import router as memory_router
from .routes.mcp import router as mcp_router
from .routes.projects import router as projects_router
from .routes.rag import router as rag_router
from .routes.runs import router as runs_router
from .routes.scheduled import router as scheduled_router
from .routes.skills import router as skills_router
from .routes.starter_packs import router as starter_packs_router
from .routes.usage import router as usage_router
from .routes.workflows import router as workflows_router
from .settings import MabelSettings

SURFACES = ["chat", "rag", "mcp", "agents"]


def _agents_sdk_installed() -> bool:
    return importlib.util.find_spec("agents") is not None


def _local_mcp_endpoint_count(settings: MabelSettings) -> int:
    try:
        return len(LocalMcpRegistry.from_settings(settings).endpoints)
    except ValueError:
        return 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_builtin_catalog(get_store(app.state.settings), app.state.settings)
    yield


def build_app(settings: MabelSettings | None = None) -> FastAPI:
    active_settings = settings or MabelSettings.load()
    if active_settings.store_mode == "memory":
        reset_store()
    seed_builtin_catalog(get_store(active_settings), active_settings)

    app = FastAPI(title="Mabel API", version="0.1.0", lifespan=lifespan)
    app.state.settings = active_settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(admin_router)
    app.include_router(chat_router)
    app.include_router(documents_router)
    app.include_router(approvals_router)
    app.include_router(files_router)
    app.include_router(memory_router)
    app.include_router(mcp_router)
    app.include_router(projects_router)
    app.include_router(rag_router)
    app.include_router(runs_router)
    app.include_router(scheduled_router)
    app.include_router(skills_router)
    app.include_router(starter_packs_router)
    app.include_router(usage_router)
    app.include_router(workflows_router)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "service": active_settings.service_name}

    @app.get("/api/v1/health/deep")
    def deep_health() -> dict:
        database = db_health(active_settings)
        store = get_store(active_settings)
        normalization = store.normalization_status()
        status = "ok"
        if database["status"] != "ok":
            status = "degraded"
        if active_settings.normalized_strict_reads and not bool(normalization.get("ready_for_strict_reads")):
            status = "degraded"
        agents_sdk_installed = _agents_sdk_installed()
        openai_api_key_configured = bool(active_settings.openai_api_key)
        local_mcp_endpoint_count = _local_mcp_endpoint_count(active_settings)
        return {
            "service": active_settings.service_name,
            "status": status,
            "database": database,
            "runtime": {
                "provider": "openai-agents-python",
                "sdk_package": "openai-agents",
                "sdk_installed": agents_sdk_installed,
                "enabled": active_settings.openai_agents_enabled,
                "ready": bool(active_settings.openai_agents_enabled and openai_api_key_configured and agents_sdk_installed),
                "model": active_settings.openai_model,
                "api_key_configured": openai_api_key_configured,
                "hosted_tools": {
                    "web_search": active_settings.openai_web_search_enabled,
                    "code_interpreter": active_settings.openai_code_interpreter_enabled,
                    "image_generation": active_settings.openai_image_generation_enabled,
                },
                "sessions": {
                    "store": "sqlite",
                    "history_limit": active_settings.openai_session_history_limit,
                    "tool_payload_max_chars": {
                        "mcp_call": active_settings.mcp_tool_result_max_chars,
                        "mcp_list": active_settings.mcp_tool_list_max_chars,
                        "memory": active_settings.memory_tool_payload_max_chars,
                        "skill": active_settings.skill_tool_payload_max_chars,
                        "catalog": active_settings.catalog_tool_payload_max_chars,
                    },
                },
                "trace_include_sensitive_data": active_settings.trace_include_sensitive_data,
            },
            "remote_gateway": {
                "configured": bool(
                    (active_settings.mcp_gateway_proxy_base_url and active_settings.remote_gateway_runtime_token)
                    or (active_settings.remote_gateway_api_base_url and active_settings.remote_gateway_runtime_token)
                ),
                "org_configured": bool(active_settings.remote_gateway_org),
                "mcp_gateway_proxy_configured": bool(active_settings.mcp_gateway_proxy_base_url),
                "mcp_gateway_local_bypass_enabled": active_settings.mcp_gateway_local_bypass_enabled,
                "local_endpoint_count": local_mcp_endpoint_count,
                "local_endpoints_configured": local_mcp_endpoint_count > 0,
            },
            "normalization": {
                "store": normalization.get("store"),
                "strict_reads": normalization.get("strict_reads"),
                "ready_for_strict_reads": normalization.get("ready_for_strict_reads"),
                "backfill_gap": normalization.get("backfill_gap"),
            },
        }

    @app.get("/api/v1/health/normalization")
    def normalization_health() -> dict:
        return get_store(active_settings).normalization_status()

    @app.get("/api/v1/bootstrap")
    def bootstrap(request: Request) -> dict:
        user = resolve_mabel_user(request)
        user_email = user.email
        store = get_store(active_settings)
        connectors = launch_visible_connector_snapshots(store)
        ready_connectors = launch_ready_connector_snapshots(store)
        ready_connector_slugs = {row.server_slug for row in ready_connectors}
        skills = launch_ready_skills(store, ready_connector_slugs=ready_connector_slugs)
        ready_skill_ids = {row.id for row in skills}
        starter_packs = launch_visible_starter_packs(store, viewer_email=user_email)
        approvals = store.list_pending_approvals(user_email, user.is_mabel_approver)
        return {
            "service": active_settings.service_name,
            "user": {"email": user_email, "name": user.name},
            "surfaces": SURFACES,
            "connectors": [
                {
                    "id": row.server_slug,
                    "name": bootstrap_connector_label(row.server_slug, row.name),
                    "connection_status": bootstrap_connection_status(row),
                    "tool_count": len(row.tools or []),
                    "enabled": getattr(row, "enabled", True),
                }
                for row in connectors
            ],
            "skills": [
                {
                    "id": row.id,
                    "name": row.name,
                    "owner_team": row.owner_team,
                    "status": normalize_skill_status(row.status),
                    "current_version": row.current_version,
                    "description": skill_description(row),
                    "tags": row.tags,
                    "mcp_bindings": row.mcp_bindings,
                }
                for row in skills
            ],
            "starter_packs": [
                {
                    "id": row.id,
                    "name": row.name,
                    "role_key": row.role_key,
                    "status": row.status,
                    "commands": row.commands,
                    "skill_ids": starter_pack_bootstrap_skill_ids(row, ready_skill_ids),
                    "connector_slugs": starter_pack_bootstrap_connector_slugs(row, ready_connector_slugs),
                    "policies": row.policies,
                }
                for row in starter_packs
            ],
            "approvals": [
                {
                    "id": row.id,
                    "title": row.title,
                    "summary": row.summary,
                    "requested_by": row.requested_by,
                    "status": row.status,
                    "created_at": row.created_at.isoformat() + "Z",
                    "payload": {
                        "tool_name": row.payload.get("tool_name") if isinstance(row.payload, dict) else None,
                        "scope": row.payload.get("scope") if isinstance(row.payload, dict) else None,
                        "server_slug": row.payload.get("server_slug") if isinstance(row.payload, dict) else None,
                    },
                }
                for row in approvals
            ],
            "runtime_readiness": {
                "agents_enabled": active_settings.openai_agents_enabled,
                "api_key_configured": bool(active_settings.openai_api_key),
                "model": active_settings.openai_model,
                "hosted_tools": {
                    "web_search": active_settings.openai_web_search_enabled,
                    "code_interpreter": active_settings.openai_code_interpreter_enabled,
                    "image_generation": active_settings.openai_image_generation_enabled,
                },
                "ready": bool(active_settings.openai_agents_enabled and active_settings.openai_api_key and _agents_sdk_installed()),
                "caveats": [] if bool(active_settings.openai_agents_enabled and active_settings.openai_api_key and _agents_sdk_installed()) else [
                    "OpenAI Agents runtime is not fully ready; verify SDK install and API key.",
                ],
            },
        }

    return app


app = build_app()
