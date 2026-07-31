# Module layout conventions

**Purpose:** One production source root per deployable service so dual-tree leftovers do not return.

## Repository structure rules

- Production source files default to at most 1,000 lines. The structural test
  in `tests/test_repository_layout.py` records remaining legacy hotspots as
  non-increasing budgets; reduce the budget whenever a hotspot is split.
- Runtime code belongs under the service's `src/` or package tree. Test helpers
  belong under `tests/support`; do not recreate a parallel `testing/` root.
- Project documentation belongs under `docs/`, except `README.md` files that
  introduce the repository or a self-contained package.
- Prefer cohesive modules named after one responsibility. Entry points compose
  modules; they should not own protocol parsing, DTO presentation, persistence,
  and orchestration in the same file.

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
    extensions/          # first-party Pi extension registry (constants.js)
    presentation/        # a2a HTTP handlers
    lib/                 # shared pure helpers (text-redaction)
    runtime/             # message/attachment/vision helpers
    skills/              # skill install/validate/paths
  tests/
    support/             # non-production harnesses and fakes
```

**Rules**

- New production modules land under `src/` only.
- Obsolete approval-waiter code is deleted; do not add a package-root `legacy/` tree.
- `tests/support/` is the only home for gates and local fakes. Production code
  may import a runtime policy, but never a test harness.

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
  artifact/              # Artifact domain: contracts, facade/runtime, infra, API
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
- Artifact is the explicit L1 domain exception: new Artifact code lives under
  `sandbox/artifact/`; the former service/router/domain paths are compatibility
  imports only.
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
3. Reintroducing a package-root `agent/legacy/` source tree.
