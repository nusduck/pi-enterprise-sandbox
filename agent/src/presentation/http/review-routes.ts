/**
 * 审核员 API 的 Agent 内部面（`/internal/reviews*`，design `agent-output-review.md` §7）。
 *
 *   GET    /internal/reviews                                    审核池与历史
 *   GET    /internal/reviews/:id                                详情（提问 / 材料 / 交付物版本链 / 审计）
 *   GET    /internal/reviews/:id/materials/:mid/download        附件快照（二进制）
 *   GET    /internal/reviews/:id/artifacts/:aid/download        交付物任一版本（二进制）
 *   POST   /internal/reviews/:id/claim                          领取
 *   POST   /internal/reviews/:id/release                        释放领取
 *   POST   /internal/reviews/:id/items/:no/revisions            上传修订（原始字节 body）
 *   POST   /internal/reviews/:id/approve                        通过
 *   POST   /internal/reviews/:id/reject                         驳回
 *
 * 鉴权（`reviewer` 角色）、org 作用域、职责分离、状态机与并发冲突都在
 * `ReviewService` 里判；这里只做路径解析、body 读取与错误映射。返回 `true` 表示
 * 请求归这里处理（无论成败）。
 *
 * BFF 侧同名端点挂在 `/api/reviews*`，只做转发与身份投影（AGENTS.md §1：BFF 不判
 * 业务状态）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  requireAuthSubjects,
  json,
  readBody,
  type AuthSubjects,
} from './request-response.js';
import { ReviewError } from '../../application/review-service.js';
import { REVIEW_TRANSFER_MAX_BYTES } from '@dsh/contract/delivery-policy.js';

/** JSON body（决定、备注）上限。 */
const JSON_BODY_MAX_BYTES = 64 * 1024;

export interface ReviewServiceLike {
  listTasks(actor: AuthSubjects, query: Record<string, unknown>): Promise<unknown>;
  getTaskDetail(actor: AuthSubjects, reviewTaskId: string): Promise<unknown>;
  claim(actor: AuthSubjects, reviewTaskId: string): Promise<unknown>;
  releaseClaim(actor: AuthSubjects, reviewTaskId: string): Promise<unknown>;
  uploadRevision(
    actor: AuthSubjects,
    reviewTaskId: string,
    itemNo: number,
    input: { baseRevision: unknown; filename?: string | null; mimeType?: string | null; bytes: Uint8Array },
  ): Promise<unknown>;
  approve(actor: AuthSubjects, reviewTaskId: string, input: { baseRevision: unknown; note?: unknown }): Promise<unknown>;
  reject(actor: AuthSubjects, reviewTaskId: string, input: { baseRevision: unknown; feedback?: unknown }): Promise<unknown>;
  readMaterial(
    actor: AuthSubjects,
    reviewTaskId: string,
    materialId: string,
  ): Promise<{ filename: string; mimeType: string; bytes: Buffer; sha256: string }>;
  readArtifact(
    actor: AuthSubjects,
    reviewTaskId: string,
    artifactId: string,
  ): Promise<{ filename: string; mimeType: string; bytes: Buffer; sha256: string }>;
}

export interface ReviewRouteInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly parsedUrl: URL;
  readonly path: string;
  readonly reviewService?: ReviewServiceLike | null | undefined;
}

const PREFIX = '/internal/reviews';

/** `:id` 或 `:id/<section>[/<tail>[/<action>]]`（`items/:no/revisions` 是四段）。 */
const REVIEW_PATH = /^([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z]+))?)?$/;

/**
 * 解码一个路径段；非法百分号编码返回 null，由调用方给 404。
 * `decodeURIComponent` 抛 `URIError` 会落到兜底错误映射变成 500。
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function statusForReviewError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ReviewError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code, ...(error.details ?? {}) },
    };
  }
  console.error('[agent-http] review operation failed:', error);
  return { status: 500, body: { error: 'Internal server error', code: 'INTERNAL_ERROR' } };
}

function methodNotAllowed(res: ServerResponse): void {
  json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
}

/** 二进制下载：与 exec 公共面的纪律一致（nosniff + 附件文件名 + 摘要头）。 */
function sendBytes(
  res: ServerResponse,
  input: { filename: string; mimeType: string; bytes: Buffer; sha256?: string },
): void {
  if (res.headersSent) return;
  const headers: Record<string, string> = {
    // 审核员下载的也是用户生成内容：html/svg 一律降级成 octet-stream，避免
    // 在浏览器里当页面执行（exec 公共面同一处判断）。
    'Content-Type': /^text\/html|^image\/svg\+xml|^application\/xhtml\+xml/i.test(input.mimeType)
      ? 'application/octet-stream'
      : input.mimeType || 'application/octet-stream',
    'Content-Length': String(input.bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'X-Artifact-Filename': encodeURIComponent(input.filename),
  };
  if (input.sha256) headers['X-Artifact-Sha256'] = input.sha256;
  res.writeHead(200, headers);
  // 最小响应接口只声明了 string body；Buffer 是 Node 的合法输入。
  (res.end as (body?: unknown) => unknown)(input.bytes);
}

function parseJsonBody(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReviewError(422, 'REVIEW_INPUT_INVALID', 'body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReviewError(422, 'REVIEW_INPUT_INVALID', 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** 读原始字节（修订上传用）：不经过 utf8 解码，二进制不会被改写。 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        reject(new ReviewError(413, 'REVIEW_FILE_INVALID', 'revision file is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

export async function handleReviewRoute(input: ReviewRouteInput): Promise<boolean> {
  const { req, res, parsedUrl, path, reviewService: service } = input;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (!service) {
    json(res, 503, { error: 'Review plane unavailable', code: 'DEPENDENCY' });
    return true;
  }
  const auth = requireAuthSubjects(req, res);
  if (!auth) return true;
  const qs = parsedUrl.searchParams;
  try {
    if (path === PREFIX) {
      if (req.method !== 'GET') return (methodNotAllowed(res), true);
      json(res, 200, await service.listTasks(auth, {
        status: qs.get('status'),
        mine: qs.get('mine') === 'true' || qs.get('mine') === '1',
        cursor: qs.get('cursor'),
        limit: qs.get('limit'),
      }));
      return true;
    }

    const match = REVIEW_PATH.exec(path.slice(PREFIX.length + 1));
    if (!match) return (notFound(res), true);
    const reviewTaskId = decodeSegment(match[1] as string);
    if (reviewTaskId === null) return (notFound(res), true);
    const section = match[2];
    const tail = typeof match[3] === 'string' && match[3] !== '' ? match[3] : null;
    const action = typeof match[4] === 'string' && match[4] !== '' ? match[4] : null;

    if (section === undefined) {
      if (req.method !== 'GET') return (methodNotAllowed(res), true);
      json(res, 200, await service.getTaskDetail(auth, reviewTaskId));
      return true;
    }

    if (section === 'claim' || section === 'release') {
      if (tail !== null) return (notFound(res), true);
      if (req.method !== 'POST') return (methodNotAllowed(res), true);
      // 领取/释放不需要 body；即使带了也忽略（不读，避免未消费的流挂住连接）。
      json(res, 200, section === 'claim'
        ? await service.claim(auth, reviewTaskId)
        : await service.releaseClaim(auth, reviewTaskId));
      return true;
    }

    if (section === 'approve' || section === 'reject') {
      if (tail !== null) return (notFound(res), true);
      if (req.method !== 'POST') return (methodNotAllowed(res), true);
      const body = parseJsonBody(await readBody(req, JSON_BODY_MAX_BYTES));
      const input_ = { baseRevision: body['base_revision'], note: body['note'], feedback: body['feedback'] };
      json(res, 200, section === 'approve'
        ? await service.approve(auth, reviewTaskId, input_)
        : await service.reject(auth, reviewTaskId, input_));
      return true;
    }

    if (section === 'items') {
      // `/items/:no/revisions` —— `tail` 是 `:no`，`action` 必须是 `revisions`。
      const itemNoText = tail;
      if (itemNoText === null || action !== 'revisions') return (notFound(res), true);
      if (!/^[1-9][0-9]{0,5}$/.test(itemNoText)) return (notFound(res), true);
      if (req.method !== 'POST') return (methodNotAllowed(res), true);
      const bytes = await readRawBody(req, REVIEW_TRANSFER_MAX_BYTES);
      const rawFilename = headerText(req, 'x-filename');
      const filename = rawFilename === null ? null : decodeSegment(rawFilename);
      json(res, 200, await service.uploadRevision(auth, reviewTaskId, Number(itemNoText), {
        baseRevision: qs.get('base_revision'),
        filename,
        mimeType: headerText(req, 'content-type'),
        bytes,
      }));
      return true;
    }

    if (section === 'materials' || section === 'artifacts') {
      // `/materials/:mid/download`、`/artifacts/:aid/download`
      if (tail === null || action !== 'download') return (notFound(res), true);
      if (req.method !== 'GET') return (methodNotAllowed(res), true);
      const id = decodeSegment(tail);
      if (id === null) return (notFound(res), true);
      const file = section === 'materials'
        ? await service.readMaterial(auth, reviewTaskId, id)
        : await service.readArtifact(auth, reviewTaskId, id);
      sendBytes(res, file);
      return true;
    }

    return (notFound(res), true);
  } catch (error) {
    const mapped = statusForReviewError(error);
    json(res, mapped.status, mapped.body);
    return true;
  }
}

function headerText(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}
