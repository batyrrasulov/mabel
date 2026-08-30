from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _dotenv_value(name: str) -> str:
    env_path = repo_root() / ".env"
    if not env_path.exists():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#") or "=" not in entry:
            continue
        key, value = entry.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


def _env(name: str, default: str = "") -> str:
    if name in os.environ:
        raw = os.getenv(name, "")
        return raw.strip() if isinstance(raw, str) else ""
    file_value = _dotenv_value(name).strip()
    return file_value or default


def _bool_env(name: str, default: bool = False) -> bool:
    fallback = "true" if default else "false"
    return _env(name, fallback).strip().lower() in {"1", "true", "yes", "on"}


def _first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = _env(name)
        if value:
            return value
    return default


@dataclass(frozen=True)
class MabelSettings:
    service_name: str
    host: str
    port: int
    database_url: str | None
    store_mode: str
    openai_api_key: str | None
    openai_model: str
    openai_agents_enabled: bool
    openai_web_search_enabled: bool
    openai_code_interpreter_enabled: bool
    openai_image_generation_enabled: bool
    openai_session_history_limit: int
    session_db_path: str
    uploads_dir: str
    uploads_max_bytes: int
    trace_include_sensitive_data: bool
    remote_gateway_org: str
    remote_gateway_api_base_url: str | None
    remote_gateway_runtime_token: str | None
    github_token: str | None
    github_repo: str
    skills_github_token: str | None
    skills_github_repo: str
    skills_github_ref: str
    skills_github_base_path: str
    # Map connector slugs to loopback Streamable HTTP endpoints for local development.
    # Remote deployments should use the configured MCP gateway instead.
    local_mcp_endpoints_json: str
    token_prices_json: str
    openai_file_search_enabled: bool = False
    openai_vector_store_ids_json: str = "[]"
    mcp_gateway_proxy_base_url: str | None = None
    mcp_gateway_profile: str = "default"
    mcp_gateway_local_bypass_enabled: bool = False
    mcp_gateway_local_endpoints_json: str = "{}"
    mcp_tool_timeout_seconds: float = 180.0
    mcp_tool_args_max_bytes: int = 200_000
    # Serialized JSON caps for tool payloads returned to the OpenAI agent (session memory).
    # Defaults balance connector payloads against total request size.
    mcp_tool_result_max_chars: int = 14_000
    mcp_tool_list_max_chars: int = 14_000
    memory_tool_payload_max_chars: int = 6_144
    skill_tool_payload_max_chars: int = 16_000
    catalog_tool_payload_max_chars: int = 10_000
    mcp_tool_blocklist_json: str = "[]"
    mcp_tool_policy_rules_json: str = "[]"
    memory_semantic_enabled: bool = True
    memory_pgvector_enabled: bool = True
    memory_embedding_model: str = "text-embedding-3-small"
    memory_embedding_max_chars: int = 8000
    normalized_strict_reads: bool = False

    @classmethod
    def load(cls) -> "MabelSettings":
        return cls(
            service_name="mabel-api",
            host=_env("MABEL_HOST", "127.0.0.1"),
            port=int(_env("MABEL_PORT", "8820")),
            database_url=_env("MABEL_DB_URL") or None,
            store_mode=_env("MABEL_STORE_MODE", "memory").lower(),
            openai_api_key=_env("MABEL_OPENAI_API_KEY") or _env("OPENAI_API_KEY") or None,
            openai_model=_env("MABEL_OPENAI_MODEL", "gpt-5.5"),
            openai_agents_enabled=_bool_env("MABEL_OPENAI_AGENTS_ENABLED", True),
            openai_web_search_enabled=_bool_env("MABEL_OPENAI_WEB_SEARCH_ENABLED", True),
            openai_code_interpreter_enabled=_bool_env("MABEL_OPENAI_CODE_INTERPRETER_ENABLED", True),
            openai_image_generation_enabled=_bool_env("MABEL_OPENAI_IMAGE_GENERATION_ENABLED", False),
            openai_file_search_enabled=_bool_env("MABEL_OPENAI_FILE_SEARCH_ENABLED", False),
            openai_vector_store_ids_json=_env("MABEL_OPENAI_VECTOR_STORE_IDS_JSON", "[]"),
            openai_session_history_limit=int(_env("MABEL_OPENAI_SESSION_HISTORY_LIMIT", "80")),
            session_db_path=_env(
                "MABEL_SESSION_DB_PATH",
                str(repo_root() / "var" / "mabel-sessions.db"),
            ),
            uploads_dir=_env(
                "MABEL_UPLOADS_DIR",
                str(repo_root() / "var" / "mabel-uploads"),
            ),
            uploads_max_bytes=int(_env("MABEL_UPLOADS_MAX_BYTES", str(25 * 1024 * 1024))),
            trace_include_sensitive_data=_bool_env("MABEL_TRACE_INCLUDE_SENSITIVE_DATA", False),
            remote_gateway_org=_env("MABEL_REMOTE_GATEWAY_ORG"),
            remote_gateway_api_base_url=_env("MABEL_REMOTE_GATEWAY_API_BASE_URL") or None,
            remote_gateway_runtime_token=_env("MABEL_REMOTE_GATEWAY_RUNTIME_TOKEN") or None,
            github_token=_first_env("MABEL_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN") or None,
            github_repo=_env("MABEL_GITHUB_REPO", "batyrrasulov/Mabel"),
            skills_github_token=_first_env(
                "MABEL_SKILLS_GITHUB_TOKEN",
                "MABEL_GITHUB_TOKEN",
                "GITHUB_TOKEN",
                "GH_TOKEN",
            )
            or None,
            skills_github_repo=_env("MABEL_SKILLS_GITHUB_REPO", "batyrrasulov/Mabel"),
            skills_github_ref=_env("MABEL_SKILLS_GITHUB_REF", "main"),
            skills_github_base_path=_env("MABEL_SKILLS_GITHUB_BASE_PATH", ""),
            local_mcp_endpoints_json=_first_env(
                "MABEL_LOCAL_MCP_ENDPOINTS_JSON",
                "MABEL_MCP_GATEWAY_LOCAL_ENDPOINTS_JSON",
                default="{}",
            ),
            token_prices_json=_env("MABEL_TOKEN_PRICES_JSON", "{}"),
            mcp_gateway_proxy_base_url=_env("MABEL_MCP_GATEWAY_PROXY_BASE_URL") or None,
            mcp_gateway_profile=_env("MABEL_MCP_GATEWAY_PROFILE", "default"),
            mcp_gateway_local_bypass_enabled=_bool_env(
                "MABEL_MCP_GATEWAY_LOCAL_BYPASS_ENABLED",
                _bool_env("MABEL_MCP_GATEWAY_LOCAL_BYPASS_ENABLED", False),
            ),
            mcp_gateway_local_endpoints_json=_env("MABEL_MCP_GATEWAY_LOCAL_ENDPOINTS_JSON", "{}"),
            mcp_tool_timeout_seconds=float(_env("MABEL_MCP_TOOL_TIMEOUT_SECONDS", "180")),
            mcp_tool_args_max_bytes=int(_env("MABEL_MCP_TOOL_ARGS_MAX_BYTES", "200000")),
            mcp_tool_result_max_chars=int(_env("MABEL_MCP_TOOL_RESULT_MAX_CHARS", "14000")),
            mcp_tool_list_max_chars=int(_env("MABEL_MCP_TOOL_LIST_MAX_CHARS", "14000")),
            memory_tool_payload_max_chars=int(_env("MABEL_MEMORY_TOOL_PAYLOAD_MAX_CHARS", "6144")),
            skill_tool_payload_max_chars=int(_env("MABEL_SKILL_TOOL_PAYLOAD_MAX_CHARS", "16000")),
            catalog_tool_payload_max_chars=int(_env("MABEL_CATALOG_TOOL_PAYLOAD_MAX_CHARS", "10000")),
            mcp_tool_blocklist_json=_env("MABEL_MCP_TOOL_BLOCKLIST_JSON", "[]"),
            mcp_tool_policy_rules_json=_env("MABEL_MCP_TOOL_POLICY_RULES_JSON", "[]"),
            memory_semantic_enabled=_bool_env("MABEL_MEMORY_SEMANTIC_ENABLED", True),
            memory_pgvector_enabled=_bool_env("MABEL_MEMORY_PGVECTOR_ENABLED", True),
            memory_embedding_model=_env("MABEL_MEMORY_EMBEDDING_MODEL", "text-embedding-3-small"),
            memory_embedding_max_chars=int(_env("MABEL_MEMORY_EMBEDDING_MAX_CHARS", "8000")),
            normalized_strict_reads=_bool_env("MABEL_NORMALIZED_STRICT_READS", False),
        )
