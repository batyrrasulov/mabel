# Contributing to Mabel

## Ground rules

- Use the product name `Mabel`.
- Keep secrets and environment-specific URLs out of source.
- Use same-origin browser API paths.
- Preserve identity, ownership, and connector policy boundaries.
- Add or update tests for behavior changes.
- Separate implemented behavior from proposals in documentation.
- Keep commits small enough to review independently.

## Setup

```bash
cp .env.example .env
bash scripts/dev.sh
```

## Validation

```bash
bash scripts/verify.sh
npm audit --omit=dev
```

Every pull request should state:

- the user-visible or platform outcome
- affected components
- security and data impact
- validation commands and results
- remaining limitations

## Repository boundaries

- web changes: `apps/web`
- API and runtime changes: `apps/api`
- connector metadata: `packages/catalog`
- reusable skills: `packages/skills`
- deployment: `deploy`
- architecture and API contract: `docs`

Do not place new product code in the repository root.

## Naming

Use:

- `Mabel` for the product
- `mabel` for paths and general identifiers
- `MABEL_` for environment variables
- `mabel_api` for the Python package
- `/mabel-api` for the browser proxy prefix

## Testing

Backend:

```bash
.venv/bin/python -m pytest apps/api/tests
```

Frontend:

```bash
npm run typecheck
npm run test
npm run build
```

For an API behavior change, test:

- valid request
- invalid request
- ownership or authorization boundary
- durable side effect

For an agent or MCP behavior change, test:

- event contract
- connector disabled state
- policy result
- upstream failure
- payload bounds

## Commit style

Prefer one coherent outcome per commit:

```text
feat(web): add artifact navigation
feat(api): persist workflow checkpoints
fix(mcp): reject disabled connector calls
docs: explain agent execution flow
test(api): cover project ownership boundary
```

Do not split mechanical edits into fake commits or create commits solely to
inflate contribution counts.
