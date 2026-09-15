# syntax=docker/dockerfile:1
#
# VM exec release 构建器（design §9.1）。只产出 release 压缩包，不产出镜像。
#
# 在**目标架构**的 Linux 容器里编译并按 lockfile 安装生产依赖：依赖里有原生模块
# （koffi 的平台预编译包），不能从 macOS 或另一种架构搬运。入口脚本：
#   scripts/vm/build-exec-release.sh --arch amd64
#
# Node 主版本钉：runtime-versions.json → node.docker_image。
FROM node:22-slim AS build
WORKDIR /src
COPY tsconfig.base.json ./
COPY contract ./contract
COPY exec ./exec
WORKDIR /src/contract
RUN npm ci --ignore-scripts && npx tsc
WORKDIR /src/exec
RUN npm ci --ignore-scripts && npx tsc

FROM node:22-slim AS stage
ARG RELEASE_ID
ARG GIT_SHA
ARG GIT_DIRTY
ARG BUILT_AT
RUN test -n "$RELEASE_ID" && test -n "$GIT_SHA" && test -n "$BUILT_AT"
WORKDIR /release/${RELEASE_ID}
# contract：dist + 运行期读取的 schema 清单 + 自身生产依赖
COPY --from=build /src/contract/package.json /src/contract/package-lock.json ./contract/
COPY --from=build /src/contract/dist ./contract/dist
COPY --from=build /src/contract/schema ./contract/schema
RUN cd contract && npm ci --omit=dev --ignore-scripts
# exec：dist + 生产依赖（@pi/contract 以 ../contract 链接）
COPY --from=build /src/exec/package.json /src/exec/package-lock.json ./exec/
COPY --from=build /src/exec/dist ./exec/dist
RUN cd exec && npm ci --omit=dev --ignore-scripts
# 部署资产：systemd unit、env 模板、启动前检查、安装脚本、工具链安装脚本与制品清单
COPY deploy/vm ./vm
COPY runtime-versions.json ./vm/runtime-versions.json
# 工具链安装脚本读取的仓库侧资产（与 exec/Dockerfile 同源）：Python 依赖、三个 wrapper、BaoYu 脚本与锁文件
COPY exec/requirements.txt ./toolchain/requirements.txt
COPY exec/skill-runtime/ ./toolchain/skill-runtime/
COPY skills/baoyu-format-markdown/scripts/ ./toolchain/pi-skill-runtime/baoyu-format-markdown/
COPY skills/baoyu-markdown-to-html/scripts/ ./toolchain/pi-skill-runtime/baoyu-markdown-to-html/
COPY scripts/vm/write-release-manifest.mjs /tmp/write-release-manifest.mjs
RUN chmod 0755 vm/exec-preflight.sh vm/install-release.sh && \
    node /tmp/write-release-manifest.mjs \
        --dir "/release/${RELEASE_ID}" \
        --release-id "${RELEASE_ID}" \
        --git-sha "${GIT_SHA}" \
        --git-dirty "${GIT_DIRTY}" \
        --built-at "${BUILT_AT}" && \
    mkdir -p /out && \
    tar -C /release -czf "/out/${RELEASE_ID}.tar.gz" "${RELEASE_ID}" && \
    cd /out && sha256sum "${RELEASE_ID}.tar.gz" > "${RELEASE_ID}.tar.gz.sha256"

FROM scratch AS artifact
COPY --from=stage /out/ /
