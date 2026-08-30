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

For production, use a fail-closed rule set. Example:

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

## Reporting vulnerabilities

Do not disclose suspected vulnerabilities in a public issue. Contact the
maintainer privately with:

- affected revision
- reproduction steps
- impact
- suggested mitigation
- whether the issue is already public
