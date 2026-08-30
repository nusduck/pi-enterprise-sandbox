/**
 * HTTP 请求/响应的小工具。阶段 C 的首批 TS 转换之一。
 *
 * 类型口径：入参用 Node 的 `IncomingMessage` / `ServerResponse` 的**最小结构**，
 * 不直接用 `node:http` 的完整类型——这几个函数在测试里被喂各种轻量替身，
 * 用完整类型会逼着每个替身实现几十个用不到的成员。
 */
import { randomBytes } from 'node:crypto';

/**
 * 只需要读头的函数用这个。**刻意不含 `on`**：把流的能力也写进来，会让
 * `IncomingMessage` 因为 `on` 的重载形状对不上而整体不可赋值，而绝大多数
 * 调用方（含测试替身）根本不需要流。
 */
export interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly requestId?: string | null;
}

/** 需要读 body 的函数用这个。方法语法让 `IncomingMessage` 的重载能匹配上。 */
export interface ReadableRequest {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** 本模块用得到的响应形状。 */
export interface ResponseLike {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}

/** BFF 解析后写入的调用者身份。浏览器直传的同名头会被 BFF 剥掉。 */
export interface AuthSubjects {
  readonly provider: 'bff';
  readonly externalOrgId: string;
  readonly externalUserId: string;
  readonly requestId: string | null;
  readonly callerType: 'web';
  readonly role: string | null;
}

function headerString(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function authSubjectsFromRequest(req: RequestLike): AuthSubjects | null {
  const userId = headerString(req, 'x-acting-user-id');
  const organizationId = headerString(req, 'x-acting-organization-id');
  if (userId === undefined || !userId.trim()) return null;
  if (organizationId === undefined || !organizationId.trim()) return null;
  const role = headerString(req, 'x-acting-role');
  return {
    provider: 'bff',
    externalOrgId: organizationId.trim(),
    externalUserId: userId.trim(),
    requestId: req.requestId || null,
    callerType: 'web',
    role: role !== undefined ? role.trim() : null,
  };
}

export function resolveRequestId(req: RequestLike | null | undefined): string {
  const incoming = String(
    req?.headers?.['x-request-id'] || req?.headers?.['X-Request-Id'] || '',
  ).trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(incoming)
    ? incoming
    : randomBytes(16).toString('hex');
}

export function readIdempotencyKey(req: RequestLike): string | null {
  // Node lowercases every inbound header name, so the canonical lowercase key
  // matches callers that send `Idempotency-Key` on the wire.
  const value = headerString(req, 'idempotency-key');
  return value !== undefined && value.trim() ? value.trim() : null;
}

export function readBody(req: ReadableRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function json(res: ResponseLike, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
