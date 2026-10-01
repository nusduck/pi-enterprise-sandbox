# 交付物审核与成员角色：遗留缺陷修复 + 界面优化（浏览器实测证据）

日期：2026-10-01。任务单：`docs/deliverables/dsh-task-review-ui-2026-10-01.md`（本地交付物，未进仓库）。
分支：`fix/review-ui-polish`（基于 `main` @ `ce5d5391`）。

## 1. 验收对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `fix/review-ui-polish`，从 `origin/main`（`ce5d5391`）新开；本次改动为工作树提交 |
| 运行栈 | Docker Compose（`docker compose ps`：agent / agent-worker / api-server / frontend / sandbox / sandbox-mcp / mysql 5.7 / redis 全部 healthy），前端 `http://127.0.0.1:3000`、BFF `http://127.0.0.1:4000` |
| 镜像 | **本次重建**：`dsh-enterprise-agent:latest`（agent 与 agent-worker 共享）、`dsh-enterprise-frontend:latest`、`enterprise-sandbox:latest`；`enterprise-sandbox-mcp:latest` 是缓存命中（新增的 `/internal/v1/review/artifacts/meta` 不在 `mcp-main` 的 import 图里，`exec/test/mcp-import-boundary.test.ts` 守着这条边界），容器已用同一镜像重建 |
| 换新核对 | `docker inspect -f '{{.Image}}'` 与刚构建的镜像 ID 一致（frontend `2908ca149028…` → 后续两次前端重构建后为最新 ID；agent `33f71201e2af…`；sandbox `772a38a207ed…`） |
| 重建前的环境变量核对 | 运行中容器的环境变量与 `docker compose config` 逐项比对：差异只有镜像自带的 `PATH` / `NODE_VERSION` / nginx 变量与 Dockerfile 默认（`EXEC_PORT`、`SANDBOX_MCP_PORT`、`NODE_ENV`），**没有命令行临时覆盖** |
| 数据库 | MySQL 5.7（`sandbox` 库），审核账本迁移 `20261001000004_review_ledger.js` 已应用；本次无新迁移 |
| 运行时 | 容器内 Node 22.x（`runtime-versions.json` 的 `node.major=22`）；宿主机 Node v26.5.0 只用于跑单测 |
| 模型 | **真实模型**（`.env` 的 deepseek），不是 fake provider |
| 浏览器 | 本机 Chrome（headless=new）+ DevTools 协议；驱动脚本 `.runtime/review-ui/cdp.mjs`（gitignored，本机没有 Playwright/Puppeteer，Node 22+ 自带 WebSocket 足够） |

改动触及 `agent/`、`exec/` 运行路径与前端页面，所以按 AGENTS.md §4 重建镜像并跑真实链路。

## 2. T1–T6 的修复与验证

每条缺陷都是**先写会失败的回归测试、再修**（`frontend/test/agent-output-review.test.ts`、
`frontend/test/member-roles.test.ts`、`agent/tests/review/review-service.unit.test.ts`、
`exec/test/internal-review.test.ts`）。

| # | 缺陷 | 修复 | 回归测试（修复前失败） |
|---|---|---|---|
| T1 | 发起人页面收不到审核结果，要手动刷新 | 纯前端轮询（**后端与接口未改**）：会话里还有 `reviewStatus === 'pending'` 的交付物且页面可见时每 20 秒重拉 `GET /api/conversations/{id}/events`，走已有重放与 `event_id`/`sequence` 去重；没有待审/隐藏/切换会话时停 | `reviewResultPolling` 的判定 + 轮询间隔（15–30s）+ `ChatContext` 接线契约（4 条） |
| T2 | 「交付物需人工审核」的单选框被长说明挤到单独一行 | 两个选项共用 `deliveryOption` 行样式（`align-items:flex-start` + 文本列 `min-width:0`） | 组件与 CSS 契约（2 条） |
| T3 | 审核会话的进程页签把 404 显示成「还没有后台进程」 | review 会话隐藏「文件」+「进程」两个页签；其他会话拉取失败显示错误态（`processListStateById` + `processPanelState` 四态） | `inspectorWorkspaceTabs`、`processPanelState`、`setProcessListState` + 页面契约（4 条） |
| T4 | 审计时间线直接显示 `{"items":1,"materials":0}` | `reviewEventDetail` 按事件类型格式化；未知结构不显示详情 | 事件详情格式化（5 条） |
| T5 | 「历史」页签列出全部任务 | 后端 `status` 接受逗号分隔多值（未知值 422，单值不变），前端历史传 `APPROVED,REJECTED` | agent 服务层 5 条 + 前端页签 2 条 |
| T6 | `api.md` 把会话事件接口写成 SSE | 改正为「一次性返回完整时间线的 JSON」，补响应字段、`limit` 语义与调用时机 | 纯文档，按 AGENTS.md §4 核对代码后修改 |

**T1 浏览器实测**（`.runtime/review-ui/verify-t1.mjs`，真实模型、compose 栈，8/8 PASS）：

```
PASS  待审任务的 Run 到终态  — conversation=01M3V5F63EHFM93KYDKM67KS4M status=SUCCEEDED
PASS  发起人卡片显示「已提交审核」  — ["已提交审核"]
PASS  卡片说明「审核通过后可下载」  — ["审核通过后可下载"]
PASS  待审期间轮询 GET /api/conversations/{id}/events  — count=1
PASS  不刷新页面，30 秒内卡片自动变为「已交付」  — 18.3s
PASS  自动更新的这一轮里有会话事件轮询  — count=1
PASS  轮询期间没有重新订阅 Run SSE（Run 已终态）  — run-sse=0
PASS  没有待审交付物后停止轮询  — count=0
```

前后截图：`.runtime/review-ui/shots/t1-before-approve.png`（「已提交审核 · 审核通过后可下载」）、
`t1-after-approve.png`（不刷新即变「已交付」并出现下载按钮）。审核员一侧由脚本直接调 BFF
（领取 → 通过），不经过界面，所以「18.3s」是**页面自己拉到的**，不是人为刷新。

**T5 真机**：历史页签只列出 `APPROVED`/`REJECTED`（浏览器截图见 §4）；
`GET /api/reviews?status=APPROVED,REJECTED` 返回 18 条历史任务、`status=APPROVED,PENDINGX` → 422。

## 3. §3 界面优化的浏览器实测

脚本：`.runtime/review-ui/verify-ui.mjs`（深色/浅色 × 1367/1100/768，共 26 张截图 + 布局体检 +
键盘 Tab 走查）。**结论：0 个失败 / 9 条记录**（记录含 768px 的「预期内溢出」提示，见下）。

结构摘要（脚本从真实 DOM 读回，不是源码推断）：

| 页面 | 结果 |
|---|---|
| 成员与角色 | 列头 `成员 / 最近登录 / 管理员 / 审核员 / 操作`；筛选 `全部 / 管理员 / 审核员`；两个开关与同行文字 `dy=0`（垂直居中）；「操作」列头右对齐；`—` 带 tooltip「这个账号还没有平台登录记录…」；页面说明与之一致 |
| 交付策略 | 两个单选 `sameLine=true`、`inputLeft` 相同（515px），长说明换行时圆圈仍与标题同行 |
| 审核工作台列表 | 列头 `交付物 / 智能体 / 发起人 / 状态 / 运行结果`；每行有交付物名与智能体名（同一发起人的 15 行可区分）；无横向滚动 |
| 审核工作台详情 | 标题 `cancel-report.md`（不是 ULID）；元信息含「智能体：review-live2-mup79ijd v1」与可复制任务 ID；版本表 `版本 / 上传者 / 时间 / 大小`；提问「上文 ×2（可折叠）+ 本次」；审计时间线 `提交审核 · 1 件交付物，0 个附件`；详情面板 `position: sticky`；状态 pill 颜色：任务「待领取」=mute、交付物「已提交审核」=warn（`rgb(226,166,77)`） |
| 键盘 | 成员页 Tab 依次到达 刷新 → 搜索 → 三个筛选 → **两个角色开关**；审核页到达 领取 → 两个「上文」折叠项 → 下载 → 导航项；焦点样式由 `:focus-visible` 提供 |

**768px 的两条 WARN 是预期内的**，不是页面级横向滚动（`documentElement.scrollWidth > innerWidth`
在三个宽度、两套主题下都为 false）：

1. 成员表格超出视口——它在 `overflow-x: auto` 的 `a.tableWrap` 里，与既有管理页同一套响应式处理；
2. 审核页/详情页的侧栏超出视口——≤768px 时侧栏是 `transform` 移出屏幕的抽屉（`sidebar.module.css` 的既有行为）。

**版本元数据的真机核对**（新增 exec 内部端点 `POST /internal/v1/review/artifacts/meta`）：

```json
// GET /api/reviews/01M3V52QJ164JQXMG8PBPW6HZX（有修订的任务）
[
  { "artifact_id": "01M3V52P7J8DTAJRH5RNYJ4G62", "current": false, "revision": 0,
    "uploaded_by_kind": "agent", "created_at": "2026-10-01T07:15:21.581Z", "size": 42 },
  { "artifact_id": "art_19c929e156734254ab34fbe92ce37086", "current": true, "revision": 1,
    "uploaded_by_kind": "reviewer", "uploaded_by_display_name": "review_reviewer",
    "created_at": "2026-10-01T07:15:29.457Z", "size": 75 }
]
```

被替换的原件（42 B）与修订版（75 B）的大小、上传者、时间都对；agent 的账本只保存当前版本，
所以非当前版本的大小确实来自 exec。

## 4. 截图清单

目录：`.runtime/review-ui/shots/`（`.runtime/` 已 gitignore，截图不入库；可用
`SHOT_DIR=… node .runtime/review-ui/verify-ui.mjs` 重新生成）。命名：`<页面>-<主题>-<宽度>.png`。

| 页面 | 文件 |
|---|---|
| 成员与角色（§3.1） | `members-{dark,light}-{1367,1100,768}.png`（6） |
| 智能体配置 · 交付策略（T2） | `delivery-policy-{dark,light}-{1367,768}.png`（4） |
| 审核工作台列表（§3.2） | `reviews-{dark,light}-{1367,1100,768}.png`（6） |
| 审核工作台详情（§3.2） | `reviews-detail-{dark,light}-{1367,768}.png`（4） |
| T1 前后对照 | `t1-before-approve.png`、`t1-after-approve.png`（2） |
| 结构摘要（脚本读回的 DOM 事实） | `summary.json` |

发起人会话页（§3.3 交付卡片）的截图由 T1 的前后对照覆盖：`t1-after-approve.png` 里卡片是
「已交付 + 下载」，`t1-before-approve.png` 是「已提交审核 + 审核通过后可下载」。
本次没有单独造「有修订 + 驳回」的卡片截图；那两条由 `frontend/test/agent-output-review.test.ts`
的三态用例（含修订版大小写回实体）覆盖，属于本次的**已知缺口**（见 §7）。

## 5. 六套测试 + 类型检查 + 前端 build

| 套件 | 命令 | 结果 |
|---|---|---|
| 仓库卫生 | `uv run pytest -q` | **223 passed** |
| 执行面 + MCP facade | `npm test --prefix exec` | **475 passed / 3 skipped / 0 fail**（478） |
| RPC 契约 | `npm test --prefix contract` | **159 passed / 0 fail** |
| Agent（Node 22 容器） | `docker run --rm -v "$PWD":/w -w /w/agent node:22 sh -c 'npm test'` | 见 §5.1 |
| BFF | `npm test --prefix api-server` | **241 passed / 0 fail** |
| 前端 | `npm test --prefix frontend` | **548 passed / 0 fail** |
| 前端构建 | `npm run build --prefix frontend` | 成功（`tsc --noEmit` + vite build） |
| 类型检查 | `exec` / `contract` / `api-server` / `agent`（含 `src/runtime` strict） | 全部无输出（通过） |

### 5.1 Agent 套件（Node 22 容器）

`npm test` 在容器里跑（宿主机是 Node 26，`tests/runtime/*` 会因 HMR 的 `--expose-internals` 失败，
是环境问题不是改动造成的）。**首次运行 1873 passed / 1 fail**，失败的是行数/状态棘轮
`agent/tests/bootstrap/no-authoritative-run-map.unit.test.js` 的
「inventories every residual new Map under agent/src as transient-OK whitelist」：
新增的 `application/review-version-chain.ts` 里两张函数局部 `Map` 未登记。按该文件的既有纪律
补登记（49 → 51）并写明用途后通过——**这条是本次唯一一次由棘轮挡下的改动**，不是产品缺陷。

最终：`# pass 1874 / # fail 0`（`not ok` 计数 0）。

## 6. 真实链路回归（改了 agent/、exec/，按 AGENTS.md §4）

在 compose 网络内跑（`--network pi-enterprise-sandbox-dev-ingress`、`BFF_BASE_URL=http://api-server:4000`；
宿主机 127.0.0.1:4000 也是 compose，K8s 那套只影响容器内 `--network host`）：

| 脚本 | 结果 |
|---|---|
| `.runtime/review-acceptance.mjs`（design §10） | **31/31 PASS** |
| `.runtime/review-acceptance-2.mjs` | **23/25 PASS**，2 项失败是脚本自身在 node:22 容器里 `spawnSync docker` 拿 MySQL（`SQL_ERROR spawnSync docker ENOENT`）——容器里没有 docker CLI，**与本次改动无关**，脚本 1 的同类断言在容器外/另一路径下为 PASS |
| `.runtime/review-ui/verify-t1.mjs` | **8/8 PASS**（§2） |
| `.runtime/review-ui/verify-ui.mjs` | **0 失败**（§3） |

## 7. 已知偏差与缺口

1. **T1 没有做「接口加 `after_sequence` 增量参数」**：任务单说「如果你认为需要给该接口加增量参数，
   先提出来，不要直接改后端」。本次按建议做法走纯前端轮询，没有改后端，也没有新增增量参数，
   所以 T6 的文档里只写了「该接口没有 `after_sequence`，每次返回完整时间线」。
2. **版本表的大小需要新增一个 exec 内部端点**：任务单只写了「在 `ReviewService` 的列表投影里补」
   列表字段，但非当前版本的大小在 agent 账本里不存在（`review_items` 只保存当前版本）。
   为不把「大小」列做成假的，新增了只读的 `POST /internal/v1/review/artifacts/meta`
   （org 作用域、跨 org 与不存在的 id 跳过、不含字节）。它落在已有的 `/internal/v1/review/*`
   HTU 绑定下，不需要新 scope；facade 镜像因此是缓存命中。
3. **`sandbox-mcp` 镜像没有实际变化**：`exec/` 改了，按 AGENTS.md 两个 target 都 build 了，
   但新增路由不在 `mcp-main` 的 import 图里，facade 层构建缓存命中。
4. **截图没有入库**：`.runtime/` 是 gitignored，截图按仓库既有做法留在本机，可重跑脚本生成。
5. **发起人侧「有修订 / 被驳回」的卡片截图未单独采集**：T1 的截图只覆盖「待审 → 已交付」。
   修订版大小与驳回反馈由 `frontend/test/agent-output-review.test.ts` 的纯函数/归约用例覆盖。
6. **`review-acceptance-2.mjs` 的 2 项失败是环境限制**（容器内没有 docker CLI），不是回退；
   同一批断言在脚本 1 与本次新增的浏览器实测里为 PASS。

## 8. 动过的容器与配置

- `docker compose build agent agent-worker sandbox sandbox-mcp frontend` + `docker compose up -d`
  （agent / agent-worker / sandbox / sandbox-mcp / frontend）；`api-server` 未改，未重建。
- 前端在界面调整后单独重建过两次（`docker compose build frontend && docker compose up -d frontend`）。
- **没有动 K8s `dsh-dev`**（未 scale、未改配置）；没有改 `.env`、`docker-compose.yml` 或 MySQL 数据。
- 验收产生的账号、智能体与审核任务留在开发库里（与上一轮验收一致，未清理）。
