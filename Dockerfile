# ── Pi Agent WebUI ──────────────────────────────────────────────
FROM node:20-slim AS agent-base

RUN groupadd -g 10001 pi-agent && \
    useradd -m -u 10001 -g pi-agent pi-agent && \
    mkdir -p /home/pi-agent/.pi/agent/skills /home/pi-agent/webui && \
    chown -R pi-agent:pi-agent /home/pi-agent

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /home/pi-agent/webui

# Copy package files first for layer caching
COPY webui/package.json webui/package-lock.json* ./

# Install dependencies (as root for system-wide npm)
RUN npm ci && npm cache clean --force

# Copy source files
COPY webui/vite.config.js webui/tsconfig.json ./
COPY webui/index.html ./
COPY webui/src/ ./src/
COPY webui/server.js ./

# Build frontend (as root, output goes to dist/)
RUN npx vite build

# Fix ownership so pi-agent can read everything at runtime
RUN chown -R pi-agent:pi-agent /home/pi-agent/webui

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=5s \
    CMD curl -sf http://localhost:3000/api/status || exit 1

USER pi-agent

CMD ["node", "server.js"]
