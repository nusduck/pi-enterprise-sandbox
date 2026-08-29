/**
 * exec 侧仓储总入口——W3-D 交付的 DB 层唯一出口。
 *
 * 设计取舍（`_shared.md #7`）：
 * - `JobStore`/`QuotaStore` 的窄接口定义仍在 `shell/job-types.ts` 与
 *   `workspace/quota-store.ts`（W2 已落盘），本目录只**收口**它们，不另起
 *   平行接口；重复定义是本次重建要消灭的头号毛病。
 * - `exec_workspaces/exec_executions/exec_artifacts/exec_datasets/
 *   session_events` 是 exec 自有表，迁移权威在 `agent/`（`dsh-rebuild.md §6`），
 *   本包只提供仓储类与 DDL 常量，不自写迁移。
 */

export { createExecDbPool, readExecDbConfig, closeExecDbPool, ExecDbConfigError } from './client.js';
export type { ExecDbConfig } from './client.js';
export * from './repositories/index.js';
