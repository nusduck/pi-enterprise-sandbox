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

/**
 * 列表接口的查询参数原样取出，**只取白名单里的键**。
 *
 * 存在的理由有两条：`limit` / `cursor` 的边界判定属于应用层（路由不做 clamp，
 * 也不把 `limit=abc` 静默变成默认页大小），而每个列表路由各写一遍
 * `searchParams.get(...)` 会把 create-http-server 顶过它的行数预算。
 */
export function listQueryParams(
  parsedUrl: URL,
  keys: readonly string[],
): Record<string, string | null> {
  const query: Record<string, string | null> = {};
  for (const key of keys) query[key] = parsedUrl.searchParams.get(key);
  return query;
}

export function readBody(req: ReadableRequest, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

export function json(res: ResponseLike, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 缺鉴权上下文时的统一 400 体（F01/F02 收敛）。
 *
 * `create-http-server.ts` 19 处与各路由的同构检查都走这里：文案与 code 唯一，
 * 状态保持 400。调用方只判返回值 null 即返回（热点文件里是 `return`，
 * 路由模块里是 `return true`），不再各写一遍 body。
 */
export const AUTH_CONTEXT_REQUIRED_BODY = Object.freeze({
  error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
  code: 'AUTH_CONTEXT_REQUIRED',
});

export function requireAuthSubjects(
  req: RequestLike,
  res: ResponseLike,
): AuthSubjects | null {
  const auth = authSubjectsFromRequest(req);
  if (!auth) {
    json(res, 400, AUTH_CONTEXT_REQUIRED_BODY);
    return null;
  }
  return auth;
}

/**
 * SSE/JSON 列表共用的游标解析（F06 收敛）。
 *
 * 语义与原内联代码逐字一致：`after_sequence` / `after` 取整，`afterSequence` /
 * `after_sequence` 数字才参与取 max，数字 `Last-Event-ID`（legacy）同样取 max；
 * 原始 `Last-Event-ID` 头一并返回，给 Redis 直播分支（ULID 形式由 SSE 服务解析）。
 * `?limit=` 与 fallback 轮询的上限（500 / 100）是分页行为，不收敛。
 */
export function parseSseCursor(
  parsedUrl: URL,
  req: RequestLike,
): { after: number, lastEventId: string | null } {
  let after =
    parseInt(
      parsedUrl.searchParams.get('after_sequence') ||
        parsedUrl.searchParams.get('after') ||
        '0',
      10,
    ) || 0;
  const afterSeqParam =
    parsedUrl.searchParams.get('afterSequence') ||
    parsedUrl.searchParams.get('after_sequence');
  if (afterSeqParam && /^\d+$/.test(afterSeqParam)) {
    after = Math.max(after, parseInt(afterSeqParam, 10));
  }
  const lastEventIdHeader = req.headers['last-event-id'];
  const lastEventId =
    typeof lastEventIdHeader === 'string' && lastEventIdHeader.trim()
      ? lastEventIdHeader.trim()
      : null;
  // Numeric Last-Event-ID is still accepted as sequence (legacy).
  if (lastEventId && /^\d+$/.test(lastEventId)) {
    after = Math.max(after, parseInt(lastEventId, 10));
  }
  return { after, lastEventId };
}
