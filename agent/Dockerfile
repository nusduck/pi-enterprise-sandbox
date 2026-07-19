# Node major pin: runtime-versions.json → node.docker_image
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

# Pi Runtime resource root (AGENT_PI_AGENT_DIR) and logical workspace cwd.
# The workspace directory is intentionally empty in this image: all workspace
# bytes remain owned by Sandbox and are accessed through the formal transport.
RUN mkdir -p /app/pi-agent-home /home/sandbox/workspace /tmp/pi-enterprise-mcp-runtime \
    && chmod 755 /app/pi-agent-home /home/sandbox/workspace \
    && chmod 700 /tmp/pi-enterprise-mcp-runtime
ENV AGENT_PI_AGENT_DIR=/app/pi-agent-home \
    PI_CODING_AGENT_DIR=/app/pi-agent-home \
    AGENT_MCP_RUNTIME_ROOT=/tmp/pi-enterprise-mcp-runtime

EXPOSE 4100
CMD ["node", "server.js"]
