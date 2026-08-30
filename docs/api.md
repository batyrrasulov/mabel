# Mabel API reference

Base service URL in local development: `http://127.0.0.1:8820`

Browser requests use the same-origin `/mabel-api` prefix. Vite or Nginx removes
that prefix before forwarding the request to FastAPI.

Interactive documentation:

- `GET /openapi.json`
- `GET /docs`
- `GET /redoc`

## Identity

All application endpoints except health and generated documentation require a
resolved Mabel user.

Development mode resolves the configured local user. Trusted-header mode expects
an identity-aware proxy to inject:

- `X-User-Email`
- `X-User-Id`
- `X-User-Name`
- `X-User-Groups`

Do not expose trusted-header mode directly to the internet.

## Common status codes

- `200` — request completed or stream accepted
- `401` — no valid identity
- `403` — identity is valid but lacks permission
- `404` — resource does not exist or is not owned by the caller
- `409` — state conflict, duplicate, disabled connector, or approval required
- `413` — uploaded file exceeds the configured limit
- `422` — request failed schema validation
- `502` — connector or provider request failed

## Health and bootstrap

### `GET /healthz`

Shallow process liveness and service identity.

### `GET /api/v1/health/deep`

Reports:

- application store health
- normalized-store readiness
- OpenAI Agents SDK presence and configuration
- hosted-tool flags
- session configuration
- MCP gateway configuration
- local connector count

An HTTP `200` response can contain `status: degraded`; deployment gates must
inspect the body.

### `GET /api/v1/health/normalization`

Reports compatibility-state and normalized-table readiness.

### `GET /api/v1/bootstrap`

Returns the current user and launch-visible workspace metadata:

- surfaces
- connectors
- skills
- starter packs and custom workflows
- pending approvals
- runtime readiness

## Chat and conversations

### `POST /api/v1/chat/stream`

Runs one agent turn and returns `text/event-stream`.

Representative request:

```json
{
  "message": "Summarize the attached report and save the result as an artifact.",
  "surface": "chat",
  "conversation_id": 42,
  "project_id": "project_abc",
  "model": "gpt-5.5",
  "instructions": "Prefer concise bullet points.",
  "attachments": [{"id": "file_abc"}],
  "document_ids": ["document_abc"]
}
```

At least one message, attachment, or document is required.

Side effects can include:

- conversation creation
- user and assistant messages
- agent run creation and terminal status
- file and document links
- tool-call records
- source metadata
- usage records
- generated files and artifacts

### Stream event types

```text
run_started
reasoning
token
tool_call
tool_result
approval_requested
sources
usage
agent_file
artifact_created
run_control
error
message_done
run_done
```

Each SSE frame uses:

```text
data: {"type":"token","text":"Hello"}

```

The stream can return HTTP `200` and later emit an `error` event because HTTP
status cannot change after streaming begins.

### `GET /api/v1/conversations`

Lists conversations owned by the caller.

### `GET /api/v1/conversations/{conversation_id}/messages`

Hydrates one owned conversation with messages, tools, sources, and files.

### `PATCH /api/v1/conversations/{conversation_id}`

Renames the conversation or moves it into a project.

### `DELETE /api/v1/conversations/{conversation_id}`

Deletes the owned conversation record and associated application state handled
by the store. It is not a global provider-retention guarantee.

## Projects

### `GET /api/v1/projects`

Lists projects owned by the caller.

### `POST /api/v1/projects`

Creates a project.

```json
{
  "name": "Launch research",
  "description": "Market and technical analysis",
  "instructions": "Cite primary sources.",
  "color": "blue"
}
```

### `GET /api/v1/projects/{project_id}`

Returns the project, its conversations, and its files.

### `PATCH /api/v1/projects/{project_id}`

Updates project metadata.

### `DELETE /api/v1/projects/{project_id}`

Deletes the project container while retaining and unassigning its conversations
and files.

## Uploads and files

### `POST /api/v1/uploads`

Multipart file upload with optional conversation and project query parameters.
The default maximum is 25 MiB per file.

### `GET /api/v1/files`

Lists caller-owned file records.

### `GET /api/v1/files/{file_id}`

Downloads owned file bytes.

### `GET /api/v1/files/{file_id}/meta`

Returns file metadata.

### `GET /api/v1/files/{file_id}/preview`

Returns an HTML preview for supported Office documents when host conversion
tools are installed.

### `GET /api/v1/files/{file_id}/preview/pdf`

Returns a PDF preview for supported Office documents.

### `DELETE /api/v1/files/{file_id}`

Deletes local bytes, metadata, conversation links, cached previews, and performs
best-effort provider-file deletion.

## Documents and artifacts

Documents and artifacts share a persistence model. Artifact routes provide a
product-specific alias for reusable generated output.

### Documents

- `GET /api/v1/documents`
- `POST /api/v1/documents`
- `GET /api/v1/documents/{document_id}`
- `PATCH /api/v1/documents/{document_id}`
- `DELETE /api/v1/documents/{document_id}`

### Artifacts

- `GET /api/v1/artifacts`
- `POST /api/v1/artifacts`
- `GET /api/v1/artifacts/{document_id}`
- `PATCH /api/v1/artifacts/{document_id}`
- `DELETE /api/v1/artifacts/{document_id}`

Representative body:

```json
{
  "title": "Launch dashboard",
  "kind": "html",
  "content": "<!doctype html><html>...</html>",
  "conversation_id": 42
}
```

## Memory

- `GET /api/v1/memory?q=QUERY`
- `POST /api/v1/memory`
- `PATCH /api/v1/memory/{item_id}`
- `DELETE /api/v1/memory/{item_id}`
- `POST /api/v1/memory/{item_id}/touch`
- `GET /api/v1/memory/export`
- `POST /api/v1/memory/import`

Memory records contain a key, content, tags, pinned state, confidence, source,
optional conversation, and timestamps.

Import modes:

- `upsert`
- `replace`

## Retrieval

### `POST /api/v1/rag/search`

Searches caller-visible Mabel state.

```json
{
  "query": "What did we decide about the launch sequence?",
  "sources": ["memory", "documents", "conversations", "skills"]
}
```

Memory can use embeddings and pgvector when configured. Other local sources use
lexical ranking.

## MCP connectors

### `POST /api/v1/mcp/{server_slug}/tools/list`

Performs live tool discovery and updates the connector snapshot. Cached tools can
be returned when live discovery is unavailable.

### `POST /api/v1/mcp/{server_slug}/tools/call`

Invokes a named connector tool.

```json
{
  "name": "github_get_issue",
  "arguments": {"number": 123}
}
```

The API validates:

- connector state
- inferred operation scope
- policy decision
- blocklist
- serialized argument limit
- transport availability

### `POST /api/v1/mcp/sync`

Refreshes enabled connector snapshots.

### `POST /api/v1/mcp/{server_slug}/state`

Enables or disables the connector snapshot.

### `GET /api/v1/mcp/{server_slug}/readiness`

Returns endpoint candidates, cached tools, inferred tool policy, configuration
gaps, and recommendations.

## Skills

- `GET /api/v1/skills?query=QUERY`
- `POST /api/v1/skills`
- `GET /api/v1/skills/marketplace`
- `POST /api/v1/skills/sync`
- `GET /api/v1/skills/{skill_id}`
- `PATCH /api/v1/skills/{skill_id}`
- `DELETE /api/v1/skills/{skill_id}`
- `POST /api/v1/skills/{skill_id}/share`
- `POST /api/v1/skills/{skill_id}/run`

Representative create body:

```json
{
  "id": "skill.release-review",
  "name": "Release Review",
  "owner_team": "developer@example.com",
  "content_md": "# Release Review\n\nInspect tests, risks, and evidence.",
  "description": "Review a release candidate.",
  "tags": ["release", "quality"],
  "mcp_bindings": [{"server_slug": "github"}]
}
```

Local skill packages live under `packages/skills/{skill-name}/`.

## Starter packs and workflows

### `POST /api/v1/starter-packs/account-manager/start-my-day`

Builds a deterministic briefing from supplied meetings and signals.

### `POST /api/v1/workflows`

Creates user-owned workflow metadata from a name, objective, optional role,
skills, and connectors.

### `POST /api/v1/workflows/{workflow_id}/run`

Builds and persists an execution plan, checkpoints, step results, next actions,
and observability events.

### `GET /api/v1/workflows/runs/{run_id}`

Returns an owned workflow run.

### `POST /api/v1/workflows/runs/{run_id}/resume`

Advances one waiting checkpoint.

### `POST /api/v1/workflows/workflow-pack.start-my-day/demo-stream`

Streams the built-in demonstration through the chat event contract.

## Generic runs and prompt inbox

- `GET /api/v1/runs/{run_id}`
- `POST /api/v1/runs/{run_id}/stop`
- `POST /api/v1/runs/{run_id}/resume`
- `GET /api/v1/runs/{run_id}/inbox`
- `POST /api/v1/runs/{run_id}/inbox`
- `PATCH /api/v1/runs/{run_id}/inbox/{item_id}`

Run-control persistence is broader than current live execution support. Clients
must not assume every recorded resume or steering instruction has already been
consumed by an active worker.

## Scheduled tasks

- `GET /api/v1/scheduled`
- `POST /api/v1/scheduled`
- `PATCH /api/v1/scheduled/{task_id}`
- `POST /api/v1/scheduled/{task_id}/run`
- `POST /api/v1/scheduled/run-due`

Supported schedule kinds:

- `cron`
- `hourly`
- `daily`
- `weekly`
- `morning`
- `afternoon`
- `evening`

Multi-worker production deployments need an atomic claim or lease around
`run-due`.

## Approvals

### `POST /api/v1/approvals`

Creates a pending approval record.

### `POST /api/v1/approvals/{approval_id}/decision`

Approves, rejects, or dismisses a pending request. The exact actor, tool,
arguments, expiry, and idempotency contract should be strengthened before
high-risk production mutations.

## Usage and administration

### `GET /api/v1/usage/summary?days=N`

Returns caller-scoped request, token, model, surface, and estimated-cost data.

### `GET /api/v1/admin/check-access`

Returns whether the caller belongs to `mabel-admins`.

### `GET /api/v1/admin/logs?days=N&limit=N`

Returns administrative run, usage, tool-call, and audit summaries.
