# Design: quality gates and docs

## CI shape

Prefer one workflow or matrix jobs:

1. python — install deps, pytest
2. node-api — install, node tests / --check
3. frontend — install, test, build
4. compose — `docker compose config -q`

Cache package managers where safe. Fail-fast optional; full matrix preferred for evidence.

## Readiness

- `/health` — process up
- `/ready` — DB/workspace root/config present as required

Do not echo secrets or full env dumps.

## Docs sources of truth

- Runtime architecture: `.trellis/spec/project-architecture.md` + `README.md`
- API: `docs/api.md` (if present)
- Ops: deployment section + `.env.example`
