# Contributing to Pi Enterprise Sandbox

Thank you for considering contributing! This document outlines the guidelines.

## Code of Conduct

Be respectful, constructive, and inclusive. We're all here to build something great.

## Development Setup

### Prerequisites

- Python 3.11+
- Node.js 20+
- Docker & Docker Compose (for container testing)
- `uv` (recommended) or `pip`

### Local Setup

权威干净安装与本地三进程步骤见 [docs/development.md](./docs/development.md)。摘要：

```bash
# Clone and enter
git clone <repo-url>
cd pi-enterprise-sandbox

cp .env.example .env   # fill LLMIO_*; never commit real secrets

# Python (Sandbox + pytest)
uv sync --extra test

# Node API Server + Frontend (lockfile present → prefer npm ci)
npm ci --prefix api-server
npm ci --prefix frontend
```

### Run Tests (aligned with `.github/workflows/test.yml`)

```bash
# Python
uv run pytest tests/ -q --tb=short

# Node API Server
node --test api-server/tests/*.test.js
# or: npm test --prefix api-server

# Frontend
npm test --prefix frontend
npm run build --prefix frontend

# Compose file validation
test -f .env || cp .env.example .env
docker compose config -q
```

Ruff/Black/Mypy 与覆盖率阈值目前**不是** CI 强制门禁（见 `.trellis/spec/backend/quality-guidelines.md`）。

## Project Structure

```
pi-enterprise-sandbox/
├── frontend/          # Vite SPA → Nginx；src/{main,state,api,render,sse,security}.js
│   ├── test/          # node:test
│   ├── index.html
│   ├── Dockerfile
│   └── nginx.conf     # /api/* → api-server:4000
├── api-server/        # Node BFF + optional AGENT_RUNTIME=python proxy
│   ├── server.js
│   ├── routes/        # chat.js, status.js, conversations, files, …
│   ├── services/      # sandbox-client.js
│   ├── sandbox-tools.js
│   ├── config.js      # AGENT_RUNTIME normalization
│   └── tests/         # node:test
├── sandbox/           # FastAPI execution / files / approvals / agent
│   ├── main.py
│   ├── routers/       # incl. health.py (/health liveness, /ready readiness)
│   ├── services/
│   ├── security/      # path_validation, safe_env, public_routes
│   └── mcp/
├── skills/            # Built-in skills
├── tests/             # pytest (unit + FastAPI integration)
├── docs/              # Active docs (archive/ is historical)
├── config/            # Runtime config files
├── nginx/             # Production Nginx + SSL
├── scripts/           # Backup/restore utilities
├── .github/workflows/ # CI matrix: python / node-api / frontend / compose
├── .trellis/          # Specs + tasks
└── pyproject.toml
```

> `extensions/` 与 `sdk/` 已从仓库移除；勿按历史文档恢复。

## How to Contribute

1. **Pick an issue** — check open issues or create one
2. **Fork & branch** — `git checkout -b feat/your-feature`
3. **Make changes** — follow existing code style and `.trellis/spec/`
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
- [ ] Node API tests pass (`node --test api-server/tests/*.test.js`)
- [ ] Frontend tests + build pass
- [ ] `docker compose config -q` succeeds
- [ ] New code has tests where behavior changed
- [ ] Active docs / `.env.example` updated if API or ops behavior changes
- [ ] No hardcoded secrets
- [ ] API Server syntax valid (`node --check` on touched sources)

## Architecture Decisions

See [docs/architecture.md](./docs/architecture.md) and [`.trellis/spec/project-architecture.md`](./.trellis/spec/project-architecture.md) for:

- Why service-side Agent runtime (no LLM key in the browser)
- Three-container architecture (Frontend + API Server + Sandbox)
- Why SQLite with WAL for persistence (optional PostgreSQL)
- Why session-per-conversation isolation model
- Why SSE streaming (not WebSocket)
- Why approval workflow for high-risk tools
- `AGENT_RUNTIME=node` default with reversible `python` cutover

## Getting Help

- Open a GitHub issue for questions
- Check [docs/](./docs/) for detailed guides
