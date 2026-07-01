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
COPY --chown=pi-agent:pi-agent skills/ /home/pi-agent/.pi/skills/

# Create a default settings.json that enables the extension
RUN mkdir -p /home/pi-agent/.pi/agent && \
    echo '{"extensions":["enterprise-sandbox"]}' > /home/pi-agent/.pi/agent/settings.json

ENV \
    SANDBOX_BASE_URL=http://sandbox:8081 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Stay alive — users docker exec -it pi-agent pi to interact
CMD ["tail", "-f", "/dev/null"]
