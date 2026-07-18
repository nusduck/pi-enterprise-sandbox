# Node major pin: runtime-versions.json → node.docker_image
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/enterprise-agent-kit ./packages/enterprise-agent-kit
RUN npm ci --ignore-scripts

COPY . .

# Pi Runtime resource root (AGENT_PI_AGENT_DIR). Skills stay on separate mounts;
# this dir is the concrete agentDir required by PiRuntimeFactory.create().
RUN mkdir -p /app/pi-agent-home && chmod 755 /app/pi-agent-home
ENV AGENT_PI_AGENT_DIR=/app/pi-agent-home

EXPOSE 4100
CMD ["node", "server.js"]
