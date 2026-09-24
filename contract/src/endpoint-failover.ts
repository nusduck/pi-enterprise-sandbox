/**
 * 多端点建连的纯策略：UPDRDB 双 Proxy 与 DBPM 双节点共用。
 *
 * 为什么放 contract/：Agent Knex、Agent DSH 裸池、exec 裸池三处都要同一套
 * 「粘住主用、失败拉黑、不回切」规则，各写一份迟早分叉。但这里**只放无驱动
 * 依赖的策略**——mysql2/Knex 的接线、错误码细分留在各自基础设施模块，契约包
 * 不引入数据库驱动（design `updrdb-dbpm-deployment.md` §4.2，ADR 0011 D5）。
 *
 * 边界（调用方必须遵守）：
 * - 只在**建连阶段**切换端点。业务 SQL 一旦发出不重试——连接中途断掉的写可能
 *   已在服务端提交，换端点重放等于重复执行。
 * - 一次 acquire 最多把每个端点试一遍；全部拉黑时只放行一轮探测，不做清表循环。
 * - 认证失败、配置错误、会话初始化失败不是网络故障：立即抛出、不拉黑、不换端点，
 *   否则一个口令错误会被伪装成「两个 Proxy 都不通」。
 * - 错误里只出现角色与端点代号（`#1`/`#2`），不出现原始配置串。
 */

export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

export class EndpointConfigError extends Error {
  override name = 'EndpointConfigError';
}

/** 默认拉黑时长：180s（ADR 0011 D5）。 */
export const DEFAULT_ENDPOINT_BLACKLIST_MS = 180_000;

/**
 * 解析 `host:port,host:port`。IPv6 须写成 `[::1]:3306`。
 *
 * 错误信息**不回显原串**：运维可能误把 `user:pass@host` 填进来。
 */
export function parseEndpointList(
  raw: string | undefined,
  opts: { readonly name: string; readonly count: number },
): Endpoint[] {
  const text = String(raw ?? '').trim();
  if (text === '') {
    throw new EndpointConfigError(`${opts.name} is required (${opts.count} host:port entries)`);
  }
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length !== opts.count) {
    throw new EndpointConfigError(
      `${opts.name} must list exactly ${opts.count} host:port entries, got ${parts.length}`,
    );
  }
  return parts.map((part, index) => {
    const parsed = parseHostPort(part);
    if (parsed === null) {
      throw new EndpointConfigError(`${opts.name} entry #${index + 1} is not a valid host:port`);
    }
    return parsed;
  });
}

function parseHostPort(part: string): Endpoint | null {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+)):([0-9]{1,5})$/.exec(part);
  if (match === null) return null;
  const host = match[1] ?? match[2] ?? '';
  const port = Number.parseInt(match[3] ?? '', 10);
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export interface EndpointPlan {
  /** 本次 acquire 依次尝试的端点下标。 */
  readonly order: readonly number[];
  /** 全部拉黑时为 true：这是唯一一轮探测，不是清表后的无限重试。 */
  readonly probe: boolean;
}

/**
 * 粘住主用、失败拉黑、不主动回切。
 *
 * 主用只在「另一个端点建连成功」时改变；拉黑过期不会让旧主用抢回位置，
 * 否则一个时好时坏的 Proxy 会让连接在两边来回漂。
 */
export class EndpointSelector {
  readonly #endpoints: readonly Endpoint[];
  readonly #blacklistMs: number;
  readonly #now: () => number;
  readonly #blockedUntil: number[];
  #primary = 0;

  constructor(
    endpoints: readonly Endpoint[],
    opts: { readonly blacklistMs?: number; readonly now?: () => number } = {},
  ) {
    if (endpoints.length === 0) {
      throw new EndpointConfigError('EndpointSelector needs at least one endpoint');
    }
    this.#endpoints = Object.freeze(endpoints.map((e) => Object.freeze({ host: e.host, port: e.port })));
    this.#blacklistMs = opts.blacklistMs ?? DEFAULT_ENDPOINT_BLACKLIST_MS;
    this.#now = opts.now ?? Date.now;
    this.#blockedUntil = endpoints.map(() => 0);
  }

  get size(): number {
    return this.#endpoints.length;
  }

  get primaryIndex(): number {
    return this.#primary;
  }

  endpoint(index: number): Endpoint {
    const endpoint = this.#endpoints[index];
    if (endpoint === undefined) throw new RangeError(`endpoint index ${index} out of range`);
    return endpoint;
  }

  label(index: number): string {
    return `#${index + 1}`;
  }

  isBlacklisted(index: number): boolean {
    return (this.#blockedUntil[index] ?? 0) > this.#now();
  }

  plan(): EndpointPlan {
    const sticky = [this.#primary];
    for (let i = 0; i < this.#endpoints.length; i += 1) {
      if (i !== this.#primary) sticky.push(i);
    }
    const available = sticky.filter((i) => !this.isBlacklisted(i));
    if (available.length > 0) return { order: available, probe: false };
    return { order: sticky, probe: true };
  }

  reportSuccess(index: number): void {
    this.endpoint(index);
    this.#blockedUntil[index] = 0;
    this.#primary = index;
  }

  reportFailure(index: number): void {
    this.endpoint(index);
    this.#blockedUntil[index] = this.#now() + this.#blacklistMs;
  }
}

export type ConnectFailureKind = 'network' | 'fatal';

export interface FailoverAttemptContext {
  readonly endpoint: Endpoint;
  readonly index: number;
  readonly label: string;
  /** 总预算耗尽时 abort；尝试方应据此销毁未交付的连接/套接字。 */
  readonly signal: AbortSignal;
  /** 总预算截止时刻（`Date.now()` 毫秒）。 */
  readonly deadline: number;
}

export interface FailoverAttemptRecord {
  readonly label: string;
  readonly code: string;
}

export type FailoverErrorCode = 'ALL_ENDPOINTS_FAILED' | 'BUDGET_EXHAUSTED';

export class FailoverError extends Error {
  override name = 'FailoverError';
  readonly code: FailoverErrorCode;
  readonly role: string;
  readonly attempts: readonly FailoverAttemptRecord[];

  constructor(code: FailoverErrorCode, role: string, attempts: readonly FailoverAttemptRecord[]) {
    const tried = attempts.map((a) => `${a.label}=${a.code}`).join(', ') || 'none';
    super(`${role}: ${code === 'BUDGET_EXHAUSTED' ? 'connect budget exhausted' : 'all endpoints failed'} (${tried})`);
    this.code = code;
    this.role = role;
    this.attempts = Object.freeze([...attempts]);
  }
}

export interface FailoverOptions<T> {
  /** 出现在错误里的角色名，例如 `agent-knex`。 */
  readonly role: string;
  /** 一次 acquire 的总预算（含全部端点尝试与会话初始化）。 */
  readonly budgetMs: number;
  /** 区分可换端点的网络故障与必须立即失败的错误。 */
  readonly classify: (err: unknown) => ConnectFailureKind;
  /** 预算耗尽后才姗姗来迟的成功结果交给这里销毁，不能漏成悬空连接。 */
  readonly dispose?: (value: T) => void;
}

/**
 * 按 selector 的计划依次建连，直到成功、遇到致命错误或预算耗尽。
 *
 * 成功即粘住该端点；网络故障拉黑并尝试下一个；致命错误原样抛出且不拉黑。
 * 预算耗尽时正在进行的那个端点按网络故障拉黑（握手挂死就是不可达）。
 */
export async function acquireWithFailover<T>(
  selector: EndpointSelector,
  attempt: (ctx: FailoverAttemptContext) => Promise<T>,
  opts: FailoverOptions<T>,
): Promise<T> {
  if (!Number.isFinite(opts.budgetMs) || opts.budgetMs <= 0) {
    throw new RangeError('failover budgetMs must be a positive number');
  }
  const controller = new AbortController();
  const deadline = Date.now() + opts.budgetMs;
  const budgetExpired = new Promise<'expired'>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve('expired'), { once: true });
  });
  // 不 unref：挂死的尝试若不持有任何句柄，unref 会让进程在预算触发前就退出，
  // 调用方永远等不到失败。finally 里一定清掉。
  const timer = setTimeout(() => controller.abort(), opts.budgetMs);

  const attempts: FailoverAttemptRecord[] = [];
  try {
    for (const index of selector.plan().order) {
      if (controller.signal.aborted) break;
      const label = selector.label(index);
      const pending = attempt({
        endpoint: selector.endpoint(index),
        index,
        label,
        signal: controller.signal,
        deadline,
      });
      let outcome: { ok: true; value: T } | { ok: false; error: unknown } | 'expired';
      try {
        outcome = await Promise.race([
          pending.then((value) => ({ ok: true as const, value })),
          budgetExpired,
        ]);
      } catch (error) {
        outcome = { ok: false, error };
      }

      if (outcome === 'expired') {
        pending.then(
          (late) => opts.dispose?.(late),
          () => undefined,
        );
        selector.reportFailure(index);
        attempts.push({ label, code: 'BUDGET_EXHAUSTED' });
        throw new FailoverError('BUDGET_EXHAUSTED', opts.role, attempts);
      }
      if (outcome.ok) {
        selector.reportSuccess(index);
        return outcome.value;
      }
      if (opts.classify(outcome.error) === 'fatal') {
        throw outcome.error;
      }
      selector.reportFailure(index);
      attempts.push({ label, code: errorCode(outcome.error) });
    }
    if (controller.signal.aborted) {
      throw new FailoverError('BUDGET_EXHAUSTED', opts.role, attempts);
    }
    throw new FailoverError('ALL_ENDPOINTS_FAILED', opts.role, attempts);
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/** Node 套接字层的网络不可达类错误（含 `cause` 链上一层）。驱动特有码由各接入点补充。 */
export function isNetworkError(err: unknown): boolean {
  const code = rawCode(err) ?? rawCode((err as { cause?: unknown } | null)?.cause);
  return code !== undefined && NETWORK_ERROR_CODES.has(code);
}

/** 只取形如 `ECONNREFUSED` 的错误码；其余一律 `UNKNOWN`，防止把消息正文带进诊断。 */
export function errorCode(err: unknown): string {
  const code = rawCode(err);
  return code !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN';
}

function rawCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
