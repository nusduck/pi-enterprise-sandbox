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

```bash
# Clone and enter
git clone <repo-url>
cd pi-sandbox

# Python environment
uv venv
source .venv/bin/activate
uv pip install -e ".[test]"

# Frontend
cd frontend && npm install && cd ..

# API Server
cd api-server && npm install && cd ..
```

### Run Tests

```bash
# All tests
uv run pytest -q

# Specific area
uv run pytest tests/test_integration.py -v
uv run pytest tests/test_webui_api.py -v   # API Server tests
uv run pytest tests/test_persistence.py -v # DB persistence tests

# With coverage
uv run pytest --cov=sandbox --cov-report=term-missing
```

## Project Structure

```
pi-sandbox/
├── frontend/          # Frontend SPA (Vite + pi-web-ui → Nginx)
│   ├── src/main.js    # Single entry point (~463 lines vanilla JS)
│   ├── index.html     # Main page
│   ├── Dockerfile     # Nginx + Vite build
│   └── nginx.conf     # /api/* → api-server:4000
├── api-server/        # API Server (Node.js + pi-coding-agent SDK)
│   ├── server.js      # HTTP entry (POST /api/chat SSE, /api/status)
│   ├── agent-handler.js  # Agent session lifecycle + SSE streaming
│   ├── sandbox-tools.js  # read/write/edit/bash tools (→ Sandbox API)
│   └── Dockerfile
├── sandbox/           # Sandbox Service (FastAPI backend)
│   ├── main.py        # App entry + middleware + router registration
│   ├── config.py      # Settings (env-based)
│   ├── models.py      # Pydantic models
│   ├── database.py    # SQLite WAL persistence
│   ├── repositories.py # Data access layer
│   ├── routers/       # API routers (sessions/executions/files/artifacts/traces...)
│   ├── services/      # Business logic (session/execution/file/approval/audit...)
│   ├── security/      # Path validation, safe_env
│   └── mcp/           # MCP Server Adapter
├── extensions/        # Pi Agent TypeScript extension
├── sdk/               # Sandbox Node.js SDK
├── skills/            # Built-in skills
├── tests/             # Test suite (pytest)
├── docs/              # Documentation
├── config/            # Runtime config files
├── nginx/             # Production Nginx + SSL
├── scripts/           # Backup/restore utilities
└── pyproject.toml
```

## How to Contribute

1. **Pick an issue** — check open issues or create one
2. **Fork & branch** — `git checkout -b feat/your-feature`
3. **Make changes** — follow existing code style
4. **Write tests** — cover new functionality
5. **Run tests** — ensure all pass: `uv run pytest -q`
6. **Lint** — `ruff check .` or `black --check .`
7. **Push & PR** — open a pull request with a clear description

## Code Style

### Python

- Follow [PEP 8](https://peps.python.org/pep-0008/)
- Use type hints for all function signatures
- Use `from __future__ import annotations` for forward references
- Prefer async/await over synchronous blocking calls
- Use `pathlib.Path` for filesystem operations
- Use Pydantic models for data validation

### JavaScript (Node.js)

- ES modules (`import`/`export`) — no CommonJS
- `const` > `let` > `var` (no `var`)
- `async/await` over raw promises
- 2-space indentation
- Descriptive variable names

### CSS

- Custom properties in `:root` for theming
- Mobile-first responsive design
- Dark theme as default, light as `[data-theme="light"]`

## Pull Request Checklist

- [ ] Tests pass (`uv run pytest -q`)
- [ ] New code has tests
- [ ] Docs updated if API changes
- [ ] CHANGELOG.md updated
- [ ] No hardcoded secrets
- [ ] Docker build succeeds (`docker compose build sandbox`)
- [ ] API Server syntax valid (`node --check api-server/server.js`)

## Architecture Decisions

See [docs/architecture.md](./docs/architecture.md) for a detailed explanation of:

- Why service-side Agent runtime (no LLM Key in browser)
- Three-container architecture (Frontend + API Server + Sandbox)
- Why SQLite with WAL for persistence (optional PostgreSQL)
- Why session-per-conversation isolation model
- Why SSE streaming (not WebSocket)
- Why approval workflow for high-risk tools

## Getting Help

- Open a GitHub issue for questions
- Check [docs/](./docs/) for detailed guides
