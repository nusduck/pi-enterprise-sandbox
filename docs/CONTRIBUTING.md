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

权威干净安装与本地四进程步骤见 [development.md](./development.md)。摘要：

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

# Node API Server（先构建再测试）
npm test --prefix api-server

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

覆盖率阈值目前**不是** CI 强制门禁。服务代码的类型检查走各自的 `tsc`；
Python `tests/` 只做仓库卫生。

## Project Structure

权威源根见 [`module-layout.md`](./module-layout.md)。摘要：

```
pi-enterprise-sandbox/
├── frontend/          # Vite + React SPA → Nginx；src/ (pure UI, no Agent SDK)
├── api-server/        # Thin Node BFF (auth, files, SSE relay)；server.js
├── agent/             # Independent DSH agent（TypeScript；容器跑 dist/）
│   ├── server.ts / worker.ts / config.ts
│   └── src/{application,runtime,bootstrap,infrastructure,presentation,skills,domain}
├── exec/              # TypeScript 执行面 + MCP facade（compose: sandbox / sandbox-mcp）
├── contract/          # exec ↔ agent runtime 的 RPC 信封、HMAC、错误码
├── skills/            # Optional shared skill packages
├── tests/             # pytest：结构棘轮、版本钉、compose 安全、SSE 夹具
├── docs/              # Active docs — see docs/README.md
├── nginx/             # Production Nginx + SSL
├── scripts/           # backup/restore, development reset, cross-service smoke
├── docker-compose.yml
├── docker-compose.prod.yml
└── .github/workflows/ # CI：python / node-bff / node-agent / frontend / compose / smoke
                       # （exec 与 contract 的 job 还没加，见 HANDOFF）
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


> Production Agent code imports from `agent/src`; the legacy `enterprise-agent-kit` package and root runtime facades have been removed.

## How to Contribute

1. **Pick an issue** — check open issues or create one
2. **Fork & branch** — `git checkout -b feat/your-feature`
3. **Make changes** — follow `docs/plan.md`, `docs/STATUS.md`, and active docs (see `docs/README.md`)
4. **Write tests** — cover new functionality at the nearest layer
5. **Update STATUS** — if the change affects a `docs/plan.md` §32 row, update `docs/STATUS.md` in the same commit; append `docs/PROCESS_LOG.md` for acceptance-program work
6. **Run gates** — Python + Node + frontend + `docker compose config -q` as above
7. **Lint (optional)** — `ruff check .` / `black --check .` if available locally
8. **Push & PR** — open a pull request with a clear description

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

See [plan.md](./plan.md), [STATUS.md](./STATUS.md), and [architecture.md](./architecture.md) for:

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
- Check the [documentation map](./README.md) for detailed guides
