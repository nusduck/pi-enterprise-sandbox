#!/bin/bash
set -euo pipefail

# ── Sandbox Service Entrypoint ─────────────────────────────────────
# Runs as root when network isolation is enabled, applies optional
# iptables policy, then drops privileges to SANDBOX_RUN_AS_USER.

bool_enabled() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

# Prefer SANDBOX_BIND_HOST (canonical); fall back to legacy SANDBOX_HOST.
SANDBOX_BIND_HOST="${SANDBOX_BIND_HOST:-${SANDBOX_HOST:-0.0.0.0}}"
SANDBOX_HOST="$SANDBOX_BIND_HOST"
SANDBOX_PORT="${SANDBOX_PORT:-8081}"
SANDBOX_APP_MODULE="${SANDBOX_APP_MODULE:-sandbox.main:app}"
SANDBOX_RUN_AS_USER="${SANDBOX_RUN_AS_USER:-sandbox}"
SANDBOX_LOG_LEVEL="$(echo "${SANDBOX_LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
SANDBOX_UVICORN_WORKERS="${SANDBOX_UVICORN_WORKERS:-1}"
# Single network mode drives iptables + (in-app) command policy.
# disabled | allowlist | unrestricted — must match SANDBOX_NETWORK_MODE in Settings.
SANDBOX_NETWORK_MODE="$(echo "${SANDBOX_NETWORK_MODE:-disabled}" | tr '[:upper:]' '[:lower:]')"
case "$SANDBOX_NETWORK_MODE" in
    unrestricted|open|full)
        SANDBOX_NETWORK_MODE="unrestricted"
        # Unrestricted: skip iptables isolation (dev only; production rejects this mode).
        SANDBOX_IPTABLES_ENABLED="${SANDBOX_IPTABLES_ENABLED:-false}"
        ;;
    allowlist|allow|whitelist)
        SANDBOX_NETWORK_MODE="allowlist"
        SANDBOX_IPTABLES_ENABLED="${SANDBOX_IPTABLES_ENABLED:-true}"
        SANDBOX_IPTABLES_DEFAULT_POLICY="${SANDBOX_IPTABLES_DEFAULT_POLICY:-DROP}"
        ;;
    disabled|off|none|deny|block|*)
        SANDBOX_NETWORK_MODE="disabled"
        SANDBOX_IPTABLES_ENABLED="${SANDBOX_IPTABLES_ENABLED:-true}"
        SANDBOX_IPTABLES_DEFAULT_POLICY="${SANDBOX_IPTABLES_DEFAULT_POLICY:-DROP}"
        # No outbound destinations beyond DNS unless explicitly set.
        ;;
esac

SANDBOX_IPTABLES_ENABLED="${SANDBOX_IPTABLES_ENABLED:-true}"
SANDBOX_IPTABLES_DEFAULT_POLICY="${SANDBOX_IPTABLES_DEFAULT_POLICY:-DROP}"
SANDBOX_ALLOWED_DNS_PORTS="${SANDBOX_ALLOWED_DNS_PORTS:-53}"
SANDBOX_ALLOWED_TCP_PORTS="${SANDBOX_ALLOWED_TCP_PORTS:-}"
SANDBOX_ALLOWED_UDP_PORTS="${SANDBOX_ALLOWED_UDP_PORTS:-}"
SANDBOX_ALLOWED_CIDRS="${SANDBOX_ALLOWED_CIDRS:-}"
SANDBOX_ALLOW_LOOPBACK="${SANDBOX_ALLOW_LOOPBACK:-true}"
SANDBOX_ALLOW_ESTABLISHED="${SANDBOX_ALLOW_ESTABLISHED:-true}"

echo "[entrypoint] SANDBOX_NETWORK_MODE=$SANDBOX_NETWORK_MODE iptables_enabled=$SANDBOX_IPTABLES_ENABLED"

apply_iptables_rules() {
    if ! bool_enabled "$SANDBOX_IPTABLES_ENABLED"; then
        echo "[entrypoint] iptables disabled by SANDBOX_IPTABLES_ENABLED=$SANDBOX_IPTABLES_ENABLED (network_mode=$SANDBOX_NETWORK_MODE)"
        return 0
    fi
    if ! command -v iptables &> /dev/null; then
        echo "[entrypoint] WARNING: iptables not found — skipping network isolation rules."
        return 0
    fi

    echo "[entrypoint] Applying iptables isolation: default=$SANDBOX_IPTABLES_DEFAULT_POLICY dns=$SANDBOX_ALLOWED_DNS_PORTS tcp=${SANDBOX_ALLOWED_TCP_PORTS:-none} udp=${SANDBOX_ALLOWED_UDP_PORTS:-none} cidrs=${SANDBOX_ALLOWED_CIDRS:-none}"

    iptables -F OUTPUT 2>/dev/null || true

    if bool_enabled "$SANDBOX_ALLOW_LOOPBACK"; then
        iptables -A OUTPUT -o lo -j ACCEPT
    fi

    if bool_enabled "$SANDBOX_ALLOW_ESTABLISHED"; then
        iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    fi

    local port cidr
    IFS=',' read -ra dns_ports <<< "$SANDBOX_ALLOWED_DNS_PORTS"
    for port in "${dns_ports[@]}"; do
        port="$(echo "$port" | xargs)"
        [ -z "$port" ] && continue
        iptables -A OUTPUT -p udp --dport "$port" -j ACCEPT
        iptables -A OUTPUT -p tcp --dport "$port" -j ACCEPT
    done

    IFS=',' read -ra tcp_ports <<< "$SANDBOX_ALLOWED_TCP_PORTS"
    for port in "${tcp_ports[@]}"; do
        port="$(echo "$port" | xargs)"
        [ -z "$port" ] && continue
        iptables -A OUTPUT -p tcp --dport "$port" -j ACCEPT
    done

    IFS=',' read -ra udp_ports <<< "$SANDBOX_ALLOWED_UDP_PORTS"
    for port in "${udp_ports[@]}"; do
        port="$(echo "$port" | xargs)"
        [ -z "$port" ] && continue
        iptables -A OUTPUT -p udp --dport "$port" -j ACCEPT
    done

    IFS=',' read -ra cidrs <<< "$SANDBOX_ALLOWED_CIDRS"
    for cidr in "${cidrs[@]}"; do
        cidr="$(echo "$cidr" | xargs)"
        [ -z "$cidr" ] && continue
        iptables -A OUTPUT -d "$cidr" -j ACCEPT
    done

    iptables -A OUTPUT -j "$SANDBOX_IPTABLES_DEFAULT_POLICY"
    echo "[entrypoint] iptables rules applied successfully."
}

build_uvicorn_args() {
    # Listen address only — inbound client allowlist is enforced in-app via
    # SANDBOX_ALLOWED_CLIENT_CIDRS (0.0.0.0 bind ≠ allow any client).
    local args="$(printf '%q' "$SANDBOX_APP_MODULE") --host $(printf '%q' "$SANDBOX_BIND_HOST") --port $(printf '%q' "$SANDBOX_PORT") --log-level $(printf '%q' "$SANDBOX_LOG_LEVEL")"

    if [ "${SANDBOX_UVICORN_WORKERS}" != "1" ]; then
        args="$args --workers $(printf '%q' "$SANDBOX_UVICORN_WORKERS")"
    fi
    if bool_enabled "${SANDBOX_UVICORN_RELOAD:-false}"; then
        args="$args --reload"
    fi
    if bool_enabled "${SANDBOX_UVICORN_PROXY_HEADERS:-true}"; then
        args="$args --proxy-headers"
    fi
    if [ -n "${SANDBOX_UVICORN_FORWARDED_ALLOW_IPS:-}" ]; then
        args="$args --forwarded-allow-ips $(printf '%q' "$SANDBOX_UVICORN_FORWARDED_ALLOW_IPS")"
    fi
    if [ -n "${SANDBOX_UVICORN_EXTRA_ARGS:-}" ]; then
        # Space-delimited advanced escape hatch for operators who need a
        # Uvicorn flag not exposed above, e.g. "--limit-concurrency 20".
        args="$args ${SANDBOX_UVICORN_EXTRA_ARGS}"
    fi
    echo "$args"
}

apply_iptables_rules

# ── Lock down workspace parent directory ──────────────────────────
# Prevent agents from listing /var/sandbox/workspaces/ to discover
# other conversation workspaces.  The sandbox user needs execute-only
# (to traverse via symlink) but not read (to list).
WORKSPACES_DIR="/var/sandbox/workspaces"
if [ -d "$WORKSPACES_DIR" ]; then
    chmod 0311 "$WORKSPACES_DIR"
fi

UVICORN_ARGS="$(build_uvicorn_args)"
echo "[entrypoint] Starting Sandbox API: uvicorn $UVICORN_ARGS"

# ── Drop privileges to the sandbox user and start the app ──────────
if [ "$(id -u)" -eq 0 ] && command -v gosu &> /dev/null; then
    exec gosu "$SANDBOX_RUN_AS_USER" bash -c "exec /app/.venv/bin/uvicorn $UVICORN_ARGS"
elif [ "$(id -u)" -eq 0 ] && command -v su &> /dev/null; then
    exec su -s /bin/bash "$SANDBOX_RUN_AS_USER" -c "exec /app/.venv/bin/uvicorn $UVICORN_ARGS"
else
    exec /app/.venv/bin/uvicorn $UVICORN_ARGS
fi
