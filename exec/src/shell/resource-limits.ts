/**
 * 执行面的资源限额：环境变量 → 一个被实际消费的配置对象。
 *
 * 为什么有这个文件：2026-09-16 的审查（R1）发现 Compose 与 `.env.example`
 * 声明了 `SANDBOX_MAX_PROCESS_COUNT` / `SANDBOX_MAX_OPEN_FILES` /
 * `SANDBOX_MAX_CPU_TIME_SECONDS` / `SANDBOX_MAX_FILE_SIZE_MB` /
 * `SANDBOX_EXECUTION_TIMEOUT_SECONDS` / `SANDBOX_MAX_OUTPUT_CHARS` 六个变量，
 * 而 `exec/src` 里**一个消费者都没有**——执行器不传 `maxProcessCount`，最终
 * profile 里那一项恒为 0（不限制）。声明了却没接线比没声明更危险：运维以为
 * 限额生效了。这里把「读」收成一处，由 `http/app.ts` 在装配时调用一次，
 * 再显式传给 shell 路由。
 *
 * **严格校验，不静默夹逼**：值非数字、非整数或超出可接受范围一律抛
 * `ResourceLimitConfigError`，让进程起不来，而不是悄悄换成默认值跑起来——
 * 「配置写错了但服务照常启动」正是这类问题最难发现的形态。
 *
 * **内存这一项刻意不自动接线。** `SANDBOX_MAX_MEMORY_MB` 描述的是「这个
 * 执行面能用多少内存」，落到 rlimit 上只有 `RLIMIT_AS`（逐进程的虚拟地址
 * 空间）可用，而地址空间 ≠ 进程树常驻内存：Python/numpy 这类运行时会预留
 * 远大于实际使用量的虚拟地址空间，按 512 MB 收紧会让正常命令直接起不来。
 * 所以：
 * - `SANDBOX_MAX_MEMORY_MB` 视为**容器/部署层的兜底声明**，exec 不把它伪装
 *   成逐任务额度，只在启动日志里说明它没有被下发到 rlimit；
 * - 真的想要逐进程地址空间上限的部署，显式设 `SANDBOX_MAX_ADDRESS_SPACE_MB`，
 *   那时才下发 `ulimit -v`。
 */

import type { ResourceLimitPlan } from '../isolation/profile.js';

export class ResourceLimitConfigError extends Error {
  override readonly name = 'ResourceLimitConfigError';
}

/** 执行面消费的全部限额。0 表示「该项不限制」，只有显式允许的项才能取 0。 */
export interface ShellResourceLimits {
  /** 前台执行预算上限（毫秒）。请求里的 `timeoutMs` 不得超过它。 */
  readonly executionTimeoutMs: number;
  /** 输出保留上限（UTF-16 code unit），对应 `SANDBOX_MAX_OUTPUT_CHARS`。 */
  readonly maxOutputChars: number;
  /** 命名空间内部的 rlimit 计划（含 nproc）。 */
  readonly maxProcessCount: number;
  readonly rlimits: ResourceLimitPlan;
  /**
   * 部署声明的内存兜底（MB），**没有**下发到 rlimit。为 0 表示未声明。
   * 保留它只为让启动日志能说清楚「这条声明的实际归属是容器，不是任务」。
   */
  readonly containerMemoryBackstopMb: number;
}

interface Range {
  readonly min: number;
  readonly max: number;
  /** 允许 0 = 不限制。 */
  readonly allowZero: boolean;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  range: Range,
): number {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ResourceLimitConfigError(`${key} must be an integer, got ${JSON.stringify(text)}`);
  }
  if (parsed === 0 && range.allowZero) return 0;
  if (parsed < range.min || parsed > range.max) {
    throw new ResourceLimitConfigError(
      `${key} must be between ${range.min} and ${range.max}${range.allowZero ? ' (or 0 to disable)' : ''}, got ${parsed}`,
    );
  }
  return parsed;
}

/** MB → KB（`ulimit -f/-v` 用 1024 字节块计）。 */
function mbToKb(mb: number): number {
  return mb * 1024;
}

export const DEFAULT_SHELL_RESOURCE_LIMITS: ShellResourceLimits = {
  executionTimeoutMs: 120_000,
  maxOutputChars: 50_000,
  maxProcessCount: 20,
  rlimits: { maxOpenFiles: 256, cpuSeconds: 300, fileSizeKb: mbToKb(50) },
  containerMemoryBackstopMb: 0,
};

/**
 * 从环境读出执行面限额。范围取自 `.env.example` 里已经写明的可接受区间
 * （例如 NOFILE「生产允许 16–65536」），不是我随手定的边界。
 */
export function readShellResourceLimits(
  env: NodeJS.ProcessEnv = process.env,
): ShellResourceLimits {
  const timeoutSeconds = readInteger(env, 'SANDBOX_EXECUTION_TIMEOUT_SECONDS', 120, {
    min: 1,
    max: 86_400,
    allowZero: false,
  });
  const maxOutputChars = readInteger(env, 'SANDBOX_MAX_OUTPUT_CHARS', 50_000, {
    min: 1_000,
    max: 5_000_000,
    allowZero: false,
  });
  const maxProcessCount = readInteger(env, 'SANDBOX_MAX_PROCESS_COUNT', 20, {
    min: 4,
    max: 4_096,
    allowZero: true,
  });
  const maxOpenFiles = readInteger(env, 'SANDBOX_MAX_OPEN_FILES', 256, {
    min: 16,
    max: 65_536,
    allowZero: true,
  });
  const cpuSeconds = readInteger(env, 'SANDBOX_MAX_CPU_TIME_SECONDS', 300, {
    min: 1,
    max: 86_400,
    allowZero: true,
  });
  const fileSizeMb = readInteger(env, 'SANDBOX_MAX_FILE_SIZE_MB', 50, {
    min: 1,
    max: 1_048_576,
    allowZero: true,
  });
  const addressSpaceMb = readInteger(env, 'SANDBOX_MAX_ADDRESS_SPACE_MB', 0, {
    min: 256,
    max: 1_048_576,
    allowZero: true,
  });
  const containerMemoryBackstopMb = readInteger(env, 'SANDBOX_MAX_MEMORY_MB', 0, {
    min: 64,
    max: 1_048_576,
    allowZero: true,
  });

  const rlimits: ResourceLimitPlan = {
    ...(maxOpenFiles > 0 ? { maxOpenFiles } : {}),
    ...(cpuSeconds > 0 ? { cpuSeconds } : {}),
    ...(fileSizeMb > 0 ? { fileSizeKb: mbToKb(fileSizeMb) } : {}),
    ...(addressSpaceMb > 0 ? { addressSpaceKb: mbToKb(addressSpaceMb) } : {}),
  };

  return {
    executionTimeoutMs: timeoutSeconds * 1000,
    maxOutputChars,
    maxProcessCount,
    rlimits,
    containerMemoryBackstopMb,
  };
}

/**
 * 启动时该打出来的诊断：声明了却**没有**落到逐任务 rlimit 的配置。
 * 返回空数组表示没有需要说明的偏差。调用方负责写到 stderr，不在这里 I/O。
 */
export function unenforcedLimitDiagnostics(limits: ShellResourceLimits): readonly string[] {
  const notes: string[] = [];
  if (limits.containerMemoryBackstopMb > 0 && limits.rlimits.addressSpaceKb === undefined) {
    notes.push(
      `SANDBOX_MAX_MEMORY_MB=${limits.containerMemoryBackstopMb} is a container-level backstop only; ` +
        'exec does not translate it into a per-task rlimit (address space != resident set). ' +
        'Set SANDBOX_MAX_ADDRESS_SPACE_MB to enforce ulimit -v per process.',
    );
  }
  if (limits.maxProcessCount === 0) {
    notes.push('SANDBOX_MAX_PROCESS_COUNT=0 disables the in-namespace RLIMIT_NPROC ceiling');
  }
  return notes;
}
