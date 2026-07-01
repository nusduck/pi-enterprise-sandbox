# ── Sandbox Service ─────────────────────────────────────────────────────
FROM python:3.11-slim AS sandbox-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 10001 sandbox
USER sandbox
WORKDIR /app

ENV \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONIOENCODING=utf-8 \
    PYTHONUNBUFFERED=1 \
    PATH="/home/sandbox/.local/bin:${PATH}"

COPY --chown=sandbox:sandbox pyproject.toml .
RUN pip install --no-cache-dir --user -e .

COPY --chown=sandbox:sandbox sandbox/ sandbox/

EXPOSE 8081 8091

CMD ["uvicorn", "sandbox.main:app", "--host", "0.0.0.0", "--port", "8081"]


# ── Pi Agent (with Enterprise Adapter) ─────────────────────────────────
FROM python:3.11-slim AS agent-base

RUN useradd -m -u 10001 pi-agent
USER pi-agent
WORKDIR /app

ENV \
    PYTHONUNBUFFERED=1 \
    PATH="/home/pi-agent/.local/bin:${PATH}"

COPY --chown=pi-agent:pi-agent pyproject.toml .
RUN pip install --no-cache-dir --user -e .

COPY --chown=pi-agent:pi-agent agent/ agent/
COPY --chown=pi-agent:pi-agent skills/ skills/

ENV SANDBOX_BASE_URL=http://sandbox:8081

CMD ["python", "-m", "agent.main"]
