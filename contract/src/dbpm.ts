/**
 * DBPM 取口令客户端（纯 TCP，无第三方依赖）。
 *
 * 协议与内部样例一致：请求 `0x0E 0x02` + ` <db_name> <db_user_name>\n`，
 * 成功应答 `OK: <password>\n`，其余为错误串。
 *
 * 为什么放 contract/：Agent、Worker、exec、sandbox-mcp 都要在启动时取口令，
 * 同一协议写多份会分叉。这里只做「取一个口令」，不读环境变量、不建数据库连接。
 *
 * 安全约束（design `updrdb-dbpm-deployment.md` §7，ADR 0011 D10）：
 * - 只在启动取一次；不做运行期重取、不做环境变量口令回退。
 * - 名称含空白/控制字符直接拒绝——否则可以拼出第二个请求行。
 * - 单帧上限 4KiB；连接 3s、每端点 5s、两端点总预算 10s。EOF、半帧超时、
 *   超长帧、错误应答都算失败并销毁套接字，然后换下一个端点。
 * - 返回值只有口令。错误里**不带服务端应答正文**（可能回显条目或口令片段），
 *   只带端点代号与失败类别。
 */

import { connect } from 'node:net';
import { TextDecoder } from 'node:util';

import {
  acquireWithFailover,
  EndpointSelector,
  FailoverError,
  type Endpoint,
  type FailoverAttemptRecord,
} from './endpoint-failover.js';

/** 协议头两个字节。用只读元组而不是 Buffer：TypedArray 冻结不了，导出后会被改写。 */
export const DBPM_REQUEST_HEADER = Object.freeze([0x0e, 0x02] as const);
export const DBPM_MAX_FRAME_BYTES = 4096;
export const DBPM_CONNECT_TIMEOUT_MS = 3_000;
export const DBPM_REQUEST_TIMEOUT_MS = 5_000;
export const DBPM_BUDGET_MS = 10_000;

const MAX_NAME_BYTES = 256;
const OK_PREFIX = 'OK: ';

export interface DbpmEntry {
  readonly dbName: string;
  readonly userName: string;
}

/** 单个端点的失败类别。 */
export type DbpmFailureCode =
  | 'CONNECT_FAILED'
  | 'CONNECTION_ERROR'
  | 'TIMEOUT'
  | 'EOF'
  | 'FRAME_TOO_LARGE'
  | 'BAD_RESPONSE'
  | 'ERROR_RESPONSE';

export type DbpmErrorCode = 'INVALID_ENTRY' | 'ALL_ENDPOINTS_FAILED' | 'BUDGET_EXHAUSTED';

export class DbpmError extends Error {
  override name = 'DbpmError';
  readonly code: DbpmErrorCode;
  readonly attempts: readonly FailoverAttemptRecord[];

  constructor(code: DbpmErrorCode, message: string, attempts: readonly FailoverAttemptRecord[] = []) {
    super(message);
    this.code = code;
    this.attempts = Object.freeze([...attempts]);
  }
}

/** 单端点一次请求的失败；`code` 同时作为 failover 记录里的类别。 */
export class DbpmAttemptError extends Error {
  override name = 'DbpmAttemptError';
  readonly code: DbpmFailureCode;

  constructor(code: DbpmFailureCode) {
    super(`DBPM attempt failed: ${code}`);
    this.code = code;
  }
}

export interface FetchDbpmPasswordOptions {
  /** 出现在错误里的角色名，例如 `agent-updrdb`。不要放条目名以外的敏感信息。 */
  readonly role: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly budgetMs?: number;
  readonly maxFrameBytes?: number;
}

function assertName(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value === '' ||
    Buffer.byteLength(value, 'utf8') > MAX_NAME_BYTES ||
    /[\s\p{Cc}]/u.test(value)
  ) {
    throw new DbpmError('INVALID_ENTRY', `DBPM ${field} must be 1-${MAX_NAME_BYTES} bytes without whitespace or control characters`);
  }
}

export function buildDbpmRequest(entry: DbpmEntry): Buffer {
  assertName(entry.dbName, 'dbName');
  assertName(entry.userName, 'userName');
  return Buffer.concat([
    Buffer.from(DBPM_REQUEST_HEADER),
    Buffer.from(` ${entry.dbName} ${entry.userName}\n`, 'utf8'),
  ]);
}

/** 解析一行应答（不含换行）。 */
export function parseDbpmResponseLine(line: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(line);
  } catch {
    throw new DbpmAttemptError('BAD_RESPONSE');
  }
  if (!text.startsWith(OK_PREFIX)) {
    throw new DbpmAttemptError('ERROR_RESPONSE');
  }
  const password = text.slice(OK_PREFIX.length);
  if (password === '' || /\p{Cc}/u.test(password)) {
    throw new DbpmAttemptError('BAD_RESPONSE');
  }
  return password;
}

function requestOnce(
  endpoint: Endpoint,
  request: Buffer,
  signal: AbortSignal,
  limits: { connectTimeoutMs: number; requestTimeoutMs: number; maxFrameBytes: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let connected = false;
    let settled = false;

    const socket = connect({ host: endpoint.host, port: endpoint.port });

    const finish = (error: DbpmAttemptError | null, password?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      chunks.length = 0;
      if (error !== null) reject(error);
      else resolve(password ?? '');
    };
    const onAbort = (): void => finish(new DbpmAttemptError('TIMEOUT'));

    const connectTimer = setTimeout(() => finish(new DbpmAttemptError('TIMEOUT')), limits.connectTimeoutMs);
    const requestTimer = setTimeout(() => finish(new DbpmAttemptError('TIMEOUT')), limits.requestTimeoutMs);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.write(request);
    });
    socket.on('data', (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const usable = newline === -1 ? chunk.length : newline + 1;
      received += usable;
      if (received > limits.maxFrameBytes) {
        finish(new DbpmAttemptError('FRAME_TOO_LARGE'));
        return;
      }
      if (newline === -1) {
        chunks.push(chunk);
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      try {
        finish(null, parseDbpmResponseLine(Buffer.concat(chunks)));
      } catch (error) {
        finish(error instanceof DbpmAttemptError ? error : new DbpmAttemptError('BAD_RESPONSE'));
      }
    });
    socket.once('error', () => {
      finish(new DbpmAttemptError(connected ? 'CONNECTION_ERROR' : 'CONNECT_FAILED'));
    });
    socket.once('close', () => finish(new DbpmAttemptError(connected ? 'EOF' : 'CONNECT_FAILED')));
  });
}

/**
 * 按配置顺序向 DBPM 取一个口令；第一个端点任何失败都切到下一个。
 *
 * 每次调用使用新的 selector：取密只在启动发生，没有需要跨调用粘住的主用。
 */
export async function fetchDbpmPassword(
  endpoints: readonly Endpoint[],
  entry: DbpmEntry,
  opts: FetchDbpmPasswordOptions,
): Promise<string> {
  const request = buildDbpmRequest(entry);
  const limits = {
    connectTimeoutMs: opts.connectTimeoutMs ?? DBPM_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: opts.requestTimeoutMs ?? DBPM_REQUEST_TIMEOUT_MS,
    maxFrameBytes: opts.maxFrameBytes ?? DBPM_MAX_FRAME_BYTES,
  };
  try {
    return await acquireWithFailover(
      new EndpointSelector(endpoints),
      ({ endpoint, signal }) => requestOnce(endpoint, request, signal, limits),
      {
        role: opts.role,
        budgetMs: opts.budgetMs ?? DBPM_BUDGET_MS,
        classify: () => 'network',
      },
    );
  } catch (error) {
    if (error instanceof FailoverError) {
      const tried = error.attempts.map((a) => `${a.label}=${a.code}`).join(', ') || 'none';
      throw new DbpmError(
        error.code,
        `DBPM credential fetch failed for ${opts.role}: ${error.code} (${tried})`,
        error.attempts,
      );
    }
    throw error;
  }
}
