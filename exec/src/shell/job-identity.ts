/**
 * 可重新验证的 OS 进程身份——移植自 Python 版
 * `sandbox/services/process_identity.py`。
 *
 * 这是什么、为什么需要：孤儿回收（`job-registry.ts` 的 `recoverOrphans()`）
 * 要在 Worker 重启后，凭 MySQL 里存的 `pid`/`pgid` 去杀一个"可能是它、
 * 也可能已经被 OS 回收并把这个 pid 分配给了别的进程"的目标。裸 pid 不安全
 * ——PID 会被复用。这里的做法是在 spawn 时捕获一个"进程启动时刻"的指纹
 * （Linux 是内核 `starttime` jiffies，其它平台退化成 `ps` 的 `lstart`），
 * 回收时重新读一次同一个 pid 的指纹，只有两次指纹完全一致才认为"还是
 * 同一个进程"，才允许发信号。指纹不一致 / 读不到 → 一律 fail-closed，
 * 绝不盲发信号。
 *
 * 与 Python 版的差异（已在交付报告里列为已知偏差，不是遗漏）：
 * - **macOS 主路径不同**：Python 版在 Darwin 上通过 ctypes 直接调用
 *   `libproc.dylib` 的 `proc_pidinfo(PROC_PIDTBSDINFO)`（不经过子进程）。
 *   Node 没有内建 FFI，加一个原生绑定依赖超出本任务范围（也超出
 *   `exec/package.json` 目前的依赖面），所以这里 macOS/其它非 Linux 平台
 *   统一退化成 Python 版本来就有的"最后手段" `ps` 路径
 *   （`ps -o lstart=,pgid=,ppid= -p <pid>`，三次独立调用，因为 `lstart`
 *   本身含空格，没法和其它列用一次 `ps` 调用的空白分隔安全地拆开——
 *   这是照抄 Python 版 `_ps_field()` 拆开调用的原因）。这让 Darwin 上的
 *   身份捕获多了一次子进程调用的开销和"策略拦截 `ps` 就彻底捕获失败"的
 *   风险，Python 版原文强调"ps 从来不是 macOS 成功路径所必需的"，这条
 *   在移植后的 TS 版**不再成立**——这是一个需要在生产 Linux 部署之外
 *   （比如本地 macOS 开发环境跑长进程孤儿回收）明确知晓的降级。
 * - **PID 命名空间根进程追踪未移植**（Python 版 `find_pid_namespace_init` /
 *   `read_pid_namespace_id`）：那是 bwrap 命名空间嵌套的细节，属于
 *   `exec/src/isolation/` 的职责边界，不在本文件范围内。如果将来需要按
 *   命名空间 init 回收 bwrap 起的整棵进程树，应该在 `JobStartSpec` 里加
 *   `namespacePid`/`namespaceStartIdentity` 可选字段，走与 `pgid` 完全
 *   相同的信号升级路径（先 TERM 命名空间 init，成功且身份仍匹配再 KILL）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROC_STAT_RE = /^\d+\s+\(.*\)\s+[A-Za-z]\s+(.*)$/;

/** Linux：从 `/proc/<pid>/stat` 读内核 starttime 字段（第 22 个字段）。 */
export function readLinuxStarttime(pid: number): string | null {
  if (pid <= 0 || process.platform !== 'linux') return null;
  let raw: string;
  try {
    // 同步读取——身份捕获/校验都发生在孤儿回收这种一次性、非热路径场景，
    // 没有必要为此引入异步文件 I/O 的复杂度。
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const match = PROC_STAT_RE.exec(raw.trim());
  if (!match) return null;
  const rest = (match[1] as string).split(/\s+/);
  // `rest` 从 stat 第 4 个字段（ppid）开始；内核 starttime 是第 22 个字段，
  // 去掉前 3 个字段后下标是 18。
  if (rest.length < 19) return null;
  const starttime = rest[18] as string;
  if (!/^\d+$/.test(starttime)) return null;
  return `linux-starttime:${starttime}`;
}

function runPsField(pid: number, field: string): string | null {
  const candidates: readonly string[][] = [
    ['-p', String(pid), '-o', `${field}=`],
    ['-o', `${field}=`, '-p', String(pid)],
  ];
  for (const args of candidates) {
    let out: string;
    try {
      out = execFileSync('ps', args, {
        encoding: 'utf8',
        timeout: 2_000,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
    } catch {
      continue;
    }
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    return lines[0]!.replace(/\s+/g, ' ');
  }
  return null;
}

/** 最后手段身份捕获：`ps` 的 `lstart`/`pgid`/`ppid`（见文件头关于平台差异的说明）。 */
export function readPsStartIdentity(pid: number): string | null {
  if (pid <= 0) return null;
  const lstart = runPsField(pid, 'lstart') ?? runPsField(pid, 'start');
  if (!lstart) return null;
  const pgid = runPsField(pid, 'pgid') ?? '?';
  const ppid = runPsField(pid, 'ppid') ?? '?';
  return `ps-v1:lstart=${lstart}|pgid=${pgid}|ppid=${ppid}`;
}

export interface CaptureIdentityOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
}

/**
 * 捕获一个可重新验证的启动身份。Linux 优先用内核 starttime（无子进程、
 * 无策略拦截风险）；其它平台退化成 `ps`（见文件头说明）。
 * 短暂重试是为了应对"spawn 刚返回，进程表还没来得及更新"的竞态。
 */
export async function captureStartIdentity(
  pid: number,
  options: CaptureIdentityOptions = {},
): Promise<string | null> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const delayMs = Math.max(0, options.delayMs ?? 20);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  for (let i = 0; i < attempts; i += 1) {
    const linux = readLinuxStarttime(pid);
    if (linux) return linux;
    if (process.platform !== 'linux') {
      const ps = readPsStartIdentity(pid);
      if (ps) return ps;
    }
    if (i + 1 < attempts) {
      await sleep(delayMs);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** pid 是否存活——`kill(pid, 0)` 不发信号，只探测。任何失败（含 EPERM）视为不存活，对齐 Python 版。 */
export function processAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 存活 且 重新捕获的身份与期望值完全一致，才算"还是同一个进程"。 */
export async function identityMatches(
  pid: number | null | undefined,
  expectedStartIdentity: string | null | undefined,
): Promise<boolean> {
  if (pid === null || pid === undefined || !expectedStartIdentity) return false;
  if (!processAlive(pid)) return false;
  const current = await captureStartIdentity(pid, { attempts: 3, delayMs: 10 });
  return current !== null && current === expectedStartIdentity;
}

export interface SafeSignalResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly signaled: boolean;
  readonly via?: 'pgid' | 'pid';
}

/**
 * 只在身份仍然匹配时才发信号；否则 fail-closed，绝不盲发。
 * 有 `pgid` 且当前存活进程组确实等于它（且不是我们自己的进程组，避免
 * 误杀调用方自身）时优先整组发送，否则退回单 pid。
 */
export async function safeSignalIdentity(params: {
  readonly pid: number | null | undefined;
  readonly pgid: number | null | undefined;
  readonly startIdentity: string | null | undefined;
  readonly signal: NodeJS.Signals;
}): Promise<SafeSignalResult> {
  const { pid, pgid, startIdentity, signal } = params;
  if (pid === null || pid === undefined) {
    return { ok: false, reason: 'no_pid', signaled: false };
  }
  if (!startIdentity) {
    return { ok: false, reason: 'no_identity', signaled: false };
  }
  if (!(await identityMatches(pid, startIdentity))) {
    return { ok: false, reason: 'identity_mismatch', signaled: false };
  }

  let targetPgid: number | null = null;
  if (pgid !== null && pgid !== undefined) {
    const livePgid = runPsField(pid, 'pgid');
    const livePgidNum = livePgid !== null ? Number(livePgid) : NaN;
    if (Number.isInteger(livePgidNum) && livePgidNum === pgid && pgid !== process.pid) {
      targetPgid = pgid;
    }
  }

  try {
    if (targetPgid !== null) {
      process.kill(-targetPgid, signal);
      return { ok: true, reason: 'signaled', signaled: true, via: 'pgid' };
    }
    process.kill(pid, signal);
    return { ok: true, reason: 'signaled', signaled: true, via: 'pid' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `signal_failed:${message}`, signaled: false };
  }
}
