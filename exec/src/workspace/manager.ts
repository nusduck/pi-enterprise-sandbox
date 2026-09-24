/**
 * 工作区粘合层——W2-C 的薄组合入口（“缺则补”）。
 *
 * 为什么单独一个文件：设计文档 `dsh-rebuild.md §2` 列出 `exec/src/workspace/manager.ts`，
 * 但实现按职责已拆成 `lifecycle.ts`（工作区生命周期）、`temp-tree.ts`（持久 /tmp）、
 * `quota-ledger.ts` / `quota-store.ts`（控制面账本）、`child-quota.ts`（子进程监控）、
 * `lock.ts` / `single-instance.ts`（锁与单实例断言）。直接让上层（W3-A 的会话编排、
 * W3-D 的仓储层）各自去拼这些碎片会重复“同一件事两处各算一遍”——这正是本次重建要消灭的
 * 头号毛病（`_shared.md §7`）。
 *
 * 本文件**不新增行为**，只做薄组合与重导出，保证：
 * - `physicalRoot` 的唯一事实源仍在 `ids.ts` + `lifecycle.ts` / `temp-tree.ts`（不另写一份拼路径逻辑）；
 * - 脱敏仍经 `fs/redact.ts` 的 `redactPhysicalRoots()` 无条件兜底（硬约束 #1）；
 * - 窄接口 `QuotaStore` / `WorkspaceLock` 的定义仍在各自文件中，本文件只转交，便于 W3-D 按
 *   “窄接口 → mysql2 实现 + 内存实现，不写迁移” 的约定接手。
 *
 * 参考：`sandbox/services/workspace_manager.py`、`workspace_quota_ledger.py`、`child_workspace_quota.py`、
 * `sandbox/paths.py`、`sandbox/isolation/bubblewrap.py:82-101`（XDG 绑定已由 `isolation/build.ts` 落实）。
 */

// 生命周期（稳定工作区 + 配对持久 temp）
export { WorkspaceManager, WorkspaceCleanupError } from './lifecycle.js';
export type { WorkspaceLifecycleConfig, WorkspaceRoots } from './lifecycle.js';
export { physicalTempPath, initTempTree } from './temp-tree.js';

// 标识与路径纯函数（唯一事实源，不另写一份）
export { validateOpaqueId, tempIdForWorkspaceId, joinContained } from './ids.js';
export { InvalidWorkspaceIdError, PathEscapeError } from './ids.js';

// 配额两套：控制面账本（工作区外，防删超卖）+ 子进程有界监控
export { WorkspaceQuotaLedger, QuotaReservation, QuotaExceededError, QuotaLedgerInputError } from './quota-ledger.js';
export type { QuotaLedgerConfig } from './quota-ledger.js';
export { InMemoryQuotaStore, MySqlQuotaStore } from './quota-store.js';
export type { QuotaStore, MySqlPoolLike } from './quota-store.js';
export {
  measureTreeBounded,
  measureChildQuotaUsage,
  evaluateChildQuota,
  ChildQuotaMeasureError,
  isWorkspaceOver,
  isTempOver,
} from './child-quota.js';
export type {
  ChildQuotaConfig,
  ChildQuotaDecision,
  BoundedTreeMeasure,
  QuotaUsage,
  MeasureUsageDeps,
  MeasureUsageOptions,
} from './child-quota.js';
export { workspaceSizeBytes } from './disk-usage.js';

// 锁与单实例预留扩展点（ADR 0008 D5）
export { InProcessWorkspaceLock } from './lock.js';
export type { WorkspaceLock } from './lock.js';
export { assertSingleInstance, readSingleInstanceConfig, SingleInstanceViolationError } from './single-instance.js';
export type { SingleInstanceConfig } from './single-instance.js';

// 环境变量组装（无副作用，调用方决定何时读）
export {
  readWorkspaceLifecycleConfig,
  readQuotaLedgerConfig,
  readChildQuotaConfig,
  readHardBackendAsserted,
  assertProductionQuotaBackend,
  ProductionQuotaConfigError,
} from './env-config.js';
