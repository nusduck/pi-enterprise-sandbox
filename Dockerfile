# ── Pi Agent (with Enterprise Sandbox Extension) ──────────────────────
FROM node:22-slim AS agent-base

# Install Pi Agent globally
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent && \
    npm cache clean --force

# Create non-root user
RUN useradd -m -u 10001 pi-agent
USER pi-agent
WORKDIR /home/pi-agent

# Set up the Enterprise Sandbox Extension
RUN mkdir -p /home/pi-agent/.pi/agent/extensions/enterprise-sandbox

# Copy extension files
COPY --chown=pi-agent:pi-agent agent/enterprise-sandbox-ext/index.ts \
    /home/pi-agent/.pi/agent/extensions/enterprise-sandbox/index.ts
COPY --chown=pi-agent:pi-agent agent/enterprise-sandbox-ext/package.json \
    /home/pi-agent/.pi/agent/extensions/enterprise-sandbox/package.json

# Install extension dependencies (typebox for parameter schemas)
RUN cd /home/pi-agent/.pi/agent/extensions/enterprise-sandbox && \
    npm install && \
    npm cache clean --force

# Copy shared skills
COPY --chown=pi-agent:pi-agent skills/ /home/pi-agent/.pi/agent/skills/

# Copy WebUI files (from repo root webui/)
COPY --chown=pi-agent:pi-agent webui/ /home/pi-agent/webui/

# Copy default config (overridden by volume mount at runtime)
RUN mkdir -p /home/pi-agent/.pi/agent
COPY --chown=pi-agent:pi-agent config/agent/settings.json /home/pi-agent/.pi/agent/settings.json
COPY --chown=pi-agent:pi-agent config/agent/models.json /home/pi-agent/.pi/agent/models.json

ENV \
    SANDBOX_BASE_URL=http://sandbox:8081 \
    AGENT_WEBUI_PORT=3000 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

EXPOSE 3000

# Start WebUI server — users can also docker exec -it pi-agent pi for CLI
CMD ["node", "/home/pi-agent/webui/server.js"]
