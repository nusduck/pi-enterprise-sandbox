# ── Sandbox Service (Python FastAPI) ──────────────────────────────
FROM python:3.11-slim AS sandbox-base

# Install system deps — including Node.js (via nodesource) for runtime and iptables for network isolation
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gosu \
    iptables \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 sandbox && \
    useradd -m -u 10001 -g sandbox sandbox && \
    mkdir -p /sandbox/workspace /var/sandbox/workspaces /sandbox/skills /sandbox/data && \
    chmod 0311 /var/sandbox/workspaces && \
    chown -R sandbox:sandbox /sandbox /var/sandbox

WORKDIR /app

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files first for caching
COPY pyproject.toml /app/
COPY sandbox/requirements.txt /app/sandbox/requirements.txt

# Create venv and install API deps plus preinstalled workload/tooling deps (no dev deps)
RUN uv venv /app/.venv && \
    . /app/.venv/bin/activate && \
    uv pip install --no-cache -e ".[test]" && \
    uv pip install --no-cache -r /app/sandbox/requirements.txt && \
    uv pip install --no-cache pip && \
    chown -R sandbox:sandbox /app

# Copy application code
COPY sandbox/ /app/sandbox/
COPY tests/ /app/tests/
COPY sandbox/entrypoint.sh /app/entrypoint.sh

# Fix ownership
RUN chown -R sandbox:sandbox /app && chmod +x /app/entrypoint.sh

# NOTE: No USER directive — entrypoint.sh runs as root to apply iptables,
# then drops privileges to the sandbox user before starting the app.
WORKDIR /app

ENV \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

EXPOSE 8081 8091

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD curl -sf http://localhost:8081/health || exit 1

CMD ["/app/entrypoint.sh"]
