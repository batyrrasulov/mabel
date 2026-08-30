from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _sse_payloads(body: str) -> list[dict]:
    payloads: list[dict] = []
    for frame in body.split("\n\n"):
        frame = frame.strip()
        if not frame:
            continue
        data_lines = [line.removeprefix("data:").strip() for line in frame.splitlines() if line.startswith("data:")]
        if data_lines:
            payloads.append(json.loads("\n".join(data_lines)))
    return payloads


def test_chat_stream_persists_messages_and_streams_disabled_runtime_notice(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")

    from mabel_api.main import build_app

    client = TestClient(build_app())

    response = client.post(
        "/api/v1/chat/stream",
        headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"},
        json={"message": "Prep my account meeting", "surface": "chat"},
    )

    assert response.status_code == 200
    payloads = _sse_payloads(response.text)
    # The runtime emits a single token (the "disabled" notice) plus
    # message_done / run_done. The chat route no longer pre-fires a
    # mabel_context tool call — that was noise for every turn including "hi".
    assert [payload["type"] for payload in payloads] == ["run_started", "token", "message_done", "run_done"]
    assert "OpenAI Agents runtime is disabled" in payloads[1]["text"]
    assert payloads[-1]["status"] == "completed"
    # And there are no spurious tool_call events of any kind for trivial turns.
    assert not any(p["type"] == "tool_call" for p in payloads)

    conversations = client.get("/api/v1/conversations", headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"})
    assert conversations.status_code == 200
    items = conversations.json()["conversations"]
    assert len(items) == 1
    assert items[0]["title"] == "Prep my account meeting"
    assert items[0]["message_count"] == 2


def test_chat_stream_accepts_attachment_only_turn(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")
    monkeypatch.setenv("MABEL_UPLOADS_DIR", str(tmp_path / "uploads"))

    from mabel_api.main import build_app

    client = TestClient(build_app())
    headers = {"x-user-email": "agent@example.com", "x-user-id": "agent-1"}
    upload = client.post(
        "/api/v1/uploads",
        headers=headers,
        files={"files": ("notes.txt", b"hello mabel", "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    file_id = upload.json()["files"][0]["id"]

    response = client.post(
        "/api/v1/chat/stream",
        headers=headers,
        json={"message": "", "surface": "chat", "attachments": [{"id": file_id}]},
    )

    assert response.status_code == 200, response.text
    payloads = _sse_payloads(response.text)
    assert any(item["type"] == "tool_call" and item["tool_name"] == "file_read" for item in payloads)


def test_chat_stream_uses_openai_runtime_event_adapter_when_enabled(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "true")
    monkeypatch.setenv("MABEL_OPENAI_API_KEY", "test-key")

    from mabel_api.agents import runtime
    from mabel_api.main import build_app

    async def fake_openai_stream(*, message: str, **_: object):
        yield {"type": "token", "text": f"handled: {message}"}
        yield {"type": "tool_call", "tool_name": "mabel_search", "arguments": {"q": message}}
        yield {"type": "tool_result", "tool_name": "mabel_search", "output_preview": "source-backed result"}

    monkeypatch.setattr(runtime, "run_openai_agents_stream", fake_openai_stream)

    client = TestClient(build_app())
    response = client.post(
        "/api/v1/chat/stream",
        headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"},
        json={"message": "Find source-backed context", "surface": "rag"},
    )

    assert response.status_code == 200
    payloads = _sse_payloads(response.text)
    # No pre-fired mabel_context — only what the (faked) runtime yields plus
    # the framing events.
    assert [payload["type"] for payload in payloads] == [
        "run_started",
        "token",
        "tool_call",
        "tool_result",
        "message_done",
        "run_done",
    ]
    assert payloads[1]["text"] == "handled: Find source-backed context"
    assert payloads[2]["tool_name"] == "mabel_search"

    usage = client.get("/api/v1/usage/summary", headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"})
    assert usage.status_code == 200
    assert usage.json()["totals"]["requests"] == 1
    assert usage.json()["totals"]["total_tokens"] > 0


def test_usage_summary_force_all_env_expands_scope_for_non_approver(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")
    monkeypatch.setenv("MABEL_STORE_MODE", "memory")
    monkeypatch.setenv("MABEL_USAGE_FORCE_ALL", "true")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    client.post(
        "/api/v1/chat/stream",
        headers={"x-user-email": "marco.burgarello@example.com", "x-user-id": "marco-1"},
        json={"message": "run one", "surface": "chat"},
    )
    client.post(
        "/api/v1/chat/stream",
        headers={"x-user-email": "ayush.kumar@example.com", "x-user-id": "ayush-1"},
        json={"message": "run two", "surface": "chat"},
    )

    usage = client.get(
        "/api/v1/usage/summary",
        headers={"x-user-email": "reviewer@example.com", "x-user-id": "reviewer-1"},
    )

    assert usage.status_code == 200
    payload = usage.json()
    assert payload["scope"] == "all"
    leaderboard_emails = {row["user_email"] for row in payload["leaderboard"]}
    assert "marco.burgarello@example.com" in leaderboard_emails
    assert "ayush.kumar@example.com" in leaderboard_emails


def test_conversation_messages_endpoint_returns_thread_and_enforces_ownership(monkeypatch) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    response = client.post(
        "/api/v1/chat/stream",
        headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"},
        json={"message": "Thread check", "surface": "chat"},
    )
    assert response.status_code == 200

    conversations = client.get("/api/v1/conversations", headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"})
    conversation_id = conversations.json()["conversations"][0]["id"]

    messages = client.get(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"},
    )
    assert messages.status_code == 200
    payload = messages.json()
    assert payload["conversation"]["id"] == conversation_id
    assert [item["role"] for item in payload["messages"]] == ["user", "assistant"]
    assert payload["messages"][0]["content"] == "Thread check"
    assert "tool_calls" in payload
    tool_calls = payload["tool_calls"]
    assert isinstance(tool_calls, list)
    # When the runtime is disabled and the user's turn doesn't need any tool,
    # the persisted tool_calls list is empty — no spurious mabel_context row.
    assert tool_calls == []
    # files list is empty too — no attachments, no agent files.
    assert payload.get("files") == []

    forbidden = client.get(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers={"x-user-email": "other@example.com", "x-user-id": "other-1"},
    )
    assert forbidden.status_code == 403


def test_runtime_uses_per_conversation_session_for_memory(monkeypatch, tmp_path) -> None:
    """The runtime must hand a per-conversation SQLiteSession to Runner.run_streamed
    so prior turns are auto-prepended to the model input. This is what makes the
    agent remember earlier messages without us hand-rolling input lists."""

    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    # Capture every kwarg passed into Runner.run_streamed so we can assert the
    # session was attached and is the same instance for the same conversation.
    captured: list[dict] = []

    class _FakeStream:
        async def stream_events(self):  # pragma: no cover - drained, no yields
            if False:
                yield None

        interruptions = []

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            captured.append(kwargs)
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeSessionSettings:
        def __init__(self, limit=None):
            self.limit = limit

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.SessionSettings = _FakeSessionSettings
    fake_module.function_tool = _fake_function_tool

    class _FakeSQLiteSession:
        def __init__(self, session_id: str, db_path: str):
            self.session_id = session_id
            self.db_path = db_path
            Path(db_path).touch()

    fake_module.SQLiteSession = _FakeSQLiteSession

    fake_responses_module = type(sys)("openai.types.responses")

    class _FakeDelta:
        pass

    fake_responses_module.ResponseTextDeltaEvent = _FakeDelta
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type(
        "ResponseOutputTextAnnotationAddedEvent", (), {}
    )

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    db_path = tmp_path / "rs.db"
    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=10,
        session_db_path=str(db_path),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    # Reset the runtime's session cache between subtests for isolation.
    runtime_module._SESSION_CACHE.clear()

    async def _drain(cid: int, message: str) -> None:
        async for _ in runtime_module.run_openai_agents_stream(
            message=message,
            settings=settings,
            conversation_id=cid,
        ):
            pass

    asyncio.run(_drain(101, "hello one"))
    asyncio.run(_drain(101, "hello two"))
    asyncio.run(_drain(202, "different convo"))

    assert len(captured) == 3, "Runner.run_streamed should run once per chat turn"
    sessions = [c.get("session") for c in captured]
    assert all(s is not None for s in sessions), "every run must carry a session"

    # Same conversation_id → same SQLiteSession instance (the cache key
    # guarantees memory persists across turns).
    assert sessions[0] is sessions[1]
    # Different conversation_id → different session (isolation).
    assert sessions[2] is not sessions[0]

    # The on-disk DB has been initialized for both sessions.
    assert db_path.exists()

    # SessionSettings.limit was forwarded from settings.openai_session_history_limit.
    rc = captured[0].get("run_config")
    assert rc is not None
    rc_kwargs = getattr(rc, "kwargs", {})
    assert rc_kwargs.get("session_settings") is not None
    assert rc_kwargs["session_settings"].limit == 10


def test_runtime_appends_custom_instructions_without_replacing_tool_guide(monkeypatch, tmp_path) -> None:
    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    captured_agents: list[dict] = []

    class _FakeStream:
        async def stream_events(self):  # pragma: no cover - drained, no yields
            if False:
                yield None

        interruptions = []

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            captured_agents.append(kwargs)

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeSessionSettings:
        def __init__(self, limit=None):
            self.limit = limit

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.SessionSettings = _FakeSessionSettings
    fake_module.function_tool = _fake_function_tool

    class _FakeSQLiteSession:
        def __init__(self, session_id: str, db_path: str):
            self.session_id = session_id
            self.db_path = db_path
            Path(db_path).touch()

    fake_module.SQLiteSession = _FakeSQLiteSession

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type(
        "ResponseOutputTextAnnotationAddedEvent", (), {}
    )

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_agents_enabled=True,
        openai_api_key="test-key",
        openai_model="gpt-test",
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "rs.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    runtime_module._SESSION_CACHE.clear()

    async def _drain() -> None:
        async for _ in runtime_module.run_openai_agents_stream(
            message="America/Los_Angeles",
            settings=settings,
            conversation_id=42,
            instructions="Use mabel_create_scheduled_task after the user gives timezone.",
        ):
            pass

    asyncio.run(_drain())

    assert captured_agents, "Agent should be constructed"
    instructions = captured_agents[-1]["instructions"]
    assert "Create workflows and schedules only when requested." in instructions
    assert "Additional run instructions:" in instructions
    assert "Use mabel_create_scheduled_task after the user gives timezone." in instructions


def test_runtime_wires_web_search_and_code_interpreter_when_enabled(monkeypatch, tmp_path) -> None:
    """When the feature flags are on and the installed SDK exposes the hosted
    tools, the agent's tools list must include them. When flags are off they
    must be absent. This is the gate that keeps ChatGPT-equivalent tools wired
    instead of the model saying 'I don't have access'."""

    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    captured_agents: list[dict] = []

    class _FakeStream:
        async def stream_events(self):  # pragma: no cover - drained
            if False:
                yield None

        interruptions = []

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            captured_agents.append({"tools": list(getattr(agent, "tools", []))})
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            self.tools = list(kwargs.get("tools", []))

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeSessionSettings:
        def __init__(self, limit=None):
            self.limit = limit

    class _MarkedTool:
        def __init__(self, kind, **kw):
            self.kind = kind
            self.kw = kw

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.SessionSettings = _FakeSessionSettings
    fake_module.function_tool = _fake_function_tool
    fake_module.WebSearchTool = lambda **kw: _MarkedTool("web_search", **kw)
    fake_module.CodeInterpreterTool = lambda tool_config=None, **kw: _MarkedTool(
        "code_interpreter", tool_config=tool_config, **kw
    )
    fake_module.ImageGenerationTool = lambda tool_config=None, **kw: _MarkedTool(
        "image_generation", tool_config=tool_config, **kw
    )

    class _FakeSQLiteSession:
        def __init__(self, session_id: str, db_path: str):
            self.session_id = session_id
            self.db_path = db_path
            Path(db_path).touch()

    fake_module.SQLiteSession = _FakeSQLiteSession

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    def _settings(*, web: bool, code: bool, image: bool) -> MabelSettings:
        return MabelSettings(
            service_name="mabel-api",
            host="127.0.0.1",
            port=8820,
            database_url=None,
            store_mode="memory",
            openai_api_key="sk-test",
            openai_model="gpt-5.5",
            openai_agents_enabled=True,
            openai_web_search_enabled=web,
            openai_code_interpreter_enabled=code,
            openai_image_generation_enabled=image,
            openai_session_history_limit=0,
            session_db_path=str(tmp_path / f"rs_{web}{code}{image}.db"),
            uploads_dir=str(tmp_path / "uploads"),
            uploads_max_bytes=10 * 1024 * 1024,
            trace_include_sensitive_data=False,
            remote_gateway_org="",
            remote_gateway_api_base_url=None,
            remote_gateway_runtime_token=None,
            github_token=None,
            github_repo="batyrrasulov/Mabel",
            skills_github_token=None,
            skills_github_repo="batyrrasulov/Mabel",
            skills_github_ref="main",
            skills_github_base_path="",
            local_mcp_endpoints_json="{}",
            token_prices_json="{}",
        )

    async def _drain(settings: MabelSettings) -> None:
        async for _ in runtime_module.run_openai_agents_stream(
            message="trigger",
            settings=settings,
            conversation_id=None,
        ):
            pass

    runtime_module._SESSION_CACHE.clear()
    captured_agents.clear()

    # All hosted tools enabled.
    asyncio.run(_drain(_settings(web=True, code=True, image=True)))
    tools_full = captured_agents[-1]["tools"]
    kinds_full = {getattr(t, "kind", None) for t in tools_full}
    function_names = {getattr(t, "__name__", "") for t in tools_full}
    assert "web_search" in kinds_full
    assert "code_interpreter" in kinds_full
    assert "image_generation" in kinds_full
    assert "mabel_create_scheduled_task" in function_names
    assert "mabel_build_execution_plan" in function_names

    # None enabled.
    asyncio.run(_drain(_settings(web=False, code=False, image=False)))
    tools_none = captured_agents[-1]["tools"]
    kinds_none = {getattr(t, "kind", None) for t in tools_none}
    assert "web_search" not in kinds_none
    assert "code_interpreter" not in kinds_none
    assert "image_generation" not in kinds_none

    # Selective: only code_interpreter on.
    asyncio.run(_drain(_settings(web=False, code=True, image=False)))
    tools_partial = captured_agents[-1]["tools"]
    kinds_partial = {getattr(t, "kind", None) for t in tools_partial}
    assert kinds_partial == {"code_interpreter"} | {k for k in kinds_partial if k is None}


def test_runtime_extracts_connector_artifact_paths_for_file_chips() -> None:
    from mabel_api.agents.runtime import _artifact_refs_from_payload

    refs = _artifact_refs_from_payload(
        {
            "status": "ok",
            "export": {
                "artifact_path": "/Users/example/.cache/connector-cache/result.docx",
                "file_name": "result.docx",
            },
        }
    )

    assert refs == [
        {
            "path": "/Users/example/.cache/connector-cache/result.docx",
            "name": "result.docx",
            "mime": "",
        }
    ]


def test_runtime_detects_failed_mcp_content_payloads() -> None:
    from mabel_api.agents.runtime import _mcp_failure_message

    payload = {
        "content": [
            {
                "type": "text",
                "text": '{"success": false, "error": "max_workers must be greater than 0"}',
            }
        ]
    }

    assert _mcp_failure_message(payload) == "max_workers must be greater than 0"


def test_identity_headers_sets_user_subject_for_hosted_mcp_writes() -> None:
    """Hosted MCPs can bind groups to an explicit user subject."""
    from mabel_api.agents.runtime import _identity_headers

    h = _identity_headers({"email": "a@b.com", "user_id": "u-42", "groups": ["writers"]})
    assert h.get("x-user-subject") == "user_id:u-42"
    assert "writers" in (h.get("x-user-groups") or "")

    h2 = _identity_headers({"email": "only@b.com", "groups": []})
    assert h2.get("x-user-subject") == "user_email:only@b.com"

    h3 = _identity_headers({"subject": "jwt-sub-9", "email": "x@y.com"})
    assert h3.get("x-user-subject") == "jwt-sub-9"


def test_runtime_resolves_pending_tool_calls_at_end_of_stream(monkeypatch, tmp_path) -> None:
    """Hosted tools like web_search don't always emit a tool_call_output_item.
    The runtime must synthesize a tool_result so the UI doesn't display the
    tool stuck in "Running" forever after the run ends."""

    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    class _FakeRawItem:
        def __init__(self, name: str, call_id: str):
            self.type = f"{name}_call"
            self.name = name
            self.call_id = call_id
            self.arguments = {}

    class _FakeItem:
        def __init__(self, name: str, call_id: str):
            self.type = "tool_call_item"
            self.raw_item = _FakeRawItem(name, call_id)
            self.name = name

    class _FakeStreamEvent:
        def __init__(self, kind: str, item=None):
            self.type = kind
            self.item = item
            self.data = None

    class _FakeStream:
        async def stream_events(self):
            # Two tool calls fire but never get matching tool_call_output_items.
            yield _FakeStreamEvent("run_item_stream_event", _FakeItem("web_search", "c1"))
            yield _FakeStreamEvent("run_item_stream_event", _FakeItem("file_search", "c2"))

        interruptions = []

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeSessionSettings:
        def __init__(self, limit=None):
            self.limit = limit

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.SessionSettings = _FakeSessionSettings
    fake_module.function_tool = _fake_function_tool

    class _FakeSQLiteSession:
        def __init__(self, session_id: str, db_path: str):
            self.session_id = session_id
            self.db_path = db_path
            Path(db_path).touch()

    fake_module.SQLiteSession = _FakeSQLiteSession

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "rs.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    runtime_module._SESSION_CACHE.clear()

    async def _drain() -> list[dict]:
        events: list[dict] = []
        async for event in runtime_module.run_openai_agents_stream(
            message="check",
            settings=settings,
            conversation_id=None,
        ):
            events.append(event)
        return events

    events = asyncio.run(_drain())
    types = [e["type"] for e in events]
    # Two tool_calls fired, two tool_results synthesized at end-of-stream.
    assert types.count("tool_call") == 2
    assert types.count("tool_result") == 2
    names_called = [e["tool_name"] for e in events if e["type"] == "tool_call"]
    names_done = [e["tool_name"] for e in events if e["type"] == "tool_result"]
    assert names_called == ["web_search", "file_search"]
    assert sorted(names_done) == sorted(["web_search", "file_search"])


def test_runtime_harvests_web_search_sources_from_completed_raw_item(monkeypatch, tmp_path) -> None:
    """The Responses stream can complete a web_search with real
    `action.sources` while the synthetic tool_result preview remains empty.
    Mabel must still emit source chips instead of leaving the UI with a dead
    "searched" accordion."""

    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    class _FakeAction:
        def __init__(self, *, sources):
            self.type = "search"
            self.query = None
            self.queries = ["weather: United States, New York, New York City"]
            self.sources = sources

    class _FakeSource:
        def __init__(self, url: str, title: str):
            self.type = "url"
            self.url = url
            self.title = title

    class _InitialWebSearchRaw:
        type = "web_search_call"
        name = "web_search"
        call_id = "call_web"
        arguments = {}
        action = _FakeAction(sources=None)

    class _CompletedWebSearchRaw:
        type = "web_search_call"
        id = "call_web"
        action = _FakeAction(
            sources=[
                _FakeSource("https://forecast.weather.gov/MapClick.php?lat=40.71&lon=-74.01", "National Weather Service"),
                {"url": "https://weather.com/weather/today/l/New+York+NY", "title": "Weather.com"},
            ]
        )

    class _FakeItem:
        type = "tool_call_item"
        raw_item = _InitialWebSearchRaw()
        name = "web_search"

    class _FakeStreamEvent:
        def __init__(self, kind: str, *, item=None, data=None):
            self.type = kind
            self.item = item
            self.data = data

    class _FakeItemDoneEvent:
        def __init__(self, item):
            self.item = item

    class _FakeStream:
        interruptions = []

        async def stream_events(self):
            yield _FakeStreamEvent("run_item_stream_event", item=_FakeItem())
            yield _FakeStreamEvent("raw_response_event", data=_FakeItemDoneEvent(_CompletedWebSearchRaw()))

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.function_tool = _fake_function_tool

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})
    fake_responses_module.ResponseOutputItemDoneEvent = _FakeItemDoneEvent

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "sources.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    async def _drain() -> list[dict]:
        events: list[dict] = []
        async for event in runtime_module.run_openai_agents_stream(message="weather", settings=settings):
            events.append(event)
        return events

    events = asyncio.run(_drain())
    source_events = [event for event in events if event["type"] == "sources"]
    assert source_events
    urls = [source["url"] for source in source_events[-1]["sources"]]
    assert "https://forecast.weather.gov/MapClick.php?lat=40.71&lon=-74.01" in urls
    assert "https://weather.com/weather/today/l/New+York+NY" in urls
    web_result = next(event for event in events if event["type"] == "tool_result" and event["tool_name"] == "web_search")
    assert web_result["output_preview"].startswith("Sources: ")
    assert "forecast.weather.gov" in web_result["output_preview"]


def test_runtime_emits_provider_source_for_weather_api(monkeypatch, tmp_path) -> None:
    """OpenAI's weather search path currently returns a provider-only source
    (`type=api`, `name=oai-weather`) with no URL annotations. Mabel should
    render that as a clean provider chip, not a raw "Sources: oai-weather"
    text row."""

    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    class _FakeAction:
        type = "search"
        query = None
        queries = ["weather: USA, New York, New York"]
        sources = [{"type": "api", "url": None, "name": "oai-weather"}]

    class _InitialWebSearchRaw:
        type = "web_search_call"
        name = "web_search"
        call_id = "call_weather"
        arguments = {}
        action = _FakeAction()

    class _CompletedWebSearchRaw:
        type = "web_search_call"
        id = "call_weather"
        action = _FakeAction()

    class _FakeItem:
        type = "tool_call_item"
        raw_item = _InitialWebSearchRaw()
        name = "web_search"

    class _FakeStreamEvent:
        def __init__(self, kind: str, *, item=None, data=None):
            self.type = kind
            self.item = item
            self.data = data

    class _FakeItemDoneEvent:
        def __init__(self, item):
            self.item = item

    class _FakeStream:
        interruptions = []

        async def stream_events(self):
            yield _FakeStreamEvent("run_item_stream_event", item=_FakeItem())
            yield _FakeStreamEvent("raw_response_event", data=_FakeItemDoneEvent(_CompletedWebSearchRaw()))

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.function_tool = _fake_function_tool

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})
    fake_responses_module.ResponseOutputItemDoneEvent = _FakeItemDoneEvent

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "weather-sources.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    async def _drain() -> list[dict]:
        events: list[dict] = []
        async for event in runtime_module.run_openai_agents_stream(message="weather", settings=settings):
            events.append(event)
        return events

    events = asyncio.run(_drain())
    source_events = [event for event in events if event["type"] == "sources"]
    assert source_events
    assert source_events[-1]["sources"] == [
        {"url": "https://www.accuweather.com/en/search-locations?query=USA%2C+New+York%2C+New+York", "title": "AccuWeather"},
        {"url": "https://forecast.weather.gov/zipcity.php?inputstring=USA%2C+New+York%2C+New+York", "title": "National Weather Service"},
        {"url": "https://weather.com/weather/today/l/USA%2C+New+York%2C+New+York", "title": "The Weather Channel"},
    ]
    web_result = next(event for event in events if event["type"] == "tool_result" and event["tool_name"] == "web_search")
    assert web_result["output_preview"] == ""


def test_runtime_emits_generic_provider_source_fallback_urls(monkeypatch, tmp_path) -> None:
    """When web_search returns provider-only source metadata for non-weather
    providers, Mabel should still emit deterministic query-result links."""

    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    class _FakeAction:
        type = "search"
        query = "latest ai governance updates"
        queries = ["latest ai governance updates"]
        sources = [{"type": "api", "url": None, "name": "oai-web"}]

    class _InitialWebSearchRaw:
        type = "web_search_call"
        name = "web_search"
        call_id = "call_generic_provider"
        arguments = {}
        action = _FakeAction()

    class _CompletedWebSearchRaw:
        type = "web_search_call"
        id = "call_generic_provider"
        action = _FakeAction()

    class _FakeItem:
        type = "tool_call_item"
        raw_item = _InitialWebSearchRaw()
        name = "web_search"

    class _FakeStreamEvent:
        def __init__(self, kind: str, *, item=None, data=None):
            self.type = kind
            self.item = item
            self.data = data

    class _FakeItemDoneEvent:
        def __init__(self, item):
            self.item = item

    class _FakeStream:
        interruptions = []

        async def stream_events(self):
            yield _FakeStreamEvent("run_item_stream_event", item=_FakeItem())
            yield _FakeStreamEvent("raw_response_event", data=_FakeItemDoneEvent(_CompletedWebSearchRaw()))

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.function_tool = _fake_function_tool

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})
    fake_responses_module.ResponseOutputItemDoneEvent = _FakeItemDoneEvent

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "generic-sources.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    async def _drain() -> list[dict]:
        events: list[dict] = []
        async for event in runtime_module.run_openai_agents_stream(message="search", settings=settings):
            events.append(event)
        return events

    events = asyncio.run(_drain())
    source_events = [event for event in events if event["type"] == "sources"]
    assert source_events
    assert source_events[-1]["sources"] == [
        {"url": "https://duckduckgo.com/?q=latest+ai+governance+updates", "title": "DuckDuckGo results"},
        {"url": "https://www.bing.com/search?q=latest+ai+governance+updates", "title": "Bing results"},
    ]


def test_runtime_emits_generic_fallback_even_without_sources_array(monkeypatch, tmp_path) -> None:
    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    class _FakeAction:
        type = "search"
        query = "federal reserve rate decision today"
        queries = ["federal reserve rate decision today"]
        sources = None

    class _InitialWebSearchRaw:
        type = "web_search_call"
        name = "web_search"
        call_id = "call_generic_no_sources"
        arguments = {}
        action = _FakeAction()

    class _CompletedWebSearchRaw:
        type = "web_search_call"
        id = "call_generic_no_sources"
        action = _FakeAction()

    class _FakeItem:
        type = "tool_call_item"
        raw_item = _InitialWebSearchRaw()
        name = "web_search"

    class _FakeStreamEvent:
        def __init__(self, kind: str, *, item=None, data=None):
            self.type = kind
            self.item = item
            self.data = data

    class _FakeItemDoneEvent:
        def __init__(self, item):
            self.item = item

    class _FakeStream:
        interruptions = []

        async def stream_events(self):
            yield _FakeStreamEvent("run_item_stream_event", item=_FakeItem())
            yield _FakeStreamEvent("raw_response_event", data=_FakeItemDoneEvent(_CompletedWebSearchRaw()))

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.function_tool = _fake_function_tool

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})
    fake_responses_module.ResponseOutputItemDoneEvent = _FakeItemDoneEvent

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "generic-sources-no-array.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    async def _drain() -> list[dict]:
        events: list[dict] = []
        async for event in runtime_module.run_openai_agents_stream(message="search", settings=settings):
            events.append(event)
        return events

    events = asyncio.run(_drain())
    source_events = [event for event in events if event["type"] == "sources"]
    assert source_events
    assert source_events[-1]["sources"] == [
        {"url": "https://duckduckgo.com/?q=federal+reserve+rate+decision+today", "title": "DuckDuckGo results"},
        {"url": "https://www.bing.com/search?q=federal+reserve+rate+decision+today", "title": "Bing results"},
    ]


def test_runtime_emits_sdk_context_usage(monkeypatch, tmp_path) -> None:
    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    class _FakeStream:
        context_wrapper = type(
            "ContextWrapper",
            (),
            {"usage": {"input_tokens": 12, "output_tokens": 5, "total_tokens": 17}},
        )()
        interruptions = []

        async def stream_events(self):
            if False:
                yield None

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.function_tool = _fake_function_tool

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "usage.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    async def _drain() -> list[dict]:
        events: list[dict] = []
        async for event in runtime_module.run_openai_agents_stream(message="usage", settings=settings):
            events.append(event)
        return events

    events = asyncio.run(_drain())
    usage = next(event["usage"] for event in events if event["type"] == "usage")
    assert usage == {"input_tokens": 12, "output_tokens": 5, "total_tokens": 17}


def test_runtime_adds_remote_gateway_hosted_mcp_tools_when_configured(monkeypatch, tmp_path) -> None:
    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.db import get_store, reset_store
    from mabel_api.models import ConnectorSnapshot
    from mabel_api.settings import MabelSettings

    captured_tools: list[object] = []

    class _FakeStream:
        interruptions = []

        async def stream_events(self):
            if False:
                yield None

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            captured_tools.extend(getattr(agent, "tools", []))
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            self.tools = list(kwargs.get("tools", []))

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeHostedMCPTool:
        def __init__(self, *, tool_config, on_approval_request=None):
            self.tool_config = tool_config
            self.on_approval_request = on_approval_request

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.HostedMCPTool = _FakeHostedMCPTool
    fake_module.function_tool = _fake_function_tool

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "mcp.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="mabel-labs",
        remote_gateway_api_base_url="https://remote_gateway.example",
        remote_gateway_runtime_token="runtime-token",
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    reset_store()
    get_store(settings).upsert_connector_snapshot(
        ConnectorSnapshot(
            org_slug="mabel-labs",
            server_slug="salesforce",
            name="Salesforce",
            connection_status="remote_gateway_available",
            tools=[],
            enabled=True,
        )
    )

    async def _drain() -> None:
        async for _ in runtime_module.run_openai_agents_stream(
            message="account context",
            settings=settings,
            user_identity={"email": "agent@example.com", "user_id": "u-1"},
        ):
            pass

    asyncio.run(_drain())
    hosted = [tool for tool in captured_tools if isinstance(tool, _FakeHostedMCPTool)]
    assert len(hosted) == 1
    assert hosted[0].tool_config["type"] == "mcp"
    assert hosted[0].tool_config["server_label"] == "salesforce"
    assert hosted[0].tool_config["server_url"] == "https://remote_gateway.example/mcp/salesforce"
    assert hosted[0].tool_config["headers"]["Authorization"] == "Bearer runtime-token"
    assert hosted[0].tool_config["headers"]["x-user-email"] == "agent@example.com"
    assert hosted[0].tool_config["require_approval"] == "always"
    approval = hosted[0].on_approval_request(type("Req", (), {"data": type("Data", (), {"name": "list_accounts"})()})())
    assert approval == {"approve": True}
    mutating = hosted[0].on_approval_request(type("Req", (), {"data": type("Data", (), {"name": "update_account"})()})())
    assert mutating == {
        "approve": False,
        "reason": "Mabel policy requires an explicit approval record.",
    }


def test_uploads_endpoint_persists_file_and_serves_back(monkeypatch, tmp_path) -> None:
    """Round-trip: POST a file to /uploads, fetch it back via GET /files/{id},
    and verify it's bound to the owner so another user can't grab it."""

    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")
    monkeypatch.setenv("MABEL_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("MABEL_OPENAI_API_KEY", "")

    from mabel_api.main import build_app

    client = TestClient(build_app())

    owner_headers = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}
    other_headers = {"x-user-email": "intruder@example.com", "x-user-id": "intruder-1"}

    response = client.post(
        "/api/v1/uploads",
        headers=owner_headers,
        files={"files": ("notes.txt", b"hello mabel", "text/plain")},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "files" in payload
    assert len(payload["files"]) == 1
    record = payload["files"][0]
    file_id = record["id"]
    assert record["name"] == "notes.txt"
    assert record["mime_type"] == "text/plain"
    assert record["size_bytes"] == len(b"hello mabel")
    assert record["source"] == "user_upload"

    # Owner can fetch the bytes back.
    fetch = client.get(f"/api/v1/files/{file_id}", headers=owner_headers)
    assert fetch.status_code == 200
    assert fetch.content == b"hello mabel"

    # Another user is forbidden.
    forbidden = client.get(f"/api/v1/files/{file_id}", headers=other_headers)
    assert forbidden.status_code == 403

    # Metadata endpoint matches.
    meta = client.get(f"/api/v1/files/{file_id}/meta", headers=owner_headers)
    assert meta.status_code == 200
    body = meta.json()
    assert body["name"] == "notes.txt"
    assert body["size_bytes"] == len(b"hello mabel")


def test_office_file_preview_uses_pandoc_and_owner_auth(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")
    monkeypatch.setenv("MABEL_UPLOADS_DIR", str(tmp_path / "uploads"))

    from mabel_api.main import build_app
    from mabel_api.routes import files as files_module

    def fake_run(args, *, capture_output, check, text, timeout):
        assert args[0] == "/usr/bin/pandoc"
        assert args[-3:] == ["-t", "html", "--standalone"]
        stdout = "<html><body><header id=\"title-block-header\"><h1 class=\"title\">Launch Doc</h1></header><p>Ready.</p></body></html>"
        return type("Completed", (), {"returncode": 0, "stdout": stdout, "stderr": ""})()

    monkeypatch.setattr(files_module.shutil, "which", lambda name: "/usr/bin/pandoc" if name == "pandoc" else None)
    monkeypatch.setattr(files_module.subprocess, "run", fake_run)

    client = TestClient(build_app())
    owner_headers = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}
    upload = client.post(
        "/api/v1/uploads",
        headers=owner_headers,
        files={"files": ("launch.docx", b"fake-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )
    assert upload.status_code == 200
    file_id = upload.json()["files"][0]["id"]

    preview = client.get(f"/api/v1/files/{file_id}/preview", headers=owner_headers)
    assert preview.status_code == 200
    assert "Launch Doc" in preview.text
    assert "title-block-header" in preview.text
    assert "<main class=\"page\">" in preview.text

    forbidden = client.get(f"/api/v1/files/{file_id}/preview", headers={"x-user-email": "other@example.com", "x-user-id": "other-1"})
    assert forbidden.status_code == 403


def test_office_file_pdf_preview_uses_soffice_and_owner_auth(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")
    monkeypatch.setenv("MABEL_UPLOADS_DIR", str(tmp_path / "uploads"))

    from mabel_api.main import build_app
    from mabel_api.routes import files as files_module

    run_calls = {"count": 0}

    def fake_run(args, *, capture_output, check, text, timeout):
        run_calls["count"] += 1
        assert args[0] == "/usr/bin/soffice"
        assert "--convert-to" in args
        assert "pdf" in args
        outdir = Path(args[args.index("--outdir") + 1])
        source = Path(args[-1])
        (outdir / f"{source.stem}.pdf").write_bytes(b"%PDF-1.4 fake")
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(files_module.shutil, "which", lambda name: "/usr/bin/soffice" if name in {"soffice", "libreoffice"} else None)
    monkeypatch.setattr(files_module.subprocess, "run", fake_run)

    client = TestClient(build_app())
    owner_headers = {"x-user-email": "owner@example.com", "x-user-id": "owner-1"}
    upload = client.post(
        "/api/v1/uploads",
        headers=owner_headers,
        files={"files": ("launch.docx", b"fake-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )
    assert upload.status_code == 200
    file_id = upload.json()["files"][0]["id"]

    preview = client.get(f"/api/v1/files/{file_id}/preview/pdf", headers=owner_headers)
    assert preview.status_code == 200
    assert preview.headers.get("content-type", "").startswith("application/pdf")
    assert preview.content.startswith(b"%PDF")
    preview_cached = client.get(f"/api/v1/files/{file_id}/preview/pdf", headers=owner_headers)
    assert preview_cached.status_code == 200
    assert preview_cached.content.startswith(b"%PDF")
    assert run_calls["count"] == 1

    forbidden = client.get(f"/api/v1/files/{file_id}/preview/pdf", headers={"x-user-email": "other@example.com", "x-user-id": "other-1"})
    assert forbidden.status_code == 403


def test_uploads_size_limit_returns_413(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("MABEL_OPENAI_AGENTS_ENABLED", "false")
    monkeypatch.setenv("MABEL_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("MABEL_UPLOADS_MAX_BYTES", "16")

    from mabel_api.main import build_app

    client = TestClient(build_app())
    response = client.post(
        "/api/v1/uploads",
        headers={"x-user-email": "owner@example.com", "x-user-id": "owner-1"},
        files={"files": ("big.bin", b"x" * 32, "application/octet-stream")},
    )
    assert response.status_code == 413


def test_runtime_builds_multimodal_input_when_attachments_present(monkeypatch, tmp_path) -> None:
    """When user attachments arrive with an OpenAI file_id, the runtime must
    build a list-of-content-parts input with input_file or input_image entries
    plus the original text — same shape OpenAI's Responses API expects."""

    import asyncio

    from mabel_api.agents import runtime as runtime_module
    from mabel_api.settings import MabelSettings

    captured: list[dict] = []

    class _FakeStream:
        async def stream_events(self):  # pragma: no cover - drained
            if False:
                yield None

        interruptions = []

    class _FakeRunner:
        @staticmethod
        def run_streamed(agent, **kwargs):
            captured.append(kwargs)
            return _FakeStream()

    class _FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

    class _FakeRunConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeSessionSettings:
        def __init__(self, limit=None):
            self.limit = limit

    def _fake_function_tool(fn):
        return fn

    fake_module = type(sys)("agents")
    fake_module.Agent = _FakeAgent
    fake_module.Runner = _FakeRunner
    fake_module.RunConfig = _FakeRunConfig
    fake_module.SessionSettings = _FakeSessionSettings
    fake_module.function_tool = _fake_function_tool

    class _FakeSQLiteSession:
        def __init__(self, session_id: str, db_path: str):
            self.session_id = session_id
            self.db_path = db_path
            Path(db_path).touch()

    fake_module.SQLiteSession = _FakeSQLiteSession

    fake_responses_module = type(sys)("openai.types.responses")
    fake_responses_module.ResponseTextDeltaEvent = type("ResponseTextDeltaEvent", (), {})
    fake_responses_module.ResponseOutputTextAnnotationAddedEvent = type("ResponseOutputTextAnnotationAddedEvent", (), {})

    monkeypatch.setitem(sys.modules, "agents", fake_module)
    monkeypatch.setitem(sys.modules, "openai.types.responses", fake_responses_module)

    settings = MabelSettings(
        service_name="mabel-api",
        host="127.0.0.1",
        port=8820,
        database_url=None,
        store_mode="memory",
        openai_api_key="sk-test",
        openai_model="gpt-5.5",
        openai_agents_enabled=True,
        openai_web_search_enabled=False,
        openai_code_interpreter_enabled=False,
        openai_image_generation_enabled=False,
        openai_session_history_limit=0,
        session_db_path=str(tmp_path / "rs.db"),
        uploads_dir=str(tmp_path / "uploads"),
        uploads_max_bytes=10 * 1024 * 1024,
        trace_include_sensitive_data=False,
        remote_gateway_org="",
        remote_gateway_api_base_url=None,
        remote_gateway_runtime_token=None,
        github_token=None,
        github_repo="batyrrasulov/Mabel",
        skills_github_token=None,
        skills_github_repo="batyrrasulov/Mabel",
        skills_github_ref="main",
        skills_github_base_path="",
        local_mcp_endpoints_json="{}",
        token_prices_json="{}",
    )

    runtime_module._SESSION_CACHE.clear()

    async def _drain() -> None:
        async for _ in runtime_module.run_openai_agents_stream(
            message="Summarize these.",
            settings=settings,
            conversation_id=42,
            attachments=[
                {"id": "f1", "name": "report.pdf", "mime_type": "application/pdf", "openai_file_id": "file-aaa"},
                {"id": "f2", "name": "chart.png", "mime_type": "image/png", "openai_file_id": "file-bbb"},
                {"id": "f3", "name": "no-remote.txt", "mime_type": "text/plain", "openai_file_id": None},
            ],
        ):
            pass

    asyncio.run(_drain())

    assert captured, "Runner.run_streamed should have been called"
    run_input = captured[-1]["input"]
    # Single user message with contextual attachment text parts + multimodal
    # file parts. The third attachment has no openai_file_id, so it contributes
    # context text only and no input_file.
    assert isinstance(run_input, list)
    assert run_input[0]["role"] == "user"
    parts = run_input[0]["content"]
    types = [p["type"] for p in parts]
    assert types.count("input_file") == 1
    assert types.count("input_image") == 1
    assert types.count("input_text") >= 2
    assert types[-1] == "input_text"
    assert any(p.get("file_id") == "file-aaa" for p in parts)
    assert any(p.get("file_id") == "file-bbb" for p in parts)
    assert any("Attached file `report.pdf`" in str(p.get("text") or "") for p in parts if p.get("type") == "input_text")
    assert any("Attached file `no-remote.txt`" in str(p.get("text") or "") for p in parts if p.get("type") == "input_text")
    assert parts[-1]["text"] == "Summarize these."


def test_approval_decision_updates_pending_run_state(monkeypatch) -> None:
    from mabel_api.main import build_app

    client = TestClient(build_app())
    create = client.post(
        "/api/v1/approvals",
        headers={"x-user-email": "agent@example.com", "x-user-id": "agent-1"},
        json={
            "title": "Approve Salesforce note draft",
            "summary": "Create a draft note for Acme.",
            "payload": {"tool": "salesforce_create_note", "scope": "create"},
        },
    )
    assert create.status_code == 200
    approval_id = create.json()["approval"]["id"]

    decision = client.post(
        f"/api/v1/approvals/{approval_id}/decision",
        headers={"x-user-email": "approver@example.com", "x-user-id": "approver-1", "x-user-groups": "mabel-approvers"},
        json={"decision": "approved", "reason": "Draft-only action is allowed"},
    )

    assert decision.status_code == 200
    assert decision.json()["approval"]["status"] == "approved"
    assert decision.json()["approval"]["decided_by"] == "approver@example.com"
