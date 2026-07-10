# Verification evidence — quality / operations / docs

**Task:** `.trellis/tasks/07-11-quality-operations-docs`  
**Date:** 2026-07-11  
**Host:** local clean-ish install (existing `.venv` / `node_modules` acceptable; commands match CI)

> No secrets, `.env` contents, tokens, or private keys are recorded here.

---

## Commands run and results

| Gate | Command | Result |
|------|---------|--------|
| Python tests | `uv run pytest tests/ -q --tb=short` | **200 passed**, 1 warning (Starlette/httpx TestClient deprecation), ~7.8s |
| Node API tests | `node --test api-server/tests/*.test.js` | **7 passed**, 0 failed (~1.7s) |
| Node syntax | `find api-server -name '*.js' ! -path '*/node_modules/*' -exec node --check {} \;` | **exit 0** |
| Frontend tests | `npm test --prefix frontend` | **35 passed**, 0 failed (~4.1s) |
| Frontend build | `npm run build --prefix frontend` | **success** (Vite production build, ~74ms) |
| Compose | `docker compose config -q` | **exit 0** |

### CI definition

`.github/workflows/test.yml` — four isolated `ubuntu-latest` jobs:

1. **python** — `uv sync --extra test` → `uv run pytest tests/ -q --tb=short`
2. **node-api** — `npm ci --prefix api-server` → `node --test api-server/tests/*.test.js` + `node --check`
3. **frontend** — `npm ci --prefix frontend` → `npm test` → `npm run build`
4. **compose** — copy `.env.example` → `.env` if missing → `docker compose config -q`

### Readiness probe (this child)

| Probe | Behavior after change |
|-------|------------------------|
| `GET /health` | Liveness only; **200** if process answers; no secret leakage |
| `GET /ready` | Workspaces root writable **and** DB `SELECT 1`; **503** + `status=not_ready` when not ready |

Regression coverage: `tests/test_integration.py` (`TestHealthIntegration`) asserts 200 happy path, 503 on workspace/DB failure mocks, and no `api_key` / `password` / `sqlite:///` in body.

---

## Parent PRD acceptance criteria → child delivery

Parent: `.trellis/tasks/07-11-fullstack-stability-completeness/prd.md`

| Parent AC | Primary child | Evidence |
|-----------|---------------|----------|
| P0 auth bypass, artifact traversal/session mismatch, binary corruption have regression tests | `07-11-backend-security-artifact-integrity` | Python tests under `tests/test_auth*.py`, artifact/file suites; public routes `/health` `/ready` |
| Two concurrent chat turns prove trace/session/tool/approval context cannot cross requests | `07-11-request-context-execution-lifecycle` | `api-server/tests/request-context.test.js` (7 Node tests include concurrent client/tools isolation) |
| Running execution can be cancelled; process terminated; lock/status correct | `07-11-request-context-execution-lifecycle` | Python execution cancel tests in `tests/` |
| Production chat uses approved Python-first route **or** documented reversible compatibility mode, with parity tests | `07-11-python-agent-production-cutover` | `AGENT_RUNTIME=node` **default** / `python` proxy; `.env.example`, `docs/api.md`, `api-server/tests/agent-runtime-config.test.js`, Python agent parity tests |
| Frontend automated tests cover SSE fragmentation/abort/error, state reset/switching, approval/artifact/injection | `07-11-frontend-resilience-security` | `frontend/test/*.test.js` — **35** tests (SSE, state, security/a11y) |
| Full Python, Node, frontend suites, frontend production build, `docker compose config -q` pass from clean-install definition | **`07-11-quality-operations-docs` (this child)** | Table above + CI workflow matrix |
| Docker health/readiness checks distinguish alive vs ready; no credentials in logs/test artifacts | **this child** (+ compose still uses `/health` for container liveness) | `sandbox/routers/health.py`; docs in `docs/api.md`, `docs/deployment.md` |
| Active architecture/API/development/deployment docs and Trellis specs match implemented behavior | **this child** | `README.md`, `docs/*` (incl. `webui.md`), `CONTRIBUTING.md`, `.env.example`, `.trellis/spec/*`; stale banners on `AUDIT.md` / `PLAN.md` / `IMPROVEMENT_PLAN.md` |
| Supervising agent requirement-by-requirement audit before parent archive | Supervising agent | This file is the attachable evidence package |

### Child requirement checklist (this task)

| Req | Status |
|-----|--------|
| R1 CI matrix | Done — four jobs in `.github/workflows/test.yml` |
| R2 Readiness | Done — `/health` vs `/ready` + 503 |
| R3 Docs accuracy | Done — active docs + specs + outdated markers; check pass also refreshed `docs/webui.md` + `CONTRIBUTING.md` |
| R4 Evidence | Done — this file |
| R5 Clean-install commands | Done — `docs/development.md` |

---

## Clean-install command block (documented)

From repository root (also in `docs/development.md`):

```bash
cp .env.example .env   # fill LLMIO_*; never commit real secrets
uv sync --extra test
npm ci --prefix api-server
npm ci --prefix frontend

uv run pytest tests/ -q --tb=short
node --test api-server/tests/*.test.js
npm test --prefix frontend
npm run build --prefix frontend
docker compose config -q
```

**Default not flipped:** `AGENT_RUNTIME=node` remains default in `.env.example`, `api-server/config.js`, and Compose.
