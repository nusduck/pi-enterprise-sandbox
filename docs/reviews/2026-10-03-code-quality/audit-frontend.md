# frontend/（src 与 test）代码质量深度盘点报告

## Summary

本报告对 `frontend/`（`src/` 与 `test/`）进行全面静态分析与调用图追踪，覆盖 564 个模块与 694 项单元测试。总体结论：前端在历经 DSH 运行时重建、线性对话流重设计与 UI 打磨后，整体核心状态流转健壮，但历史演进遗留了明显的债务层。核心发现包括：**3 个超长核心文件**（`ChatContext.tsx` 1366 行、`entityBridge.ts` 1047 行、`runReducer.ts` 1122 行）紧贴或超过行数棘轮，需按职责垂直拆分；存在多套未完全对齐的别名与兼容路径（`reducePlatformEventBatch`、`MeResponseSchema`、`ConversationDetailSchema`，以及违背 ADR 0014 的 loose event 合成）；API 请求层存在 24 处重复的 `String(err.error || err.detail || …)` 错误抛出样板；运行状态到视觉色调的映射割裂散落，`StatusBadge` 未全站统一，且伴随大量未 Token 化的硬编码色号。经严格核实，**确认可直接删除/清理的代码约 234 行**，建议通过 4 个独立小步 PR 安全推进。

---

## Findings

| ID | 类别(1–6) | 位置(file:line) | 现状 | 证据(命令→结果) | 建议(删除/合并/改写/需确认/不动) | 风险 | 预计行数变化 |
|---|---|---|---|---|---|---|---|
| F01 | 5 过度集中 / 热点超标 | `features/chat/ChatContext.tsx:1-1366` (1366行，棘轮钉死 1369行) | 单文件聚合了 Controller 类型、附件上传队列、对话生命周期、消息突变、审批代理与会话恢复等多重职责，难以阅读和维护。 | `wc -l frontend/src/features/chat/ChatContext.tsx` → 1366行；`tests/test_repository_layout.py:81` 预算上限 1369行，仅剩 3 行余量。 | 改写（按职责拆分为 4 个子 Hook 与类型定义文件，详见 Details），对外接口 `useChat` / `ChatProvider` 保持不变。注意避开测试正则。 | 中：涉及聊天上下文接线，需完整回归 Workbench 与测试覆盖。 | 主文件 -575行（拆出到新模块，总行数微降） |
| F02 | 5 过度集中 / 热点超标 | `features/chat/entityBridge.ts:1-1047` (1047行，棘轮钉死 1175行) | 核心 Bridge 混合了纯实体转换（Trace/Dataset/Process）、Durable Trace 分页拉取、审批状态回填以及会话级历史回放。 | `wc -l frontend/src/features/chat/entityBridge.ts` → 1047行；`tests/test_repository_layout.py:83` 钉在 1175行。 | 改写（按职责拆出实体投影 `entityProjections.ts`、Trace 加载器与历史回放器，详见 Details），对外接口全量 re-export。 | 低：主要为纯函数与无状态拉取逻辑的解耦，对外调用无感。 | 主文件 -550行（拆出到新模块） |
| F03 | 5 过度集中 / 热点超标 | `shared/state/runReducer.ts:1-1122` (1122行，棘轮钉死 1309行) | Reducer 主程序虽然已拆出 `messageEvents.ts`，但仍内联包含大量 Tool 执行生命周期分支、审批决议分支、产物分支以及历史 Rehydrate 逻辑。 | `wc -l frontend/src/shared/state/runReducer.ts` → 1122行；`tests/test_repository_layout.py:86` 钉在 1309行。 | 改写（拆出 `toolEvents.ts`、`artifactEvents.ts` 与 `runRehydration.ts`，详见 Details），保留主状态机分发。 | 中：状态归约核心，需全部 694 项单元测试（尤其是 platform-reducer 用例）全绿守护。 | 主文件 -560行（拆出到新模块） |
| F04 | 2 兼容残留 | `shared/state/runReducer.ts:860-866, 904` (`reducePlatformEvent`, `reducePlatformEventBatch`) | `reducePlatformEventBatch` 恒等指向 `reduceRuntimeEventBatch`；`reducePlatformEvent` 仅套壳转发 `reduceRuntimeEvent`。在生产代码中零调用，仅残留在历史测试用例中。 | `git grep -n "reducePlatformEventBatch"` 生产 0 处，测试 24 处；`git grep -n "reducePlatformEvent\b"` 生产 0 处，测试 23 处；生产代码统一调用 `reduceRuntimeEventBatch`（`:1047`）。 | 合并/改写：测试用例统一改调 `reduceRuntimeEventBatch` / `reduceRuntimeEvent`，废弃并删除这两个别名。 | 低：别名消除，运行时无任何行为变更。 | -20行 |
| F05 | 2 兼容残留 / 别名冗余 | `shared/schemas/api.ts:27, 89` (`MeResponseSchema`, `ConversationDetailSchema`) | `MeResponseSchema = AuthUserSchema`，`ConversationDetailSchema = ConversationSchema`，两者均无任何附加字段，属于无意义的一对一别名。 | `git grep -n "MeResponseSchema"` 仅在 `shared/api/auth.ts:87` 被使用 1 次；`git grep -n "ConversationDetailSchema"` 仅在 `shared/api/client.ts:94` 被使用 1 次。 | 合并：在 `auth.ts` 中直接使用 `AuthUserSchema`，在 `client.ts` 中直接使用 `ConversationSchema`，删除别名定义。 | 极低：TypeScript 类型推导与 Zod 校验结果恒等。 | -4行 |
| F06 | 3 重复实现 / 样板冗余 | `shared/api/client.ts:75,92,107,128,144,177,207,224` 以及整个 `shared/api/` (共 24 处) | 每次请求失败后均手动解构 `String(err.error || err.detail || ...)`；且抛错类型不一致（部分抛原生 `Error`，部分抛包含状态码的 `ApiError`）。 | `git grep -n "err\.error\|err\.detail" frontend/src/shared/api/` 输出 24 处：`client.ts` 8 处、`runs.ts` 10 处、`processes.ts` 5 处、`datasets.ts` 1 处。 | 合并：在 `shared/api/client.ts` 中提取 `toApiError(resp, err, fallback)` 工具函数，统一错误消息解析并标准化抛出 `ApiError`。 | 低：错误消息提取规则保持完全一致，调用方获益于一致的 `ApiError` 属性。 | -40行 |
| F07 | 3 重复实现 / 1 死代码 | `widgets/runtime-timeline/buildTimeline.ts:132-153` (`runStatusTone`) | UI 打磨引入了全局 `StatusBadge`（包含 `'running'|'waiting'|'success'|'failed'|'neutral'`），但旧状态映射函数 `runStatusTone` 残留在代码库中，生产零调用。 | `git grep -n "runStatusTone" frontend/` → 仅在 `buildTimeline.ts:132` 定义，且仅在 `test/workbench-timeline.test.ts:51-57` 中断言，生产代码零命中。 | 删除：移除 `runStatusTone` 导出，清理对应测试。状态徽标展示统一走 `StatusBadge`。 | 极低：纯死代码清理。 | -22行 |
| F08 | 3 重复实现 / 样式割裂 | `widgets/turn-stream/TurnCards.tsx:51-64`, `runtime-timeline/cards/ProcessCard.tsx:4-11`, `pages/runs/RunDetailPage.tsx:26-33` | 运行状态渲染未收敛：`TurnCards` 自定义了局部 `Pill`（5 种 Tone）；`ProcessCard` 自建了 `statusDot` 样式名映射；`RunDetailPage` 的 `NODE_STATUS` 保留了未被消费的第二项样式类名。 | 源码查阅：`RunDetailPage.tsx:237` 只读 `NODE_STATUS[status][0]` 作为标签；`ProcessCard.tsx:47` 使用 `rtc-dot-*`；`TurnCards.tsx` 使用 `s.pill`。 | 改写：精简 `NODE_STATUS` 废弃样式元组；为组件层提供与 `StatusBadge` 对齐的语义化状态映射层。 | 低：视觉样式与标签文案保持一致。 | -15行 |
| F09 | 1 死代码（仅测试引用） | `entities/store.ts:259, 441` (`upsertConversation`, `getRunMessages`) 及 `shared/state/chatState.ts:133, 144` (`errorStream`, `clearEphemeral`) | `entities/store.ts` 与 `chatState.ts` 中导出的部分更新/查询函数在生产代码中零调用，只被测试文件引用。所有真实更新早已收敛至 `runReducer`。 | 全局搜索：`upsertConversation` 仅在 `entities.test.ts` 与 `workbench-timeline.test.ts` 出现；`getRunMessages` 仅在 `entities.test.ts` 出现；`errorStream`/`clearEphemeral` 仅在 `stream-transitions.test.ts` 出现。 | 需确认：若确系历史遗留 API，清理生产导出并移入测试夹具；若作为公用 store 工具，补齐注释并注明为测试构造器。 | 低：生产路径无调用。 | -45行 |
| F10 | 2 兼容残留（违背 ADR 0014） | `shared/sse/manager.ts:322-340` (loose event 合成 `synth_${runId}_${seq}`) 与 `:298-308` | `coerceEvent` 保留了松散事件的合成兜底，生成 `synth_*` 假 ID；同时前置检查与 `platformEventNormalize.ts:203` 存在无法命中的重复解包。ADR 0014 明确要求“前端只认平台事件：无法规范化的帧直接丢弃，不合成 ID”。 | 查阅 `docs/adr/0014-sse-contract-is-the-platform-events.md:31`；对比 `manager.ts:331` 生成 `synth_${runId}_${seq}` 的逻辑与 `platformEventNormalize.ts:203-211`。 | 改写/删除：剔除 loose event 猜测与伪 ID 合成分支，无法通过 `normalizeToRuntimeEvent` 解析的帧直接丢弃，严格对齐 ADR 0014。 | 低：线上与开发环境所有服务均已产出标准平台事件。 | -30行 |
| F11 | 1 死代码 / 遗留样式 | `shared/styles/app.css:733-757, 1245-1250, 132-156, 159` | 包含已删除的 `TraceTree` 样式（`.status-pill-*`）、已迁移至 CSS Modules 的 `AgentPicker` 全局样式（`.agent-picker*`），以及旧 `Sidebar` 类与背景遮罩。 | Python 扫描所有 `.tsx`/`.ts` 文件：`.agent-picker*`、`.status-pill-ok/error/running/cancelled`、`.sidebar.collapsed` 均零命中；`AgentPicker` 现在使用 `agentPicker.module.css`，`Sidebar` 使用 `sidebar.module.css`。 | 删除：删除 `app.css` 中的失效规则。 | 极低：纯 CSS 规则清理，元素已有局部 CSS Module 样式兜底。 | -65行 |
| F12 | 3 未使用设计变量 / 硬编码颜色 | `ChatContext.tsx:236`, `useRunControls.ts:178-349`, `chatState.ts:17`, 及多个 `*.module.css` | 在状态更新方法与组件样式中大量直接传递十六进制颜色（如 `'#22c55e'`, `'#64748b'`, `'#f59e0b'`, `'#3b82f6'`, `#fff`），导致暗黑/明亮主题切换时无法自适应。 | Python 扫描输出 34 处十六进制硬编码；如 `ChatContext.tsx:236` 默认入参 `color = '#22c55e'`，`useRunControls.ts:178` 调用 `setStatus('Stopping…', '#f59e0b')`。 | 改写：将 `statusColor` 属性重构为语义枚举 `'success'|'warning'|'danger'|'info'|'muted'`，UI 层映射为 `var(--color-*)`；CSS 中 `#fff` 替换为 `var(--color-text-inverse)` 或 `var(--color-bg)`。 | 低：提升主题一致性与可维护性。 | 净减约 0行（重构） |
| F13 | 4 命名/注释漂移 & 6 测试残留 | `test/trace-panel.test.ts` (全文件) | 文件名依然保留已删除组件 `TracePanel` 的名字，但测试内容实际上已全量转为验证 `entityBridge.ts` 的 `rehydrateTraceSpans`。 | `docs/design/frontend-redesign.md:76` 说明 `TracePanel` 已被删除；`git grep -n "TracePanel" frontend/src` 零命中；测试文件内无任何 UI 渲染断言。 | 改写：重命名为 `test/trace-rehydration.test.ts` 并更新头部说明。 | 极低：纯测试文件重命名与注释纠偏。 | 0行 |
| F14 | 6 测试脆弱性（源码字符串断言） | `test/approval-decision.test.ts:165-172`, `test/agent-output-review.test.ts:671-677` | 单元测试通过 `fs.readFileSync` 将 `ChatContext.tsx` 当作纯文本读取，并用正则硬编码断言其内部方法名与参数签名。 | `frontend/test/approval-decision.test.ts:167` 读取 `ChatContext.tsx` 并断言 `/resolveApprovalDecision/`；`frontend/test/agent-output-review.test.ts:672` 正则断言 `/useReviewResultPolling\(/`。 | 需确认：在拆分 `ChatContext.tsx` 时，必须原样保留对应的代理调用名；后续 PR 应将此类测试迁移为对导出行为的真实断言。 | 中：重构 `ChatContext` 时极易误伤该测试。 | 0行 |

---

## Details

### 1. 三大超长文件拆分具体实施方案

按照 `tests/test_repository_layout.py` 的棘轮限制，每个生产文件上限为 1000 行。目前三个文件均因历史功能叠加而膨胀，拆分方案遵循：**职责单一、单向依赖、对外导出接口完全不变**。

#### (1) `frontend/src/features/chat/ChatContext.tsx`（当前 1366 行 → 目标约 790 行）
- **问题**：聚合了认证状态同步、附件上传处理、消息历史更新、对话 CRUD、审批代理及大量 UI 抽屉开关。
- **拆分方案**：
  1. `frontend/src/features/chat/chatContextTypes.ts` (~95 行)：
     - 迁移 `AuthConfigState`、`ChatController`、`ChatContextValue` 等 TypeScript 核心类型。
     - `ChatContext.tsx` 重新 `export type * from './chatContextTypes'`。
  2. `frontend/src/features/chat/uploads/useAttachmentDrafts.ts` (~185 行)：
     - 迁移 `runUploadForDraft`、`handleFilesSelected`、`removeAttachmentDraft`、`retryAttachmentDraft`。
     - 维护 `dropzoneVisible` 状态。
     - 入参：`{ state, setState, currentSessionId, flashError }`。
  3. `frontend/src/features/chat/useConversationActions.ts` (~230 行)：
     - 迁移 `selectConversation`、`startNewChat`、`removeConversation`、`importArtifactToConversation`、`ensureConversationSession`、`refreshArtifacts`。
     - 入参：`{ state, setState, entityStore, bridge, currentSessionId, setStatus, flashError, clearFlash }`。
  4. `frontend/src/features/chat/useUserMessageMutations.ts` (~60 行)：
     - 迁移 `appendUserMessage`、`removeUserMessage`、`patchUserMessage`。
     - 入参：`{ state, setState }`。
  5. `ChatContext.tsx` 宿主保留 (~790 行)：
     - 保留 `ChatProvider` 组合装配、`useAuthSession`、`useRunControls`、`useModelSelection`、`useReviewResultPolling`。
     - **特别注意测试守卫**：`frontend/test/approval-decision.test.ts` 和 `frontend/test/agent-output-review.test.ts` 包含对 `ChatContext.tsx` 文件内容的正则表达式断言。必须确保 `useReviewResultPolling(bridge, entityStore, state.conversationId)` 以及包含 `resolveApprovalDecision`、`decideApproval`、`markApproval` 的代理函数字面量直接留在 `ChatContext.tsx` 中，确保现有测试不被破坏。

#### (2) `frontend/src/features/chat/entityBridge.ts`（当前 1047 行 → 目标约 490 行）
- **问题**：既包含纯粹的后端数据行到领域实体的投影映射（Trace、Dataset、Process），又包含复杂的 SSE 管理、审批回水与长耗时的会话历史重放。
- **拆分方案**：
  1. `frontend/src/features/chat/entityProjections.ts` (~235 行)：
     - 迁移纯投影转换函数：`datasetRowToEntity`、`processRowToEntity`、`rehydrateTraceSpans`、`backfillArtifactSessionIds`、`traceAttributes`、`sameRunRevision`、`finiteNumber`。
     - 常量：`TRACE_SPAN_KINDS`、`PROCESS_STATUSES`、`MAX_TRACE_PAGES`。
     - `entityBridge.ts` 重新导出以兼容 `entities.test.ts` 和 `trace-panel.test.ts` 的既有引用。
  2. `frontend/src/features/chat/bridge/conversationRehydration.ts` (~240 行)：
     - 迁移 `rehydrateInProgress` 与 `rehydrateConversation` 及其会话事件按 Run 分组重放的逻辑。
  3. `frontend/src/features/chat/bridge/traceLoader.ts` (~80 行)：
     - 迁移 Durable Trace 分页加载逻辑：`fetchDurableTrace`、`loadDurableTrace`。
  4. `entityBridge.ts` 宿主保留 (~490 行)：
     - 专注 `createEntityBridge` 状态机闭包、传输层生命周期控制（`attachTransport`/`abortRun`/`stopRun`/`interruptRun`/`failRun`）与审批决议标记（`markApproval`/`pollReviewDecisions`）。

#### (3) `frontend/src/shared/state/runReducer.ts`（当前 1122 行 → 目标约 560 行）
- **问题**：在已拆出 `messageEvents.ts` 后，Tool 生命周期、Approval 决议以及快照 Rehydrate 仍堆叠在巨大的 switch-case 中。
- **拆分方案**：
  1. `frontend/src/shared/state/runRehydration.ts` (~215 行)：
     - 迁移 `rehydrateRun`、`ledgerToolStatus`、`rehydrateToolExecutions`。
     - 在 `runReducer.ts` 中保持 re-export。
  2. `frontend/src/shared/state/toolEvents.ts` (~265 行)：
     - 参考 `messageEvents.ts` 模式，抽取 `reduceToolEvent(store, event, payload, opts)`，接管：
       - `tool.prepared`、`tool.started`、`tool.progress`
       - `tool.approval_required`、`approval.resolved`
       - `tool.completed`、`tool.failed`
  3. `frontend/src/shared/state/artifactEvents.ts` (~80 行)：
     - 抽取 `reduceArtifactEvent(store, event, payload, opts)`，接管：
       - `artifact.released`、`review.rejected`、`artifact.created`
  4. `runReducer.ts` 宿主保留 (~560 行)：
     - 保留基础帮助函数（`ensureRun`, `touchRun`, `advanceCursor`）、Run 顶层生命周期事件（`run.created`, `run.started`, `run.status_changed`, `run.completed`, `run.failed`, `run.cancelled`）、模型请求与错误事件分发，以及批处理入口 `reduceRuntimeEventBatch`。

---

### 2. API 层统一错误处理重构设计

全仓扫描 `frontend/src/shared/api/*.ts` 发现多达 24 处重复的错误解析样板：
```typescript
// 现状：重复散落于 client.ts, runs.ts, processes.ts, datasets.ts
if (!resp.ok) {
  const err = await errorBody(resp);
  throw new Error(String(err.error || `List conversations failed: ${resp.status}`));
  // 或者：
  // throw new ApiError(String(err.error || err.detail || `...: ${resp.status}`), { status: resp.status, ... });
}
```
**建议方案**：
在 `frontend/src/shared/api/client.ts` 规范化导出错误工厂：
```typescript
export function createApiError(resp: Response, body: Record<string, unknown>, fallback: string): ApiError {
  const message = String(body.error || body.detail || `${fallback}: ${resp.status}`);
  return new ApiError(message, {
    status: resp.status,
    code: typeof body.code === 'string' ? body.code : null,
    traceId: (body.trace_id as string) || resp.headers.get('x-trace-id'),
    detail: body,
  });
}
```
将所有 API 方法统一收敛为：
```typescript
if (!resp.ok) {
  throw createApiError(resp, await errorBody(resp), 'List conversations failed');
}
```
消除 24 处手写拼接，并确保调用方始终获得具有完整 `status`、`traceId` 和 `code` 属性的 `ApiError` 实例。

---

### 3. 运行状态与视觉设计 Token 统一

现状存在 4 套彼此独立的色彩与状态词汇：
1. `StatusBadge`: `'running' | 'waiting' | 'success' | 'failed' | 'neutral'`（规范实现，支持中英文映射）
2. `buildTimeline.ts`: `runStatusTone`（输出 `'idle' | 'active' | 'warning' | 'danger' | 'success'`，仅供测试，死代码）
3. `TurnCards.tsx`: `Pill`（输出 `'ok' | 'err' | 'run' | 'warn' | 'mute'`）
4. `ProcessCard.tsx`: `statusDot`（输出 `rtc-dot-active`, `rtc-dot-ok`, `rtc-dot-danger`, `rtc-dot-muted`）
5. `chatState.ts` / `ChatContext.tsx`: 穿透传递 `#22c55e`、`#64748b` 等 HEX 字符串

**统一路径**：
1. 立即删除未使用的 `buildTimeline.ts:runStatusTone`。
2. 将 `ChatState.statusColor` 字段改造为语义 Tone：`type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'muted'`。
3. 对齐 CSS Modules 中的颜色消费：严禁在样式中使用 `#fff`、`#22c55e` 等硬编码值，必须使用 `tokens.css` 声明的 CSS 变量：
   - 背景与反转：`var(--color-bg)`、`var(--color-text-inverse)`
   - 语义色彩：`var(--color-success)`、`var(--color-warning)`、`var(--color-danger)`、`var(--color-primary)`

---

## 建议的 PR 切分

按改动性质与风险等级，分为 4 个可独立验证的小步 PR：

### PR-1: 纯死代码与失效 CSS 清理（无行为变更，风险极低）
- **涉及文件**：
  - `frontend/src/shared/styles/app.css`（删除 `.agent-picker*`、`.status-pill-*`、`.sidebar.collapsed` 等失效规则，-65 行）
  - `frontend/src/widgets/runtime-timeline/buildTimeline.ts`（删除死函数 `runStatusTone`，-22 行）
  - `frontend/test/workbench-timeline.test.ts`（移除对应单测断言）
  - `frontend/src/pages/runs/RunDetailPage.tsx`（清理 `NODE_STATUS` 冗余样式元组，-8 行）
- **验证方式**：
  - `npm test --prefix frontend`
  - `npm run build --prefix frontend`

### PR-2: 契约与规范收敛（对齐 ADR 0014 与消除别名，风险低）
- **涉及文件**：
  - `frontend/src/shared/schemas/api.ts`（删除 `MeResponseSchema`、`ConversationDetailSchema`，-4 行）
  - `frontend/src/shared/api/auth.ts` 与 `frontend/src/shared/api/client.ts`（替换别名引用）
  - `frontend/src/shared/sse/manager.ts`（删除 loose event 合成逻辑与重复解包，对齐 ADR 0014，-30 行）
  - `frontend/src/shared/state/runReducer.ts`（废弃 `reducePlatformEvent` 与 `reducePlatformEventBatch`，-20 行）
  - `frontend/test/` 各用例（改调规范方法名）
- **验证方式**：
  - `npm test --prefix frontend`
  - 重点运行 `live-run-replay.test.ts` 与 `platform-reducer.test.ts`。

### PR-3: API 错误处理样板收敛与设计 Token 规范化（质量提升，风险低）
- **涉及文件**：
  - `frontend/src/shared/api/client.ts`（抽象 `createApiError` 工具工厂，并在 `client.ts`、`runs.ts`、`processes.ts`、`datasets.ts` 替换 24 处样板，-40 行）
  - `frontend/src/shared/state/chatState.ts` 与 `frontend/src/features/chat/controllers/useRunControls.ts`（将 HEX 色号改造为语义 StatusTone）
  - 相关的 `*.module.css`（将 `#fff` 替换为 `var(--color-*)`）
- **验证方式**：
  - `npm test --prefix frontend`
  - `npx tsc --noEmit -p frontend/tsconfig.json`
  - 手工验证浏览器内弱网或 400/500 时的错误 Toast 展现。

### PR-4: 三大超长文件架构解耦与棘轮合规（架构重构，需精细验证）
- **涉及文件**：
  - `frontend/src/features/chat/ChatContext.tsx`（按方案拆分出 4 个文件，主文件降至 ~790 行）
  - `frontend/src/features/chat/entityBridge.ts`（按方案拆分出 3 个文件，主文件降至 ~490 行）
  - `frontend/src/shared/state/runReducer.ts`（按方案拆分出 3 个文件，主文件降至 ~560 行）
  - `tests/test_repository_layout.py`（收紧或移除这 3 个文件的行数棘轮预算，恢复全仓 1000 行默认上限标准）
- **验证方式**：
  - `uv run pytest -q tests/test_repository_layout.py`
  - `npm test --prefix frontend`
  - `npm run build --prefix frontend`
  - 启动 Docker 容器进行真实链路验收：登录 → 新建会话 → 执行带工具的 Run → 发送附件与审批决议 → 验证历史重放一致性。

---

## Unverified / open questions

1. **`conversationModelPref.ts` 的 LocalStorage 历史键迁移（`dsh.selectedModelId` → `dsh.conversationModelIds`）**：
   - 现状：代码保留了读取旧键并写回新键的自动迁移逻辑（约 10 行）。
   - 疑问：生产环境中是否仍有使用超旧版本（2026-08 前）的用户浏览器缓存尚未完成迁移？
   - 验证方法：咨询产品/运维团队确认存量客户端迁移周期；若已全部过渡完毕，可直接移除。
2. **`ContextInspector.tsx` 与 `DeliverablesPanel.tsx` 的长远去留**：
   - 现状：`docs/design/frontend-redesign.md:76, 108` 曾规划“删除右侧 ContextInspector”，但实际在实现时保留了该抽屉并作为“会话资料”（包含产物、文件、数据集、进程）。同时用户界面又新增了 `DeliverablesPanel` 浮层。
   - 疑问：设计上是否计划最终合并“会话资料抽屉”与“交付物面板”？
   - 验证方法：需与产品/UI 设计师核对最新设计收敛方案。
3. **`entities/store.ts` 纯测试更新函数（`upsertConversation` / `getRunMessages` 等）的外部契约**：
   - 现状：无任何生产调用，但在多个测试中用于快捷组装 Mock Store。
   - 疑问：是否有未合并的在途分支或插件依赖这些 Store 原始增删方法？
   - 验证方法：确认无外部依赖后，可将其迁移至 `test/fixtures/storeHelpers.ts`。
