/**
 * 审核员面的 BFF（design `docs/design/agent-output-review.md` §7）：
 *
 *   GET    /api/reviews?status=&mine=&cursor=&limit=        审核池与历史
 *   GET    /api/reviews/:id                                 详情
 *   GET    /api/reviews/:id/materials/:mid/download         附件快照（流式）
 *   GET    /api/reviews/:id/artifacts/:aid/download         交付物任一版本（流式）
 *   POST   /api/reviews/:id/claim                           领取
 *   POST   /api/reviews/:id/release                         释放领取
 *   POST   /api/reviews/:id/items/:no/revisions?base_revision=  上传修订（原始字节）
 *   POST   /api/reviews/:id/approve                         通过
 *   POST   /api/reviews/:id/reject                          驳回
 *
 * 身份由服务端解析后写入 `X-Acting-*`（含角色集合）：浏览器声明不了自己的角色。
 * `reviewer` 判定、org 作用域、跨租户 404 与全部 `REVIEW_*` 错误码都在 agent/，
 * 这里只做路径解析、body 转发与流式代理。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';
import {
  approveReview,
  claimReview,
  getReview,
  listReviews,
  openReviewArtifact,
  openReviewMaterial,
  rejectReview,
  releaseReview,
  uploadReviewRevision,
} from '../services/agent-review-client.js';
import { discardRequestBody, spillRequestToTempFile } from './files.js';
import { sendError, sendJson as json } from '../http/response.js';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';

const PREFIX = '/api/reviews';

/** `:id` 或 `:id/<section>[/<tail>[/<action>]]`（`items/:no/revisions` 是四段）。 */
const REVIEW_PATH = /^([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z]+))?)?$/;

/**
 * 修订文件上限：100 MiB，与 `contract` 的 `REVIEW_TRANSFER_MAX_BYTES` 同值（BFF 不依赖 contract 包）。
 * agent ↔ exec 内部面以 base64 放进 JSON 传文件，更大的文件会超出 Node 单字符串上限。
 */
const MAX_REVISION_BYTES = 100 * 1024 * 1024;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
}

function methodNotAllowed(res: ServerResponse): void {
  json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
}

function readJsonBody(req: IncomingMessage | null, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!req) return resolve({});
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(Object.assign(new Error('body must be JSON'), { status: 422, code: 'REVIEW_INPUT_INVALID' }));
      }
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

/** 流式转发 agent 的字节响应（背压 + 断连清理，与产物下载同一实现纪律）。 */
async function proxyBytes(
  upstream: Response,
  req: IncomingMessage | null,
  res: ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  };
  const length = upstream.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  const filename = upstream.headers.get('x-artifact-filename');
  if (filename) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${filename}`;
  res.writeHead(200, headers);

  let aborted = false;
  const onClose = () => {
    aborted = true;
    (upstream.body as any)?.cancel?.();
  };
  if (req) req.on('close', onClose);
  try {
    if (!upstream.body) {
      res.end();
      return;
    }
    for await (const chunk of upstream.body as any) {
      if (aborted || res.writableEnded || res.destroyed) break;
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
  } finally {
    if (req) req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

export async function handleReviewsRoute(
  method: string,
  path: string,
  parsedUrl: URL,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<boolean> {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  try {
    const auth = await resolveTrustedAuth(req);
    const opts = { auth, traceId: req?.traceId ?? null };

    if (path === PREFIX) {
      if (method !== 'GET') {
        methodNotAllowed(res);
        return true;
      }
      json(res, 200, await listReviews(parsedUrl.searchParams, opts));
      return true;
    }

    const match = REVIEW_PATH.exec(path.slice(PREFIX.length + 1));
    if (!match) {
      notFound(res);
      return true;
    }
    const reviewTaskId = decodeSegment(match[1] as string);
    if (reviewTaskId === null) {
      notFound(res);
      return true;
    }
    const section = match[2];
    const tail = typeof match[3] === 'string' && match[3] !== '' ? match[3] : null;
    const action = typeof match[4] === 'string' && match[4] !== '' ? match[4] : null;

    if (section === undefined) {
      if (method !== 'GET') {
        methodNotAllowed(res);
        return true;
      }
      json(res, 200, await getReview(reviewTaskId, opts));
      return true;
    }

    if (section === 'claim' || section === 'release') {
      if (tail !== null || method !== 'POST') {
        tail !== null ? notFound(res) : methodNotAllowed(res);
        return true;
      }
      // 领取/释放不带 body；排空入站流，避免 keep-alive 连接上残留字节被当成
      // 下一个请求（`discardRequestBody` 会 destroy，那是拒绝路径的语义，不用）。
      req?.resume?.();
      json(res, 200, section === 'claim'
        ? await claimReview(reviewTaskId, opts)
        : await releaseReview(reviewTaskId, opts));
      return true;
    }

    if (section === 'approve' || section === 'reject') {
      if (tail !== null || method !== 'POST') {
        tail !== null ? notFound(res) : methodNotAllowed(res);
        return true;
      }
      const body = await readJsonBody(req);
      const baseRevision = Number(body['base_revision']);
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        json(res, 422, { error: 'base_revision must be a non-negative integer', code: 'REVIEW_INPUT_INVALID' });
        return true;
      }
      if (section === 'approve') {
        json(res, 200, await approveReview(reviewTaskId, {
          base_revision: baseRevision,
          note: typeof body['note'] === 'string' ? body['note'] : null,
        }, opts));
        return true;
      }
      const feedback = typeof body['feedback'] === 'string' ? body['feedback'].trim() : '';
      if (!feedback) {
        // 反馈必填（U3）：在 BFF 就挡住，省一次往返；agent 侧同样会判。
        json(res, 422, { error: 'Rejection feedback is required', code: 'REVIEW_FEEDBACK_REQUIRED' });
        return true;
      }
      json(res, 200, await rejectReview(reviewTaskId, { base_revision: baseRevision, feedback }, opts));
      return true;
    }

    if (section === 'items') {
      if (tail === null || action !== 'revisions' || method !== 'POST') {
        tail === null || action !== 'revisions' ? notFound(res) : methodNotAllowed(res);
        return true;
      }
      const itemNo = Number(tail);
      if (!Number.isSafeInteger(itemNo) || itemNo < 1) {
        notFound(res);
        return true;
      }
      const baseRevision = Number(parsedUrl.searchParams.get('base_revision'));
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        json(res, 422, { error: 'base_revision must be a non-negative integer', code: 'REVIEW_INPUT_INVALID' });
        return true;
      }
      const declared = parseInt(String(req?.headers?.['content-length'] || '0'), 10);
      if (Number.isFinite(declared) && declared > MAX_REVISION_BYTES) {
        discardRequestBody(req, res);
        json(res, 413, { error: 'Revision file is too large', code: 'REVIEW_FILE_INVALID' });
        return true;
      }
      // 流式落盘再转发：直接拿请求流当 body 会在 agent 拒绝时把浏览器挂在那里，
      // 而且 `content-length` 不可信时我们仍要能先量出真实大小（与附件上传同因）。
      const spill = await spillRequestToTempFile(req as IncomingMessage, MAX_REVISION_BYTES);
      try {
        const filename = decodeSegment(String(req?.headers?.['x-filename'] || '')) || 'revision';
        const upstream = await uploadReviewRevision(reviewTaskId, itemNo, {
          baseRevision,
          filename,
          mimeType: String(req?.headers?.['content-type'] || 'application/octet-stream'),
          body: createReadStream(spill.filePath),
          duplex: 'half',
        }, opts);
        json(res, 200, await upstream.json().catch(() => ({})));
      } finally {
        await rm(spill.dir, { recursive: true, force: true }).catch(() => {});
      }
      return true;
    }

    if (section === 'materials' || section === 'artifacts') {
      if (tail === null || action !== 'download' || method !== 'GET') {
        tail === null || action !== 'download' ? notFound(res) : methodNotAllowed(res);
        return true;
      }
      const id = decodeSegment(tail);
      if (id === null) {
        notFound(res);
        return true;
      }
      const upstream = section === 'materials'
        ? await openReviewMaterial(reviewTaskId, id, opts)
        : await openReviewArtifact(reviewTaskId, id, opts);
      await proxyBytes(upstream, req, res);
      return true;
    }

    notFound(res);
    return true;
  } catch (error) {
    sendError(res, error, req?.traceId);
    return true;
  }
}
