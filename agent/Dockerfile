# Node major pin: runtime-versions.json → node.docker_image
# Compose context is the repo root so `@pi/runtime` (file:../runtime) and
# `@pi/contract` are installable. The HTTP process and worker both import them.
FROM node:22-slim
WORKDIR /app

COPY tsconfig.base.json ./
COPY contract ./contract
COPY runtime ./runtime
COPY agent/package.json agent/package-lock.json ./agent/

WORKDIR /app/contract
RUN npm ci --ignore-scripts && npx tsc

WORKDIR /app/runtime
RUN npm ci --ignore-scripts && npx tsc

WORKDIR /app/agent
RUN npm ci --ignore-scripts

WORKDIR /app
COPY agent ./agent

WORKDIR /app/agent

# Pi Runtime resource root (AGENT_PI_AGENT_DIR) and logical workspace cwd.
# The workspace directory is intentionally empty in this image: all workspace
# bytes remain owned by Sandbox and are accessed through the formal transport.
RUN mkdir -p /app/pi-agent-home /home/sandbox/workspace /home/sandbox/skill-user /tmp/pi-enterprise-mcp-runtime \
    && chmod 755 /app/pi-agent-home /home/sandbox/workspace \
    && chmod 700 /tmp/pi-enterprise-mcp-runtime
ENV AGENT_PI_AGENT_DIR=/app/pi-agent-home \
    PI_CODING_AGENT_DIR=/app/pi-agent-home \
    AGENT_MCP_RUNTIME_ROOT=/tmp/pi-enterprise-mcp-runtime

# Drop root. Unlike Sandbox — which starts as root to build the Bubblewrap
# jail and then drops with setpriv — the Agent process never needs a
# privileged operation: it talks to MySQL, Redis, the provider and Sandbox.
# The writable paths are the Pi resource root, the MCP runtime dir and the
# user-skill tier, so those are handed over with the image.
#
# /home/sandbox/skill-user is a named volume at runtime. Docker seeds a fresh
# volume from the image directory, ownership included — a volume created
# before this change stays root-owned and must be recreated or chowned once.
RUN chown -R node:node /app /app/pi-agent-home /home/sandbox/skill-user /tmp/pi-enterprise-mcp-runtime
USER node

EXPOSE 4100
CMD ["node", "server.js"]
