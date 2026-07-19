# ── Sandbox Service (Python FastAPI) ──────────────────────────────
# Python minor pin: runtime-versions.json → python.docker_image
FROM python:3.11-slim AS sandbox-base

# System deps: runtime isolation + everyday agent tooling (docs, git, text utils)
# Intentionally NO iptables: container-wide firewall is not the execution
# isolation authority (no NET_ADMIN/NET_RAW; missing tools must not fail-open).
RUN apt-get update && apt-get install -y --no-install-recommends \
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
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-chi-sim \
    ffmpeg \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && ln -sf "$(command -v fdfind || true)" /usr/local/bin/fd || true \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 sandbox && \
    useradd -m -u 10001 -g sandbox sandbox && \
    mkdir -p \
        /home/sandbox/workspace \
        /home/sandbox/skill \
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

# Create venv and install API deps plus preinstalled workload/tooling deps (no dev deps)
RUN uv venv /app/.venv && \
    . /app/.venv/bin/activate && \
    uv pip install --no-cache -e ".[test]" && \
    uv pip install --no-cache -r /app/sandbox/requirements.txt && \
    uv pip install --no-cache pip && \
    chown -R sandbox:sandbox /app

# Copy application code
COPY sandbox/ /app/sandbox/
COPY tests/ /app/tests/
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
