from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote, urlencode

from ..settings import MabelSettings


@dataclass(frozen=True)
class RemoteGatewayMcpTarget:
    endpoint: str
    headers: dict[str, str]
    source: str = "remote_gateway"


def mcp_target_for_server(settings: MabelSettings, server_slug: str) -> RemoteGatewayMcpTarget | None:
    if settings.mcp_gateway_proxy_base_url:
        base = settings.mcp_gateway_proxy_base_url.rstrip("/")
        query = {"profile": settings.mcp_gateway_profile or "default"}
        if settings.remote_gateway_org:
            query["org"] = settings.remote_gateway_org
        headers: dict[str, str] = {}
        if settings.remote_gateway_runtime_token:
            headers["Authorization"] = f"Bearer {settings.remote_gateway_runtime_token}"
        return RemoteGatewayMcpTarget(
            endpoint=f"{base}/v1/mcp_gateway/{quote(server_slug, safe='')}?{urlencode(query)}",
            headers=headers,
            source="mabel_mcp_gateway",
        )

    if not settings.remote_gateway_api_base_url or not settings.remote_gateway_runtime_token:
        return None

    base = settings.remote_gateway_api_base_url.rstrip("/")
    return RemoteGatewayMcpTarget(
        endpoint=f"{base}/mcp/{server_slug}",
        headers={"Authorization": f"Bearer {settings.remote_gateway_runtime_token}"},
    )
