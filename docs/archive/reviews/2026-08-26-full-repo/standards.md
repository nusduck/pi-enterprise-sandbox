# Standards 轴（规范符合性）

审查基准：`AGENTS.md`（分层边界、§2 安全不变量、§3 千行棘轮）+ Fowler 坏味道基线（判断题）。
范围：agent / api-server / sandbox / frontend 四服务源码抽查，测试略读。只读审查，未改动任何文件。

## 硬违规

### 1. P1 · agent · 出站调用缺超时

- `agent/src/infrastructure/sandbox/sandbox-client.js:152-153` 的 `sbFetch` 默认 `timeoutMs = null`；公开面所有方法均未传超时：
  - 进程类：`getProcessLogs/readProcess/writeProcessStdin/signalProcess/cancelProcess`（:215-266）
  - `removeSessionWorkspace`(:198)、文件/artifact 系列(:270-383)
- 受影响路径：运维 `process-access-service.js:78-128`、会话删除 GC（`conversation-service.js:416`）可被挂起的 sandbox 无限阻塞；`checkHealth`(:410-418) 连 signal 都没有。
- 反证：`/internal/v1/*` HMAC 面（`internal-execution-http.js:19`、`internal-files-read-http.js:461` 等）全部有默认超时——证明此客户端是遗漏而非约定。
- 违反条款：AGENTS.md §2「所有出站调用有超时」。

### 2. P1 · api-server · 文件代理出站 fetch 无超时

- `api-server/src/routes/files.js:275`（handleFileDownload）、`:383`（handleArtifactDownload）、`:540`（handleFileUpload 上游 fetch）：三个文件代理的出站 fetch 均无 AbortSignal/deadline。
- 同仓先例：`sandbox-client.js` sbFetch 有 deadline、`agent-client.js` 用 `AbortSignal.timeout`；config 注释只豁免 SSE 流——文件代理不在豁免之列。
- 影响：挂起的 sandbox 会钉死浏览器请求与 socket。

### 3. P1 · api-server · checkHealth 裸 fetch

- `api-server/src/services/sandbox-client.js:235` 的 `checkHealth()` 无超时；同类 `agent-client.js:935` 有 3s 超时，属遗漏。

### 4. P1 · frontend · 千行约束突破且不受棘轮保护

- AGENTS.md §3「生产文件 ≤1000 行」，但 `ChatContext.tsx`≈1457、`runReducer.ts`≈1494、`InlineRuntimeSteps.tsx`≈1008。
- `tests/test_repository_layout.py` 棘轮只覆盖 agent/sandbox，frontend 完全不在钉内——建议把 frontend src 纳入棘轮并按职责拆分。

> 根因归并：#1/#2/#3 是同一根因的两个面——sandbox 客户端链路（agent 侧 + BFF 侧）整体缺默认 deadline。建议一个 PR 统一修复。

## 坏味道（判断题）

### Duplicated Code

- **agent**：`create-http-server.js` 内 `authSubjectsFromRequest(req)` 判空 + 完全相同的 400 错误体在约 20 个路由重复（:271/313/358/393/432/489/523/624/655/687/732/779/836/870/904/954/980/1220/1284/1353/1400）。最小修法：提取 `requireAuthSubjects(req)` helper。
- **api-server**：`agent-client.js` 约 10 处近同形的 `if (!resp.ok) {...throw}` 错误映射块（createAgentRun、cancelAgentRun、steerAgentRun 等），而 requestAgentConversation/Cron/Process/Approval 已示范共享 helper——应收敛为一个 `requestAgent()`。
- **api-server**：浏览器 X-Acting-* 头剥离清单在 `sandbox-client.js:99-104` 与 `routes/files.js:34-41` 两处手写大小写清单，易漂移。
- **sandbox**：`_fail` 在 `internal_execution_contract.py:74`、`internal_files_write_contract.py:36`、`internal_search_contract.py:93`、`files_read_contract.py:86` 各写一份；claim 绑定循环在 `files_read_contract.py:411-443` 与 `internal_process_contract.py:124` 同形重复——可提取到 `sandbox/app/domain` 共享模块。
- **frontend**：`client.ts` 中 `String(err.error || err.detail || …)` + throw 样板重复约 15 处；run 状态→色调映射散落 `buildTimeline.ts:107`、`TracePanel.tsx:72,93`、`composerMode.ts:45`、`runReducer.ts:1318-1341`。

### Speculative Generality / 死代码

- **agent**：`sandbox-client.js:435-496` 的模块级 wrapper（authRegister/authLogin/authMe/readFile/writeFile/lsFiles/findFiles/grepFiles/listArtifacts 等）在 src 内零调用方；文件头注释自认这些面已从 Sandbox 删除。

### Divergent Change

- **sandbox**：`config.py`（1,491 行）集 Settings 解析+生产校验+密钥嗅探+脱敏于一体，属棘轮认可债务但建议按职责拆分。

### Data Clumps

- **frontend**：`budget-bar/budget.ts:6-27` 自行声明 budget usage/limits 字段，与 `entities/types.ts:83,96` 结伴字段重复，宜收拢到 entities 类型。

### 边界提示（非问题）

- `api-server/routes/runs.js` presentRunDetail 将 FAILED/CANCELLED 等状态映射为 error 文本：属 DTO 投影而非状态判定，可接受，注释宜说明。

## 正面合规证据

- **agent**：内部面 fail-closed + 常量时间比较（`bootstrap/internal-auth.js:50-56`）；JWT 严 schema + timingSafeEqual（`infrastructure/sandbox/internal-hmac.js:888`）；跨租户经 `OwnerScopedNotFoundError` 统一映射 404 非 403（`error-mapper.js:26-29`）；审批账本带 orgId/userId owner-scope 并写 RunEvent+outbox 同事务（`approval-decision-service.js:96-121`）；千行棘轮由 `tests/test_repository_layout.py:32` 钉住，未见超预算。
- **api-server**：X-Acting-* 服务端解析链完整（`authFromRequest` 拒收浏览器头，`files.js:49-51` 缺 trustedAuth 即抛错，fail-closed）；SSE 中继先鉴权后写头、断连只退订不取消 Run；零 pi SDK import；无 Run 状态账本行为；跨租户 404 一致。
- **sandbox**：`isolation/bubblewrap.py:57-66` setpriv 缺失即 `IsolationUnavailable`（fail-closed）；entrypoint.sh root 仅建目录后 setpriv 降权；`config.py:914-947` keyring 空→内部面禁用、半配置即 raise、`:1066-1071` 生产弱 secret 拒绝启动；`security/internal_auth.py` 全部 `hmac.compare_digest`；无 `/agent-runs` 残留；`ownership.py:139` 未授权会话返回 404 非 403。
- **frontend**：零 Agent/pi SDK（package.json 仅 react/zod 等）；零 LLM key；A2a 页仅展示服务端下发的 one-time token（`A2aPage.tsx:266`）；鉴权走 BFF HttpOnly cookie；未透传 X-Acting-*；localStorage 只存 UI 偏好并禁止缓存消息体（`chatState.ts:168-172`）；URL 白名单 fail-closed。

## 残余风险

- 本次为抽查而非逐行全审（~720 个源文件）；MySQL knex 未显式设 connectTimeout（knex 默认值兜底），未列为违规。
- api-server 不在千行棘轮覆盖内，`agent-client.js` 已达 944 行且持续增长。
- `sandbox/mcp/sandbox_client.py:99` 出站超时 310s 有界但偏长。
