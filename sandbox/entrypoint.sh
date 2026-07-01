#!/bin/bash
set -e

# ── Sandbox Service Entrypoint ─────────────────────────────────────

LOG_LEVEL=$(echo "${SANDBOX_LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')

echo "[entrypoint] Starting Sandbox API (MCP embedded) on 0.0.0.0:${SANDBOX_PORT:-8081}"

exec uvicorn sandbox.main:app \
    --host 0.0.0.0 \
    --port "${SANDBOX_PORT:-8081}" \
    --log-level "$LOG_LEVEL"
