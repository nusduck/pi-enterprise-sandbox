/**
 * `/internal/v1/shell/run` 与 `/internal/v1/shell/start` 的请求体契约。
 *
 * 为什么放在 contract/ 而不是 exec/：这是 Agent 与执行面**共用**的那条边界。
 * 2026-09-16 的审查（R4）发现两侧对同一个 payload 的理解并不一致——Agent 发
 * `workdir/stdin/env/stdoutMaxBytes`，exec 的路由只挑 `command`/`timeoutMs`，
 * 其余字段静默丢弃，HTTP 仍然 200。「指定了子目录却在工作区根执行」这种事
 * 不会报错，只会写错文件。字段一旦落在一份两侧都 import 的解析器里，就不存在
 * 「一侧加了字段、另一侧忘了读」的静默分叉。
 *
 * 规则（对应 review 执行方案 PR 2 的契约表）：
 * - **越界或类型非法在执行前拒绝**，不静默退回默认值。非法字段抛
 *   `ENVELOPE_INVALID`，与信封校验同一个错误码，路由映射成 400。
 * - `workdir` 是**沙箱内的逻辑路径**（`/home/sandbox/workspace[/...]` 或
 *   `/tmp[/...]`），不是宿主物理路径。解析结果是 `{ scope, relative }`，
 *   交给 `isolation/build.ts` 的 `relativeCwd`/`cwdScope` 消费。
 * - `stdin` 保留空字符串与非空输入的区别（`''` 表示「有输入、内容为空」，
 *   缺省表示「无输入」）；两者都在 spawn 时一次性写入并关闭 fd 0。
 * - `env` 只接受字符串键值，键必须是合法环境变量名；真正能不能落到子进程
 *   由执行面的 safe-env 过滤决定，这里只做形状校验。
 * - `stdoutMaxBytes` / `timeoutMs` 严格按字节 / 毫秒解释，上限由服务端给，
 *   请求只能要更小的值。
 */

import { ContractError } from './errors.js';

/** 沙箱内的逻辑根。与 `exec/src/isolation/profile.ts` 的同名常量一致。 */
export const SANDBOX_WORKSPACE_PATH = '/home/sandbox/workspace';
export const SANDBOX_TEMP_PATH = '/tmp';

/** cwd 归属的根。`isolation/build.ts` 的 `cwdScope` 用同一组字面量。 */
export type ShellWorkdirScope = 'workspace' | 'temp';

/** 解析后的 workdir：根 + 相对段（`''` 表示根本身）。 */
export interface ShellWorkdir {
  readonly scope: ShellWorkdirScope;
  readonly relative: string;
}

/** 服务端给的硬上限。请求只能要更小的值，要更大一律拒绝。 */
export interface ShellPayloadLimits {
  /** 前台执行预算上限（毫秒）。 */
  readonly maxTimeoutMs: number;
  /** 单次调用返回给模型的输出字节上限。 */
  readonly maxStdoutBytes: number;
  /** stdin 一次性写入的字节上限。 */
  readonly maxStdinBytes: number;
  /** 请求可覆盖的环境变量条数上限。 */
  readonly maxEnvEntries: number;
}

export const DEFAULT_SHELL_PAYLOAD_LIMITS: ShellPayloadLimits = {
  maxTimeoutMs: 120_000,
  maxStdoutBytes: 200_000,
  maxStdinBytes: 1_000_000,
  maxEnvEntries: 64,
};

/** 解析后的 shell 请求体。字段缺省即 `undefined`，不是「默认值已填好」。 */
export interface ShellPayload {
  readonly command: string;
  readonly workdir: ShellWorkdir;
  readonly timeoutMs?: number;
  readonly stdoutMaxBytes?: number;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** `start` 额外带的两个标识——后台作业账本要用。 */
export interface ShellStartPayload extends ShellPayload {
  readonly id?: string;
  readonly runId?: string;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function invalid(message: string): ContractError {
  return new ContractError('ENVELOPE_INVALID', message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('shell payload must be an object');
  }
  return value as Record<string, unknown>;
}

/**
 * 逻辑 workdir → `{ scope, relative }`。
 *
 * 只认两个根下的**规范化**路径：不接受 `..` 段、不接受重复/结尾斜杠之外的
 * 花样、不接受 NUL 与控制字符。越界（例如 `/etc`、`/home/sandbox/skill`）
 * 抛错而不是退回工作区根——「悄悄换个目录执行」比「拒绝执行」危险得多。
 */
export function parseShellWorkdir(raw: unknown): ShellWorkdir {
  if (raw === undefined || raw === null) {
    return { scope: 'workspace', relative: '' };
  }
  if (typeof raw !== 'string') {
    throw invalid('workdir must be a string');
  }
  const value = raw.trim();
  if (value === '' || value === '.') {
    return { scope: 'workspace', relative: '' };
  }
  if (value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid('workdir contains control characters');
  }
  if (!value.startsWith('/')) {
    throw invalid('workdir must be an absolute sandbox path');
  }

  const scope: ShellWorkdirScope | null =
    value === SANDBOX_WORKSPACE_PATH || value.startsWith(`${SANDBOX_WORKSPACE_PATH}/`)
      ? 'workspace'
      : value === SANDBOX_TEMP_PATH || value.startsWith(`${SANDBOX_TEMP_PATH}/`)
        ? 'temp'
        : null;
  if (scope === null) {
    throw invalid('workdir must stay under /home/sandbox/workspace or /tmp');
  }

  const root = scope === 'temp' ? SANDBOX_TEMP_PATH : SANDBOX_WORKSPACE_PATH;
  // 只剥**一个**前导/尾随斜杠：`//sub` 与 `sub//` 是未规范化的路径，
  // 剥成 `sub` 等于替调用方猜意图。留着空段让下面的循环拒绝它们。
  let rest = value.slice(root.length);
  if (rest.startsWith('/')) rest = rest.slice(1);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  if (rest === '') return { scope, relative: '' };
  const segments = rest.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalid('workdir must be a normalized path without empty or relative segments');
    }
  }
  return { scope, relative: segments.join('/') };
}

function parseBoundedInteger(
  raw: unknown,
  field: string,
  max: number,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw invalid(`${field} must be a finite integer`);
  }
  if (raw < 1) throw invalid(`${field} must be >= 1`);
  if (raw > max) throw invalid(`${field} must be <= ${max}`);
  return raw;
}

function parseStdin(raw: unknown, maxBytes: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw invalid('stdin must be a string');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw invalid(`stdin must be <= ${maxBytes} bytes`);
  }
  return raw;
}

function parseEnv(raw: unknown, maxEntries: number): Readonly<Record<string, string>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asRecord(raw);
  const keys = Object.keys(obj);
  if (keys.length > maxEntries) {
    throw invalid(`env must have at most ${maxEntries} entries`);
  }
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (!ENV_NAME_RE.test(key)) throw invalid(`env key is not a valid variable name: ${key}`);
    const value = obj[key];
    if (typeof value !== 'string') throw invalid(`env value must be a string: ${key}`);
    if (value.includes('\0')) throw invalid(`env value contains NUL: ${key}`);
    out[key] = value;
  }
  return out;
}

function parseCommand(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('command must be a string');
  return raw;
}

/** 前台 `run` 请求体。 */
export function parseShellRunPayload(
  raw: unknown,
  limits: ShellPayloadLimits = DEFAULT_SHELL_PAYLOAD_LIMITS,
): ShellPayload {
  const p = asRecord(raw);
  const timeoutMs = parseBoundedInteger(p['timeoutMs'], 'timeoutMs', limits.maxTimeoutMs);
  const stdoutMaxBytes = parseBoundedInteger(
    p['stdoutMaxBytes'],
    'stdoutMaxBytes',
    limits.maxStdoutBytes,
  );
  const stdin = parseStdin(p['stdin'], limits.maxStdinBytes);
  const env = parseEnv(p['env'], limits.maxEnvEntries);
  return {
    command: parseCommand(p['command']),
    workdir: parseShellWorkdir(p['workdir']),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(stdoutMaxBytes !== undefined ? { stdoutMaxBytes } : {}),
    ...(stdin !== undefined ? { stdin } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

function parseOptionalId(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !JOB_ID_RE.test(raw)) {
    throw invalid(`${field} must match ${JOB_ID_RE.source}`);
  }
  return raw;
}

/**
 * 后台 `start` 请求体。**不接受 `timeoutMs`**——后台作业按异步进程契约运行，
 * 生命周期由作业账本与 kill 管，不套前台预算。带了这个字段说明调用方把两条
 * 路径搞混了，直接拒绝比静默忽略更容易发现。
 */
export function parseShellStartPayload(
  raw: unknown,
  limits: ShellPayloadLimits = DEFAULT_SHELL_PAYLOAD_LIMITS,
): ShellStartPayload {
  const p = asRecord(raw);
  if (p['timeoutMs'] !== undefined && p['timeoutMs'] !== null) {
    throw invalid('timeoutMs is not accepted by shell/start (background jobs have no foreground budget)');
  }
  const base = parseShellRunPayload({ ...p, timeoutMs: undefined }, limits);
  const id = parseOptionalId(p['id'], 'id');
  const runId = parseOptionalId(p['runId'], 'runId');
  return {
    ...base,
    ...(id !== undefined ? { id } : {}),
    ...(runId !== undefined ? { runId } : {}),
  };
}
