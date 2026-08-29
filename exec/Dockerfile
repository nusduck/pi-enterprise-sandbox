# Node major pin: runtime-versions.json → node.docker_image
# Compose context is the repo root so `@pi/contract` (file:../contract) and
# tsconfig.base.json are visible. `npx tsc -b` from ./exec alone cannot see them.
FROM node:22-slim
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap util-linux bash ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --home-dir /home/sandbox --create-home sandbox
WORKDIR /app

COPY tsconfig.base.json ./
COPY contract ./contract
COPY exec/package.json exec/package-lock.json ./exec/

WORKDIR /app/contract
RUN npm ci --ignore-scripts && npx tsc

WORKDIR /app/exec
RUN npm ci --ignore-scripts

WORKDIR /app
COPY exec ./exec

WORKDIR /app/exec
RUN npx tsc

RUN mkdir -p /home/sandbox/workspace /home/sandbox/skill /home/sandbox/skill-user \
    /var/sandbox/workspaces /var/sandbox/tmp \
    && chown -R 10001:10001 /app /home/sandbox /var/sandbox
USER 10001:10001

EXPOSE 8081
ENV EXEC_PORT=8081
CMD ["node", "dist/main.js"]
