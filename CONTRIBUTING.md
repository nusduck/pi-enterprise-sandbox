# Contributing to Pi Enterprise Sandbox

Thank you for considering contributing! This document outlines the guidelines.

## Code of Conduct

Be respectful, constructive, and inclusive. We're all here to build something great.

## Development Setup

### Prerequisites

- **Python 3.11** (pinned minor; see `runtime-versions.json` / `.python-version`)
- **Node.js 22** (pinned major; engines `>=22.19.0 <23`; see `runtime-versions.json` / `.node-version`)
- Docker & Docker Compose (for container testing)
- `uv` (recommended) or `pip`

Runtime/SDK pins are machine-checked by `tests/test_runtime_versions.py`.

### Local Setup

权威干净安装与本地四进程步骤见 [docs/development.md](./docs/development.md)。摘要：

```bash
# Clone and enter
git clone <repo-url>
cd pi-enterprise-sandbox

cp .env.example .env   # fill LLMIO_*; never commit real secrets

# Python (Sandbox + pytest)
uv sync --extra test

# Node API Server + Agent + Frontend (lockfile present → prefer npm ci)
npm ci --prefix api-server
npm ci --prefix agent
npm ci --prefix frontend
```

### Run Tests (aligned with `.github/workflows/test.yml`)

```bash
# Python (includes runtime version consistency)
uv run pytest tests/ -q --tb=short

# Node API Server
node --test api-server/tests/*.test.js
# or: npm test --prefix api-server

# Node Agent（全部层级测试）
node --test agent/tests/*.test.js agent/tests/**/*.test.js
# or: npm test --prefix agent

# Frontend
npm test --prefix frontend
npm run build --prefix frontend

# Compose file validation
test -f .env || cp .env.example .env
docker compose config -q
```

Ruff/Black/Mypy 与覆盖率阈值目前**不是** CI 强制门禁。

## Project Structure

```
pi-enterprise-sandbox/
├── frontend/          # Vite + React SPA → Nginx；src/ (pure UI, no Agent SDK)
│   ├── test/          # node:test
│   ├── index.html
│   ├── Dockerfile
│   └── nginx.conf     # /api/* → api-server:4000
├── api-server/        # Thin Node BFF (auth, files, SSE relay)
│   ├── server.js
│   ├── routes/        # chat.js, status.js, conversations, files, …
│   ├── services/      # sandbox-client.js, agent-client.js
│   ├── config.js      # AGENT_BASE_URL / auth
│   └── tests/         # node:test
├── agent/             # Independent pi-coding-agent runtime
│   ├── server.js      # internal Run API + health
│   ├── config.js
│   ├── src/application/ # Run, Session, approval, A2A services
│   ├── src/extensions/  # sandbox-bridge, enterprise-policy, observability
│   ├── src/infrastructure/ # MySQL, Redis, Pi, MCP, Sandbox ports
│   ├── services/      # model registry and platform services
│   └── tests/         # node:test + sdk-compat
├── sandbox/           # FastAPI execution / files / datasets / artifacts (no agent loop)
│   ├── main.py
│   ├── routers/       # incl. health.py (/health liveness, /ready readiness)
│   ├── services/
│   ├── security/      # path_validation, safe_env, public_routes
│   └── mcp/
├── skills/            # Optional shared skill packages (profile + registry controlled)
├── tests/             # pytest (unit + FastAPI integration)
├── docs/              # Active docs (docs/archive/ is historical only)
├── config/            # Runtime config files
├── nginx/             # Production Nginx + SSL
├── scripts/           # backup/restore, development reset, cross-service smoke
├── docker-compose.yml # Dev topology: services + MySQL 8 + Redis 7
├── docker-compose.prod.yml # Prod overlay: MySQL 8 + Redis 7 + Nginx + secrets required
├── .github/workflows/ # CI matrix: python / node / frontend / compose
├── plan.md            # Current refactor baseline and acceptance criteria
└── pyproject.toml
```

**Persistence:** MySQL 8 is the sole database topology for development and
production (`AGENT_DATABASE_URL`, `SANDBOX_DATABASE_URL`, `MYSQL_*`). Do not
reintroduce Compose PostgreSQL or SQLite defaults. The Sandbox test suite uses
connection-free fakes and an unreachable MySQL-shaped DSN; it does not install a
SQLite compatibility runtime. Tests that construct a SQLite `Settings` value do
so only to verify the startup rejection path.

**Runtime coordination:** Redis 7 is the Agent-only coordination topology
(`AGENT_REDIS_URL` / `REDIS_URL`, `REDIS_PASSWORD`, queue/lease/stream settings).
It holds queues, leases, streams, and cancel signals — never authoritative Run
facts. Clearing Redis loses only coordination state; MySQL facts + Outbox
replay recover durable events. BFF and Sandbox must not take Redis authority
in PR-03. Production fails fast when `REDIS_PASSWORD` is missing.


> Root-level `PLAN.md` / `AUDIT.md` / `IMPROVEMENT_PLAN.md` live under `docs/archive/`.  
> Production Agent code imports from `agent/src`; the legacy `enterprise-agent-kit` package and root runtime facades have been removed.

## How to Contribute

1. **Pick an issue** — check open issues or create one
2. **Fork & branch** — `git checkout -b feat/your-feature`
3. **Make changes** — follow `plan.md`, active docs, and existing code style
4. **Write tests** — cover new functionality at the nearest layer
5. **Run gates** — Python + Node + frontend + `docker compose config -q` as above
6. **Lint (optional)** — `ruff check .` / `black --check .` if available locally
7. **Push & PR** — open a pull request with a clear description

## Code Style

### Python

- Follow [PEP 8](https://peps.python.org/pep-0008/)
- Use type hints for all function signatures
- Use `from __future__ import annotations` for forward references
- Prefer async/await at I/O boundaries; sync is fine for most Router/Service/DB paths
- Use `pathlib.Path` for filesystem operations
- Use Pydantic models for data validation

### JavaScript (Node.js + Frontend)

- ES modules (`import`/`export`) — no CommonJS
- `const` > `let` > `var` (no `var`)
- `async/await` over raw promises
- 2-space indentation
- Descriptive variable names
- Frontend: keep agent/LLM logic out of the browser; sanitize/allowlist download URLs

### CSS

- Custom properties in `:root` for theming
- Mobile-first responsive design
- Dark theme as default, light as `[data-theme="light"]`

## Pull Request Checklist

- [ ] Python tests pass (`uv run pytest tests/ -q --tb=short`)
- [ ] Runtime pins consistent (`uv run pytest tests/test_runtime_versions.py -q`)
- [ ] Node BFF tests pass (`npm test --prefix api-server`)
- [ ] Node Agent tests pass (`npm test --prefix agent`)
- [ ] Frontend tests + build pass
- [ ] `docker compose config -q` succeeds
- [ ] New code has tests where behavior changed
- [ ] Active docs / `.env.example` updated if API or ops behavior changes
- [ ] No hardcoded secrets
- [ ] Node syntax valid (`node --check` on touched sources)

## Architecture Decisions

See [plan.md](./plan.md) and [docs/architecture.md](./docs/architecture.md) for:

- Why service-side Agent runtime (no LLM key in the browser)
- Four-service architecture (Frontend + BFF + Agent + Sandbox)
- Why MySQL 8 is the sole formal persistence topology
- Why Redis 7 is Agent-only runtime coordination (not fact authority)
- Why Agent Session-owned Workspace isolation (one active Agent Session per Conversation by default)
- Why SSE streaming (not WebSocket)
- Why approval workflow for high-risk tools
- Independent Node Agent service (Python agent runtime removed)

## Getting Help

- Open a GitHub issue for questions
- Check [docs/](./docs/) for detailed guides
