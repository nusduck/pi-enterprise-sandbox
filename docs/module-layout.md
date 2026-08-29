# Module layout conventions

**Purpose:** One production source root per deployable service so dual-tree leftovers do not return.

## Repository structure rules

- Production source files default to at most 1,000 lines. The structural test
  in `tests/test_repository_layout.py` records the remaining hotspots as
  budgets pinned to their current length: a hotspot can shrink but never grow.
  Adding lines to one fails that test in the same PR that added them. Growing a
  hotspot on purpose means splitting it or raising its budget there, with the
  reason in the commit message — never silently.
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
| `contract/` | Agent↔执行面共享类型与 RPC 信封（TS） | `contract/src/**` | `src/index.ts` |
| `runtime/` | Agent 侧 DSH 组合层：provider / 策略 / 投影（TS） | `runtime/src/**` | `src/boot.ts` |
| `exec/` | 执行面：隔离、文件、命令、作业、产物（TS） | `exec/src/**` | `src/main.ts` |

Do **not** reintroduce parallel production trees at the package root that mirror `src/` (e.g. `agent/application` next to `agent/src/application`).

---

## DSH 重建的三个新包（ADR 0007 / 0008）

```text
contract/          Agent 与执行面之间的共享契约。两侧同为 TS，所以不手写 DTO：
  src/               直接复用 @deepseek-ai/dsh-fs / dsh-shell 的类型，本包只加
    envelope.ts      RPC 信封（必带 workspaceId，多实例路由的预留键）
    errors.ts        错误码 + 物理路径脱敏（脱敏参数**必填**，不给默认值）
    hmac.ts          两侧共用一份签名实现
runtime/           Agent 侧的 DSH 组合层
  bundle/            cordis.patch.yml —— 叠在 dsh-base 之上的组合层
  src/providers/     ctx.fs / ctx.shell / ctx.jobs / sessionPersistence / skills / …
  src/policy/        四个挂载点：pre-execute / guard / execute / post-execute
  src/projection/    session/event → 平台 Run Event → SSE（契约逐字节不变）
exec/              执行面（取代 Python 版 sandbox/）
  src/fs/            WorkspaceFileSystem extends LocalFileSystem + 围栏
  src/isolation/     Profile 数据模型 + 唯一的 render() + preflight 同源
  src/shell/         命令执行与作业登记
  src/workspace/     工作区、配额、路径
  src/http/          内部面（HMAC）与公共面（对 BFF 契约不变）
```

**规则**

- 三个新包**没有任何 hotspot 预算**：`tests/test_repository_layout.py` 已把它们纳入，
  1000 行上限从第一天就生效。**不要把既有债务复制过来。**
- 相对 import 必须带 `.js` 后缀（NodeNext 解析），`"type": "module"`。
- 每个文件顶部写清楚"这是什么、为什么这样设计"，中文。
- `exec/src/types.ts` 与 `contract/` 的导出是跨任务共享面，**改签名要先提出来**，
  不要各写一份（可写根、路径常量都踩过这个坑）。

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
    config/              # runtime policy data (fake-llm-policy)
    domain/              # pure domain
    infrastructure/      # mysql, redis, pi, mcp, outbox, sandbox transports, model-registry, telemetry
    extensions/          # first-party Pi extensions + registry (constants.js)
    presentation/        # a2a HTTP handlers
    lib/                 # shared pure helpers (text-redaction)
    skills/              # skill install/validate/paths
  tests/
    support/             # non-production harnesses and fakes
```

**Rules**

- New production modules land under `src/` only.
- Obsolete approval-waiter code is deleted; do not add a package-root `legacy/` tree.
- `tests/support/` is the only home for gates and local fakes. Production code
  may import a runtime policy, but never a test harness. There is no
  `agent/testing/` root — CI syntax-checks every `agent/**/*.js` outside
  `node_modules`, with no carve-out.

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
  routers/               # HTTP routers (internal plane + files/datasets compat + health)
  services/              # runtime services (process, files, formal_*)
  isolation/             # bubblewrap / resource policy
  security/              # internal auth, network policy
  mcp/                   # sandbox-mcp Streamable HTTP facade (separately deployed)
  utils/                 # resource_limits and other pure helpers
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
  `sandbox/artifact/`; `main.py` mounts `sandbox.artifact.api` directly. Former
  service/domain paths that still exist are compatibility imports; the former
  `sandbox.routers.{artifacts,internal_artifacts}` shims have been removed.
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
