# ── JS toolchain (build-time only) ──────────────────────────────────
# nodejs/npm exist only in this ephemeral stage, to fetch bun itself (a
# standalone binary — chicken-and-egg, npm is the bootstrap), docx/pptxgenjs,
# and to `npm ci` the native autocorrect-node addon with its npm lockfile.
# Nothing at runtime invokes `node`: BaoYu skills and docx/pptx generation
# scripts all run under bun, so nodejs itself never reaches the final image.
FROM python:3.11-slim AS js-deps
ARG BUN_VERSION=1.4.0
ARG DOCX_JS_VERSION=9.7.1
ARG PPTXGENJS_VERSION=4.0.1

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install --global --prefix /usr/local --no-audit --no-fund \
        "bun@${BUN_VERSION}" \
        "docx@${DOCX_JS_VERSION}" \
        "pptxgenjs@${PPTXGENJS_VERSION}"

COPY skills/baoyu-format-markdown/scripts/ /build/baoyu-format-markdown/
RUN npm ci --omit=dev --ignore-scripts --prefix /build/baoyu-format-markdown

# ── Sandbox Service (Python FastAPI) ──────────────────────────────
# Python minor pin: runtime-versions.json → python.docker_image
FROM python:3.11-slim AS sandbox-base

# System deps: runtime isolation + everyday agent tooling (docs, office, git, text utils)
# Intentionally NO iptables: container-wide firewall is not the execution
# isolation authority (no NET_ADMIN/NET_RAW; missing tools must not fail-open).
ARG BUN_VERSION=1.4.0
ARG DOCX_JS_VERSION=9.7.1
ARG PPTXGENJS_VERSION=4.0.1

RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    bubblewrap \
    gosu \
    util-linux \
    git \
    jq \
    unzip \
    zip \
    file \
    less \
    tree \
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
    && ln -sf "$(command -v fdfind || true)" /usr/local/bin/fd || true \
    && rm -rf /var/lib/apt/lists/*

# bun (standalone binary) + docx/pptxgenjs, fetched via npm in the js-deps
# stage above; no nodejs/npm in this (final) image.
COPY --from=js-deps /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=js-deps /usr/local/bin/bun /usr/local/bin/bun

# BaoYu's TypeScript Skills are read-only bind mounts at runtime. Keep a
# build-time copy with locked dependencies in the image so the production
# Bubblewrap child never needs npx/npm access to the network.
COPY skills/baoyu-format-markdown/scripts/ /usr/local/lib/pi-skill-runtime/baoyu-format-markdown/
COPY --from=js-deps /build/baoyu-format-markdown/node_modules/ /usr/local/lib/pi-skill-runtime/baoyu-format-markdown/node_modules/
COPY skills/baoyu-markdown-to-html/scripts/ /usr/local/lib/pi-skill-runtime/baoyu-markdown-to-html/
RUN cd /usr/local/lib/pi-skill-runtime/baoyu-markdown-to-html && \
    bun install --frozen-lockfile --production --no-progress

COPY sandbox/skill-runtime/ /usr/local/bin/
RUN chmod 0555 \
        /usr/local/bin/baoyu-format-markdown \
        /usr/local/bin/baoyu-markdown-to-html \
        /usr/local/bin/baoyu-chromium
RUN groupadd -g 10001 sandbox && \
    useradd -m -u 10001 -g sandbox sandbox && \
    mkdir -p \
        /home/sandbox/workspace \
        /home/sandbox/skill \
        /home/sandbox/skill-user \
        /var/sandbox/workspaces \
        /var/sandbox/tmp && \
    chmod 0700 /var/sandbox/workspaces /var/sandbox/tmp && \
    chown -R sandbox:sandbox /home/sandbox /var/sandbox

WORKDIR /app

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files first for caching
COPY pyproject.toml /app/
COPY sandbox/requirements.txt /app/sandbox/requirements.txt

# Create venv and install API deps plus preinstalled workload/tooling deps (no dev/test deps)
RUN uv venv /app/.venv && \
    . /app/.venv/bin/activate && \
    uv pip install --no-cache -e "." && \
    uv pip install --no-cache -r /app/sandbox/requirements.txt && \
    uv pip install --no-cache pip && \
    chown -R sandbox:sandbox /app

# Copy application code
COPY sandbox/ /app/sandbox/
COPY sandbox/entrypoint.sh /app/entrypoint.sh

# Fix ownership
RUN chown -R sandbox:sandbox /app && chmod +x /app/entrypoint.sh

# NOTE: No USER directive — entrypoint.sh starts as root only to initialize
# workdir ownership (CHOWN/FOWNER), then drops to the sandbox user via gosu
# (SETUID/SETGID). No iptables / NET_ADMIN path remains.
# Hard RLIMIT_* for untrusted work are applied per-child in Python preexec
# (not via image-level ulimit, which would starve the API process).
WORKDIR /app

ENV \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD curl -sf http://localhost:8081/health || exit 1

CMD ["/app/entrypoint.sh"]
