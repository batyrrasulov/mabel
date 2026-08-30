# Mabel

Mabel is an agent workspace for turning intent into durable work.

It combines a multi-surface web workspace, the OpenAI Agents SDK, governed MCP
connectors, reusable skills, workflows, projects, files, memory, artifacts,
schedules, approvals, usage accounting, and operational health in one system.

Mabel is not a thin completion endpoint, a prompt gallery, or a chat window with
retrieval attached. Its unit of value is a completed piece of work with context,
tool evidence, durable state, and a place to continue.

```text
Mabel = context + agent runtime + tools + durable state + workspace UI + controls
```

## Why Mabel exists

Models are becoming more capable and more interchangeable. The difficult layer
is everything required to make those models useful for real work:

- assembling the right context without turning retrieved data into instructions
- connecting tools through explicit, inspectable contracts
- preserving conversations, files, projects, memory, and outputs
- turning successful instructions into reusable skills and workflows
- separating read operations from controlled mutations
- streaming reasoning summaries, tools, sources, files, and results as one run
- attributing usage and outcomes to the person and workflow that produced them

Mabel makes people producers of reusable capability:

```mermaid
flowchart LR
    Prompt[Useful prompt] --> Skill[Reusable skill]
    Skill --> Workflow[Repeatable workflow]
    Workflow --> Schedule[Scheduled operation]
    Workflow --> Artifact[Durable artifact]
    Artifact --> Evidence[Reviewable evidence]
    Evidence --> Improvement[Measured improvement]
    Improvement --> Skill
```

The result is a foundation for research, operations, software delivery, analysis,
customer work, and any domain where an agent must do more than return text.

## What is implemented

Mabel currently includes:

- streamed multi-turn agent chat
- OpenAI Agents SDK execution and hosted tools
- projects with instructions, conversations, and files
- user uploads and generated files
- a searchable Library
- saved documents and previewable artifacts
- explicit long-term memory
- local retrieval across memory, documents, conversations, and skills
- MCP tool discovery and invocation
- connector enablement, readiness, and policy evaluation
- reusable local and GitHub-backed skills
- declarative workflows with plans and checkpoints
- scheduled prompts and due-task execution
- approval records and decisions
- usage, cost-estimation hooks, and administrative logs
- memory and PostgreSQL application stores
- SQLite-backed SDK session history
- health and normalization diagnostics
- Docker and local-development workflows

Evidence language in this repository is deliberate:

- **Implemented**: present in source and covered by a local test or build.
- **Observed**: exercised against a running local process.
- **Configured**: available when the documented environment is supplied.
- **Planned**: a product direction, not a current runtime guarantee.

## System architecture

Mabel is organized as a web application, an API service, an agent runtime, an MCP
action plane, and three persistence boundaries.

```mermaid
flowchart TB
    Person[User] --> Web[Mabel web workspace]
    Web --> Client[Typed API client]
    Client --> Edge[/mabel-api same-origin proxy]
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
2. **Transport layer** — typed HTTP, multipart uploads, authenticated file access,
   and Server-Sent Events.
3. **Application API** — FastAPI routes grouped by domain.
4. **Agent runtime** — agent construction, tools, sessions, streaming, sources,
   generated files, and run state.
5. **Connector plane** — MCP initialization, tool listing, tool calls, policy,
   local endpoints, and an optional remote gateway.
6. **Knowledge plane** — projects, messages, documents, memory, files, and skills.
7. **Persistence plane** — memory or PostgreSQL application state, SQLite SDK
   sessions, and configured file storage.
8. **Operations plane** — health, usage, logs, containers, proxying, and scripts.

## The OpenAI Agents SDK at the center

Mabel delegates the core agent loop to the OpenAI Agents SDK. The runtime uses
the SDK's `Agent`, `Runner`, `RunConfig`, `ModelSettings`, `SessionSettings`,
`SQLiteSession`, and `function_tool` abstractions. Depending on configuration, it
also exposes hosted web search, code interpreter, image generation, file search,
and hosted MCP tools.

The SDK provides the execution grammar:

1. invoke the selected model
2. inspect its output
3. execute requested tools
4. return tool results to the model
5. continue until final output or interruption

Mabel adds the workspace and control system around that loop:

- user and project context
- durable conversations and messages
- connector and skill discovery
- bounded tool payloads
- files and generated outputs
- run, usage, source, and approval records
- UI events that make the run inspectable while it happens

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

This architecture is more capable than a single LLM call because the model is
only one participant in a durable execution system. It is also more general than
RAG: retrieval is one source of context, while tools, state transitions, files,
skills, schedules, and artifacts produce and preserve work.

## The workspace model

The chat surface remains the center of gravity, but Mabel treats its surrounding
objects as first-class:

- **Projects** group instructions, conversations, and files.
- **Memory** stores explicit long-term preferences and facts.
- **Library** gives uploaded and generated files an account-wide home.
- **Skills** package reusable operating instructions and connector bindings.
- **Workflows** package objectives, skills, connectors, commands, and policies.
- **Artifacts** preserve reports, dashboards, code, and structured outputs.
- **Schedules** turn prompts into recurring work.
- **Usage and logs** make execution attributable and inspectable.

```mermaid
erDiagram
    USER ||--o{ PROJECT : owns
    USER ||--o{ CONVERSATION : owns
    USER ||--o{ RUN : initiates
    USER ||--o{ DOCUMENT : owns
    USER ||--o{ MEMORY_ITEM : owns
    USER ||--o{ FILE : owns
    USER ||--o{ SCHEDULED_TASK : owns

    PROJECT o|--o{ CONVERSATION : groups
    PROJECT o|--o{ FILE : groups
    CONVERSATION ||--o{ MESSAGE : contains
    CONVERSATION o|--o{ RUN : executes
    CONVERSATION o|--o{ DOCUMENT : produces
    CONVERSATION o|--o{ FILE_LINK : references
    FILE ||--o{ FILE_LINK : linked_by
    RUN o|--o{ TOOL_CALL : records
    RUN o|--o| USAGE_EVENT : attributes
    RUN o|--o{ APPROVAL : requests
    RUN o|--o{ PROMPT_INBOX_ITEM : receives
```

### Context flow

Mabel deliberately keeps several forms of memory separate:

```mermaid
flowchart TD
    Turn[New user turn] --> Session[SDK conversation session]
    Turn --> Project[Project instructions and recent project context]
    Turn --> Explicit[Explicit Mabel memory]
    Turn --> Attachments[Files and saved documents]
    Turn --> Skills[Loaded skill instructions]
    Turn --> Connectors[Connector evidence]

    Session --> Input[Structured runner input]
    Project --> Input
    Attachments --> Input
    Skills --> RuntimeTools[Runtime tools]
    Explicit --> RuntimeTools
    Connectors --> RuntimeTools
    Input --> Agent[OpenAI Agent]
    RuntimeTools --> Agent
```

Retrieved text, files, connector results, project notes, and memory are treated as
user-context data. They are not silently promoted into system instructions.

## MCP and the action plane

MCP gives Mabel a common interface for discovering and invoking tools without
hardwiring each integration into the model contract.

Implemented MCP operations:

- initialization
- `tools/list`
- `tools/call`
- Streamable HTTP and stdio clients
- loopback validation for local endpoints
- optional remote-gateway routing
- per-user identity context
- argument-size limits
- tool-name blocklists
- ordered allow, ask, and deny policy rules
- response compaction before model-session persistence

```mermaid
flowchart LR
    Agent[Mabel agent] --> Manager[MCP manager]
    REST[Mabel API caller] --> Manager
    Manager --> Canonical[Canonical connector slug]
    Canonical --> Policy[Scope + policy evaluation]
    Policy -->|deny| Block[Block and audit]
    Policy -->|allow or approved| Resolve[Resolve transport]
    Resolve --> Local[Loopback Streamable HTTP]
    Resolve --> Stdio[Catalog stdio package]
    Resolve --> Remote[Remote MCP gateway]
    Local --> Tools[External tools]
    Stdio --> Tools
    Remote --> Tools
    Tools --> Compact[Bound response payload]
    Compact --> Agent
```

Local MCP endpoints are configured as JSON:

```bash
export MABEL_LOCAL_MCP_ENDPOINTS_JSON='{
  "github": "http://127.0.0.1:9001/mcp",
  "analytics": "http://127.0.0.1:9002/mcp"
}'
```

Mabel rejects non-loopback URLs in the local endpoint registry. Remote endpoints
belong behind the explicit gateway configuration.

## Chat event contract

The chat endpoint streams normalized JSON events as Server-Sent Events:

- `run_started`
- `reasoning`
- `token`
- `tool_call`
- `tool_result`
- `approval_requested`
- `sources`
- `usage`
- `agent_file`
- `artifact_created`
- `run_control`
- `error`
- `message_done`
- `run_done`

The web client uses these events to build the answer, activity timeline, sources,
generated-file chips, artifacts, and terminal state without waiting for the
entire run to finish.

## Repository structure

```text
Mabel/
├── apps/
│   ├── web/                 React + Vite workspace
│   │   └── src/mabel/       product UI, API client, stream state, tests
│   └── api/                 FastAPI package and backend tests
│       └── mabel_api/       routes, runtime, MCP, stores, models
├── packages/
│   ├── catalog/             connector metadata
│   └── skills/              local reusable skill packages
├── docs/
│   ├── api.md               endpoint and event reference
│   ├── architecture.md      deeper subsystem and data-flow guide
│   └── security.md          trust boundaries and deployment requirements
├── deploy/                  reverse-proxy configuration
├── scripts/                 local development and verification
├── compose.yaml             containerized web, API, and PostgreSQL stack
├── .env.example             configuration contract
└── README.md
```

## Quick start

Requirements:

- Node.js 20 or newer
- Python 3.11 or newer
- an OpenAI API key for live agent turns
- PostgreSQL 16 with pgvector for durable mode
- optional Pandoc and LibreOffice for Office previews

### Local memory mode

```bash
git clone https://github.com/batyrrasulov/Mabel.git
cd Mabel
cp .env.example .env
# Add OPENAI_API_KEY to .env
bash scripts/dev.sh
```

Open [http://localhost:5173](http://localhost:5173).

The local default is intentionally simple:

- application store: memory
- agent session store: SQLite
- identity mode: local development user
- file storage: `var/`

### Durable PostgreSQL mode

Set:

```bash
MABEL_STORE_MODE=postgres
MABEL_DB_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

Then initialize and start the API:

```bash
.venv/bin/mabel-api init-db
.venv/bin/mabel-api serve --host 127.0.0.1 --port 8820
```

### Containers

Set `MABEL_POSTGRES_PASSWORD` and `OPENAI_API_KEY`, then run:

```bash
docker compose up --build
```

The web application is exposed on port `5173` by default.

## Configuration

All environment-specific values are externalized. See `.env.example` for the
complete local template.

### Service and persistence

- `MABEL_HOST`
- `MABEL_PORT`
- `MABEL_STORE_MODE`
- `MABEL_DB_URL`
- `MABEL_NORMALIZED_STRICT_READS`
- `MABEL_SESSION_DB_PATH`
- `MABEL_UPLOADS_DIR`
- `MABEL_UPLOADS_MAX_BYTES`

### OpenAI runtime

- `OPENAI_API_KEY` or `MABEL_OPENAI_API_KEY`
- `MABEL_OPENAI_MODEL`
- `MABEL_OPENAI_AGENTS_ENABLED`
- `MABEL_OPENAI_WEB_SEARCH_ENABLED`
- `MABEL_OPENAI_CODE_INTERPRETER_ENABLED`
- `MABEL_OPENAI_IMAGE_GENERATION_ENABLED`
- `MABEL_OPENAI_FILE_SEARCH_ENABLED`
- `MABEL_OPENAI_VECTOR_STORE_IDS_JSON`
- `MABEL_OPENAI_SESSION_HISTORY_LIMIT`
- `MABEL_TRACE_INCLUDE_SENSITIVE_DATA`

### Identity

- `MABEL_AUTH_MODE=development` for local work
- `MABEL_AUTH_MODE=trusted_headers` behind an identity-aware reverse proxy
- `MABEL_DEV_USER_EMAIL`
- `MABEL_DEV_USER_ID`
- `MABEL_DEV_USER_NAME`

In `trusted_headers` mode, the proxy must remove caller-supplied identity headers
and inject verified `X-User-Email`, `X-User-Id`, `X-User-Name`, and
`X-User-Groups` values.

### MCP

- `MABEL_LOCAL_MCP_ENDPOINTS_JSON`
- `MABEL_LOCAL_MCP_ENDPOINT_<SLUG>`
- `MABEL_MCP_GATEWAY_PROXY_BASE_URL`
- `MABEL_MCP_GATEWAY_PROFILE`
- `MABEL_REMOTE_GATEWAY_API_BASE_URL`
- `MABEL_REMOTE_GATEWAY_ORG`
- `MABEL_REMOTE_GATEWAY_RUNTIME_TOKEN`
- `MABEL_MCP_TOOL_TIMEOUT_SECONDS`
- `MABEL_MCP_TOOL_ARGS_MAX_BYTES`
- `MABEL_MCP_TOOL_RESULT_MAX_CHARS`
- `MABEL_MCP_TOOL_POLICY_RULES_JSON`
- `MABEL_MCP_TOOL_BLOCKLIST_JSON`

### Skills registry

- `MABEL_SKILLS_GITHUB_REPO`
- `MABEL_SKILLS_GITHUB_REF`
- `MABEL_SKILLS_GITHUB_BASE_PATH`
- `MABEL_SKILLS_GITHUB_TOKEN`

## API

The service exposes:

- OpenAPI JSON at `/openapi.json`
- Swagger UI at `/docs`
- ReDoc at `/redoc`
- shallow health at `/healthz`
- deep health at `/api/v1/health/deep`

Major API domains:

```text
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

See [docs/api.md](docs/api.md) for endpoint behavior, payloads, side effects,
stream events, and status codes.

## Data and persistence

Mabel uses three separate storage concerns:

1. **Application state** — memory for tests/development or PostgreSQL for
   durable projects, conversations, messages, runs, tools, approvals, skills,
   documents, memory, and usage.
2. **Agent session history** — SQLite through the OpenAI Agents SDK.
3. **File bytes** — configured local storage with optional OpenAI Files mirroring.

The PostgreSQL implementation retains a compatibility state document alongside
normalized tables. Strict normalized reads are opt-in while the normalization
health endpoint reports readiness.

This split is suitable for a single-node foundation. Horizontal production scale
requires shared session storage, object storage, transactional normalized
repositories, distributed schedule claims, and idempotent tool execution.

## Security model

Mabel's important trust boundaries are:

- browser to identity-aware edge
- edge to API
- API to model provider
- API to file storage
- agent runtime to MCP connector
- connector to external source system

Security defaults and requirements:

- secrets are environment-driven and excluded from Git
- local MCP endpoints must be loopback addresses
- tool arguments and model-session payloads are bounded
- sensitive provider tracing is disabled by default
- artifact and Markdown rendering use sanitization or browser sandboxing
- data access is owner-scoped in application routes
- development identity mode must not be exposed publicly
- trusted-header identity requires a proxy that strips unverified headers
- mutating connector policy should be configured fail-closed for production

See [docs/security.md](docs/security.md) before any internet-facing deployment.

## Verification

Run the full local gate:

```bash
bash scripts/verify.sh
```

Individual commands:

```bash
npm run typecheck
npm run test
npm run build
.venv/bin/python -m pytest apps/api/tests
npm audit --omit=dev
```

Current local evidence:

- API: 106 passing tests
- web: 50 passing tests
- TypeScript: strict no-emit check passes
- production web bundle: builds successfully
- production npm dependency audit: zero known vulnerabilities

These checks prove the local source contract. They do not prove a specific cloud
deployment, external connector entitlement, model-provider quota, or production
service-level objective.

## Current boundaries

Mabel is a working platform foundation, not a finished multi-tenant control
plane. Important boundaries remain:

- development identity is not production authentication
- approval records and every tool execution path are not yet one durable state
  machine
- workflows are strongest as plans and checkpoints; arbitrary workflow packages
  are not yet a fully distributed execution engine
- run resume and steering persistence is broader than live execution support
- local files and SQLite sessions constrain horizontal scale
- PostgreSQL still includes compatibility-state writes
- schedules need atomic distributed claims for multi-worker deployment
- deletion is not yet an orchestrated erasure across all stores and providers
- deep health reports configuration readiness more than live upstream success

These are engineering constraints, not hidden product claims. The architecture is
designed so each can be replaced behind a clear boundary.

## Strategic direction

Mabel can become the layer through which people and agents produce repeatable,
reviewable work:

- **Open workspace** — chat, projects, files, memory, artifacts, and local skills
- **Developer platform** — API, MCP gateway, connector contracts, and client SDKs
- **Workflow platform** — durable plans, checkpoints, schedules, and outcomes
- **Control plane** — tenant identity, policy, approvals, audit, and retention
- **Ecosystem** — community skills, connectors, workflow packs, and renderers

The defensible value is not a list of AI features. It is the evaluated operating
system formed by context, methods, reliable tools, policy, evidence, and outcome
telemetry.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Contributions
should preserve:

- exact `Mabel` product naming
- environment-driven configuration
- same-origin browser API paths
- explicit identity and ownership boundaries
- test coverage for behavior changes
- evidence-backed product claims
- small, reviewable commits

## License and release status

This repository is in pre-release preparation. No open-source license is granted
until a `LICENSE` file is intentionally selected and added by the rights holder.
Do not redistribute the source before that release gate is complete.
