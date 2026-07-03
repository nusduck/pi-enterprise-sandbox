#!/bin/sh
set -euo pipefail

# ── Nginx entrypoint — cert bootstrap ────────────────────────────
DOMAIN="${DOMAIN:-localhost}"
SSL_DIR="/etc/nginx/ssl"

mkdir -p "$SSL_DIR"

# Generate self-signed cert if none exists (for dev/test)
if [ ! -f "$SSL_DIR/fullchain.pem" ] || [ ! -f "$SSL_DIR/privkey.pem" ]; then
    echo "[entrypoint] Generating self-signed certificate for $DOMAIN"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$SSL_DIR/privkey.pem" \
        -out "$SSL_DIR/fullchain.pem" \
        -subj "/CN=$DOMAIN/O=Pi Enterprise Sandbox/C=CN" \
        2>/dev/null
    echo "[entrypoint] Self-signed cert generated"
fi

# Substitute DOMAIN in nginx config
sed -i "s/\${DOMAIN}/$DOMAIN/g" /etc/nginx/conf.d/sandbox.conf 2>/dev/null || true

echo "[entrypoint] Starting nginx..."
exec nginx -g "daemon off;"
