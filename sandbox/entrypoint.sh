#!/bin/bash
set -euo pipefail

# ── Sandbox Service Entrypoint ─────────────────────────────────────
# Starts as root only to fix storage ownership, then drops privileges
# to SANDBOX_RUN_AS_USER. Network isolation for untrusted child
# executions is NOT applied here:
#   - production / default: SANDBOX_NETWORK_MODE=disabled + Bubblewrap
#     --unshare-net (empty netns; fail-closed)
#   - container-wide iptables is intentionally NOT used (no NET_ADMIN,
#     no fail-open when iptables is missing)
# Inbound Sandbox HTTP clients are gated separately by
# SANDBOX_ALLOWED_CLIENT_CIDRS (in-app), not by this script.
#
# Hard resource limits (RLIMIT_CPU/AS/FSIZE/NOFILE/NPROC) are applied
# per untrusted child in Python preexec_fn before exec — NEVER via a
# global ulimit/setrlimit on this service process (would starve uvicorn).

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
# Outbound *execution* network policy (not inbound HTTP client CIDRs).
# disabled | allowlist | unrestricted — must match SANDBOX_NETWORK_MODE in Settings.
# Production validation rejects anything other than disabled until a real
# per-child egress proxy exists (no container-wide iptables substitute).
SANDBOX_NETWORK_MODE="$(echo "${SANDBOX_NETWORK_MODE:-disabled}" | tr '[:upper:]' '[:lower:]')"
case "$SANDBOX_NETWORK_MODE" in
    unrestricted|open|full)
        SANDBOX_NETWORK_MODE="unrestricted"
        ;;
    allowlist|allow|whitelist)
        SANDBOX_NETWORK_MODE="allowlist"
        ;;
    disabled|off|none|deny|block|*)
        SANDBOX_NETWORK_MODE="disabled"
        ;;
esac

echo "[entrypoint] SANDBOX_NETWORK_MODE=$SANDBOX_NETWORK_MODE (execution policy; no iptables authority)"

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

# ── Prepare private storage roots ──────────────────────────────────
# Only the trusted Sandbox API can access these parents. Untrusted commands
# receive only their conversation-specific children through Bubblewrap.
WORKSPACES_DIR="${SANDBOX_WORKSPACES_ROOT:-/var/sandbox/workspaces}"
TEMP_DIR="${SANDBOX_TEMP_ROOT:-/var/sandbox/tmp}"
for storage_dir in "$WORKSPACES_DIR" "$TEMP_DIR"; do
    mkdir -p "$storage_dir"
    if [ "$(id -u)" -eq 0 ]; then
        chown "$SANDBOX_RUN_AS_USER" "$storage_dir"
    fi
    chmod 0700 "$storage_dir"
done

UVICORN_ARGS="$(build_uvicorn_args)"
echo "[entrypoint] Starting Sandbox API: uvicorn $UVICORN_ARGS"

# Release-gate only supervisor mode.  The normal production path below uses
# exec so the API remains the container's direct service process.  The live
# hard-kill gate needs to kill only uvicorn while retaining a container
# supervisor long enough to inspect durable RUNNING rows before restarting the
# service.  This is never enabled by the normal Compose configuration.
if bool_enabled "${SANDBOX_GATE_SERVICE_SUPERVISOR:-false}"; then
    echo "[entrypoint] release-gate service supervisor enabled"
    restart_delay="${SANDBOX_GATE_RESTART_DELAY_SECONDS:-5}"
    case "$restart_delay" in
        ''|*[!0-9]*) restart_delay=5 ;;
    esac
    while :; do
        if [ "$(id -u)" -eq 0 ] && command -v gosu &> /dev/null; then
            gosu "$SANDBOX_RUN_AS_USER" bash -c "exec /app/.venv/bin/uvicorn $UVICORN_ARGS" &
        elif [ "$(id -u)" -eq 0 ] && command -v su &> /dev/null; then
            su -s /bin/bash "$SANDBOX_RUN_AS_USER" -c "exec /app/.venv/bin/uvicorn $UVICORN_ARGS" &
        else
            /app/.venv/bin/uvicorn $UVICORN_ARGS &
        fi
        service_pid=$!
        echo "[entrypoint] release-gate service pid=$service_pid"
        set +e
        wait "$service_pid"
        service_status=$?
        set -e
        echo "[entrypoint] release-gate service exited status=$service_status; restarting in ${restart_delay}s"
        sleep "$restart_delay"
    done
fi

# Production Linux: refuse start when critical RLIMIT primitives are missing.
# (App-level validate_production_settings also checks; this fails earlier.)
DEPLOYMENT_ENV_NORM="$(echo "${DEPLOYMENT_ENV:-${SANDBOX_DEPLOYMENT_ENV:-development}}" | tr '[:upper:]' '[:lower:]')"
case "$DEPLOYMENT_ENV_NORM" in
    production|prod)
        if [ "$(uname -s 2>/dev/null || echo unknown)" = "Linux" ]; then
            echo "[entrypoint] Production Linux: verifying resource primitives"
            /app/.venv/bin/python -c \
                "from sandbox.utils.resource_limits import assert_production_resource_primitives; assert_production_resource_primitives()"
        fi
        ;;
esac

# ── Drop privileges to the sandbox user and start the app ──────────
# No global ulimit here — child hard limits are applied in preexec only.
if [ "$(id -u)" -eq 0 ] && command -v gosu &> /dev/null; then
    exec gosu "$SANDBOX_RUN_AS_USER" bash -c "exec /app/.venv/bin/uvicorn $UVICORN_ARGS"
elif [ "$(id -u)" -eq 0 ] && command -v su &> /dev/null; then
    exec su -s /bin/bash "$SANDBOX_RUN_AS_USER" -c "exec /app/.venv/bin/uvicorn $UVICORN_ARGS"
else
    exec /app/.venv/bin/uvicorn $UVICORN_ARGS
fi
