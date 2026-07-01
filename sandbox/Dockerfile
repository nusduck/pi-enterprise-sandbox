# ── Sandbox Service (Python FastAPI) ──────────────────────────────
FROM python:3.11-slim AS sandbox-base

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 10001 sandbox && \
    useradd -m -u 10001 -g sandbox sandbox && \
    mkdir -p /sandbox/workspaces /sandbox/skills /sandbox/data && \
    chown -R sandbox:sandbox /sandbox

WORKDIR /app

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency file first for caching
COPY pyproject.toml /app/

# Create venv and install deps (no dev deps)
RUN uv venv /app/.venv && \
    . /app/.venv/bin/activate && \
    uv pip install --no-cache -e ".[test]" && \
    chown -R sandbox:sandbox /app

# Copy application code
COPY sandbox/ /app/sandbox/
COPY tests/ /app/tests/
COPY sandbox/entrypoint.sh /app/entrypoint.sh

# Fix ownership
RUN chown -R sandbox:sandbox /app && chmod +x /app/entrypoint.sh

USER sandbox
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
