# 交付物人工审核（ADR 0016 / design agent-output-review）真机验收证据

日期：2026-10-01。设计：[design/agent-output-review.md](../design/agent-output-review.md)（本次实施后状态改为**已实施**），
决策：[ADR 0016](../adr/0016-agent-output-human-review.md)（**Accepted**）。

## 1. 验收对象与版本

| 项 | 值 |
|---|---|
| 分支 / HEAD | `feat/agent-output-review`，P1–P6 已提交（`048eac18`、`0e30077f`、`717f1d24`、`01cdd134`、`68a27731`、`80341922`），P7 改动为本次未提交工作树 |
| 运行栈 | Docker Compose（`docker compose ps`：agent / agent-worker / api-server / frontend / sandbox / sandbox-mcp / mysql 5.7 / redis 全部 healthy），BFF `http://127.0.0.1:4000` |
| 镜像 | `dsh-enterprise-agent:latest`（agent 与 agent-worker 共享）、`dsh-enterprise-api:latest`、`dsh-enterprise-frontend:latest`、`enterprise-sandbox:latest` / `enterprise-sandbox-mcp:latest` **本次全部重建**（`docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend` + `docker compose up -d`） |
| 数据库 | MySQL 5.7（`sandbox` 库）；迁移 `20261001000004_review_ledger.js`（四张审核表）已应用 |
| 运行时 | 容器内 Node 22.x（`runtime-versions.json` 钉的版本）；宿主机 Node v26.5.0 只用于跑单测（见 §5 已知偏差） |
| 模型 | **真实模型**（`LLMIO_BASE_URL=https://api.deepseek.com`，`MODEL_ID=deepseek-flash`），不是 fake provider |
| 验收脚本 | `.runtime/review-acceptance.mjs`（31 项）、`.runtime/review-acceptance-2.mjs`（25 项）、`.runtime/rbac-live-chain.mjs`（AGENTS.md §4 最少链路 13 项）。脚本对运行中的 BFF 发真实请求，放在 gitignored 的 `.runtime/`，可重跑 |

改动触及 `agent/`、`api-server/`、`exec/` 的运行路径与前端页面，所以按 AGENTS.md §4 重建镜像并跑真实链路。

## 2. §10 验收清单结果（真实链路，真实模型）

### 2.1 可见性与正向对照（脚本 1）

准备：admin 建 review 智能体与 direct 智能体（同一 system prompt），发起人 `review_requester`，
审核员 `review_reviewer`，对照账号 `review_outsider`。

| §10 | 结果 | 证据 |
|---|---|---|
| 1 聊天与工具过程正常，卡片「已提交审核」 | **PASS** | `artifact.ready` 事件负载 `review_status: "pending"`（A1）；模型真的调了 `write` / `read` / `bash` / `submit_artifact`（工具台账 4 行） |
| 2 会话产物列表不含待审产物 | **PASS** | `GET /api/artifacts?session_id=` → 200 且 `artifacts: []` |
| 2 待审产物下载 404（E2） | **PASS** | `GET /api/files/artifact-download` → 404 |
| 2 产物库不含待审产物（E3） | **PASS** | `GET /api/artifacts` → 200，`held` 产物不在列表里 |
| 2 工作区文件下载 404（E5） | **PASS** | `GET /api/files/download?path=report.md` → 404 |
| 2 进程列表 404（E6） | **PASS** | `GET /api/processes?session_id=` → 404 |
| 2 **direct 正向对照** | **PASS** | 同样的四个请求在 direct 会话里全部成功：产物列表 1 条、工作区文件下载 200、产物下载 200、Run `SUCCEEDED` |
| 3 非 reviewer → 403 `REVIEWER_REQUIRED` | **PASS** | 发起人（无角色）读 `/api/reviews` → 403 `REVIEWER_REQUIRED` |
| 3 不存在 / 跨 org 任务 → 404 | **PASS** | 不存在的任务 id → 404 `NOT_FOUND`（与跨租户同码；本开发栈只有一个 org，跨 org 的作用域判定由 `agent/tests/review/review-service.unit.test.ts` 与 exec 的跨 org 用例覆盖） |
| 4 R 看到 U 的提问 | **PASS** | 详情 `questions` 非空 |
| 4 附件快照与上传一致 | **PASS** | 上传 `材料.txt`（内容含唯一标记）→ 审核员下载材料，`status=200` 且正文含该标记（脚本 2） |
| 4 删除工作区原文件后快照仍可下载 | **PASS** | 容器内删掉 `uploads/材料.txt` 后重新下载同一 `material_id` → 200（脚本 2） |
| 5 领取成功、重复领取 409 | **PASS** | `POST /claim` → 200；第二次 → 409 `REVIEW_ALREADY_CLAIMED` |
| 5 上传修订版、旧 `base_revision` → 409 | **PASS** | 第一次修订 200；用同一 `base_revision` 再传 → 409 `REVIEW_VERSION_CONFLICT` |
| 5 通过后 U 能看到「已交付」卡片 | **PASS** | 放行后会话产物列表出现 `art_7bcd17fa…`（`reviewStatus: released`） |
| 5 下载到的是修订版 | **PASS** | 下载正文含「（审核员修订）」；原件下载 404（已 `withdrawn`）；产物库里有它 |
| 5 修订版进了工作区 `审核版/` | **PASS** | 容器内 `ls` 该工作区：`审核版/report.md`，内容为审核员提交的修订正文 |
| 6 追问的提示词里有 §5.4 注入文本 | **PASS** | 通过后追问一轮：该 Run 的 DSH 会话事件（模型请求记录）里能查到注入文本的小节标题与结尾句 |
| 6 注入只做一次 | **PASS** | `tbl_agsvc_review_tasks.context_injected_run_id` 有且仅有一个任务被标记 |
| 6 新产物产生新任务、驳回后始终 404 | **PASS** | 追问产生新的 `review_status: pending` 事件与独立任务；驳回（反馈必填）后 `review.rejected` 事件落库，被驳回产物下载 404 |
| 6 驳回空反馈 422 | **PASS** | `POST /reject` 带空白 feedback → 422 `REVIEW_FEEDBACK_REQUIRED` |
| 7 提交产物后被取消的 Run 仍建任务 | **PASS** | Run 终态 `CANCELLED`，且取消前已观察到该 Run 的 `artifact.ready`（`review_status: pending`）；任务行 `run_status = CANCELLED` |
| 8 admin 能看到待审交付物事件（U7） | **PASS** | admin 读别人的 Run 详情 200，事件重放里能看到 `artifact.ready` 与 `review_status: "pending"` |
| 9 exec fail-closed（策略查询失败 → 503） | **未在真机执行** | 需要人为打断策略查询；由 `exec/test/artifact-visibility.test.ts` 的真实 HTTP 服务器用例覆盖（503 而非放行）。真机上只验证了正常路径的 404/200 分流 |
| 10 AGENTS.md §4 最少链路 | **PASS** | 登录 → 建会话 → 一轮**真实调 bash** 的 Run（工具台账有 `bash`，stdout 有 `echo` 结果）→ 同会话第二轮起长进程 → `GET /api/processes` / `/logs` / `POST /signal` 全部 200 → 用另一个账号读该 Run / 会话 / 工具台账**全部 404**（12/13；唯一 FAIL 是脚本自己把终态字面写成 `COMPLETED`，实际是 `SUCCEEDED`，属断言字面错误，已记在脚本注释里） |

### 2.2 两批脚本的最终计数

```
.review-acceptance.mjs    === 31/31 PASS ===
.review-acceptance-2.mjs  === 25/25 PASS ===
.rbac-live-chain.mjs      === 12/13 PASS ===（唯一失败为脚本断言字面）
```

### 2.3 未覆盖 / 留待后续

- **§10.9 的真机部分**（临时让 exec 策略查询失败）没有做：那需要改运行中的 exec 依赖注入，
  风险大于收益；同一 fail-closed 分支由 exec 的真实 HTTP 服务器用例覆盖。
- **浏览器实操**：审核工作台与交付卡片的交互（三态渲染、错误态、409 后保留已选文件、文件页签隐藏）
  由 `frontend/test/agent-output-review.test.ts`（24 项，含三个渲染点的下载门禁与页面契约）覆盖，
  本次真机走的是 HTTP 接口与数据库；未做 Playwright 级别的 UI 走查。这一点是本次验收的**已知缺口**。
- **跨 org 审核员**：开发栈只有一个组织，造不出第二个 org 的 reviewer，所以「X 读任务 → 404」
  用「不存在的任务 → 404」代替（同一码），作用域判定由单测覆盖。
- 验收产生的临时账号（`review_requester` / `review_reviewer` / `review_outsider` / `rbac_other*`）
  与 review 智能体留在开发库中，未清理。

## 3. 六套测试 + 类型检查 + 前端 build

| 套件 | 命令 | 结果 |
|---|---|---|
| 仓库卫生 | `uv run pytest -q` | **223 passed** |
| RPC 契约 | `npm test --prefix contract` | **158 passed / 0 fail** |
| 执行面 | `npm test --prefix exec` | **473 passed / 3 skipped / 0 fail** |
| Agent | `npm test --prefix agent` | **1846 passed / 8 fail**（8 项全部是 `tests/runtime/*` 的既存环境失败，见 §5） |
| BFF | `npm test --prefix api-server` | **240 passed / 0 fail** |
| 前端 | `npm test --prefix frontend` | **510 passed / 0 fail** |
| 前端构建 | `npm run build --prefix frontend` | 成功（`tsc --noEmit` + vite build） |
| 类型检查 | `exec` / `contract` / `frontend` / `api-server` / `agent`（含 `src/runtime` strict） | 全部无输出（通过） |

本次新增/改写的针对性用例：

- `agent/tests/review/review-task-create.unit.test.ts`（6）、`artifact-ready-review-status.unit.test.ts`（3）、
  `review-service.unit.test.ts`（14）、`review-publisher.unit.test.ts`（8）、
  `review-notification-and-context.unit.test.ts`（11）、`review-wiring.unit.test.ts`（3）、
  `http/review-http.unit.test.ts`（13）：账本事务、A1 负载、服务层错误语义与乐观并发、
  outbox 投递的失败分类、通知聚合隔离与邮件、§5.4 注入顺序与只注入一次、exec 客户端装配。
- `exec/test/internal-review.test.ts`（5）：四个审核端点的 HMAC 面、错误码透传、可见性状态机。
- `api-server/tests/reviews-route.test.js`（7）：审核代理的鉴权、字节流与错误透传。
- `frontend/test/agent-output-review.test.ts`（24）：交付卡片三态与下载门禁、`review_status` 进实体、
  放行/驳回归约、错误码与三态纯逻辑、交付策略读写、页面契约（路由、导航项、文件页签隐藏、三个渲染点）。

## 4. 验收期发现的三个问题（都已修，两个是代码缺陷）

1. **exec 明文 baseUrl 漏传 `allowInsecureHttp` → agent 进程起不来。**
   `createReviewTransportFromEnv` 构造 exec 客户端时没传 `allowInsecureHttp`，而 compose 里的
   `http://sandbox:8081` 不是字面 loopback，`normalizeBaseUrl` 在**启动期**抛
   `http baseUrl rejected unless loopback or allowInsecureHttp=true`，`agent` 容器
   `Restarting (1)` 起不来。单测发现不了（测试用的 baseUrl 往往是 `http://exec`）。
   修复：与另两个 exec 传输（`sessions/ensure`、`artifacts/download`）同一口径显式传 `true`；
   回归用例 `agent/tests/review/review-wiring.unit.test.ts`（含「缺密钥环 → null」的 fail-closed 对照）。
2. **审核 outbox 消费者拿到未绑定的 `createRepositories`，放行行卡在 `PUBLISHING`。**
   `ReviewPublisher` / `ReviewNotificationPublisher` 调 `createRepositories()` 不带执行器，
   而 worker 进程里那条路径抛 `ServiceContainer MySQL not started`：症状是 `review.decided`
   行被认领后永远不结清（`attempts=5, status=PUBLISHING`），产物永远不放行、原件也不撤回。
   修复：两个消费者显式持有 `db`（knex）并把它传给仓储工厂，缺执行器直接构造失败；
   回归断言写进两个 publisher 用例（仓储工厂必须拿到显式执行器）。
   修复后同一行被 stale 回收机制重新认领并结清，修订版 `released`、原件 `withdrawn`。
3. **环境陷阱：另一个运行栈的旧镜像 worker 抢走了队列任务。**
   宿主机上还跑着上一轮 RBAC 验收用的 K8s 开发栈（`dsh-dev`），它的 `agent-worker`
   通过外部 Service 指向**同一套 MySQL 与 Redis**（`mysql-ext` / `redis-ext`），于是它和
   compose 的 worker 争抢同一个 `agent-runs` 队列。旧镜像没有本次改动，被它执行的 Run
   事件里就没有 `review_status`、也不建审核任务——表现为「同一会话第一轮有、第二轮没有」
   这种看似随机的失败。定位方式：把 `artifact.ready` 的 `deliveryMode` 打进容器内 dist 观察，
   发现有一半事件根本不经过新代码；再查 `docker ps` 才看到 13 小时前的 K8s worker。
   处理：`kubectl -n dsh-dev scale deploy/agent-worker --replicas=0` 后重跑，全部一致；
   **验收数据以缩容后的重跑为准**（本文档 §2 的数字都来自缩容后的干净重跑）。
   教训：本机存在两套共享存储的运行栈时，「同一份代码同一份输入结果不同」要先怀疑有别的消费者。

## 5. 已知偏差

- `agent/tests/runtime/*` 的 8 个用例在宿主机（Node v26.5.0）失败，原因是它们 `npx tsx`
  起真实 cordis 插件树，HMR 插件要求 `--expose-internals`。**与本次变更无关**：
  P1–P2 提交时已在干净工作树上复现同样的 8 项；容器内运行时是 22.x。
- 验收脚本放在 `.runtime/`（gitignored），不是仓库资产；它们对运行栈发真实请求，可重跑。
- 模型是真实模型，所以「模型是否调用工具」由工具台账证明，而不是由 fake provider 断言；
  「模型是否收到注入文本」由 DSH 会话事件（模型请求记录）证明。
