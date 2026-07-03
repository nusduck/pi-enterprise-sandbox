# Development Guide

## Local Development Setup

### Prerequisites

- **Python 3.11+** with `uv` (recommended) or `pip`
- **Node.js 20+** (for WebUI development)
- **Docker** (for containerized testing)
- **Git**

### Step-by-Step

```bash
# 1. Clone the repository
git clone <repo-url>
cd pi-sandbox

# 2. Create Python virtual environment
uv venv
source .venv/bin/activate

# 3. Install dependencies
uv pip install -e ".[test]"

# 4. Install pre-commit hooks (optional)
pip install pre-commit
pre-commit install

# 5. Install WebUI dependencies
cd webui && npm install && cd ..
```

### Running Locally

```bash
# Terminal 1: Start Sandbox Service
uvicorn sandbox.main:app --port 8081 --reload

# Terminal 2: Start WebUI (requires sandbox running)
cd webui && SANDBOX_BASE_URL=http://localhost:8081 node server.js

# Terminal 3: Run tests
uv run pytest -q
```

### Running with Docker

```bash
# Full stack
docker compose up --build

# Just sandbox (for WebUI development with local server.js)
docker compose up --build sandbox -d
# Then run WebUI locally pointing at docker sandbox:
cd webui && SANDBOX_BASE_URL=http://localhost:8083 node server.js
```

## Development Workflows

### Adding a New API Endpoint

1. Create or update a router in `sandbox/routers/`
2. Add business logic in `sandbox/services/`
3. Register the router in `sandbox/main.py`
4. Add Pydantic models in `sandbox/models.py` if needed
5. Write tests in `tests/`
6. Update API docs in `docs/api.md`

### Adding a New Skill

1. Create a directory under `skills/your-skill-name/`
2. Add `SKILL.md` with YAML frontmatter + description
3. Add scripts in `skills/your-skill-name/scripts/`
4. The sandbox mounts `skills/` at `/sandbox/skills/`
5. Skills are auto-discovered by the agent

### Modifying the WebUI

1. **Server-side**: Edit files in `webui/routes/`, `webui/services/`
2. **Client-side**: Edit files in `webui/js/`, `webui/style.css`, `webui/index.html`
3. Run syntax check: `node --check webui/server.js`
4. Test with both dark and light themes

### Working with the Database

The sandbox uses SQLite with WAL mode. The database is auto-created on first access.

```python
# Access the database in code
from sandbox.database import get_db

async with get_db() as db:
    # db is an aiosqlite Connection
    cursor = await db.execute("SELECT * FROM sessions")
    rows = await cursor.fetchall()
```

Reset the database:
```bash
rm sandbox/data/sandbox.db  # SQLite will recreate on next start
```

## Testing

### Running Tests

```bash
# Quick run (all tests)
uv run pytest -q

# Verbose
uv run pytest -v

# Specific file
uv run pytest tests/test_integration.py -v

# With coverage
uv run pytest --cov=sandbox --cov-report=term-missing

# With coverage report
uv run pytest --cov=sandbox --cov-report=html
open htmlcov/index.html
```

### Test Structure

| Test File | What It Tests |
|---|---|
| `test_integration.py` | End-to-end API via TestClient |
| `test_session_manager.py` | Session CRUD, TTL, cleanup |
| `test_execution_manager.py` | Python/command execution |
| `test_file_manager.py` | File read/write/list/preview |
| `test_artifact_manager.py` | Artifact registration/list/download |
| `test_policy_checker.py` | Risk level classification |
| `test_tool_policy.py` | Tool policy checks |
| `test_path_validation.py` | Path escape protection |
| `test_approval.py` | Approval workflow |
| `test_persistence.py` | SQLite persistence layer |
| `test_trace.py` | Trace ID middleware |
| `test_builtin_skills.py` | Built-in skill scripts |
| `test_container_startup.py` | Docker entrypoint, compose config |
| `test_webui_api.py` | WebUI server API |

### Writing Tests

```python
# Example: Testing a new endpoint
from fastapi.testclient import TestClient
from sandbox.main import app

client = TestClient(app)

def test_my_endpoint():
    # Create session
    session = client.post("/sessions", json={"caller_id": "test"}).json()
    sid = session["session_id"]

    # Call endpoint
    resp = client.get(f"/sessions/{sid}/my-new-endpoint")
    assert resp.status_code == 200
    assert resp.json()["key"] == "expected_value"
```

## Code Quality

### Linting

We recommend `ruff` for Python linting:

```bash
pip install ruff
ruff check sandbox/ tests/
ruff format --check sandbox/ tests/
```

### Type Checking

```bash
pip install mypy
mypy sandbox/ --ignore-missing-imports
```

### Security Scanning

```bash
# Check for hardcoded secrets
grep -rn "sk-[A-Za-z0-9]" --include="*.py" --include="*.js" --include="*.json"
grep -rn "api_key\s*=\s*['\"]" --include="*.py" --include="*.js" --include="*.json"
```

## Git Workflow

```bash
# Start a new feature
git checkout -b feat/your-feature

# Make changes, commit often
git add -A
git commit -m "feat: add your feature"

# Rebase on main
git fetch origin
git rebase origin/main

# Push
git push -u origin feat/your-feature
```

### Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation
- `test:` — testing
- `refactor:` — code restructuring
- `chore:` — build/config/dependencies

## Debugging

### Sandbox

```bash
# Watch sandbox logs
docker compose logs -f sandbox

# Interactive shell in sandbox
docker exec -it pi-enterprise-sandbox /bin/bash

# Check database
docker exec pi-enterprise-sandbox sqlite3 /sandbox/data/sandbox.db ".tables"
```

### WebUI

```bash
# Watch WebUI logs
docker compose logs -f pi-agent

# Debug with Node.js inspector
cd webui && node --inspect server.js
# Then open chrome://inspect in Chrome
```

### Common Issues

| Issue | Solution |
|---|---|
| `port already in use` | Change `SANDBOX_HOST_PORT` or `AGENT_HOST_PORT` |
| `sqlite3.OperationalError: database is locked` | Wait or restart sandbox container |
| `Connection refused` when accessing sandbox | Ensure sandbox is healthy first |
| WebUI shows `sandbox: unreachable` | Check `SANDBOX_BASE_URL` env var |
