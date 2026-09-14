# release gate 运行器：Node 22（runtime-versions.json）+ docker CLI（gate 要重启专用 Redis 容器）。
# 构建上下文是仓库根，与 agent/Dockerfile 一样在镜像里装依赖、再 COPY 源码
# （根 .dockerignore 排除宿主机的 node_modules / dist，原生模块按 Linux 装）。
# 不挂载宿主目录：验证的就是构建时的工作树。
FROM docker:27-cli AS dockercli

FROM node:22-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /repo

COPY tsconfig.base.json ./
COPY contract ./contract
COPY agent/package.json agent/package-lock.json ./agent/

WORKDIR /repo/contract
RUN npm ci --ignore-scripts && npx tsc

WORKDIR /repo/agent
RUN npm ci --ignore-scripts

WORKDIR /repo
COPY agent ./agent
COPY scripts/dev ./scripts/dev

WORKDIR /repo/agent
RUN npm run build
