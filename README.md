# Mabel

Mabel is an agent workspace for turning intent into durable work.

It combines a multi-surface web workspace, the OpenAI Agents SDK, governed MCP
connectors, reusable skills, workflows, projects, files, memory, artifacts,
schedules, approvals, usage accounting, and operational health in one system.

Mabel is not a thin completion endpoint or a chat window with retrieval. Its unit
of value is a completed piece of work with context, tool evidence, durable state,
and a place to continue.

```
Mabel = identity + context + agent runtime + tools + durable state + workspace UI + controls
```

## Current status

**Not production-ready.** Before deploying to any multi-user or internet-facing environment,
address the 13 known authorization, policy, and persistence gaps documented in [docs/security.md](docs/security.md).

Local development and testing are safe. Multi-user deployments require:
- explicit hardening of all 13 gaps
- your own identity provider and OIDC flow
- removal of development auth modes
- tenant isolation on every data row
- reviewed tool policies and connector manifests

See [docs/security.md](docs/security.md) for the complete list of issues and mitigation strategies.

## What's implemented

Mabel includes:

- streamed multi-turn agent chat
- OpenAI Agents SDK execution and hosted tools
- projects with instructions, conversations, and files
- user uploads and generated files
- a searchable Library
- saved documents and previewable artifacts
- explicit long-term memory
- local retrieval across memory, documents, conversations, and skills
- MCP tool discovery and invocation
- connector enablement and policy evaluation
- reusable local and GitHub-backed skills
- declarative workflows with plans and checkpoints
- scheduled prompts and due-task execution
- approval records and decisions
- usage hooks and administrative logs
- memory or PostgreSQL application store
- SQLite-backed SDK session history
- health and normalization diagnostics
- Docker and local-development workflows

## Evidence language

To avoid conflating plans with current behavior, this repository uses four levels:

- **Implemented**: present in current source and covered by test or build.
- **Observed**: exercised against a running local stack.
- **Configured**: available when the documented environment is supplied.
- **Planned**: a product direction, not a current runtime guarantee.

## System architecture

Mabel is organized as a web application, API service, agent runtime, MCP action plane, and three persistence boundaries.

```mermaid
flowchart TB
    Person[User] --> Web[Mabel web workspace]
    Web --> Client[Typed API client]
    Client --> Edge["mabel-api same-origin proxy"]
    Edge --> API[FastAPI application]

    API --> Runtime[OpenAI Agents SDK runtime]
    API --> Store[Mabel application store]
    API --> Catalog[Skills and connector catalog]
    API --> Files[File service]

    Runtime --> Model[OpenAI Responses models]
    Runtime --> Hosted[Hosted tools]
    Runtime --> Native[Mabel function tools]
    Runtime --> Session[SQLiteSession]

    Native --> MCP[MCP manager]
    MCP --> Local[Local Streamable HTTP or stdio MCP]
    MCP --> Gateway[Optional remote MCP gateway]
    Local --> Systems[External systems]
    Gateway --> Systems

    Store --> MemoryStore[In-memory development store]
    Store --> Postgres[(PostgreSQL)]
    Files --> Disk[(Configured file storage)]
    Files -. optional mirror .-> OpenAIFiles[OpenAI Files]
```

### Architectural layers

1. **Experience layer** — React workspace surfaces and run visualization.
2. **Transport layer** — typed HTTP, multipart uploads, authenticated file access, and Server-Sent Events.
3. **Application API** — FastAPI routes grouped by domain.
4. **Agent runtime** — agent construction, tools, sessions, streaming, sources, generated files, and run state.
5. **Connector plane** — MCP initialization, tool listing, tool calls, policy, local endpoints, and an optional remote gateway.
6. **Knowledge plane** — projects, messages, documents, memory, files, and skills.
7. **Persistence plane** — memory or PostgreSQL application state, SQLite SDK sessions, and configured file storage.
8. **Operations plane** — health, usage, logs, containers, proxying, and scripts.

## The OpenAI Agents SDK

Mabel delegates the core agent loop to the OpenAI Agents SDK. The runtime wraps
the SDK's `Agent`, `Runner`, `RunConfig`, `ModelSettings`, `SessionSettings`,
and `function_tool` abstractions.

The SDK execution loop is:

1. invoke the selected model
2. inspect its output
3. execute requested tools
4. return tool results to the model
5. continue until final output or interruption

Mabel adds around this loop:

- user and project context
- durable conversations and messages
- connector and skill discovery
- bounded tool payloads
- files and generated outputs
- run, usage, source, and approval records
- UI events streamed back as the run happens

```mermaid
sequenceDiagram
    actor User
    participant UI as Mabel web
    participant API as Mabel API
    participant Store as Application store
    participant Runtime as Agent runtime
    participant SDK as OpenAI Agents SDK
    participant Tool as Hosted or MCP tool

    User->>UI: Prompt, project, and files
    UI->>API: POST /api/v1/chat/stream
    API->>Store: Create conversation, run, and user message
    API-->>UI: run_started
    API->>Runtime: Structured input and identity context
    Runtime->>SDK: Agent + Runner.run_streamed
    loop Until terminal output
        SDK-->>Runtime: Text, reasoning, tool, source, or file event
        opt Tool requested
            Runtime->>Tool: Invoke with bounded arguments
            Tool-->>Runtime: Result
        end
        Runtime-->>API: Normalized Mabel event
        API-->>UI: SSE event
    end
    API->>Store: Assistant message, usage, sources, terminal state
    API-->>UI: message_done and run_done
```

## Repository structure

```
Mabel/
├── apps/
│   ├── web/                 React + Vite workspace
│   │   └── src/mabel/       UI components, API client, stream state, tests
│   └── api/                 FastAPI package and backend tests
│       └── mabel_api/       routes, runtime, MCP, stores, data models
├── packages/
│   ├── catalog/             connector metadata
│   └── skills/              reusable skill packages
├── docs/
│   ├── api.md               endpoint and event reference
│   ├── architecture.md      data-flow and subsystem guide
│   └── security.md          trust boundaries and deployment requirements
├── deploy/                  reverse-proxy configuration
├── scripts/                 development and verification
├── compose.yaml             containerized stack
├── .env.example             configuration template
└── README.md
```

## Quick start

Requirements: Node.js 20+, Python 3.11+, OpenAI API key.

### Local memory mode

```bash
git clone https://github.com/batyrrasulov/mabel.git
cd mabel
cp .env.example .env
# Add OPENAI_API_KEY to .env
bash scripts/dev.sh
```

Open [http://localhost:5173](http://localhost:5173).

Default configuration:

- application store: memory
- agent session store: SQLite
- identity: local development user
- file storage: `var/`

### Durable PostgreSQL mode

```bash
export MABEL_STORE_MODE=postgres
export MABEL_DB_URL=postgresql://user:password@localhost:5432/mabel
.venv/bin/mabel-api init-db
.venv/bin/mabel-api serve --host 127.0.0.1 --port 8820
```

### Containers

```bash
export MABEL_POSTGRES_PASSWORD=...
export OPENAI_API_KEY=...
docker compose up --build
```

Web is on port 5173.

## Configuration

All environment-specific values are externalized. See `.env.example` for the full template.

### Service and persistence

- `MABEL_HOST`, `MABEL_PORT`
- `MABEL_STORE_MODE`, `MABEL_DB_URL`
- `MABEL_SESSION_DB_PATH`, `MABEL_UPLOADS_DIR`, `MABEL_UPLOADS_MAX_BYTES`

### OpenAI runtime

- `OPENAI_API_KEY` or `MABEL_OPENAI_API_KEY`
- `MABEL_OPENAI_MODEL`
- `MABEL_OPENAI_AGENTS_ENABLED`, `MABEL_OPENAI_WEB_SEARCH_ENABLED`, `MABEL_OPENAI_CODE_INTERPRETER_ENABLED`, `MABEL_OPENAI_IMAGE_GENERATION_ENABLED`, `MABEL_OPENAI_FILE_SEARCH_ENABLED`
- `MABEL_OPENAI_SESSION_HISTORY_LIMIT`

### Identity

- `MABEL_AUTH_MODE=development` (local work only)
- `MABEL_AUTH_MODE=trusted_headers` (behind identity-aware proxy)
- `MABEL_DEV_USER_EMAIL`, `MABEL_DEV_USER_ID`, `MABEL_DEV_USER_NAME`

In `trusted_headers` mode, the proxy must remove all caller-supplied identity headers
and inject verified `X-User-Email`, `X-User-Id`, `X-User-Name`, and `X-User-Groups`.

### MCP

- `MABEL_LOCAL_MCP_ENDPOINTS_JSON` or `MABEL_LOCAL_MCP_ENDPOINT_<SLUG>`
- `MABEL_MCP_GATEWAY_PROXY_BASE_URL`, `MABEL_MCP_GATEWAY_PROFILE`
- `MABEL_MCP_TOOL_TIMEOUT_SECONDS`, `MABEL_MCP_TOOL_ARGS_MAX_BYTES`, `MABEL_MCP_TOOL_RESULT_MAX_CHARS`
- `MABEL_MCP_TOOL_POLICY_RULES_JSON`, `MABEL_MCP_TOOL_BLOCKLIST_JSON`

Local MCP endpoints must be loopback addresses. Remote endpoints belong behind an explicit gateway.

### Skills registry

- `MABEL_SKILLS_GITHUB_REPO`, `MABEL_SKILLS_GITHUB_REF`, `MABEL_SKILLS_GITHUB_BASE_PATH`, `MABEL_SKILLS_GITHUB_TOKEN`

## API

OpenAPI reference at `/openapi.json`, Swagger UI at `/docs`.

Major API domains:

```
/api/v1/bootstrap
/api/v1/chat
/api/v1/conversations
/api/v1/projects
/api/v1/uploads
/api/v1/files
/api/v1/documents
/api/v1/artifacts
/api/v1/memory
/api/v1/rag
/api/v1/mcp
/api/v1/skills
/api/v1/workflows
/api/v1/runs
/api/v1/scheduled
/api/v1/approvals
/api/v1/usage
/api/v1/admin
```

See [docs/api.md](docs/api.md) for endpoint behavior and payloads.

## Data and persistence

Mabel uses three storage concerns:

1. **Application state** — memory (tests/dev) or PostgreSQL (durable).
2. **Agent session history** — SQLite through the OpenAI Agents SDK.
3. **File bytes** — configured local storage with optional OpenAI Files mirroring.

The PostgreSQL implementation includes a compatibility-state document alongside normalized tables.
Strict normalized reads are opt-in.

This is suitable for single-node foundation. Horizontal production scale requires:
- shared session storage
- object storage
- transactional normalized repositories
- distributed schedule claims
- idempotent tool execution

## Security model

Important trust boundaries:

- browser to identity-aware edge
- edge to API
- API to model provider
- API to file storage
- agent runtime to MCP connector
- connector to external source system

Security defaults:

- secrets are environment-driven
- local MCP endpoints must be loopback addresses
- tool arguments and model-session payloads are bounded
- sensitive provider tracing is disabled by default
- artifact and Markdown rendering use sanitization or browser sandboxing
- data access is owner-scoped in routes
- development identity mode must not be exposed publicly
- trusted-header identity requires a proxy that strips unverified headers
- connector policy allows reads, requires approval for create/update, denies delete/admin/unknown by default

See [docs/security.md](docs/security.md) before any internet-facing deployment.

## Verification

```bash
bash scripts/verify.sh
```

Individual checks:

```bash
npm run typecheck
npm run test
npm run build
.venv/bin/python -m pytest apps/api/tests
npm audit --omit=dev
```

Current local status:

- API: 111 passing tests
- Web: 51 passing tests
- TypeScript: strict no-emit passes
- Production bundle: builds successfully
- npm audit: zero known vulnerabilities

These verify the local source contract. They do not prove cloud deployment,
external connector entitlement, model-provider quota, or production SLO.

## Current boundaries

Mabel is a working foundation, not a finished multi-tenant control plane:

- development identity is not production authentication
- approval records and tool execution paths are not yet one durable state machine
- workflows are strongest as plans and checkpoints
- run resume and steering is broader than live execution support
- local files and SQLite sessions constrain horizontal scale
- PostgreSQL includes compatibility-state writes
- schedules need atomic distributed claims for multi-worker deployment
- deletion is not yet orchestrated across all stores and providers
- deep health reports configuration readiness more than upstream success

Each constraint is an engineering boundary, not a hidden product claim.
The architecture is designed so each can be replaced.

## Future direction

Mabel can become the layer through which people and agents produce repeatable,
reviewable work:

- **Open workspace** — chat, projects, files, memory, artifacts, local skills
- **Developer platform** — API, MCP gateway, connector contracts, client SDKs
- **Workflow platform** — durable plans, checkpoints, schedules, outcomes
- **Control plane** — tenant identity, policy, approvals, audit, retention
- **Ecosystem** — community skills, connectors, workflow packs, renderers

The defensible value is not a feature checklist. It is the operating system formed
by context, methods, reliable tools, policy, evidence, and outcome telemetry.
