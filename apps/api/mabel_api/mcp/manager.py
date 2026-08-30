from __future__ import annotations

import json
import os
import re
import asyncio
import shutil
import sys
from fnmatch import fnmatch
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

try:
    from mcp.client.streamable_http import streamable_http_client
except ImportError:  # mcp 1.12.x exported helper without second underscore
    from mcp.client.streamable_http import streamablehttp_client as streamable_http_client

from ..settings import MabelSettings, _env, repo_root
from .remote_gateway import mcp_target_for_server


class McpJsonRpcError(RuntimeError):
    def __init__(self, error: Any) -> None:
        self.error = error
        message = "MCP JSON-RPC error"
        if isinstance(error, dict):
            raw_message = error.get("message")
            if raw_message:
                message = str(raw_message)
        super().__init__(message)


@dataclass(frozen=True)
class LocalMcpRegistry:
    endpoints: dict[str, str]

    @classmethod
    def from_settings(cls, settings: MabelSettings) -> "LocalMcpRegistry":
        endpoints: dict[str, str] = {}
        endpoints.update(_parse_local_endpoint_json(settings.local_mcp_endpoints_json, "MABEL_LOCAL_MCP_ENDPOINTS_JSON"))
        endpoints.update(_parse_local_endpoint_json(settings.mcp_gateway_local_endpoints_json, "MABEL_MCP_GATEWAY_LOCAL_ENDPOINTS_JSON"))
        endpoints.update(_prefixed_local_endpoints("MABEL_MCP_GATEWAY_LOCAL_ENDPOINT_"))
        endpoints.update(_prefixed_local_endpoints("MABEL_LOCAL_MCP_ENDPOINT_"))
        return cls(endpoints)

    def endpoint_for(self, server_slug: str) -> str | None:
        endpoint = self.endpoints.get(canonical_connector_slug(server_slug))
        if not endpoint:
            return None
        _validate_loopback_endpoint(server_slug, endpoint)
        return endpoint


def _parse_local_endpoint_json(raw: str, env_name: str) -> dict[str, str]:
    raw = raw.strip() or "{}"
    if raw == "{}":
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{env_name} must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{env_name} must be a JSON object")
    endpoints: dict[str, str] = {}
    for key, value in parsed.items():
        if not value:
            continue
        endpoints[canonical_connector_slug(str(key))] = str(value)
    return endpoints


LOCAL_CONNECTOR_ALIASES: dict[str, str] = {
    "google-analytics": "google-analytics-mcp",
}


def canonical_connector_slug(server_slug: str) -> str:
    normalized = str(server_slug).strip().lower().replace("_", "-")
    if not normalized:
        return normalized
    if normalized.startswith("user-"):
        normalized = normalized.removeprefix("user-")
    return LOCAL_CONNECTOR_ALIASES.get(normalized, normalized)


def _env_keys_with_prefix(prefix: str) -> set[str]:
    keys = {key for key in os.environ if key.startswith(prefix)}
    env_path = repo_root() / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            entry = line.strip()
            if not entry or entry.startswith("#") or "=" not in entry:
                continue
            key, _ = entry.split("=", 1)
            key = key.strip()
            if key.startswith(prefix):
                keys.add(key)
    return keys


def _prefixed_local_endpoints(prefix: str) -> dict[str, str]:
    endpoints: dict[str, str] = {}
    for key in _env_keys_with_prefix(prefix):
        suffix = key.removeprefix(prefix)
        if not suffix:
            continue
        slug = canonical_connector_slug(suffix)
        value = _env(key)
        if value:
            endpoints[slug] = value
    return endpoints


def _validate_loopback_endpoint(server_slug: str, endpoint: str) -> None:
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"local MCP endpoint for {server_slug} must be a loopback HTTP URL")


def infer_tool_scope(tool_name: str) -> str:
    lowered = tool_name.lower()
    if lowered.endswith("_health") or lowered.endswith("_health_check") or lowered in {"health", "ping"}:
        return "read"
    parts = [part for part in lowered.replace("-", "_").split("_") if part]
    verbs = set(parts)
    if "delete" in verbs or "remove" in verbs:
        return "delete"
    if "admin" in verbs:
        return "admin"
    if {"update", "patch", "edit", "upsert"} & verbs:
        return "update"
    if {"create", "send", "post", "write", "generate", "export", "publish"} & verbs:
        return "create"
    if {"get", "list", "search", "read", "fetch", "lookup", "find", "summarize", "chat"} & verbs:
        return "read"
    return "unknown"


def requires_approval(scope: str) -> bool:
    return scope.strip().lower() in {"create", "update"}


def normalize_tool_arguments(arguments: dict[str, Any] | Any) -> dict[str, Any]:
    if isinstance(arguments, dict):
        return arguments
    if arguments is None:
        return {}
    raise ValueError("MCP tool arguments must be a JSON object")


def enforce_tool_call_policy(settings: MabelSettings, tool_name: str, arguments: dict[str, Any]) -> None:
    if not tool_name or not tool_name.strip():
        raise ValueError("MCP tool name is required")
    if len(tool_name) > 255:
        raise ValueError("MCP tool name exceeds maximum length")
    if not re.fullmatch(r"[A-Za-z0-9_.:-]+", tool_name):
        raise ValueError("MCP tool name contains unsupported characters")

    try:
        raw_rules = json.loads(settings.mcp_tool_blocklist_json or "[]")
    except json.JSONDecodeError:
        raw_rules = []
    if not isinstance(raw_rules, list):
        raw_rules = []
    lowered = tool_name.lower()
    for rule in raw_rules:
        if not isinstance(rule, str):
            continue
        token = rule.strip().lower()
        if token and token in lowered:
            raise PermissionError(f"MCP tool call blocked by policy: {tool_name}")

    try:
        encoded = json.dumps(arguments or {}, separators=(",", ":")).encode("utf-8")
    except Exception as exc:  # pragma: no cover
        raise ValueError("MCP tool arguments are not JSON-serializable") from exc
    if len(encoded) > max(1, int(settings.mcp_tool_args_max_bytes or 0)):
        raise ValueError("MCP tool arguments exceed size limit")


def evaluate_tool_policy(
    settings: MabelSettings,
    *,
    server_slug: str,
    tool_name: str,
    scope: str,
) -> str:
    """Ordered allow|ask|deny policy engine.

    Rules are read from MABEL_MCP_TOOL_POLICY_RULES_JSON. They may use
    ``action``/``resource`` or ``scope``/``server``/``tool`` fields. First match
    wins. The fallback allows reads, asks for create/update, and denies
    delete/admin/unknown operations.
    """
    try:
        raw_rules = json.loads(settings.mcp_tool_policy_rules_json or "[]")
    except json.JSONDecodeError:
        raw_rules = []
    if not isinstance(raw_rules, list):
        raw_rules = []
    resource = f"{server_slug}/{tool_name}"
    for row in raw_rules:
        if not isinstance(row, dict):
            continue
        action = str(row.get("action") or row.get("scope") or "*").strip().lower()
        decision = str(row.get("decision") or "").strip().lower()
        pattern = str(row.get("resource") or row.get("resource_pattern") or "").strip()
        if not pattern:
            server_pattern = str(row.get("server") or "*").strip()
            tool_pattern = str(row.get("tool") or "*").strip()
            pattern = f"{server_pattern}/{tool_pattern}"
        if decision not in {"allow", "ask", "deny"}:
            continue
        if action not in {"*", scope.lower()}:
            continue
        if not fnmatch(resource, pattern):
            continue
        return decision
    fallback = {
        "read": "allow",
        "create": "ask",
        "update": "ask",
        "delete": "deny",
        "admin": "deny",
        "unknown": "deny",
    }
    return fallback.get(scope.strip().lower(), "deny")


def resolve_mcp_endpoint_candidates(settings: MabelSettings, server_slug: str) -> list[tuple[str, dict[str, str], bool]]:
    candidates: list[tuple[str, dict[str, str], bool]] = []
    canonical_slug = canonical_connector_slug(server_slug)
    local_endpoint = LocalMcpRegistry.from_settings(settings).endpoint_for(canonical_slug)
    if local_endpoint:
        candidates.append((local_endpoint, {}, True))

    target = mcp_target_for_server(settings, canonical_slug)
    if target is not None and target.endpoint != local_endpoint:
        candidates.append((target.endpoint, target.headers, False))

    if not candidates:
        raise LookupError(f"No MCP endpoint configured for {server_slug}")
    return candidates


def resolve_mcp_endpoint(settings: MabelSettings, server_slug: str) -> tuple[str, dict[str, str], bool]:
    return resolve_mcp_endpoint_candidates(settings, server_slug)[0]


async def post_mcp_json(
    *,
    endpoint: str,
    payload: dict[str, Any],
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    retryable_error: httpx.RequestError | None = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await client.post(
                    endpoint,
                    json=payload,
                    headers={
                        "Accept": "application/json, text/event-stream",
                        "Content-Type": "application/json",
                        **(headers or {}),
                    },
                )
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                if "json" in content_type:
                    data = response.json()
                else:
                    data = _json_from_sse(response.text)
            break
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 400:
                streamable = await _post_mcp_via_streamable_http(
                    endpoint=endpoint,
                    payload=payload,
                    headers=headers or {},
                    timeout_seconds=timeout_seconds,
                )
                if streamable is not None:
                    data = streamable
                    break
            raise
        except httpx.RequestError as exc:
            retryable_error = exc
            if attempt == 1:
                raise
            continue
    else:  # pragma: no cover
        if retryable_error is not None:
            raise retryable_error
        raise RuntimeError("MCP request failed unexpectedly")
    if not isinstance(data, dict):
        raise ValueError("MCP server returned a non-object JSON response")
    if data.get("error"):
        raise McpJsonRpcError(data["error"])
    return data


async def _post_mcp_via_streamable_http(
    *,
    endpoint: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_seconds: float,
) -> dict[str, Any] | None:
    method = str(payload.get("method") or "")
    request_id = payload.get("id")
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds, headers=headers) as stream_client:
            async with streamable_http_client(endpoint, http_client=stream_client) as (
                read_stream,
                write_stream,
                _get_session_id,
            ):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    if method == "tools/list":
                        result = await session.list_tools()
                        tools: list[dict[str, Any]] = []
                        for tool in result.tools:
                            schema = tool.inputSchema
                            if hasattr(schema, "model_dump"):
                                schema = schema.model_dump()
                            tools.append(
                                {
                                    "name": tool.name,
                                    "description": tool.description,
                                    "inputSchema": schema,
                                }
                            )
                        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}}
                    if method == "tools/call":
                        tool_name = str(params.get("name") or "")
                        tool_args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
                        result = await session.call_tool(tool_name, tool_args)
                        content: list[dict[str, Any]] = []
                        for item in result.content:
                            if hasattr(item, "model_dump"):
                                content.append(item.model_dump())
                            elif isinstance(item, dict):
                                content.append(item)
                            else:
                                content.append({"type": "text", "text": str(item)})
                        out: dict[str, Any] = {"content": content}
                        if result.structuredContent is not None:
                            out["structuredContent"] = result.structuredContent
                        if result.isError is not None:
                            out["isError"] = result.isError
                        return {"jsonrpc": "2.0", "id": request_id, "result": out}
    except Exception:
        return None
    return None


def _json_from_sse(text: str) -> dict[str, Any]:
    frames = text.replace("\r\n", "\n").split("\n\n")
    for frame in frames:
        data_lines = []
        for line in frame.splitlines():
            if line.startswith("data:"):
                data_lines.append(line.removeprefix("data:").strip())
        if not data_lines:
            continue
        raw = "\n".join(data_lines).strip()
        if not raw or raw == "[DONE]":
            continue
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("MCP stream returned a non-object JSON response")
    return parsed


def _catalog_stdio_parameters(server_slug: str, identity_headers: dict[str, str]) -> StdioServerParameters | None:
    slug = canonical_connector_slug(server_slug)
    manifest_path = repo_root() / "packages" / "catalog" / f"connector.{slug}.json"
    if not manifest_path.exists():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    mcp = payload.get("mcp") if isinstance(payload.get("mcp"), dict) else {}
    if str(mcp.get("transport") or "").strip().lower() != "stdio":
        return None
    command = str(mcp.get("command") or "").strip()
    if not command:
        return None
    resolved_command = shutil.which(command)
    if resolved_command is None:
        venv_command = Path(sys.executable).resolve().parent / command
        if venv_command.exists():
            resolved_command = str(venv_command)
    if resolved_command is None:
        mabel_venv_command = repo_root() / ".venv-mabel-api" / "bin" / command
        if mabel_venv_command.exists():
            resolved_command = str(mabel_venv_command)
    args = [str(item) for item in (mcp.get("args") or []) if str(item).strip()]
    env = os.environ.copy()
    mabel_venv_bin = str(repo_root() / ".venv-mabel-api" / "bin")
    env["PATH"] = f"{mabel_venv_bin}{os.pathsep}{env.get('PATH', '')}"
    email = identity_headers.get("x-user-email")
    user_id = identity_headers.get("x-user-id")
    user_name = identity_headers.get("x-user-name")
    user_groups = identity_headers.get("x-user-groups")
    if email:
        env["MABEL_MCP_CONTEXT_EMAIL"] = email
    if user_id:
        env["MABEL_MCP_CONTEXT_USER_ID"] = user_id
    if user_name:
        env["MABEL_MCP_CONTEXT_USER_NAME"] = user_name
    if user_groups:
        env["MABEL_MCP_CONTEXT_GROUPS"] = user_groups
    return StdioServerParameters(
        command=resolved_command or command,
        args=args,
        env=env,
        cwd=str(repo_root()),
    )


async def post_mcp_stdio_json(
    *,
    server_slug: str,
    payload: dict[str, Any],
    identity_headers: dict[str, str],
    timeout_seconds: float = 30.0,
) -> dict[str, Any] | None:
    params = _catalog_stdio_parameters(server_slug, identity_headers)
    if params is None:
        return None
    method = str(payload.get("method") or "")
    request_id = payload.get("id")
    call_params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    try:
        async with asyncio.timeout(timeout_seconds):
            async with stdio_client(params) as (read_stream, write_stream):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    if method == "tools/list":
                        result = await session.list_tools()
                        tools: list[dict[str, Any]] = []
                        for tool in result.tools:
                            schema = tool.inputSchema
                            if hasattr(schema, "model_dump"):
                                schema = schema.model_dump()
                            tools.append(
                                {
                                    "name": tool.name,
                                    "description": tool.description,
                                    "inputSchema": schema,
                                }
                            )
                        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}}
                    if method == "tools/call":
                        tool_name = str(call_params.get("name") or "")
                        tool_args = call_params.get("arguments") if isinstance(call_params.get("arguments"), dict) else {}
                        result = await session.call_tool(tool_name, tool_args)
                        content: list[dict[str, Any]] = []
                        for item in result.content:
                            if hasattr(item, "model_dump"):
                                content.append(item.model_dump())
                            elif isinstance(item, dict):
                                content.append(item)
                            else:
                                content.append({"type": "text", "text": str(item)})
                        out: dict[str, Any] = {"content": content}
                        if result.structuredContent is not None:
                            out["structuredContent"] = result.structuredContent
                        if result.isError is not None:
                            out["isError"] = result.isError
                        return {"jsonrpc": "2.0", "id": request_id, "result": out}
    except Exception:
        return None
    return None
