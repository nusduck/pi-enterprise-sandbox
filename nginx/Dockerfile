# ── Nginx Reverse Proxy for Pi Enterprise Sandbox ─────────────────
# Production-grade: TLS termination, rate limiting, SSE support

FROM nginx:1.27-alpine

# Install OpenSSL for self-signed cert generation (development)
RUN apk add --no-cache openssl

# Remove default config
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy our config
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/conf.d/ /etc/nginx/conf.d/

# Entrypoint — generates self-signed cert if none exists, then starts nginx
COPY nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
