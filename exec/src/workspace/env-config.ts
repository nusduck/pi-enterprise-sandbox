/**
 * 环境变量 → 本模块各配置对象的组装。
 *
 * exec/src 目前没有共享的全局配置模块（不新建一个是本任务的范围决定，见
 * 任务说明），但"工作区管理、配额与路径"这几件事又确实需要从环境变量取值
 * ——所以把读取逻辑收在这一个文件里，函数式、无副作用（只读 `process.env`
 * 或调用方传入的替身，不写、不缓存单例），方便主入口（`exec/src/main.ts`，
 * 不在本任务范围）自己决定什么时候调用、要不要包一层缓存。
 *
 * **沿用 Python 版 `.env.example` 里已有的 `SANDBOX_*` 变量名**，不是我自己
 * 发明的新前缀——`docker-compose`/运维手册目前认的就是这一套名字（见仓库根
 * `.env.example:347-410`），exec/ 取代 sandbox/ 之后如果换名字，运维侧的
 * `.env` 也要跟着改，那是一次没有必要的破坏性变更。`EXEC_CONCURRENCY` /
 * `EXEC_ALLOW_MULTI_INSTANCE`（`single-instance.ts`）例外——那是 TypeScript
 * 重写才出现的新概念，Python 版没有对应字段，不存在"沿用"的问题。
 */
import type { WorkspaceLifecycleConfig } from './lifecycle.js';
import type { QuotaLedgerConfig } from './quota-ledger.js';
import type { ChildQuotaConfig } from './child-quota.js';

function numberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function stringEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** 对应 `SANDBOX_WORKSPACES_ROOT` / `SANDBOX_TEMP_ROOT`。 */
export function readWorkspaceLifecycleConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceLifecycleConfig {
  return {
    workspacesBaseRoot: stringEnv(env, 'SANDBOX_WORKSPACES_ROOT', '/var/sandbox/workspaces'),
    tempBaseRoot: stringEnv(env, 'SANDBOX_TEMP_ROOT', '/var/sandbox/tmp'),
  };
}

/** 对应 `SANDBOX_WORKSPACE_QUOTA_MB`。 */
export function readQuotaLedgerConfig(env: NodeJS.ProcessEnv = process.env): QuotaLedgerConfig {
  return {
    defaultQuotaMb: numberEnv(env, 'SANDBOX_WORKSPACE_QUOTA_MB', 500),
  };
}

/** 对应 `SANDBOX_TEMP_QUOTA_MB` / `SANDBOX_WORKSPACE_CHILD_QUOTA_*`。 */
export function readChildQuotaConfig(env: NodeJS.ProcessEnv = process.env): ChildQuotaConfig {
  return {
    enforcement: boolEnv(env, 'SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT', true),
    workspaceQuotaMb: numberEnv(env, 'SANDBOX_WORKSPACE_QUOTA_MB', 500),
    tempQuotaMb: numberEnv(env, 'SANDBOX_TEMP_QUOTA_MB', 500),
    maxEntries: numberEnv(env, 'SANDBOX_WORKSPACE_CHILD_QUOTA_MAX_ENTRIES', 100_000),
    sampleIntervalS: numberEnv(env, 'SANDBOX_WORKSPACE_CHILD_QUOTA_SAMPLE_INTERVAL_S', 2.0),
  };
}

export class ProductionQuotaConfigError extends Error {
  override readonly name = 'ProductionQuotaConfigError';
}

/**
 * 生产环境的配额闸门（ADR 0004 第 4 条 / Python 版
 * `validate_production_settings()` 里 workspace 配额相关的两条校验）：
 * 一旦声明了正数配额（多租户磁盘隔离承诺），生产环境必须**同时**：
 *
 * 1. 打开子进程配额监控（`SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT=true`）；
 * 2. 运维显式确认外部硬配额已经挂在 workspace/temp 根上
 *    （`SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED=true`）——这个监控器
 *    本身不是硬配额（见 `child-quota.ts` 顶部注释），生产不能只靠它。
 *
 * 这条校验属于"配额"这个职责范畴，所以留在这里；**是否在生产启动时调用它**
 * 是整体配置校验流程（`exec/src/main.ts` 或专门的 config 模块，都不在本
 * 任务范围）的编排决定，本函数只负责判定逻辑本身，不读 `NODE_ENV`、
 * 不自己决定"什么算生产"。
 */
export function assertProductionQuotaBackend(
  quotaConfig: ChildQuotaConfig,
  hardBackendAsserted: boolean,
): void {
  const positiveQuota = quotaConfig.workspaceQuotaMb > 0 || quotaConfig.tempQuotaMb > 0;
  if (!positiveQuota) return;
  if (!quotaConfig.enforcement) {
    throw new ProductionQuotaConfigError(
      'production requires SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT=true when a positive ' +
        'workspace/temp quota is configured',
    );
  }
  if (!hardBackendAsserted) {
    throw new ProductionQuotaConfigError(
      'production requires SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED=true when a positive ' +
        'workspace/temp quota is configured (monitoring alone is not a hard quota)',
    );
  }
}

/** 对应 `SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED`，单独读取是因为它
 * 只在 `assertProductionQuotaBackend()` 这一处使用，不属于
 * `ChildQuotaConfig` 本身（那是"监控行为"的配置，这是"运维承诺"的配置，
 * 两者语义不同，混进同一个对象会让 `evaluateChildQuota()` 看起来好像依赖了
 * 一个它其实不读的字段）。 */
export function readHardBackendAsserted(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env, 'SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED', false);
}
