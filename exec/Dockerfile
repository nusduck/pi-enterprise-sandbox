# syntax=docker/dockerfile:1
#
# 执行面镜像。Node 主版本钉：runtime-versions.json → node.docker_image。
#
# 这个镜像装两样东西，别把它们搞混：
#
#  1. **服务自己**——TypeScript 写的 exec 进程，跑在 Node 上。
#  2. **模型要用的工具链**——`python3`、git、ripgrep、pandoc、chromium、
#     LibreOffice、bun 等等。这些不是服务的依赖，是 Bubblewrap 子进程里
#     执行用户代码时要用的东西。少一样，对应的能力就静默失效。
#
# 历史教训（2026-08-29 查出）：从 Python `sandbox/` 迁到 `exec/` 时，第 2 类
# 一整套都没跟过来，镜像里连 `python3` 都没有——而 `shell/python-materialize.ts`
# 产出的 argv 第一个词就是 `python3`。守这条的 `test_skill_runtime_dependencies.py`
# 当时被改成只断言三个 shell 垫片文件存在，于是测试是绿的、能力是没的。
# 现在那份测试重新按本文件断言，**改这里就要同步改它**。
#
# 刻意不装 iptables：容器级防火墙不是执行隔离的权威（没有 NET_ADMIN/NET_RAW，
# 缺工具不得 fail-open）。网络隔离由 bwrap 的 netns 承担。

# ── JS 工具链（仅构建期）───────────────────────────────────────────
# bun 是独立二进制，用 npm 引导下载；docx/pptxgenjs 供 skill 生成文档用；
# autocorrect-node 是原生插件，要用它自己的 npm lockfile 装。
FROM node:22-slim AS js-deps
ARG BUN_VERSION=1.4.0
ARG DOCX_JS_VERSION=9.7.1
ARG PPTXGENJS_VERSION=4.0.1

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --global --prefix /usr/local --no-audit --no-fund \
        "bun@${BUN_VERSION}" \
        "docx@${DOCX_JS_VERSION}" \
        "pptxgenjs@${PPTXGENJS_VERSION}"

COPY skills/baoyu-format-markdown/scripts/ /build/baoyu-format-markdown/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --prefix /build/baoyu-format-markdown

# ── TypeScript 编译（仅构建期）─────────────────────────────────────
# compose 的 context 是仓库根，这样 `@pi/contract`（file:../contract）与
# tsconfig.base.json 可见；单从 ./exec 出发 `tsc -b` 看不到它们。
FROM node:22-slim AS ts-build
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

# ── 终态镜像 ───────────────────────────────────────────────────────
FROM node:22-slim

# 系统依赖：隔离原语 + 模型日常要用的工具（文档、办公、git、文本处理）。
# `util-linux` 提供 `setpriv`——`isolation/bubblewrap.ts` 在 exec bwrap 之前
# 用它剥离服务自身的 capabilities，缺了会 fail-closed 拒绝执行，不是可选项。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    bubblewrap \
    util-linux \
    bash \
    git \
    jq \
    unzip \
    zip \
    file \
    less \
    ripgrep \
    fd-find \
    pandoc \
    poppler-utils \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-chi-sim \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-writer \
    python3 \
    python3-venv \
    && ln -sf "$(command -v fdfind)" /usr/local/bin/fd

# 模型执行 Python 代码用的运行库。装在独立 venv 里，不污染系统 python3，
# 也不与服务自身混在一起——服务是 Node，本来就不需要这些。
# `shell/python-materialize.ts` 产出的 argv 是 `python3 ...`，所以 venv 的
# bin 目录要进 PATH。
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY exec/requirements.txt /opt/pi-python/requirements.txt
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv venv /opt/pi-python/venv && \
    VIRTUAL_ENV=/opt/pi-python/venv uv pip install -r /opt/pi-python/requirements.txt

# bun（独立二进制）+ docx/pptxgenjs，来自上面的 js-deps 阶段。
COPY --from=js-deps /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=js-deps /usr/local/bin/bun /usr/local/bin/bun

# BaoYu 的 TS Skill 在运行时是只读 bind。镜像里留一份锁好依赖的副本，
# 生产的 Bubblewrap 子进程因此永远不需要 npx/npm 联网。
COPY skills/baoyu-format-markdown/scripts/ /usr/local/lib/pi-skill-runtime/baoyu-format-markdown/
COPY --from=js-deps /build/baoyu-format-markdown/node_modules/ /usr/local/lib/pi-skill-runtime/baoyu-format-markdown/node_modules/
COPY skills/baoyu-markdown-to-html/scripts/ /usr/local/lib/pi-skill-runtime/baoyu-markdown-to-html/
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    cd /usr/local/lib/pi-skill-runtime/baoyu-markdown-to-html && \
    bun install --frozen-lockfile --production --no-progress

# 三个 shell 启动垫片（ADR 0008 D10）。它们写死了 /usr/local/bin/bun 与
# /usr/local/lib/pi-skill-runtime/，所以必须在上面两步之后才有意义。
COPY exec/skill-runtime/ /usr/local/bin/
RUN chmod 0555 \
        /usr/local/bin/baoyu-format-markdown \
        /usr/local/bin/baoyu-markdown-to-html \
        /usr/local/bin/baoyu-chromium

RUN groupadd --gid 10001 sandbox && \
    useradd --uid 10001 --gid 10001 --home-dir /home/sandbox --create-home sandbox && \
    mkdir -p \
        /home/sandbox/workspace \
        /home/sandbox/skill \
        /home/sandbox/skill-user \
        /var/sandbox/workspaces \
        /var/sandbox/tmp \
        /var/sandbox/artifacts \
        /var/sandbox/control && \
    chmod 0700 /var/sandbox/workspaces /var/sandbox/tmp \
               /var/sandbox/artifacts /var/sandbox/control && \
    chown -R 10001:10001 /home/sandbox /var/sandbox

WORKDIR /app
COPY --from=ts-build --chown=10001:10001 /app/contract /app/contract
COPY --from=ts-build --chown=10001:10001 /app/exec /app/exec

WORKDIR /app/exec
USER 10001:10001

ENV PATH="/opt/pi-python/venv/bin:$PATH" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    EXEC_PORT=8081 \
    SANDBOX_ARTIFACTS_ROOT=/var/sandbox/artifacts \
    SANDBOX_CONTROL_ROOT=/var/sandbox/control

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD curl -sf http://localhost:8081/health || exit 1

CMD ["node", "dist/main.js"]
