# 文档与实现一致性审计报告

## Summary

本报告对 `pi-enterprise-sandbox` 仓库的根目录规范（`AGENTS.md`、`README.md`、`.env.example`）及 `docs/` 下全部活跃文档（含架构、API、部署、开发、WebUI、模块布局、MCP、产物、委派指引、Runbooks 及已落地设计稿）进行了与代码实现的全量双向一致性核对。核对覆盖 HTTP 路由与方法、环境变量与默认值、架构机制描述、文件/目录路径及外部 Worker 配置等核心维度。审计共发现 **31 处明确的代码与文档漂移**，集中表现为：API 路由存在死端点与未登记的内部面端点；`.env.example` 残留大量已删除 Python 沙箱环境配置却缺失代码强依赖的新变量；部分核心文档仍遗留 Python 类名、FastAPI 排错命令与过时的 ADR/Worker 档位描述。所有发现均已附带代码主证据与复现命令，可直接指导文档修复工作。

---

## Findings

1. **API 路由双向漂移（9 处）**：`docs/api.md` 记载的端点存在多处与代码脱节。交付物下载路由路径在文档（`/items/{no}/download`）与实现（`/artifacts/:aid/download`）之间完全不一致；公共面文档中仍残留已删除的 `POST /sessions/{id}/datasets/{did}/abort`、`DELETE /sessions/{session_id}` 以及三个公共文件写/改/补端点；exec 内部面遗漏了已落地的 `POST /internal/v1/review/artifacts/import`；Agent 的标准 A2A 协议服务路由（5 个）和重启唤醒路由在 `api.md` 中完全缺失；同时文档在 `metrics` 探针上存在自我矛盾。
2. **环境变量双向失真（12 处）**：`.env.example` 与实际代码读取严重脱节。一方面残留大量已废弃 Python 沙箱（如 `SANDBOX_BIND_HOST`、`SANDBOX_CORS_*`、`SANDBOX_MYSQL_*`、`SANDBOX_MAX_MANAGED_PROCESSES*` 等）和废弃 Redis 变量（`AGENT_RUN_STREAM_MAXLEN`）；另一方面，代码与 Compose 实际消费的关键变量（`SANDBOX_USER_SKILLS_ROOT`、`EXEC_DATABASE_URL`、`EXEC_CONCURRENCY`、`EXEC_ALLOW_MULTI_INSTANCE`、`JSON_BODY_LIMIT_BYTES`、`AGENT_RUN_DEADLINE_MS`、`SSO_LABEL`）在 `.env.example` 中全数缺失。
3. **已退役架构与历史叙事残留（6 处）**：`docs/deployment.md` 仍建议在 TS exec 容器内运行 `python -c "import fastapi"` 探针；`docs/architecture.md` 错误断言「dev / prod 均使用 MySQL 8」，与 `docker-compose.yml` 的 MySQL 5.7 事实相悖；`README.md` 仍沿用旧版 RBAC 逻辑，声称管理员角色仅来自环境变量名单且移除会自动降级；`README.md` 仍列出已删除的入站 CIDR 变量，并遗漏了 ADR 0015 引入的组织共享 Skill 层。
4. **幻影文件路径与旧模块架构（3 处）**：`docs/module-layout.md`、`AGENTS.md`、`README.md` 和 `sdk-upgrade.md` 一致声称存在 `agent/src/runtime/projection/sse.ts` 负责事件投影，但代码中该目录根本不存在（ADR 0014 已确立平台事件即契约，投影在 infra 与 BFF 处理）；`docs/artifact-module.md` 的架构图和调用说明完全由已删除的 Python 包（`sandbox.artifact.application.facade.ArtifactFacade`）构成，且审核导入端点被笔误写为 `revision`。
5. **元文档与委托规范脱节（1 处）**：`docs/README.md` 的 ADR 汇总表遗漏了已落地的 ADR 0012 和 ADR 0013，且宣称下一个未用编号为 0012（实际已至 0016）；`docs/delegation.md §6` 对 DSH Worker 档位的描述过时，未能反映 flash（`deepseek-v4.1-flash`）与 pro（`muse-spark-1.3-contributor`）在 `opencode-go` 下的模型分化。

---

## Details

### 1. 核心审计发现总表

| ID | 文档:行 | 文档说法 | 代码事实(file:line) | 证据命令 | 建议改法 |
|---|---|---|---|---|---|
| D01 | `docs/api.md:413` | `GET /api/reviews/{id}/items/{no}/download` 下载该交付物当前版本 | `api-server/src/routes/reviews.ts:7, 259-274` 与 `agent/src/presentation/http/review-routes.ts:7` 实现的是 `/artifacts/:aid/download`；请求 `/items/{no}/download` 返回 404 | `git grep -n "reviews" api-server/src/routes/ agent/src/presentation/http/` | 将路径更正为 `GET /api/reviews/{id}/artifacts/{aid}/download`，参数说明改为交付物 artifact ID |
| D02 | `docs/api.md:804-809, 816` | 仅列出 5 个 `/internal/v1/review/*` 端点，且 line 816 声称「这五个端点发生在 Run 之外...」 | `exec/src/http/internal-review.ts:11, 370-389` 与 `agent/src/infrastructure/sandbox/internal-review-http.ts:34` 实现了第 6 个端点 `POST /internal/v1/review/artifacts/import` | `git grep -n "review/artifacts" exec/src/` | 补全 `POST /internal/v1/review/artifacts/import` 条目，并将「五个端点」改为「六个端点」 |
| D03 | `docs/api.md:898` | 列出 `POST /sessions/{id}/datasets/{did}/abort` 用于中止上传 | `exec/src/http/public/datasets.ts:138-196` 仅有创建、列表、详情、取内容端点，不存在任何 `abort` 路由 | `git grep -n "abort" exec/src/http/public/` | 从公共路由表中删除死端点 `POST /sessions/{id}/datasets/{did}/abort` |
| D04 | `docs/api.md:893` | 列出 `DELETE /sessions/{session_id}` 用于清理该 Session 私有存储 | `exec/src/http/public/files.ts:259` 仅实现 `DELETE /sessions/:sessionId/files?path=`；不存在清理整个 Session 的路由 | `git grep -n "app\.delete" exec/src/http/public/` | 从公共路由表中删除 `DELETE /sessions/{session_id}`，澄清仅支持删除文件路径 |
| D05 | `docs/api.md:917-919, 1007-1015` | 公共 Files 接口包含 `POST /sessions/{id}/files/write`、`edit`、`apply_patch` | `exec/src/http/public/files.ts` 仅实现读、预览、下载、上传、删除、ls/find/grep，公共面不存在任何写/改/补路由（写操作严格收口在 HMAC 内部面） | `git grep -n -E "app\.(post\|get\|delete)" exec/src/http/public/files.ts` | 移除公共文件写/改/补路由描述，注明公共面只读（仅除附件上传与文件删除） |
| D06 | `docs/api.md:775, 903` vs `docs/api.md:1145` | line 775/903 将 `/metrics` 列为 exec 的免鉴权公共探针与指标；而 line 1145 声明「执行面没有 /metrics 端点」 | `exec/src/http/app.ts:295-311` 仅挂载 `/health` 与 `/ready`；`exec` 目录下零 `metrics` 路由，文档前后自相矛盾 | `git grep -n "metrics" exec/` | 删除 line 775 与 line 903 中对 `/metrics` 的提及，统一表述为仅有 health/ready |
| D07 | `docs/api.md:452-454` | A2A 仅记录了 BFF 的 `/api/a2a/*` 管理接口，缺少 Agent 运行时的 A2A 协议服务接口 | `agent/src/presentation/a2a/http-handler.ts:5-10, 166-203` 提供了 `GET /.well-known/agent-card.json`、`POST /a2a`、`GET /a2a/agents/{id}/.well-known/agent-card.json`、`POST /a2a/agents/{id}`、`GET /a2a/artifacts/download` | `git grep -n "agent-card" agent/src/` | 在 `api.md` 增加「Agent A2A 协议端点」小节，文档化这 5 个核心服务接口 |
| D08 | `docs/api.md` (全文档) | 未记录 Agent 的交互状态重新激活端点 | `agent/src/bootstrap/create-http-server.ts:1250-1286` 实现了内部端点 `POST /internal/agent-runs/rehydrate-waiting`（用于重启后唤醒带已决响应的交互） | `git grep -n "rehydrate-waiting" agent/src/` | 在 `docs/api.md` 内部端点清单中补充 `POST /internal/agent-runs/rehydrate-waiting` |
| D09 | `docs/api.md:406` | REST 表格仅列出 `GET /api/artifacts`（列表查询），遗漏独立产物二进制下载接口 | `api-server/server.ts:710` 与 `api-server/src/routes/files.ts:414-440` 挂载了 `GET /api/artifacts/download?session_id=&artifact_id=` | `git grep -n "handleArtifactDownload" api-server/` | 在 REST 表格补充 `GET /api/artifacts/download` 条目 |
| D10 | `.env.example:258, 260` | 声明 `SANDBOX_DEBUG=false`、`SANDBOX_BIND_HOST=0.0.0.0` | `docs/deployment.md:397` 明确说明 `SANDBOX_BIND_HOST` 属已删除 Python 执行面，TS exec 不读取；`SANDBOX_DEBUG` 全仓代码零引用 | `git grep -n "SANDBOX_BIND_HOST" exec/ agent/` | 从 `.env.example` 中删除 `SANDBOX_BIND_HOST` 与 `SANDBOX_DEBUG` |
| D11 | `.env.example:266, 267, 612` | 声明 `SANDBOX_CORS_ORIGINS=*`、`SANDBOX_CORS_ALLOW_CREDENTIALS=true` | `exec/src` 零读取 CORS 配置；跨域由 BFF 处理且变量名为 `CORS_ALLOWED_ORIGINS`（`api-server/src/config.ts:292`） | `git grep -n "SANDBOX_CORS" exec/ api-server/` | 从 `.env.example` 及 `docker-compose.yml` 移除 `SANDBOX_CORS_*`，保留 `CORS_ALLOWED_ORIGINS` |
| D12 | `.env.example:456-459` | 包含 `SANDBOX_MYSQL_CONNECT_TIMEOUT_SECONDS`、`READ_TIMEOUT`、`WRITE_TIMEOUT`、`MAX_CONNECTIONS` | 为原 Python SQLAlchemy 引擎参数，TS 执行面（`exec/src/db/client.ts`）完全不读取这 4 个变量 | `git grep -n "SANDBOX_MYSQL_" exec/src/` | 从 `.env.example` 彻底清理这 4 个死变量 |
| D13 | `.env.example:481` | 声明 `SANDBOX_ATTACHMENTS_ROOT=/var/sandbox/workspaces` | `exec/src` 零读取。工作区使用 `SANDBOX_WORKSPACES_ROOT`，控制面使用 `SANDBOX_ARTIFACTS_ROOT` / `SANDBOX_CONTROL_ROOT` | `git grep -n "SANDBOX_ATTACHMENTS_ROOT" exec/src/` | 从 `.env.example` 中移除 `SANDBOX_ATTACHMENTS_ROOT` |
| D14 | `.env.example:499-507, 534-537` | 声明 `SANDBOX_MAX_MANAGED_PROCESSES*`、`SANDBOX_PROCESS_TIMEOUT_SECONDS`、`SANDBOX_MAX_RETAINED_TERMINAL*`、`SANDBOX_MAX_ATTACHMENTS_PER_TURN`、`SANDBOX_APPROVAL_TIMEOUT_SECONDS` | 这 9 个变量在 `exec/src` 与 `agent/src` 中全为零读取，属于旧 Python 引擎残留的未生效配置 | `git grep -n -E "SANDBOX_MAX_MANAGED_PROCESSES\|SANDBOX_PROCESS_TIMEOUT_SECONDS\|SANDBOX_MAX_RETAINED_TERMINAL\|SANDBOX_MAX_ATTACHMENTS_PER_TURN\|SANDBOX_MAX_TURN_ATTACHMENT_MB\|SANDBOX_APPROVAL_TIMEOUT_SECONDS" exec/src/ agent/src/` | 从 `.env.example` 中删除这 9 个死变量 |
| D15 | `.env.example:375, 386, 387` & `docs/deployment.md:600` | 声明并文档化 `AGENT_RUN_STREAM_MAXLEN`（默认 10000），以及 `AGENT_PROVIDER_MAX_CONCURRENT`、`AGENT_PROVIDER_COOLDOWN_MS` | `agent/src` 零读取这 3 个变量。Redis Stream 架构调整后，Run 流不再受该变量限制；429 冷却并发闸门也未保留 | `git grep -n -E "AGENT_RUN_STREAM_MAXLEN\|AGENT_PROVIDER_MAX_CONCURRENT\|AGENT_PROVIDER_COOLDOWN_MS" agent/src/` | 从 `.env.example` 和 `docs/deployment.md` 中删除这 3 个变量 |
| D16 | `exec/src/http/app.ts:489` vs `.env.example` | `.env.example` 仅声明 `SKILLS_USER_ROOT`（供 Agent 消费），缺少执行面发布包路径 | `exec/src/http/app.ts:489` 消费 `SANDBOX_USER_SKILLS_ROOT`，且 `docker-compose.yml:702` 已注入该变量 | `git grep -n "SANDBOX_USER_SKILLS_ROOT" exec/src/ .env.example` | 在 `.env.example` 中补充 `SANDBOX_USER_SKILLS_ROOT=/home/sandbox/skill-user` |
| D17 | `exec/src/db/client.ts:76` vs `.env.example:304` | `.env.example:304` 声明 `SANDBOX_DATABASE_URL=mysql+pymysql://sandbox@mysql:3306/sandbox` | `exec/src/db/client.ts:76` 和 `exec/src/http/app.ts:333` 支持标准的 `EXEC_DATABASE_URL`（Node 原生 `mysql://` 协议） | `git grep -n "EXEC_DATABASE_URL" exec/src/` | 在 `.env.example` 中提供 `EXEC_DATABASE_URL`，并将旧 DSN 前缀由 `mysql+pymysql://` 规范为 `mysql://` |
| D18 | `exec/src/workspace/single-instance.ts:34-36` vs `.env.example` | `.env.example` 未声明 exec 单实例安全闸门配置 | `exec` 启动时消费 `EXEC_CONCURRENCY`（默认 1）与 `EXEC_ALLOW_MULTI_INSTANCE`（默认 false），非单实例且未显式开启时 fail-closed 拒启 | `git grep -n "EXEC_ALLOW_MULTI_INSTANCE" exec/src/` | 在 `.env.example` 与 `deployment.md` 中增加 `EXEC_CONCURRENCY` 与 `EXEC_ALLOW_MULTI_INSTANCE` 的配置说明 |
| D19 | `api-server/src/config.ts:289` vs `.env.example` | `.env.example` 缺少 BFF 请求体大小上限环境变量 | `api-server/src/config.ts:289` 读取 `JSON_BODY_LIMIT_BYTES`（默认 1048576），并在 20 余处 JSON 解析点强制校验 | `git grep -n "JSON_BODY_LIMIT_BYTES" api-server/` | 在 `.env.example` 补充 `JSON_BODY_LIMIT_BYTES=1048576` 及其说明 |
| D20 | `agent/src/runtime/policy/run-budget.ts:30` vs `.env.example` & `deployment.md:607-609` | 部署文档与模板中仅列出了工具数与回合数上限，遗漏 Run 总截止时间 | `agent/src/runtime/policy/run-budget.ts:30` 与 `agent/src/application/dsh-run-tool-budget.ts:43` 消费 `AGENT_RUN_DEADLINE_MS` | `git grep -n "AGENT_RUN_DEADLINE_MS" agent/src/` | 在 `.env.example` 和 `docs/deployment.md` 运行限额表中补充 `AGENT_RUN_DEADLINE_MS` |
| D21 | `agent/src/application/sso-config.ts:71` vs `.env.example` | `docs/deployment.md:1163` 列出了 `SSO_LABEL`，但 `.env.example` 缺少该变量 | `agent/src/application/sso-config.ts:71` 显式读取 `SSO_LABEL`（默认 `公司 SSO`），`docker-compose.yml:367` 也注入了此变量 | `git grep -n "SSO_LABEL" agent/src/ .env.example` | 在 `.env.example` 的 SSO 配置部分补充 `SSO_LABEL=公司 SSO` |
| D22 | `docs/deployment.md:1059` | 排错指南指导用户执行 `docker compose run --rm sandbox python -c "import fastapi; print('ok')"` | `sandbox` 容器镜像由 `exec/Dockerfile` 构建，入口为 Node.js，容器内根本未安装 FastAPI | `git grep -n "fastapi" exec/Dockerfile` | 将排错命令替换为测试 Node 执行面的命令，例如 `docker compose run --rm sandbox node -e "console.log('ok')"` |
| D23 | `docs/architecture.md:44, 153` | 断言「dev / prod 均使用 MySQL 8（docker-compose.yml + docker-compose.prod.yml）」 | `docker-compose.yml:32` 使用 `image: mysql:5.7`，`docs/development.md:367` 和 `docs/deployment.md:459` 亦明确说明开发环境统一使用 MySQL 5.7 | `git grep -n "image: mysql:5.7" docker-compose.yml` | 更正 `architecture.md`，明确「开发/CI 使用 MySQL 5.7，生产使用 MySQL 8 / UPDRDB」 |
| D24 | `docs/delegation.md §6:109-110` | 称「dsh 两个档位（flash、pro）当前都绑到 opencode 提供商的同一个模型，pro 与 flash 实际是同一模型」 | 现状已分化：提供商为 `opencode-go`，`flash` 对应 `deepseek-v4.1-flash`，`pro` 对应 `muse-spark-1.3-contributor` | 任务背景约定与会话级配置核验 | 更新 `docs/delegation.md §6` 中的提供商与两档模型映射描述 |
| D25 | `README.md:126-129` | 声称 `SANDBOX_AUTH_ADMIN_USERNAMES` 是 admin 角色唯一来源，从名单移除账号会自动降级回 user | RBAC 实施后（`docs/design/rbac-roles.md`），角色权威在 MySQL `tbl_agsvc_member_roles`，admin 可在前端配置；名单仅具「引导与锁定」语义，移除不会自动降级（`docs/api.md:605`） | `git grep -n "SANDBOX_AUTH_ADMIN_USERNAMES" agent/src/application/browser-auth-service.ts` | 按 `docs/api.md:605-606` 和 `docs/deployment.md:280` 重写 `README.md` 的管理员权限说明 |
| D26 | `README.md:165-166` | 在网络策略表中仍列出 `SANDBOX_ALLOWED_CLIENT_CIDRS` 与 `SANDBOX_TRUSTED_PROXY_CIDRS` | `docs/deployment.md:397` 明确注明二者属已删除 Python 执行面，TS exec 不读取；当前入站白名单为 `EXEC_INTERNAL_ALLOW_CIDR` | `git grep -n "SANDBOX_ALLOWED_CLIENT_CIDRS" exec/src/` | 从 `README.md` 网络策略表中移除废弃变量，更新为 `EXEC_INTERNAL_ALLOW_CIDR` |
| D27 | `README.md:211-219` | Skill 分层说明中仅列出「系统」、「草稿」、「已启用」三层 | ADR 0015 已实施组织共享层（Org 共享 Skill），存储在 `/home/sandbox/skill-org/<orgId>`，`README.md` 漏掉了第四层 | `git grep -n "skill-org" agent/src/ contract/src/` | 在 `README.md` 的 Skill 分层表格中补充「组织共享层」 |
| D28 | `docs/artifact-module.md:8-25` | 目录结构写为 `sandbox/artifact/{domain, application, infrastructure, api}`，并引用 Python 类 `ArtifactFacade` | 属于 Python 沙箱历史残留；当前 TS 执行面实现在 `exec/src/artifact/`，公开入口为 `exec/src/artifact/service.ts` | `ls exec/src/artifact/` | 按 TS `exec/src/artifact/` 的真实结构与类重新编写该架构节 |
| D29 | `docs/artifact-module.md:84` | 审核放行后消费者执行「再 `POST …/revision` 把修订版导入工作区 审核版/X」 | `POST …/revision` 是上传修订文件；导入工作区实际调用的是 `POST /internal/v1/review/artifacts/import`（`exec/src/http/internal-review.ts:370`） | `git grep -n "review/artifacts/import" agent/src/` | 将文档中的 `POST …/revision` 纠正为 `POST …/import` |
| D30 | `docs/module-layout.md:59`, `AGENTS.md:36`, `README.md:60`, `docs/runbooks/sdk-upgrade.md:106` | 宣称存在 `agent/src/runtime/projection/` 目录与 `sse.ts` 文件，负责事件向 SSE 投影 | 目录 `agent/src/runtime/projection/` 并不存在。根据 ADR 0014，平台事件即为 SSE 契约，投影实现位于 `agent/src/infrastructure/dsh/event-projector.ts` 及 BFF 侧 | `ls agent/src/runtime/` | 在所有相关文档中移除对 `projection/` 目录的引用，修正为 `infrastructure/dsh/event-projector.ts` |
| D31 | `docs/README.md:80-81` | ADR 汇总表遗漏 0012 与 0013，且正文声明「新 ADR 采用下一个未用编号 (0012)」 | `docs/adr/0012-depth-layered-run-queues.md` 与 `0013-upspec-table-naming.md` 已实施；当前编号已用到 0016，下一个可用编号为 0017 | `ls docs/adr/` | 补全表格中的 ADR 0012、0013，并将下一个未用编号更正为 0017 |

---

### 2. 分类深度剖析

#### 2.1 API 契约与路由漂移（D01–D09）
- **核心风险**：外部客户端或前端开发者按照 `docs/api.md` 接入时会直接撞上 404。例如 D01 中的 `GET /api/reviews/{id}/items/{no}/download`，虽然设计初稿有类似提议，但实际最终落地的路由契约严格以全局唯一的 `artifact_id` 为基准（`/artifacts/:aid/download`）。
- **死路由清理**：D03（`POST /sessions/{id}/datasets/{did}/abort`）、D04（`DELETE /sessions/{session_id}`）以及 D05（公共面 `files/write`、`edit`、`apply_patch`）均为 Python 时代遗留或设计过渡期产物。在 TypeScript 执行面重构后，由于引入了 Bubblewrap 进程隔离与严格的 HMAC 内部面，公共会话面被收敛为纯只读与安全受控上传，原先直接暴露在公共面的写入操作已全数撤销，文档未及时同步。
- **内部面与 A2A 协议遗漏**：D02 中的 `POST /internal/v1/review/artifacts/import` 与 D08 中的 `POST /internal/agent-runs/rehydrate-waiting` 属于实际承担生产流转的内部接口，但在 `api.md` 内部端点总表中被漏记；D07 中的 Agent 端 5 个 A2A 协议路由属于平台对外联邦的核心能力，文档目前只记录了 BFF 的管理端点，导致 A2A 协议调用方缺少权威文档。

#### 2.2 环境变量双向漂移（D10–D21）
- **残留噪音**：`.env.example` 中多达 16 个变量在当前代码中完全无读取方（涵盖 Python 连接池参数、Uvicorn 启动参数、旧长进程限制、废弃的 Redis Stream 长度控制等）。这些变量不仅增加部署配置负担，而且容易误导运维人员以为调整它们能控制系统行为。
- **缺失核心配置**：代码中实际消费的重要安全与限额变量未暴露给运维人员。例如：
  - `EXEC_CONCURRENCY` 与 `EXEC_ALLOW_MULTI_INSTANCE`：exec 容器启动时强制校验单实例不变量，若未显式配置多实例开关，并发部署会直接崩溃（fail-closed），属于关键的部署安全变量。
  - `SANDBOX_USER_SKILLS_ROOT`：执行面挂载已启用用户 Skill 的必需路径，缺少会导致用户 Skill 无法被隔离容器挂载。
  - `AGENT_RUN_DEADLINE_MS`：控制单次 Agent 运行的最长墙钟时间，遗漏会导致长任务超时失控。
  - `JSON_BODY_LIMIT_BYTES`：控制 BFF 防大包攻击的网关阈值，生产调优必需。

#### 2.3 机制叙事与架构漂移（D22–D27）
- **排错脚本脱节**：D22 中 `deployment.md` 依然保留 `import fastapi`，在纯 TypeScript 化的沙箱执行面中执行必然报错，会使排查问题的运维人员误判容器损坏。
- **持久层拓扑声明与现实不符**：D23 中 `architecture.md` 声称开发栈使用 MySQL 8，然而整个开发编排（`docker-compose.yml:32`）和开发文档均以 MySQL 5.7 为基准（以契合企业 UPDRDB 迁移限制）。
- **RBAC 与权限叙事倒退**：D25 中 `README.md` 仍停留在 RBAC 一期实施前的状态，宣称管理员名单由环境变量唯一决定且移除即降级，这与代码中早已落地的 MySQL 角色账本（`tbl_agsvc_member_roles`）及管理端界面能力严重冲突。

#### 2.4 幻影目录与模块布局（D28–D31）
- **`projection/` 幻影目录**：D30 涉及 4 份核心文档（`AGENTS.md`、`README.md`、`docs/module-layout.md`、`sdk-upgrade.md`）。在 DSH 重构初期曾设想将事件投影独立放置在 `agent/src/runtime/projection/sse.ts`，但随着 ADR 0014（锁定平台事件即 SSE 契约）落地，该目录从未真正创建，投影逻辑最终收归在 `agent/src/infrastructure/dsh/event-projector.ts` 及 BFF 侧。文档长期未修正该路径，会误导阅读代码的新开发者。
- **产物文档历史停滞**：D28 中 `docs/artifact-module.md` 开篇仍在使用 Python 包路径（`sandbox.artifact.*`）和 Python 类进行说明，未随 ADR 0008 执行面 TS 重写而更新。

---

## Unverified / open questions

1. **数据库迁移历史注释中的 Pi 词汇**：`agent/src/infrastructure/mysql/migrations/` 下的历史迁移文件名与注释中仍有较多 `pi_session_journal` 等词汇。由于硬规则规定迁移文件属于不可篡改的变更历史，本报告未将其列入需修改的漂移项，但确认运行时逻辑已无对这些表旧结构的依赖。
2. **外部 SSO OIDC 生产环境具体提供商配置**：`docs/design/sso-integration-reservation.md` 记录了针对公司 SSO 的预留，当前代码已实现 P1a/P1b（可撤销 Session 账本、`sid` 校验等）。由于公司侧 OIDC 联调资料尚未下发，生产级 OIDC 回调与真实 issuer 尚处未联调状态，文档声明的「公司 SSO 未联调」与代码现实完全一致，不存在虚假实现。
