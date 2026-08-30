# Mabel security model

## Trust boundaries

Mabel processes model input, uploaded files, retrieved content, connector output,
generated code, and external-system actions. Every one of those inputs can be
hostile.

Primary boundaries:

1. browser to edge
2. edge to API identity
3. API to model provider
4. agent runtime to MCP
5. MCP to source system
6. API to application store
7. API to file storage
8. generated artifact to browser renderer

## Authentication modes

### Development

`MABEL_AUTH_MODE=development` resolves one configured local identity. It exists
for local work and tests. Never expose it on an internet-facing deployment.

### Trusted headers

`MABEL_AUTH_MODE=trusted_headers` accepts identity headers from an upstream
identity-aware proxy.

The proxy must:

- authenticate the user
- remove caller-supplied `X-User-*` headers
- inject verified identity claims
- terminate TLS
- restrict direct API access

Mabel does not currently ship a complete OIDC browser flow.

## Authorization

Routes scope projects, conversations, files, documents, memory, schedules, and
runs to the resolved user. Administrative endpoints require the `mabel-admins`
group. Approval decisions recognize `mabel-approvers`.

Production work should add:

- tenant ID on every row and cache key
- database row-level security
- role and permission claims from the identity provider
- service identities for background execution
- explicit reviewer separation for approvals

## MCP tools

Local MCP URLs are restricted to loopback hosts. Remote tools require an
explicit gateway. Tool requests are checked against:

- connector enabled state
- inferred read/create/update/delete/admin/unknown scope
- ordered policy rules
- tool-name blocklist
- serialized argument limit

The built-in fallback allows reads, requires approval for create/update, and
denies delete/admin/unknown operations. Production deployments should still use
an explicit reviewed rule set. Example:

```json
[
  {"server": "*", "tool": "*", "scope": "read", "decision": "allow"},
  {"server": "*", "tool": "*", "scope": "create", "decision": "ask"},
  {"server": "*", "tool": "*", "scope": "update", "decision": "ask"},
  {"server": "*", "tool": "*", "scope": "delete", "decision": "deny"},
  {"server": "*", "tool": "*", "scope": "admin", "decision": "deny"},
  {"server": "*", "tool": "*", "scope": "unknown", "decision": "deny"}
]
```

Name-based scope inference is a useful fallback, not a complete authorization
model. Connector-declared annotations and reviewed tool manifests should replace
it for high-risk actions.

## Prompt injection

Treat all of the following as untrusted:

- user uploads
- web pages
- connector results
- project notes
- saved memory
- documents and artifacts
- tool error messages

The runtime keeps this content in user/context input rather than silently
promoting it into top-level instructions. Tool policy must still be enforced
outside the model because prompt instructions alone are not a security boundary.

## Files

Current controls:

- configurable per-file size limit
- user ownership checks
- configured storage root
- best-effort provider-file deletion
- browser sandboxing for previews

Production additions:

- malware and archive scanning
- MIME verification
- object storage with tenant prefixes
- signed, expiring download URLs
- storage quotas
- lifecycle and retention policies
- deletion across backups and provider mirrors

## Artifacts and rendering

Markdown is sanitized. HTML artifacts use a sandboxed iframe. Script-enabled
artifacts can still attempt outbound network requests; a production deployment
should add a restrictive Content Security Policy and a renderer isolation origin.

## Secrets

Secrets must come from environment or a secret manager. Never commit:

- `.env`
- API keys
- OAuth client secrets
- connector tokens
- database passwords
- private keys
- identity-provider signing material

Sensitive provider tracing is disabled by default.

## Logging and privacy

Tool arguments, outputs, prompts, sources, and generated artifacts may contain
personal or confidential data. Before production:

- define a structured redaction policy
- classify fields by sensitivity
- prevent secret values from entering logs
- set retention periods
- expose user export and deletion
- document provider subprocessors
- add immutable security audit events for controlled actions

## Known limitations and required hardening

**Do not deploy to production without addressing these gaps:**

### Backend authorization

1. **Scheduled task execution is not isolated** (`routes/scheduled.py:322-333`)
   - Any authenticated user can invoke `/api/v1/scheduled/run-due`, executing all due tasks under their owner's identity.
   - **Fix:** Restrict to a dedicated scheduler principal using signed service authentication; never accept interactive users as the execution identity.

2. **Skills lack ownership enforcement** (`routes/skills.py`)
   - Detail, update, run endpoints do not validate skill ownership or access.
   - Any authenticated user can read, modify, or execute any known skill.
   - **Fix:** Add `_assert_resource_owner_or_admin()` checks on all mutation routes.

3. **RAG search exposes all skill content** (`routes/rag.py:112-127`)
   - Search iterates all skills regardless of visibility or ownership.
   - **Fix:** Filter results through `relay_skill_is_visible()` and user access checks.

4. **Workflow packs are not access-controlled** (`routes/workflows.py`)
   - Any authenticated user can run any workflow pack or starter pack.
   - **Fix:** Enforce owner/team membership; add visibility checks.

5. **Document ownership validation is missing** (`routes/documents.py:43-105`)
   - Create/update accept arbitrary `conversation_id` without existence or ownership checks.
   - Database has no foreign-key constraint.
   - **Fix:** Validate conversation exists and is owned by the user.

6. **Approval policy is not enforced** (`mcp/manager.py`, `routes/mcp.py`)
   - `requires_approval()` always returns false.
   - Policy decision `ask` executes immediately instead of blocking.
   - Users can create self-approving payloads.
   - **Fix:** Require explicit approval from a separate authorized principal before tool execution.

7. **Connector state is global, not tenant-isolated**
   - Enabling/disabling/syncing connectors affects all users.
   - Shared cached tools and credentials create cross-user leakage.
   - **Fix:** Scope connectors by tenant/user; implement per-user token storage.

8. **Browser identity headers are trusted by default**
   - Frontend can set `X-User-Email`, `X-User-Name`, `X-User-Id` without authentication.
   - `MABEL_TRUST_EDGE_IDENTITY_HEADERS` disables local validation but is easy to enable accidentally.
   - **Fix:** Require mutable headers to pass through a signed edge proxy only; make development mode reject direct header spoofing.

### Frontend authorization and safety

9. **Connector test calls execute write tools without confirmation**
   - `ConnectorsPage.tsx` auto-fills tool arguments with empty/default values and submits.
   - No scope classification or user confirmation gate exists.
   - **Fix:** Require explicit confirmation for write-like tools; implement scope-aware UI gating.

10. **Generated HTML artifacts execute scripts**
    - `ArtifactPanel.tsx` and `RelayFilePreviewPanel.tsx` use `sandbox="allow-scripts"`.
    - Iframes can make outbound network requests.
    - **Fix:** Remove `allow-scripts` by default; use restrictive CSP and same-origin policy.

11. **Favicon URLs disclose source domains to Google**
    - `MessageSources.tsx` and `MessageSteps.tsx` fetch `google.com/s2/favicons`.
    - **Fix:** Remove external favicon requests or cache locally.

### Persistence and operations

12. **Dual state (normalized + JSONB) creates consistency gaps**
    - Every operation reloads and rewrites the global `relay_v2_state` row.
    - Serialization, contention, stale-state, and scaling risks.
    - **Fix:** Choose one state storage (normalized or JSONB); implement versioned migrations.

13. **SQLiteSession is not multi-replica safe**
    - Local-node storage with no shared session backend.
    - Requires sticky routing or replacement.
    - **Fix:** Migrate to PostgreSQL or Redis for agent session history.

## Reporting vulnerabilities

Do not disclose suspected vulnerabilities in a public issue. Contact the
maintainer privately with:

- affected revision
- reproduction steps
- impact
- suggested mitigation
- whether the issue is already public
