from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
import httpx

from ..auth import resolve_mabel_user
from ..catalog import connector_is_enabled, resolve_connector_snapshot, set_all_connector_enabled
from ..db import get_store
from ..mcp import manager
from ..mcp.tool_display import normalize_mcp_tools_for_display
from ..models import Approval, ConnectorSnapshot
from ..schemas import ConnectorStateRequest, McpToolCallRequest

router = APIRouter(prefix="/api/v1/mcp", tags=["mcp"])


def _canonical_slug(server_slug: str) -> str:
    return manager.canonical_connector_slug(server_slug)


def _identity_headers(request: Request) -> dict[str, str]:
    user = resolve_mabel_user(request)
    headers = {
        "x-user-email": user.email,
        "x-user-id": user.user_id,
    }
    if user.name:
        headers["x-user-name"] = user.name
    if user.groups:
        headers["x-user-groups"] = ",".join(user.groups)
    uid = (user.user_id or "").strip()
    if uid:
        headers["x-user-subject"] = f"user_id:{uid}"
    elif user.email:
        headers["x-user-subject"] = f"user_email:{user.email.strip().lower()}"
    return headers


def _exception_message(exc: BaseException, *, fallback: str = "MCP request failed") -> str:
    message = str(exc).strip()
    return message or f"{fallback}: {exc.__class__.__name__}"


def _tools_from_jsonrpc(payload: dict, *, server_slug: str = "") -> list[dict]:
    result = payload.get("result")
    if not isinstance(result, dict):
        return []
    tools = result.get("tools")
    if not isinstance(tools, list):
        return []
    return normalize_mcp_tools_for_display([tool for tool in tools if isinstance(tool, dict)], server_slug)


def _status_after_tools_list(previous_status: str, local: bool) -> str:
    if local:
        return "connected"
    if previous_status == "connected":
        return "connected"
    return "remote_gateway_available"


def _status_after_http_error(previous_status: str, status_code: int, local: bool) -> str:
    if local:
        return previous_status
    if status_code in {401, 403}:
        if previous_status in {"connected", "local_package_available"}:
            return previous_status
        # Vendor connector exists but the runtime token/user is not authorized yet.
        return "not_configured"
    return previous_status


async def _tools_list_from_candidates(
    *,
    request: Request,
    candidates: list[tuple[str, dict[str, str], bool]],
    payload_id: str,
    server_slug: str,
) -> tuple[list[dict], bool] | None:
    payload = {"jsonrpc": "2.0", "id": payload_id, "method": "tools/list", "params": {}}
    for endpoint, target_headers, candidate_is_local in candidates:
        try:
            response = await manager.post_mcp_json(
                endpoint=endpoint,
                payload=payload,
                headers={**target_headers, **_identity_headers(request)},
            )
            return _tools_from_jsonrpc(response, server_slug=server_slug), candidate_is_local
        except (manager.McpJsonRpcError, httpx.HTTPStatusError):
            raise
        except httpx.RequestError:
            continue
    return None


def _connector_disabled(settings, server_slug: str) -> bool:
    return not connector_is_enabled(get_store(settings), server_slug)


def _cached_connector_tools(settings, server_slug: str) -> list[dict]:
    snapshot = resolve_connector_snapshot(get_store(settings), server_slug)
    if snapshot is None or not isinstance(snapshot.tools, list):
        return []
    return normalize_mcp_tools_for_display(
        [tool for tool in snapshot.tools if isinstance(tool, dict)],
        server_slug,
    )


def _connector_readiness(settings, server_slug: str) -> dict:
    snapshot = resolve_connector_snapshot(get_store(settings), server_slug)
    cached_tools = _cached_connector_tools(settings, server_slug)
    tool_policy = []
    approval_required_count = 0
    for tool in cached_tools:
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        scope = manager.infer_tool_scope(name)
        decision = manager.evaluate_tool_policy(
            settings,
            server_slug=server_slug,
            tool_name=name,
            scope=scope,
        )
        requires_approval = decision == "ask"
        if requires_approval:
            approval_required_count += 1
        tool_policy.append({"name": name, "scope": scope, "decision": decision, "requires_approval": requires_approval})
    tool_policy.sort(key=lambda row: row["name"])

    endpoint_candidates: list[dict] = []
    try:
        for endpoint, _, is_local in manager.resolve_mcp_endpoint_candidates(settings, server_slug):
            endpoint_candidates.append(
                {
                    "transport": "local" if is_local else "remote_gateway",
                    "configured": True,
                    "endpoint": endpoint,
                }
            )
    except Exception:
        endpoint_candidates = []

    recommendations: list[str] = []
    if snapshot is None:
        recommendations.append("Connector is unknown in Mabel bootstrap; refresh catalog/bootstrap first.")
    if snapshot is not None and snapshot.enabled is False:
        recommendations.append("Connector is disabled; enable it before tool calls.")
    if not endpoint_candidates:
        recommendations.append("No MCP endpoint candidate is configured for this connector.")
    has_remote_gateway_candidate = any(row.get("transport") == "remote_gateway" for row in endpoint_candidates)
    if has_remote_gateway_candidate and not (settings.remote_gateway_runtime_token or "").strip():
        recommendations.append(
            "No global Remote Gateway runtime token is configured. Use per-user runtime credential "
            "(`/v1/remote_gateway/runtime-credential`) or set MABEL_REMOTE_GATEWAY_RUNTIME_TOKEN."
        )
    if snapshot is not None:
        st = snapshot.connection_status
        if st == "local_package_available":
            recommendations.append(
                "Set MABEL_LOCAL_MCP_ENDPOINT_<SLUG> or MABEL_LOCAL_MCP_ENDPOINTS_JSON "
                "to a loopback Streamable HTTP endpoint for this local connector."
            )
        elif st == "not_configured":
            recommendations.append(
                "Set a loopback MCP URL for this connector, or complete Remote Gateway vendor setup for external tools."
            )
        elif st not in {"connected", "remote_gateway_available"}:
            recommendations.append(f'Connector connection status is "{st}". Review catalog approval or local wiring.')
        elif st == "remote_gateway_available":
            recommendations.append("Vendor MCP via Remote Gateway: open View tools to sync tool list when the org token is valid.")
    if not cached_tools:
        recommendations.append("No cached tools found; run tools/list after endpoint is reachable.")
    if approval_required_count > 0:
        recommendations.append(
            f"{approval_required_count} tool(s) have policy decision 'ask' (informational tag; authenticated Mabel still executes them unless denied)."
        )

    return {
        "server_slug": server_slug,
        "connector": {
            "name": snapshot.name if snapshot else server_slug,
            "enabled": snapshot.enabled if snapshot else None,
            "connection_status": snapshot.connection_status if snapshot else "unknown",
            "tool_count": len(cached_tools),
        },
        "endpoint_candidates": endpoint_candidates,
        "tool_policy": tool_policy[:50],
        "approval_required_count": approval_required_count,
        "recommendations": recommendations,
    }


async def execute_mcp_tool(
    settings,
    request: Request,
    server_slug: str,
    name: str,
    arguments: dict,
    *,
    policy_approved: bool = False,
) -> dict:
    server_slug = _canonical_slug(server_slug)
    if _connector_disabled(settings, server_slug):
        raise HTTPException(status_code=409, detail=f"connector {server_slug} is disabled")
    store = get_store(settings)
    snapshot = resolve_connector_snapshot(store, server_slug)
    identity_headers = _identity_headers(request)
    try:
        normalized_args = manager.normalize_tool_arguments(arguments)
        manager.enforce_tool_call_policy(settings, name, normalized_args)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    scope = manager.infer_tool_scope(name)
    decision = manager.evaluate_tool_policy(settings, server_slug=server_slug, tool_name=name, scope=scope)
    if decision == "deny":
        raise HTTPException(status_code=403, detail=f"policy denied tool call {name}")
    if decision == "ask" and not policy_approved:
        raise HTTPException(status_code=409, detail="approval required")
    if snapshot is not None and snapshot.connection_status in {"local_package_available", "connected"}:
        stdio_response = await manager.post_mcp_stdio_json(
            server_slug=server_slug,
            payload={
                "jsonrpc": "2.0",
                "id": f"mabel-call-{uuid.uuid4().hex[:12]}",
                "method": "tools/call",
                "params": {"name": name, "arguments": normalized_args},
            },
            identity_headers=identity_headers,
            timeout_seconds=settings.mcp_tool_timeout_seconds,
        )
        if stdio_response is not None:
            return {
                "status": "ok",
                "server_slug": server_slug,
                "source": "local",
                "response": stdio_response,
            }
    candidates: list[tuple[str, dict[str, str], bool]]
    try:
        candidates = manager.resolve_mcp_endpoint_candidates(settings, server_slug)
    except (LookupError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    response: dict | None = None
    local = False
    last_request_error: httpx.RequestError | None = None
    for endpoint, target_headers, candidate_is_local in candidates:
        try:
            response = await manager.post_mcp_json(
                endpoint=endpoint,
                payload={
                    "jsonrpc": "2.0",
                    "id": f"mabel-call-{uuid.uuid4().hex[:12]}",
                    "method": "tools/call",
                    "params": {"name": name, "arguments": normalized_args},
                },
                headers={**target_headers, **identity_headers},
                timeout_seconds=settings.mcp_tool_timeout_seconds,
            )
            local = candidate_is_local
            break
        except manager.McpJsonRpcError as exc:
            raise HTTPException(status_code=502, detail={"message": str(exc), "error": exc.error}) from exc
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=502, detail=f"MCP upstream returned {exc.response.status_code}") from exc
        except httpx.RequestError as exc:
            last_request_error = exc
            continue

    if response is None:
        error = last_request_error or httpx.RequestError("all MCP endpoints failed")
        raise HTTPException(status_code=502, detail=_exception_message(error, fallback=f"MCP upstream unavailable after {settings.mcp_tool_timeout_seconds:g}s")) from error

    return {
        "status": "ok",
        "server_slug": server_slug,
        "source": "local" if local else "remote_gateway",
        "response": response,
    }


@router.post("/{server_slug}/tools/list")
async def tools_list(server_slug: str, request: Request) -> dict:
    server_slug = _canonical_slug(server_slug)
    settings = request.app.state.settings
    resolve_mabel_user(request)
    if _connector_disabled(settings, server_slug):
        raise HTTPException(status_code=409, detail=f"connector {server_slug} is disabled")
    store = get_store(settings)
    previous = resolve_connector_snapshot(store, server_slug)
    identity_headers = _identity_headers(request)
    if previous is not None and previous.connection_status in {"local_package_available", "connected"}:
        stdio_response = await manager.post_mcp_stdio_json(
            server_slug=server_slug,
            payload={"jsonrpc": "2.0", "id": "mabel-tools-list", "method": "tools/list", "params": {}},
            identity_headers=identity_headers,
            timeout_seconds=settings.mcp_tool_timeout_seconds,
        )
        if stdio_response is not None:
            tools = _tools_from_jsonrpc(stdio_response, server_slug=server_slug)
            store.upsert_connector_snapshot(
                ConnectorSnapshot(
                    org_slug=settings.remote_gateway_org or "local",
                    server_slug=server_slug,
                    name=previous.name if previous and previous.name else server_slug,
                    connection_status="connected",
                    tools=tools,
                    enabled=previous.enabled if previous else None,
                    last_error=None,
                )
            )
            return {"server_slug": server_slug, "source": "local", "tools": tools}

    candidates: list[tuple[str, dict[str, str], bool]]
    try:
        candidates = manager.resolve_mcp_endpoint_candidates(settings, server_slug)
    except (LookupError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        listed = await _tools_list_from_candidates(
            request=request,
            candidates=candidates,
            payload_id="mabel-tools-list",
            server_slug=server_slug,
        )
    except manager.McpJsonRpcError as exc:
        raise HTTPException(status_code=502, detail={"message": str(exc), "error": exc.error}) from exc
    except httpx.HTTPStatusError as exc:
        status_code = int(exc.response.status_code)
        if status_code in {401, 403}:
            if previous is not None:
                store.upsert_connector_snapshot(
                    ConnectorSnapshot(
                        org_slug=previous.org_slug,
                        server_slug=server_slug,
                        name=previous.name,
                        connection_status=_status_after_http_error(previous.connection_status, status_code, local=False),
                        tools=previous.tools or [],
                        enabled=previous.enabled,
                        last_error=f"MCP upstream returned {status_code}",
                    )
                )
            return {
                "server_slug": server_slug,
                "source": "cache",
                "tools": _cached_connector_tools(settings, server_slug),
            }
        raise HTTPException(status_code=502, detail=f"MCP upstream returned {status_code}") from exc

    if listed is None:
        # Keep connector inspection functional when endpoints are transiently down.
        # The UI can still render last-known tools (or an empty list) without a hard error.
        return {
            "server_slug": server_slug,
            "source": "cache",
            "tools": _cached_connector_tools(settings, server_slug),
        }

    tools, local = listed
    updated_status = _status_after_tools_list(previous.connection_status if previous else "remote_gateway_available", local)

    store.upsert_connector_snapshot(
        ConnectorSnapshot(
            org_slug=settings.remote_gateway_org or "local",
            server_slug=server_slug,
            name=previous.name if previous and previous.name else server_slug,
            connection_status=updated_status,
            tools=tools,
            enabled=previous.enabled if previous else None,
            last_error=None,
        )
    )

    return {"server_slug": server_slug, "source": "local" if local else "remote_gateway", "tools": tools}


@router.post("/sync")
async def sync_connectors(request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    if not user.is_mabel_admin:
        raise HTTPException(status_code=403, detail="connector administration requires mabel-admins")
    store = get_store(settings)
    snapshots = [row for row in store.list_connectors() if row.server_slug != "skills" and row.enabled is not False]

    synced: list[dict[str, Any]] = []
    for snapshot in snapshots:
        slug = snapshot.server_slug
        if snapshot.connection_status in {"local_package_available", "connected"}:
            stdio_response = await manager.post_mcp_stdio_json(
                server_slug=slug,
                payload={"jsonrpc": "2.0", "id": f"mabel-sync-{slug}", "method": "tools/list", "params": {}},
                identity_headers=_identity_headers(request),
                timeout_seconds=settings.mcp_tool_timeout_seconds,
            )
            if stdio_response is not None:
                tools = _tools_from_jsonrpc(stdio_response, server_slug=slug)
                store.upsert_connector_snapshot(
                    ConnectorSnapshot(
                        org_slug=snapshot.org_slug,
                        server_slug=slug,
                        name=snapshot.name,
                        connection_status="connected",
                        tools=tools,
                        enabled=snapshot.enabled,
                        last_error=None,
                    )
                )
                synced.append(
                    {
                        "server_slug": slug,
                        "status": "ok",
                        "source": "local",
                        "connection_status": "connected",
                        "tool_count": len(tools),
                    }
                )
                continue
        try:
            candidates = manager.resolve_mcp_endpoint_candidates(settings, slug)
        except (LookupError, ValueError) as exc:
            synced.append(
                {
                    "server_slug": slug,
                    "status": "skipped",
                    "reason": str(exc),
                    "connection_status": snapshot.connection_status,
                    "tool_count": len(snapshot.tools or []),
                }
            )
            continue
        try:
            listed = await _tools_list_from_candidates(
                request=request,
                candidates=candidates,
                payload_id=f"mabel-sync-{slug}",
                server_slug=slug,
            )
        except manager.McpJsonRpcError as exc:
            synced.append(
                {
                    "server_slug": slug,
                    "status": "error",
                    "reason": str(exc),
                    "connection_status": snapshot.connection_status,
                    "tool_count": len(snapshot.tools or []),
                }
            )
            continue
        except httpx.HTTPStatusError as exc:
            error_status = int(exc.response.status_code)
            next_status = _status_after_http_error(snapshot.connection_status, error_status, local=False)
            store.upsert_connector_snapshot(
                ConnectorSnapshot(
                    org_slug=snapshot.org_slug,
                    server_slug=slug,
                    name=snapshot.name,
                    connection_status=next_status,
                    tools=snapshot.tools or [],
                    enabled=snapshot.enabled,
                    last_error=f"MCP upstream returned {error_status}",
                )
            )
            synced.append(
                {
                    "server_slug": slug,
                    "status": "error",
                    "reason": f"MCP upstream returned {error_status}",
                    "connection_status": next_status,
                    "tool_count": len(snapshot.tools or []),
                }
            )
            continue
        if listed is None:
            synced.append(
                {
                    "server_slug": slug,
                    "status": "offline",
                    "reason": "all endpoint candidates unavailable",
                    "connection_status": snapshot.connection_status,
                    "tool_count": len(snapshot.tools or []),
                }
            )
            continue
        tools, local = listed
        connection_status = _status_after_tools_list(snapshot.connection_status, local)
        store.upsert_connector_snapshot(
            ConnectorSnapshot(
                org_slug=snapshot.org_slug,
                server_slug=slug,
                name=snapshot.name,
                connection_status=connection_status,
                tools=tools,
                enabled=snapshot.enabled,
                last_error=None,
            )
        )
        synced.append(
            {
                "server_slug": slug,
                "status": "ok",
                "source": "local" if local else "remote_gateway",
                "connection_status": connection_status,
                "tool_count": len(tools),
            }
        )

    return {"status": "ok", "count": len(synced), "connectors": synced}


@router.post("/{server_slug}/state")
def set_connector_state(server_slug: str, payload: ConnectorStateRequest, request: Request) -> dict:
    server_slug = _canonical_slug(server_slug)
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    if not user.is_mabel_admin:
        raise HTTPException(status_code=403, detail="connector administration requires mabel-admins")
    store = get_store(settings)
    snapshot = set_all_connector_enabled(store, server_slug, payload.enabled)
    if snapshot is None:
        raise HTTPException(status_code=404, detail=f"connector {server_slug} not found")
    return {
        "connector": {
            "server_slug": snapshot.server_slug,
            "name": snapshot.name,
            "connection_status": snapshot.connection_status,
            "enabled": snapshot.enabled,
        }
    }


@router.get("/{server_slug}/readiness")
def connector_readiness(server_slug: str, request: Request) -> dict:
    server_slug = _canonical_slug(server_slug)
    settings = request.app.state.settings
    resolve_mabel_user(request)
    return _connector_readiness(settings, server_slug)


@router.post("/{server_slug}/tools/call")
async def tools_call(server_slug: str, payload: McpToolCallRequest, request: Request) -> dict:
    server_slug = _canonical_slug(server_slug)
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    try:
        normalized_args = manager.normalize_tool_arguments(payload.arguments)
        manager.enforce_tool_call_policy(settings, payload.name, normalized_args)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    scope = manager.infer_tool_scope(payload.name)
    decision = manager.evaluate_tool_policy(
        settings,
        server_slug=server_slug,
        tool_name=payload.name,
        scope=scope,
    )
    if decision == "deny":
        raise HTTPException(status_code=403, detail=f"policy denied tool call {payload.name}")
    if decision == "ask":
        approval = get_store(settings).create_approval(
            Approval(
                id=f"approval_{uuid.uuid4().hex}",
                status="pending",
                title=f"Approve {payload.name}",
                summary=f"Mabel requires approval for a {scope} action on {server_slug}.",
                requested_by=user.email,
                payload={
                    "server_slug": server_slug,
                    "tool_name": payload.name,
                    "arguments": normalized_args,
                    "scope": scope,
                },
            )
        )
        raise HTTPException(
            status_code=409,
            detail={"message": "approval required", "approval_id": approval.id},
        )

    return await execute_mcp_tool(settings, request, server_slug, payload.name, normalized_args)
