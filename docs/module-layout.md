# Module layout conventions

**Branch:** `codex/plan-acceptance`  
**Purpose:** One production source root per deployable service so dual-tree leftovers do not return.

## Monorepo packages

| Package | Role | Production source root | Thin entry |
|---------|------|------------------------|------------|
| `agent/` | Pi Agent HTTP + Worker | `agent/src/**` | `server.js`, `worker.js`, package-root `config.js` |
| `api-server/` | BFF | `api-server/src/**` | `server.js` |
| `sandbox/` | FastAPI execution plane | Python package `sandbox/` (installable) | `sandbox/main.py` (uvicorn) |
| `frontend/` | Vite React app | `frontend/src/**` (FSD-style) | `index.html` + Vite |

Do **not** reintroduce parallel production trees at the package root that mirror `src/` (e.g. `agent/application` next to `agent/src/application`).

---

## agent/

```text
agent/
  server.js              # re-exports + listen when main
  worker.js              # worker process entry
  config.js              # env / settings (package root for Docker WORKDIR)
  Dockerfile
  package.json
  src/                   # sole production source root
    bootstrap/           # composition root, http-main, worker-main
    application/         # use-cases / services
    domain/              # pure domain
    infrastructure/      # mysql, redis, pi, mcp, sandbox transports, model-registry
    extensions/          # sandbox-bridge, enterprise-policy, observability
    presentation/        # a2a HTTP handlers
    lib/                 # shared pure helpers (text-redaction)
    runtime/             # message/attachment/vision helpers
    skills/              # skill install/validate/paths
  testing/               # non-production harness (fake OpenAI provider)
  legacy/                # deliberately non-production (e.g. approval-waiter)
  tests/
```

**Rules**

- New production modules land under `src/` only.
- `legacy/` is not part of the production graph (asserted by B3 structural tests for approval-waiter).
- `testing/` is for gates and local fakes; do not import from production request paths except config-gated dev hooks.

---

## api-server/

```text
api-server/
  server.js              # HTTP entry; imports from ./src/**
  Dockerfile
  package.json
  src/
    config.js
    application/
    http/
    routes/
    services/
    ARCHITECTURE.ts      # optional contract notes
  tests/
```

**Rules**

- Production code only under `src/`.
- Tests import via `../src/...` (or `readFileSync` of `src/...`).

---

## sandbox/

Python package layout (setuptools `sandbox*`):

```text
sandbox/
  main.py                # FastAPI app entry (uvicorn sandbox.main:app)
  config.py, auth.py, paths.py, models.py, telemetry.py, trace.py
  routers/               # HTTP routers (internal plane + health)
  services/              # runtime services (process, files, formal_*)
  isolation/             # bubblewrap / resource policy
  security/              # internal auth, network policy
  app/
    domain/              # pure contracts / types
    persistence/         # MySQL repositories for formal plane
  Dockerfile
  entrypoint.sh
```

**Rules**

- Import as `from sandbox....` (package root on `PYTHONPATH` / installed editable).
- Domain and persistence live under `sandbox/app/`; HTTP and process runtime stay at package-level `routers/` / `services/` (FastAPI conventional hybrid — not a second competing app tree).
- Do not create a parallel `sandbox/src/` that duplicates these modules.

---

## frontend/

Unchanged: feature-sliced style under `frontend/src/` (`pages/`, `widgets/`, `features/`, `entities/`, `shared/`). Tests under `frontend/test/`.

---

## Docker / compose

- Agent / API: `WORKDIR /app`, `CMD ["node", "server.js"]` (or worker) — copy entire package so `src/` is present.
- Sandbox: uvicorn targets `sandbox.main:app` with package on `PYTHONPATH`.

---

## Anti-patterns (do not reintroduce)

1. Production helpers at `agent/lib` or `agent/services` while the same role also lives under `agent/src`.
2. BFF routes at `api-server/routes` after this layout — always `api-server/src/routes`.
3. Importing `agent/legacy/*` from `agent/src`.
