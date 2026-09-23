# ── Nginx Reverse Proxy for DSH Enterprise Sandbox ─────────────────
# Production-grade: TLS termination, rate limiting, SSE support

FROM nginx:1.27-alpine

# Install OpenSSL for self-signed cert generation (development)
RUN apk add --no-cache openssl

# Remove default config
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy our config. 两套 server 模板与共享 location 放在 conf.d **之外**：
# nginx.conf 会 include conf.d/*.conf，模板留在那里会被同时加载（80 冲突）。
# entrypoint 按 TLS_ENABLED 把选中的一套渲染进 conf.d/sandbox.conf。
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/templates/ /etc/nginx/dsh-templates/

# Entrypoint — generates self-signed cert if none exists, then starts nginx
COPY nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
