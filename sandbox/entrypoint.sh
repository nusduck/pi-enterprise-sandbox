#!/bin/bash
set -e

# ── Sandbox Service Entrypoint ─────────────────────────────────────
# This entrypoint runs as root (no USER in Dockerfile) so iptables
# rules can be applied. It then drops privileges to the sandbox user
# before starting the application.

LOG_LEVEL=$(echo "${SANDBOX_LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')

# ── Apply iptables network isolation (defense-in-depth) ───────────
# Blocks all outbound traffic except loopback and DNS resolution.
# This is a safety net on top of the Docker internal network isolation.
# Requires NET_ADMIN and NET_RAW capabilities.

if command -v iptables &> /dev/null; then
    echo "[entrypoint] Applying iptables network isolation rules..."

    # Flush any existing rules (safety)
    iptables -F OUTPUT 2>/dev/null || true

    # Allow loopback traffic
    iptables -A OUTPUT -o lo -j ACCEPT

    # Allow established/related connections (so responses come back)
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

    # Allow DNS resolution (UDP and TCP port 53)
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

    # Block all other outbound traffic
    iptables -A OUTPUT -j DROP

    echo "[entrypoint] iptables rules applied successfully."
else
    echo "[entrypoint] WARNING: iptables not found — skipping network isolation rules."
fi

echo "[entrypoint] Starting Sandbox API (MCP embedded) on 0.0.0.0:${SANDBOX_PORT:-8081}"

# ── Drop privileges to the sandbox user and start the app ──────────
if [ "$(id -u)" -eq 0 ] && command -v gosu &> /dev/null; then
    exec gosu sandbox uvicorn sandbox.main:app \
        --host 0.0.0.0 \
        --port "${SANDBOX_PORT:-8081}" \
        --log-level "$LOG_LEVEL"
elif [ "$(id -u)" -eq 0 ] && command -v su &> /dev/null; then
    exec su -s /bin/bash sandbox -c "uvicorn sandbox.main:app --host 0.0.0.0 --port ${SANDBOX_PORT:-8081} --log-level $LOG_LEVEL"
else
    # Already running as non-root, just start the app
    exec uvicorn sandbox.main:app \
        --host 0.0.0.0 \
        --port "${SANDBOX_PORT:-8081}" \
        --log-level "$LOG_LEVEL"
fi
