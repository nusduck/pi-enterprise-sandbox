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
| `agent/` | Agent HTTP + Worker（TS） | `agent/src/**` | `server.ts`, `worker.ts`, package-root `config.ts`；容器跑 `dist/` |
| `api-server/` | BFF（TS） | `api-server/src/**` | `server.ts`；容器跑 `dist/server.js` |

| `exec/` | 执行面 + MCP facade（TS） | `exec/src/**` | `src/main.ts`、`src/mcp-main.ts` |
| `frontend/` | Vite React app | `frontend/src/**` (FSD-style) | `index.html` + Vite |
| `contract/` | exec↔agent runtime 共享类型与 RPC 信封（TS） | `contract/src/**` | `src/index.ts` |

DSH 组合层是 `agent/src/runtime/`，不是独立包、也不是第六个服务。它曾经短暂
作为 `agent/runtime/`（`@pi/runtime`），阶段 F 并进主树，与其余源码同一次
`tsc` 编译。`contract/` 留在顶层，因为 exec 与 agent runtime 都用它。

Do **not** reintroduce parallel production trees at the package root that mirror `src/` (e.g. `agent/application` next to `agent/src/application`).

---

## DSH 重建后的包（ADR 0007 / 0008）

```text
contract/          Agent 与执行面之间的共享契约。两侧同为 TS，所以不手写 DTO：
  src/               直接复用 @deepseek-ai/dsh-fs / dsh-shell 的类型，本包只加
    envelope.ts      RPC 信封（必带 workspaceId，多实例路由的预留键）
    errors.ts        错误码 + 物理路径脱敏（脱敏参数**必填**，不给默认值）
    hmac.ts          两侧共用一份签名实现
agent/src/runtime/ Agent 侧的 DSH 组合层（agent 私有，同一次 tsc）
  bundle/            cordis.patch.yml —— 叠在 dsh-base 之上的组合层（生成物）
  plugins/           类型化清单，`npm run gen:patch` 写出 YAML
  providers/         ctx.fs / ctx.shell / ctx.jobs / sessionPersistence / skills / …
  policy/            四个挂载点：pre-execute / guard / execute / post-execute
  projection/        session/event → 平台 Run Event → SSE（契约逐字节不变）
exec/              执行面 + MCP facade（取代 Python 版 sandbox/ 全部内容）
  src/fs/            WorkspaceFileSystem extends LocalFileSystem + 围栏
                     make-workspace-fs.ts 是**唯一**构造入口（每次新建 cordis
                     Context：同一个 Context 注册两次 fs 服务会抛）
  src/isolation/     Profile 数据模型 + 唯一的 render() + preflight 同源
                     AGENT_PYTHON_VENV 同时决定只读挂载与子进程 PATH
  src/shell/         命令执行与作业登记
  src/search/        ls / find / grep（内部面与公共面共用同一个服务）
  src/workspace/     工作区、配额、路径
  src/artifact/      控制面快照（**不在工作区**：产物要对模型不可变）
  src/dataset/       三段式流式上传：begin → writeChunk → finish
  src/mcp/           对外 MCP facade（settings/context-store/bridge-client/server）
  src/http/          internal（HMAC）· internal-mcp（窄桥）· public（对 BFF 契约不变）
```

**规则**

- `contract/`、`exec/` 和 `agent/src/runtime/`**没有任何 hotspot 预算**：
  `tests/test_repository_layout.py` 已把它们纳入，1000 行上限从第一天就生效。
  **不要把既有债务复制过来。**
- 相对 import 必须带 `.js` 后缀（NodeNext 解析），`"type": "module"`。
- 每个文件顶部写清楚"这是什么、为什么这样设计"，中文。
- `exec/src/types.ts` 与 `contract/` 的导出是跨任务共享面，**改签名要先提出来**，
  不要各写一份（可写根、路径常量都踩过这个坑）。

---

## agent/

```text
agent/
  server.ts              # re-exports + listen when main
  worker.ts              # worker process entry
  config.ts              # env / settings (package root for Docker WORKDIR)
  tsconfig.json          # 检查（strict 仍关着，已知待办）
  tsconfig.build.json    # 出 dist/
  tsconfig.runtime.json  # 只检查 src/runtime/** 且开 strict
  Dockerfile             # CMD node dist/server.js
  package.json
  src/                   # sole production source root
    bootstrap/           # composition root, http-main, worker-main
    application/         # use-cases / services（不认识 cordis）
    runtime/             # DSH 组合层：plugins / providers / policy / projection
    config/              # runtime policy data (fake-llm-policy)
    domain/              # pure domain
    infrastructure/      # mysql, redis, dsh, mcp, outbox, sandbox public client
    presentation/        # a2a HTTP handlers
    lib/                 # shared pure helpers (text-redaction)
    skills/              # skill install/validate/paths
  tests/
    support/             # non-production harnesses and fakes
    runtime/             # 组合层用例（含 boot 起真实插件树）
```

**Rules**

- New production modules land under `src/` only. 入口是 `.ts`，容器跑 `dist/`。
- `application/` 不 import cordis / `@pi/runtime` / `@deepseek-ai/dsh-*`。
- 新增 plugin 只改 `src/runtime/plugins/manifest.ts`，然后 `npm run gen:patch`。
- Obsolete approval-waiter code is deleted; do not add a package-root `legacy/` tree.
- `tests/support/` is the only home for gates and local fakes. Production code
  may import a runtime policy, but never a test harness. There is no
  `agent/testing/` root。
- `src/` 下仅 `infrastructure/mysql/migrations/` 保留 `.js`（knex 按目录扫描
  加载的纯 DDL）。不要把别的生产文件以 `.js` 加回来。

---

## api-server/

```text
api-server/
  server.ts              # HTTP entry; imports from ./src/**
  Dockerfile
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
    config.ts
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

## exec/

TypeScript，两个入口共用一个包（也共用一个镜像）：

```text
exec/
  src/
    main.ts              # 执行面入口（compose: sandbox）
    mcp-main.ts          # MCP facade 入口（compose: sandbox-mcp）
    types.ts             # WorkspaceContext 等跨模块类型
    fs/                  # 围栏、路径策略、脱敏、可写根、make-workspace-fs
    isolation/           # profile 数据模型、render()、preflight、bubblewrap 探测
    shell/               # executor、job-registry、python 物化、safe-env
    search/              # ls / find / grep 与它们的谓词、上限
    workspace/           # 生命周期、配额账本、锁、单实例断言
    artifact/            # control-plane-storage + service（快照不在工作区）
    dataset/             # 三段式流式上传
    attachment/          # 上传件与文件名净化
    db/                  # 连接池 + exec_* 仓储
    security/            # HMAC 校验、CIDR
    http/
      app.ts             # 唯一组合入口
      router.ts          # 内部面（HMAC + CIDR）
      internal-*.ts      # fs / shell / jobs / artifact / session
      internal-mcp.ts    # MCP 窄桥（独立 bearer，**不**挂 HMAC 中间件）
      public/            # 对 BFF 的会话作用域面
    mcp/                 # facade：settings / context-store / bridge-client /
                         #        service / server / tools / disposition / ulid
  requirements.txt       # 镜像里给**模型执行代码**用的 Python 运行库
  skill-runtime/         # 三个 shell 启动垫片（ADR 0008 D10）
  test/
  Dockerfile             # 服务 + 模型工具链
```

**Rules**

- 生产代码只在 `src/` 下。
- `WorkspaceFileSystem` **只能**经 `fs/make-workspace-fs.ts` 构造：它每次新建一个
  cordis Context，因为同一个 Context 上注册两次 `fs` 服务会抛。
- MCP 窄桥挂在 `http/app.ts` 而不是 `http/router.ts` 里——让"facade 够不到
  `/internal/v1/*`"这条性质在代码结构上看得见，而不只是写在文档里。
- 产物快照落控制面（`SANDBOX_ARTIFACTS_ROOT`），**不落工作区**；数据集相反，
  它就是要给模型读的，落 `datasets/{id}/{name}`。

---

## frontend/

Unchanged: feature-sliced style under `frontend/src/` (`pages/`, `widgets/`, `features/`, `entities/`, `shared/`). Tests under `frontend/test/`.

---

## Docker / compose

- Agent: `WORKDIR /app/agent`，`CMD ["node", "dist/server.js"]`（worker 是
  `dist/worker.js`）。镜像**不挂载源码**，改了 `agent/` 必须重建。
- API: `WORKDIR /app`, `CMD ["node", "dist/server.js"]` — TypeScript 构建产物，镜像**不挂载源码**，改了 `api-server/` 必须重建。
- Exec: `WORKDIR /app/exec`，`CMD ["node", "dist/main.js"]`；MCP facade 是同一镜像的
  `node dist/mcp-main.js`。compose 服务名仍是 `sandbox` / `sandbox-mcp`。
  **两者必须一起重建**，否则一个跑新代码一个跑旧的。

---

## Anti-patterns (do not reintroduce)

1. Production helpers at `agent/lib` or `agent/services` while the same role also lives under `agent/src`.
2. BFF routes at `api-server/routes` after this layout — always `api-server/src/routes`.
3. Reintroducing a package-root `agent/legacy/` source tree.
