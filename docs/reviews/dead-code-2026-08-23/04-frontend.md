# 死代码考古 · frontend/src（React+TS, ~21K 行）

> 每项均经全局 grep 引用验证（覆盖 src/ 与 test/）。

## A. 死代码（完全未被生产代码引用）

| # | 位置 | 简摘 | 动作 |
|---|------|------|------|
| A1 | shared/state/chatState.ts:41-55 | `subscribe`/`notify` 订阅机制：无任何调用方，订阅者数组恒为空，update() 每次构建 ChangeMap 的 diff 循环是纯开销 | 删 subscribe+notify+ChangeMap/Subscriber 类型及 diff 循环 |
| A2 | shared/api/client.ts:298-303 | `getDownloadUrl`：已被 getArtifactDownloadUrl 取代，仅 ArtifactPanel.tsx:4 注释提及 | 直接删 + 清理注释 |
| A3 | shared/ui/Icons.tsx:551-569,633-651 | `IconSearch` / `IconEye` 零消费 | 删两个组件（约 40 行 SVG） |
| A4 | widgets/runtime-timeline/buildTimeline.ts:331-341 | `listPendingApprovalsForConversation`：调用方全用 listPendingApprovals | 直接删 |
| A5 | widgets/composer/Composer.tsx:597 | 尾部 re-export 无消费者 | 删该行 |

**A6. 仅剩测试引用的生产导出**
- agentEventAdapter.ts:554-565 `adaptAgentEventStream`（测试专用）
- runReducer.ts:1218-1224 `reducePlatformEvent`（"Plan §19.3 public name" 别名，生产走 reduceRuntimeEvent）
- runReducer.ts:1262 `reducePlatformEventBatch` 纯别名
- entities/store.ts:485-494 `getRunMessages` [待确认是否预留]
- schemas/api.ts:137-142 `SSEEventSchema` → 删

A 类合计约 **150–200 行**。

## B. Legacy 兼容层

**B1.【重点】seq=0 "最后机会"合成通路 —— 生产链路不可达**
- platformEventNormalize.ts:316-338
- 可达性证据：
  1. 历史回放走 parseApiStrict(PersistedAgentEventSchema)，强制 sequence 正整数
  2. SSE 直连路径 manager.ts:249 起有自己的 loose-event 兜底（用 lastSequence+1 而非 0），甚至专门写了 seq===0 补偿块（manager.ts:257-267）——第二层兜底修补第一层的坏输出
  3. entityBridge 传入已解析 RuntimeEvent
- 唯一触达者是手工构造裸对象的测试
- 动作：删分支或收紧条件；同步删 manager.ts:257-267 补偿块。[待确认]仓库外旧部署是否发无序列号事件

**B2. coerceEvent 内重复 loose-event 兜底**（manager.ts:296-338 三层历史叠加）→ 合并为单一兜底

**B3. 有意保留的安全兜底（勿删）**
- runs.ts:28-49 terminal 状态别名容忍（误判会导致 SSE 永不重连）
- capabilities/approvals/datasets soft-fail 降级空态
- chatState.ts:262-330 normalizeServerMessages camel/snake 双读（真实双数据源）
- runs.ts:118-141 normalizeToolSnapshotRow arguments_json/args 别名（单坏行不炸面板）

B1+B2 合计可删 ~60 行双层兜底与补偿逻辑。

## C. 冗余兜底 / 重复实现

| # | 位置 | 说明 |
|---|------|------|
| C1 | client.ts:47、runs.ts:58、processes.ts:32、datasets.ts:23 | `errorBody()` 四处完全相同复制 → 收敛到 client.ts |
| C2 | ContextInspector.tsx:120 vs runHelpers.ts:210 | `shortId()` 等价重复 → 复用 runHelpers 版本 |
| C3 | client.ts:27-28 | readSSEStream/isAllowedApiUrl/safeApiUrl re-export 无人经此导入 → 删 |
| C4 | schemas/api.ts:143-161 | convenience re-export 块无人消费 → 整块删 |

C 类约 **60–80 行**。

## D. 过渡残留

| # | 位置 | 说明 | 动作 |
|---|------|------|------|
| D1 | vite.trace-gate.config.ts | 整文件孤儿配置：全仓零引用，tsconfig include 不含它 | 直接删文件 |
| D2 | tsconfig.json:20 | exclude:["src/legacy"] 目录不存在 | 删该项 |
| D3 | tsconfig paths "@/*" + vite alias '@' | 双处定义零使用（项目统一相对导入） | 两处同步删 |

## E. 未使用资产

- E1 public/brand 4 张无引用图片：uprc-icon-app.jpg、uprc-icon-imagine.jpg、uprc-icon-primary.jpg、uprc-icon.svg（实际只用 uprc-icon.png 与 uprc-icon-app-180.jpg）
- E2 tokens.css 约 15 个死 CSS 变量（×2 主题）：--glow-card/--glow-focus/--color-cyan-soft/--color-cyan-border/--color-accent-soft/--color-accent-border/--duration-slow/--font-size-display/--tracking-label/--color-tree-line-active/-success/-error/--color-success-text/--blur-heavy（均经 var() 全局反查验证）[待确认是否作为调色板库存保留]
- E3 package.json 依赖全部在用，无可删
- E4 附带发现：shared/api/index.ts 桶导出漏掉 ./cron-jobs（SchedulesPage 只能深路径导入）；isStreamTerminalRunStatus 建议降为模块私有

E 类合计：4 个静态资源 + ~30 个死 CSS 变量定义 + 3 处死配置。
