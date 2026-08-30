# Mabel

Technical blueprint, operating manual, and agent workspace platform.

Status: source-grounded architecture record for the Mabel agent workspace.

Primary implementation:

- Frontend: `apps/web/src/mabel/`
- Backend: `apps/api/mabel_api/`
- Connector catalog: `packages/catalog/`
- Reusable skills: `packages/skills/`
- Browser route: `/`
- Browser API prefix: `/mabel-api`
- Service API prefix: `/api/v1`

This document is authoritative for the current source state. It excludes promotional claims
and accepted without verified measurement. The repository cannot prove that deployments
will match this behavior; audit your own environment before production claims.

## Evidence language

To avoid conflating plans with current behavior, this document uses four levels:

1. **Implemented** means the behavior exists in current source.
2. **Observed** means it was exercised against the local stack.
3. **Configured** means a checked-in deployment artifact describes it, but the live host was not inspected.
4. **Planned** means it belongs to the product direction, not the current runtime.

---

# Contents

1. The short version
2. What Mabel is
3. The platform as layers
4. The full system boundary
5. The OpenAI Agents SDK at the center
6. Chat, from keystroke to durable record
7. MCP connectors and the action plane
8. Retrieval, memory, projects, and context
9. Files, Library, and generated outputs
10. Skills, workflows, and starter packs
11. Artifacts and the workspace model
12. Scheduled work and automation
13. Persistence and the data model
14. Identity, authorization, and approvals
15. Security boundaries and trust model
16. Current gaps and hard truths
17. API reference and endpoints
18. Repository structure
19. Quick start
20. Configuration reference
21. Verification and testing
22. Deployment and operations

---

# 1. The short version

Mabel is an agent workspace wrapped around the OpenAI Agents SDK. It gives a person
one place to converse with a model, attach and generate files, call governed MCP tools,
load reusable skills, preserve working context, save artifacts, group work into projects,
schedule prompts, inspect usage, and review activity.

That is already more than a chatbot. A chatbot maps text to text. Mabel maps an authenticated
person and a body of context to an agent run that may reason, retrieve, call tools, create
durable objects, and stream the work back as it happens.

The simplest accurate formula is:

```
Mabel = identity + context + agent runtime + tools + durable state + workspace UI + controls
```

Mabel is not yet a complete enterprise AI control plane. The code does not prove that all
agent traffic is forced through Mabel. It does not centrally resolve every upstream entitlement.
Approval paths are not yet one coherent state machine. The default MCP policy is permissive
unless configured. Storage is still hybrid (memory + PostgreSQL + SQLite). Those are not
reasons to dismiss the platform. They are the exact boundary between the working foundation
and the next platform release.

Mabel's strongest claim is concrete: the project has assembled the difficult middle layer
between a capable model and real work. That middle layer is where identity, context, tool
reliability, reusable operating knowledge, evidence, and user experience meet.

---

# 2. What Mabel is

## 2.1 A workspace, not a prompt box

The visible application has dedicated surfaces for:

- conversations
- projects
- connectors
- skills
- workflows
- artifacts
- Library files
- scheduled tasks
- memory
- usage
- administrative logs

The chat remains the center of gravity, but the surrounding surfaces turn chat output
into reusable state. A file can outlive the turn that created it. A conversation can belong
to a project. A skill can be discovered later. A dashboard can become an artifact. A task
can produce a new conversation on a schedule. Usage can be attributed to a user and run.

This changes the unit of value. In a plain chat product, the unit is the answer. In Mabel,
the unit is a completed piece of work with provenance and a place to live.

## 2.2 A control plane and a data plane

Mabel contains two intertwined systems.

The control plane decides:

- who the caller is
- which connectors are visible or enabled
- which skill or workflow metadata exists
- how a tool is classified
- whether policy says allow, ask, or deny
- which project and memory belong to the user
- what gets recorded
- when approval is required

The data plane performs:

- model calls
- streamed agent events
- MCP tool listing and invocation
- file upload and retrieval
- embedding requests
- generated file capture
- scheduled prompt execution
- context assembly and retrieval

The product only becomes trustworthy when both planes agree. A polished UI on an unconstrained
data plane is not governance. A strict control plane with poor tools is not adoption.
Mabel attempts both.

## 2.3 What Mabel is not

Mabel is not:

- a thin wrapper around a single LLM endpoint
- only RAG
- only an MCP catalog
- only a collection of prompt templates
- proof that every connector inherits correct source-system permissions
- proof that every write waits for human approval
- a production-verified multi-tenant SaaS
- a replacement for identity infrastructure

It is a working agent workspace with several control-plane foundations and several
unfinished control-plane promises.

---

# 3. The platform as layers

Mabel is organized as nine layers:

```
Experience layer
   ↓
Transport layer
   ↓
Application API
   ↓
Agent runtime
   ↓
Connector plane (MCP)
   ↓
Knowledge plane
   ↓
Persistence plane
   ↓
Operations plane
```

### 3.1 Experience layer

React workspace surfaces and run visualization.

**Implemented:**
- chat UI with streamed events
- project browser and switcher
- connector status dashboard
- skill discovery and loading
- workflow builder and execution view
- artifact preview and editing
- memory browser and editor
- scheduled task creation and status
- usage and cost dashboard
- administrative action panel
- file uploads and downloads

The UI is intentionally modular. Each surface is independent of the others, though they
all consume the same API and application store.

### 3.2 Transport layer

Typed HTTP, multipart uploads, authenticated file access, Server-Sent Events.

**Implemented:**
- RESTful API with JSON payloads
- OpenAPI 3.0 contract at `/openapi.json`
- SSE streaming for agent runs
- multipart file uploads with size limits
- signed file downloads
- bearer token and header-based identity
- CORS and same-origin proxy support

### 3.3 Application API

FastAPI routes grouped by domain.

**Implemented:**
- `/api/v1/bootstrap` — session initialization
- `/api/v1/chat` — streaming agent turns
- `/api/v1/conversations` — conversation CRUD
- `/api/v1/projects` — project and file management
- `/api/v1/skills` — skill discovery and execution
- `/api/v1/workflows` — workflow packs and runs
- `/api/v1/memory` — user memory storage
- `/api/v1/rag` — retrieval across projects and documents
- `/api/v1/mcp` — tool discovery and test calls
- `/api/v1/artifacts` — generated artifact storage
- `/api/v1/scheduled` — prompt scheduling and execution
- `/api/v1/approvals` — approval records and decisions
- `/api/v1/usage` — usage accounting and logs
- `/api/v1/admin` — administrative functions

Each domain is independently tested. Routes enforce user ownership and policy checks.

### 3.4 Agent runtime

Agent construction, tools, sessions, streaming, sources, generated files, and run state.

**Implemented:**
- OpenAI Agents SDK `Agent` and `Runner` wrappers
- tool definition from Mabel and MCP
- session history via SQLiteSession
- context assembly from projects, memory, skills, and files
- streaming event normalization to Mabel schema
- generated file capture and persistence
- run state transitions and persistence

The runtime is the highest-value layer. It transforms raw SDK capabilities into
a durable, accountable, context-aware execution engine.

### 3.5 Connector plane (MCP)

MCP initialization, tool listing, tool calls, policy, local endpoints, remote gateway.

**Implemented:**
- connector registration and enablement
- MCP server initialization (stdio and HTTP)
- tool discovery and caching
- argument bounds checking
- response compaction before persistence
- scope inference (read/create/update/delete/admin)
- ordered allow, ask, deny policy rules
- tool-name blocklists
- loopback validation for local endpoints
- optional remote gateway routing

### 3.6 Knowledge plane

Projects, messages, documents, memory, files, and skills.

**Implemented:**
- projects with instructions, metadata, and file grouping
- conversations and messages with attribution and timestamps
- documents saved from runs or uploaded
- memory items (facts and preferences)
- uploaded files and generated artifacts
- skill definitions and GitHub-backed skill catalogs

### 3.7 Persistence plane

Memory or PostgreSQL application state, SQLite SDK sessions, configured file storage.

**Implemented:**
- memory store (tests and development)
- PostgreSQL store with normalized schema and compatibility JSONB
- SQLiteSession for agent conversation history
- local filesystem storage for uploads and generated files
- optional OpenAI Files mirroring

### 3.8 Operations plane

Health checks, usage accounting, logs, container configuration, reverse proxy configuration.

**Implemented:**
- shallow health at `/healthz`
- deep health at `/api/v1/health/deep`
- structured usage event recording
- administrative audit logs
- Docker Compose configuration
- nginx reverse-proxy templates
- local development scripts

---

# 4. The full system boundary

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

Key trust boundaries:

1. **Browser to edge** — authenticated user session
2. **Edge to API identity** — verified X-User headers or bearer token
3. **API to model provider** — OpenAI API key
4. **Agent runtime to MCP** — tool policy and argument bounds
5. **MCP to source system** — connector authentication and scoping
6. **API to application store** — owner-scoped queries
7. **API to file storage** — owner-scoped access
8. **Generated artifact to browser renderer** — Markdown sanitization or sandboxing

---

# 5. The OpenAI Agents SDK at the center

Mabel delegates the core agent loop to the OpenAI Agents SDK.

The SDK execution grammar is:

1. invoke the selected model
2. inspect its output
3. execute requested tools
4. return tool results to the model
5. continue until final output or interruption

**Implemented:**
- `Agent` construction with model, tools, and initial instructions
- `RunConfig` for model settings and behavior
- `ModelSettings` for temperature, max tokens, reasoning effort
- `SessionSettings` for conversation history management
- `SQLiteSession` for persistent agent memory
- `function_tool` decorator for Mabel-native functions
- hosted tools (web search, code interpreter, image generation, file search)
- streaming event capture and normalization

Mabel wraps the SDK loop with:

- user and project context assembly
- durable conversation and message storage
- connector and skill discovery
- bounded tool payloads
- generated file capture and persistence
- run state transitions
- usage accounting
- source tracking
- approval records

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

This architecture is more capable than a single LLM call because the model is only one
participant in a durable execution system. It is also more general than RAG: retrieval is
one source of context, while tools, state transitions, files, skills, schedules, and
artifacts produce and preserve work.

---

# 6. Chat, from keystroke to durable record

A user's keystroke in the chat box becomes a durable conversation record, an agent run,
tool invocations, files, usage events, and approval records.

**Flow:**

1. User types prompt and selects project, files, and optional skill
2. Browser creates SSE stream to `/api/v1/chat/stream`
3. API validates user ownership of project and files
4. API creates conversation (if new), message, and run records
5. API instantiates agent with project instructions, user memory, and skill definitions
6. API invokes `Runner.run_streamed` from OpenAI SDK
7. SDK invokes model with assembled context and tools
8. Model streams reasoning, token events, and tool requests
9. Runtime validates each tool request against MCP policy
10. Runtime invokes tool with bounded arguments
11. Tool result returned to model
12. Loop continues until model stops requesting tools
13. Runtime normalizes all events and sends them as SSE to browser
14. Browser reconstructs the run visualization in real time
15. Final assistant message and usage events persisted to store
16. Run marked terminal

The browser receives events as they happen, not after the entire run completes. This
enables live activity visualization, real-time error recovery, and user steering before
the run ends.

**Implemented:**
- SSE streaming with event normalization
- concurrent tool execution (when SDK permits)
- tool error capture and retry
- generated file capture from file_search and code_interpreter
- usage event recording
- source attribution
- approval record creation when policy requires

---

# 7. MCP connectors and the action plane

MCP gives Mabel a common interface for discovering and invoking tools without hardwiring
each integration into the model contract.

**Implemented:**
- connector registration
- MCP server initialization (stdio and HTTP)
- tool discovery and caching per connector
- argument serialization and bounds checking
- response compaction before model persistence
- scope inference (read/create/update/delete/admin/unknown)
- ordered allow/ask/deny policy rules
- tool-name blocklists
- per-user identity context injection
- error capture and logging

Local MCP endpoints must be loopback addresses:

```bash
export MABEL_LOCAL_MCP_ENDPOINTS_JSON='{
  "github": "http://127.0.0.1:9001/mcp",
  "analytics": "http://127.0.0.1:9002/mcp"
}'
```

Remote endpoints belong behind an explicit gateway:

```bash
export MABEL_MCP_GATEWAY_PROXY_BASE_URL=https://gateway.example.com
export MABEL_MCP_GATEWAY_PROFILE=production
```

Policy example (allow reads, require approval for create/update, deny delete):

```json
[
  {"server": "*", "tool": "*", "scope": "read", "decision": "allow"},
  {"server": "*", "tool": "*", "scope": "create", "decision": "ask"},
  {"server": "*", "tool": "*", "scope": "update", "decision": "ask"},
  {"server": "*", "tool": "*", "scope": "delete", "decision": "deny"},
  {"server": "*", "tool": "*", "scope": "admin", "decision": "deny"}
]
```

---

# 8. Retrieval, memory, projects, and context

Mabel deliberately keeps several forms of memory separate.

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

**Implemented:**
- SDK session history (persistent via SQLiteSession)
- project instructions and file grouping
- explicit memory items (facts and preferences)
- uploaded and generated files
- saved documents from runs
- skill definitions and instructions
- connector metadata and tool evidence

Retrieved text, files, connector results, project notes, and memory are treated as
user-context data. They are not silently promoted into system instructions. This
prevents prompt injection and makes the model's actual context visible to the user.

**RAG implementation:**
- local search across conversations, documents, memory, and skills
- embedding-optional (vector search when available)
- owner scoping to prevent cross-user leakage
- source attribution to original message or document

---

# 9. Files, Library, and generated outputs

Files come from three sources: user uploads, agent-generated (via code_interpreter or
file_search), and saved documents (snapshots of run output).

**Implemented:**
- user uploads with size limits and virus scanning (when configured)
- generated file capture from hosted tools
- preview rendering (Markdown, images, PDFs, Office, CSV)
- download and sharing (owner-scoped)
- Library (account-wide file home)
- optional OpenAI Files mirroring

Files are owner-scoped. A user cannot access another user's files.

**Configurable:**
- `MABEL_UPLOADS_MAX_BYTES` — per-file size limit
- `MABEL_UPLOADS_DIR` — storage root
- file preview MIME types

---

# 10. Skills, workflows, and starter packs

A skill packages reusable operating instructions and connector bindings.

**Skill anatomy:**
- name and description
- instructions (system prompt component)
- connector bindings (which tools are available)
- tags and metadata
- visibility (public, team, private)
- version and GitHub backing (optional)

**Implemented:**
- local skill loading
- GitHub-backed skill catalogs
- skill search across public and private packs
- skill selection and loading in chat
- skill execution with isolated context

A workflow packages objectives, connectors, commands, and policies.

**Implemented:**
- workflow builder with visual plan definition
- workflow packs (reusable workflow templates)
- workflow runs with checkpoint tracking
- approval gates within workflows
- scheduled workflow execution

Starter packs are predefined workflows for common tasks.

**Implemented:**
- built-in starter pack library
- custom starter pack creation
- starter pack execution with prefilled parameters

---

# 11. Artifacts and the workspace model

An artifact is a durable output (code, report, dashboard, markdown).

**Implemented:**
- artifact creation from run output
- artifact storage with metadata
- artifact versioning
- artifact preview in workspace
- artifact export (download, share link)
- Markdown sanitization
- HTML sandboxing with `sandbox` attribute

**Current gaps:**
- generated HTML can execute scripts with network access
- artifact rendering does not use a separate isolation origin

---

# 12. Scheduled work and automation

Users can schedule prompts to execute at specific times or intervals.

**Implemented:**
- cron-based scheduling
- scheduled prompt storage
- due-task execution
- new conversation generation from scheduled output
- execution logging

**Current gaps:**
- scheduled task execution runs under the user's identity (can impersonate)
- no distributed claims for multi-worker deployment
- no retry logic on transient failures

---

# 13. Persistence and the data model

Mabel uses three separate storage concerns:

1. **Application state** — memory (tests/development) or PostgreSQL (durable)
2. **Agent session history** — SQLite via OpenAI SDK
3. **File bytes** — local storage with optional OpenAI Files mirroring

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
```

**PostgreSQL schema:**
- users
- projects (with instructions)
- conversations (with project association)
- messages (with user, role, and timestamp)
- runs (with agent output, usage, sources, status)
- tool_calls (with scope and policy decision)
- files (with owner, storage path, and metadata)
- documents (with conversation link)
- memory_items (with facts and preferences)
- scheduled_tasks (with cron and execution log)
- approvals (with payload and decision)
- usage_events (with model and tokens)

**Dual-state challenge:**
The PostgreSQL implementation retains a compatibility-state document (JSONB) alongside
normalized tables. This is suitable for single-node development. Horizontal production scale
requires choice: either normalized relational (cleaner schema, less flexible) or JSONB
(flexible, harder to query, eventual consistency risks).

**Implemented:**
- normalized schema with tests
- compatibility JSONB for backwards compatibility
- strict normalized reads (opt-in via configuration)
- normalization health endpoint

---

# 14. Identity, authorization, and approvals

User identity is resolved from headers or bearer token.

**Modes:**

- `MABEL_AUTH_MODE=development` — local testing (not for production)
- `MABEL_AUTH_MODE=trusted_headers` — identity-aware reverse proxy

In `trusted_headers` mode, the proxy must:

1. authenticate the user
2. remove caller-supplied identity headers
3. inject verified `X-User-Email`, `X-User-Id`, `X-User-Name`, `X-User-Groups`
4. forward the request to Mabel

Mabel validates:

- user exists or can be auto-created
- group claims for admin functions
- ownership on every resource access

**Implemented:**
- per-user project, conversation, file, memory ownership
- admin group checks
- approval decision enforcement
- usage attribution to user

**Current gaps:**
- browser identity headers are trusted (no signed headers)
- approval policy is permissive (doesn't block execution)
- scheduled tasks run under the requester's identity (no service principal)

---

# 15. Security boundaries and trust model

**Important trust boundaries:**

1. browser to identity-aware edge
2. edge to API identity
3. API to model provider
4. API to file storage
5. agent runtime to MCP connector
6. connector to external source system

**Security defaults and requirements:**

- secrets are environment-driven and excluded from Git
- local MCP endpoints must be loopback addresses
- tool arguments and model-session payloads are bounded
- sensitive provider tracing is disabled by default
- artifact and Markdown rendering use sanitization or browser sandboxing
- data access is owner-scoped in application routes
- development identity mode must not be exposed publicly
- trusted-header identity requires a proxy that strips unverified headers
- connector policy allows reads, requires approval for create/update, denies delete/admin by default

**Documented gaps and required hardening:**

See [docs/security.md](docs/security.md) for the complete 13-item blockers list.

---

# 16. Current gaps and hard truths

Mabel is a working platform foundation, not a finished multi-tenant control plane.

**Gaps:**

- development identity is not production authentication
- approval records are not one durable state machine
- workflows are partly declarative (not fully distributed)
- run resume and steering is broader than live execution support
- local files and SQLite sessions constrain horizontal scale
- PostgreSQL includes compatibility-state writes
- schedules need atomic distributed claims for multi-worker deployment
- deletion is not orchestrated across all stores and providers
- deep health reports configuration readiness more than upstream success
- approval policy does not enforce approvals (tools execute immediately)
- skills and workflows lack ownership checks
- RAG search exposes all content to any authenticated user
- connector state is global (not tenant-isolated)
- browser identity headers are trusted by default
- generated HTML artifacts execute scripts with network access

Each is an engineering boundary, not a hidden product claim. The architecture is designed
so each can be replaced behind a clear interface.

---

# 17. API reference and endpoints

OpenAPI reference at `/openapi.json`, Swagger UI at `/docs`, ReDoc at `/redoc`.

Major API domains:

```
/api/v1/bootstrap             POST   session initialization
/api/v1/chat                  POST   streaming agent turns
/api/v1/conversations         GET/POST  conversation CRUD
/api/v1/projects              GET/POST  project CRUD
/api/v1/uploads               POST   file uploads
/api/v1/files                 GET    file list and download
/api/v1/documents             POST   save run output
/api/v1/artifacts             GET/POST  artifact storage
/api/v1/memory                GET/POST  user memory
/api/v1/rag                   POST   retrieval across projects
/api/v1/mcp                   GET/POST  tool discovery and test
/api/v1/skills                GET/POST  skill catalog
/api/v1/workflows             GET/POST  workflow packs
/api/v1/runs                  GET    run history
/api/v1/scheduled             GET/POST  prompt scheduling
/api/v1/approvals             GET/POST  approval records
/api/v1/usage                 GET    usage accounting
/api/v1/admin                 POST   administrative actions
```

See [docs/api.md](docs/api.md) for endpoint signatures, payloads, and side effects.

---

# 18. Repository structure

```
Mabel/
├── apps/
│   ├── web/                 React + Vite workspace
│   │   ├── src/mabel/       UI components, API client, stream state
│   │   ├── tests/           component and integration tests
│   │   └── public/          static assets
│   │
│   └── api/                 FastAPI application
│       ├── mabel_api/       routes, runtime, MCP, stores, models
│       │   ├── routes/      endpoint implementations
│       │   ├── agents/      agent runtime and context assembly
│       │   ├── mcp/         MCP manager and policy
│       │   ├── stores/      memory and PostgreSQL implementations
│       │   ├── models/      Pydantic data models
│       │   └── services/    reusable business logic
│       │
│       └── tests/           API test suite (111 tests)
│
├── packages/
│   ├── catalog/             connector metadata and types
│   └── skills/              local reusable skill definitions
│
├── docs/
│   ├── README.md            this file
│   ├── api.md               endpoint and event reference
│   ├── architecture.md      subsystem deep dive
│   └── security.md          trust boundaries and deployment
│
├── deploy/
│   └── nginx.conf           reverse-proxy template
│
├── scripts/
│   ├── dev.sh               local development launcher
│   ├── verify.sh            test and build verification
│   └── ...                  other local helpers
│
├── compose.yaml             containerized stack
├── .env.example             configuration template
├── package.json             root workspace config
└── tsconfig.json            TypeScript configuration
```

---

# 19. Quick start

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

- application store: memory (no persistence)
- agent session store: SQLite local
- identity: development user (single hardcoded user)
- file storage: `var/`

### Durable PostgreSQL mode

```bash
export MABEL_STORE_MODE=postgres
export MABEL_DB_URL=postgresql://user:password@localhost:5432/mabel
.venv/bin/mabel-api init-db
.venv/bin/mabel-api serve --host 127.0.0.1 --port 8820
```

In a separate terminal:

```bash
npm --prefix apps/web run dev
```

### Containers

```bash
export MABEL_POSTGRES_PASSWORD=YOUR_PASSWORD
export OPENAI_API_KEY=YOUR_API_KEY
docker compose up --build
```

Web is on port 5173, API is on port 8820.

---

# 20. Configuration reference

All environment-specific values are externalized. See `.env.example` for the full template.

### Service and persistence

```bash
MABEL_HOST=0.0.0.0
MABEL_PORT=8820
MABEL_STORE_MODE=memory | postgres
MABEL_DB_URL=postgresql://user:password@host:5432/database
MABEL_SESSION_DB_PATH=/tmp/mabel_sessions.db
MABEL_UPLOADS_DIR=var/uploads
MABEL_UPLOADS_MAX_BYTES=100000000
```

### OpenAI runtime

```bash
OPENAI_API_KEY=...
MABEL_OPENAI_MODEL=gpt-4o | gpt-4-turbo
MABEL_OPENAI_AGENTS_ENABLED=true
MABEL_OPENAI_WEB_SEARCH_ENABLED=true
MABEL_OPENAI_CODE_INTERPRETER_ENABLED=true
MABEL_OPENAI_IMAGE_GENERATION_ENABLED=true
MABEL_OPENAI_FILE_SEARCH_ENABLED=true
MABEL_OPENAI_SESSION_HISTORY_LIMIT=5
MABEL_TRACE_INCLUDE_SENSITIVE_DATA=false
```

### Identity

```bash
MABEL_AUTH_MODE=development | trusted_headers
MABEL_DEV_USER_EMAIL=user@example.com
MABEL_DEV_USER_ID=user-1
MABEL_DEV_USER_NAME=Local User
```

In `trusted_headers` mode, the proxy must inject verified headers:

```bash
X-User-Email: user@example.com
X-User-Id: user-1
X-User-Name: User Name
X-User-Groups: mabel-admins, mabel-approvers
```

### MCP connectors

```bash
MABEL_LOCAL_MCP_ENDPOINTS_JSON='{"github":"http://127.0.0.1:9001/mcp"}'
MABEL_LOCAL_MCP_ENDPOINT_GITHUB=http://127.0.0.1:9001/mcp
MABEL_MCP_GATEWAY_PROXY_BASE_URL=https://gateway.example.com
MABEL_MCP_TOOL_TIMEOUT_SECONDS=30
MABEL_MCP_TOOL_ARGS_MAX_BYTES=50000
MABEL_MCP_TOOL_RESULT_MAX_CHARS=500000
MABEL_MCP_TOOL_POLICY_RULES_JSON='[{"server":"*","tool":"*","scope":"read","decision":"allow"}]'
MABEL_MCP_TOOL_BLOCKLIST_JSON='["delete_*", "destroy_*"]'
```

### Skills registry

```bash
MABEL_SKILLS_GITHUB_REPO=organization/skills-repo
MABEL_SKILLS_GITHUB_REF=main
MABEL_SKILLS_GITHUB_BASE_PATH=skills/
MABEL_SKILLS_GITHUB_TOKEN=ghp_...
```

---

# 21. Verification and testing

Run the full local gate:

```bash
bash scripts/verify.sh
```

Individual commands:

```bash
npm run typecheck                          # TypeScript strict check
npm run test                               # Frontend unit tests
npm run build                              # Production bundle
.venv/bin/python -m pytest apps/api/tests # API test suite
npm audit --omit=dev                       # Dependency scan
```

**Current local status:**

- API: 111 passing tests (Implemented)
- Web: 51 passing tests (Implemented)
- TypeScript: strict no-emit passes (Implemented)
- Production bundle: builds successfully (Implemented)
- npm audit: zero known vulnerabilities (Observed)

These checks verify the local source contract. They do not prove cloud deployment,
external connector entitlement, model-provider quota, or production service-level objectives.

---

# 22. Deployment and operations

### Health checks

```bash
curl http://localhost:8820/healthz                 # shallow (ready to receive requests)
curl http://localhost:8820/api/v1/health/deep     # deep (external dependencies)
```

### Docker Compose stack

The `compose.yaml` includes:

- Mabel web (port 5173)
- Mabel API (port 8820)
- PostgreSQL 16 with pgvector (port 5432)

### Reverse proxy

Mabel behind a reverse proxy (nginx):

```nginx
server {
    listen 443 ssl http2;
    server_name mabel.example.com;

    ssl_certificate /etc/ssl/certs/...;
    ssl_certificate_key /etc/ssl/private/...;

    # Authenticate and inject identity headers
    auth_request /external/auth;
    
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /mabel-api {
        # Remove caller-supplied identity headers
        proxy_set_header X-User-Email "";
        proxy_set_header X-User-Id "";
        
        # Inject verified identity
        proxy_set_header X-User-Email $auth_user_email;
        proxy_set_header X-User-Id $auth_user_id;
        proxy_set_header X-User-Name $auth_user_name;
        
        proxy_pass http://127.0.0.1:8820;
    }
}
```

See `deploy/nginx.conf` for a complete template.

---

# Contributing

This is a technical blueprint, not a prompt gallery or a contribution guide.
Contributions should preserve:

- exact `Mabel` product naming
- environment-driven configuration
- same-origin browser API paths
- explicit identity and ownership boundaries
- test coverage for behavior changes
- evidence-backed product claims
- small, reviewable commits

Avoid:

- promoting unverified claims
- adding Contributing or License sections to README
- increasing AI-generated narrative
- removing security documentation

---

## License and release status

This repository is in pre-release preparation. No open-source license is granted
until a `LICENSE` file is intentionally selected and added by the rights holder.
Do not redistribute the source before that release gate is complete.
