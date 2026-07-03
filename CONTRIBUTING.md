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

# WebUI (if working on frontend)
cd webui && npm install && cd ..
```

### Run Tests

```bash
# All tests
uv run pytest -q

# Specific area
uv run pytest tests/test_integration.py -v
uv run pytest tests/test_webui_api.py -v   # WebUI API tests
uv run pytest tests/test_persistence.py -v # DB persistence tests

# With coverage
uv run pytest --cov=sandbox --cov-report=term-missing
```

## Project Structure

```
pi-sandbox/
├── sandbox/          # Sandbox Service (FastAPI backend)
│   ├── main.py       # App entry point
│   ├── config.py     # Settings (env-based)
│   ├── models.py     # Pydantic models
│   ├── database.py   # SQLite persistence
│   ├── repositories.py # Data access layer
│   ├── trace.py      # Trace ID context
│   ├── routers/      # API routers
│   ├── services/     # Business logic
│   ├── security/     # Path validation, safe_env
│   └── mcp/          # MCP Server Adapter
├── webui/            # WebUI (Node.js)
│   ├── server.js     # Entry point (thin router)
│   ├── config.js     # Configuration
│   ├── services/     # Backend services
│   ├── routes/       # Route handlers
│   ├── js/           # Frontend ES modules
│   ├── index.html    # Main page
│   └── style.css     # Styles
├── agent/            # Agent-side SDK + Pi Extension
├── skills/           # Built-in skills
├── tests/            # Test suite
├── docs/             # Documentation
├── config/           # Runtime config files
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
- [ ] Frontend syntax valid (`node --check webui/server.js`)

## Architecture Decisions

See [docs/architecture.md](./docs/architecture.md) for a detailed explanation of:

- Why HTTP API (not MCP) for agent→sandbox communication
- Why SQLite with WAL for persistence
- Why session-per-conversation isolation model
- Why approval workflow for high-risk tools

## Getting Help

- Open a GitHub issue for questions
- Check [docs/](./docs/) for detailed guides
