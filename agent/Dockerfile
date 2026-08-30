# Node major pin: runtime-versions.json → node.docker_image
# Compose context is the repo root so `@pi/contract` (file:../../contract from
# agent/runtime) is installable. The HTTP process and worker both import it.
FROM node:22-slim
WORKDIR /app

COPY tsconfig.base.json ./
COPY contract ./contract
COPY agent/runtime ./agent/runtime
COPY agent/package.json agent/package-lock.json ./agent/

WORKDIR /app/contract
RUN npm ci --ignore-scripts && npx tsc

# `@pi/runtime` is agent-private (file:./runtime) and must be compiled before
# the agent install resolves it. `dist/` is dockerignored, so the later
# `COPY agent ./agent` cannot clobber what this stage builds.
WORKDIR /app/agent/runtime
RUN npm ci --ignore-scripts && npx tsc

WORKDIR /app/agent
RUN npm ci --ignore-scripts

WORKDIR /app
COPY agent ./agent

WORKDIR /app/agent

# Logical workspace cwd. The directory is intentionally empty in this image:
# all workspace bytes stay owned by exec and are reached over the signed RPC.
#
# `/app/pi-agent-home` (AGENT_PI_AGENT_DIR / PI_CODING_AGENT_DIR) is gone with
# the Pi runtime: agentDir was threaded from the container to
# runtime-factory.create(), which never read it, and @pi/runtime never
# mentioned it at all.
RUN mkdir -p /home/sandbox/workspace /home/sandbox/skill-user /tmp/pi-enterprise-mcp-runtime \
    && chmod 755 /home/sandbox/workspace \
    && chmod 700 /tmp/pi-enterprise-mcp-runtime
ENV AGENT_MCP_RUNTIME_ROOT=/tmp/pi-enterprise-mcp-runtime

# Drop root. Unlike the exec service — which needs Bubblewrap — the Agent
# process never performs a privileged operation: it talks to MySQL, Redis, the
# provider and exec. The writable paths are the MCP runtime dir and the
# user-skill tier, so those are handed over with the image.
#
# /home/sandbox/skill-user is a named volume at runtime. Docker seeds a fresh
# volume from the image directory, ownership included — a volume created
# before this change stays root-owned and must be recreated or chowned once.
RUN chown -R node:node /app /home/sandbox/skill-user /tmp/pi-enterprise-mcp-runtime
USER node

EXPOSE 4100
CMD ["node", "server.js"]
