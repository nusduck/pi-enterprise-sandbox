#!/bin/sh
set -euo pipefail

# ── Nginx entrypoint — 入口形态选择 + 证书兜底 ────────────────────
# TLS_ENABLED=true（默认）：80 跳转 443，边缘终止 TLS，缺证书时自签一张。
# TLS_ENABLED=false：只监听 80 明文，不生成也不要求证书（内网部署）。
# 两套模板共用 templates/locations.conf，路由语义不会因为模式不同而漂移。
DOMAIN="${DOMAIN:-localhost}"
TLS_ENABLED="${TLS_ENABLED:-true}"
SSL_DIR="/etc/nginx/ssl"
TEMPLATE_DIR="/etc/nginx/dsh-templates"
TARGET="/etc/nginx/conf.d/sandbox.conf"

# 拼错的值不猜意图：既不能当成 true（可能没有证书）也不能当成 false
# （可能把本该加密的入口降级成明文），直接拒绝启动。
case "$TLS_ENABLED" in
    true | false) ;;
    *)
        echo "[entrypoint] TLS_ENABLED must be exactly 'true' or 'false' (got '${TLS_ENABLED}')" >&2
        exit 1
        ;;
esac

if [ "$TLS_ENABLED" = "true" ]; then
    mkdir -p "$SSL_DIR"
    # Generate self-signed cert if none exists (for dev/test)
    if [ ! -f "$SSL_DIR/fullchain.pem" ] || [ ! -f "$SSL_DIR/privkey.pem" ]; then
        echo "[entrypoint] Generating self-signed certificate for $DOMAIN"
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout "$SSL_DIR/privkey.pem" \
            -out "$SSL_DIR/fullchain.pem" \
            -subj "/CN=$DOMAIN/O=DSH Enterprise Sandbox/C=CN" \
            2>/dev/null
        echo "[entrypoint] Self-signed cert generated"
    fi
    cp "$TEMPLATE_DIR/sandbox-tls.conf" "$TARGET"
    echo "[entrypoint] TLS mode — 80 redirects to 443, HSTS enabled"
else
    cp "$TEMPLATE_DIR/sandbox-http.conf" "$TARGET"
    echo "[entrypoint] PLAINTEXT mode (TLS_ENABLED=false) — serving HTTP on 80 only."
    echo "[entrypoint] Session cookies and uploads travel unencrypted; use only on a trusted internal network."
fi

# Substitute DOMAIN in the rendered config
sed -i "s/\${DOMAIN}/$DOMAIN/g" "$TARGET"

# 渲染失败不能带着占位符继续跑（server_name 会变成字面量 ${DOMAIN}）。
if grep -q '\${' "$TARGET"; then
    echo "[entrypoint] unrendered placeholder left in $TARGET" >&2
    exit 1
fi

# 坏配置在这里就退出，而不是让容器起来却 502。
nginx -t

echo "[entrypoint] Starting nginx..."
exec nginx -g "daemon off;"
