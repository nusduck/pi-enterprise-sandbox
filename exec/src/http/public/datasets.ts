/**
 * 公共面数据集路由——对 BFF `routes/datasets.js` 与 Python `routers/datasets.py` 逐字节不变。
 *
 * Python 语义：
 * - POST /sessions/:id/datasets?session_id=  + conversationId path param + Idempotency-Key 必传 → 201 {dataset_id,...}，流式不缓冲
 * - GET  /sessions/:id/datasets?session_id= → 200 {datasets,total}
 * - 缺 session_id→400，缺 conversationId/idempotency→400，declared>max→413 dataset_too_large，auth 失败→500/400
 * - 成功写 `X-Trace-Id`，错误经 mapUploadErrorBody 统一 envelope。
 *
 * 本实现复用 `files.ts` 的 ownership 校验与 redact 纪律，不新写一份解析。
 */

import { Hono } from 'hono';
import { badRequest, errorBody, HttpError, payloadTooLarge } from './errors.js';
import { parseActingHeaders, requireOwnedSession } from './ownership.js';
import { redactPhysicalRoots } from '../../fs/redact.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { DatasetService } from '../../dataset/service.js';
import { DatasetError } from '../../dataset/service.js';
import type { ExecDatasetRecord } from '../../db/repositories/datasets.js';

export interface PublicDatasetDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly datasetMaxBytes?: number;
  readonly datasetService: DatasetService;
}

/** 对外 JSON。字段名与 Python `DatasetEntry.to_public()` 一致（含冗余别名）。 */
function toResponse(r: ExecDatasetRecord): Record<string, unknown> {
  const storedPath = r.status === 'ready' ? r.storedRelativePath : '';
  return {
    dataset_id: r.datasetId,
    org_id: r.orgId,
    user_id: r.userId,
    conversation_id: r.conversationId,
    agent_session_id: r.sessionId,
    sandbox_session_id: r.sessionId,
    original_filename: r.originalFilename,
    name: r.originalFilename,
    path: storedPath,
    stored_relative_path: storedPath,
    mime_type: r.mimeType,
    size_bytes: r.sizeBytes,
    size: r.sizeBytes,
    sha256: r.status === 'ready' ? r.sha256 : null,
    status: r.status,
    created_at: r.createdAt.toISOString(),
    completed_at: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

const DEFAULT_DATASET_MAX = 100 * 1024 * 1024;

function actingFrom(c: import('hono').Context): Record<string, string | undefined> {
  const h: Record<string, string | undefined> = {};
  for (const k of ['x-acting-organization-id', 'x-acting-user-id', 'x-conversation-id']) {
    const v = c.req.header(k);
    if (v !== undefined) h[k] = v;
  }
  return h;
}

function traceIdFrom(c: import('hono').Context): string {
  return c.req.header('x-trace-id') ?? c.req.header('X-Trace-Id') ?? `tr_${Date.now()}`;
}

export function registerPublicDatasetRoutes(app: Hono, deps: PublicDatasetDeps): void {
  const maxBytes = deps.datasetMaxBytes ?? DEFAULT_DATASET_MAX;

  // POST upload — 支持两种挂载：/sessions/:sessionId/datasets 与 /conversations/:conversationId/datasets
  const handleUpload = async (c: import('hono').Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const sessionId = c.req.param('sessionId') ?? url.searchParams.get('session_id') ?? '';
    const conversationId = c.req.param('conversationId') ?? c.req.header('x-conversation-id') ?? '';
    const traceId = traceIdFrom(c);
    let roots: readonly string[] = [];
    try {
      if (!sessionId) throw badRequest('session_id required', 'session_required');
      if (!conversationId) throw badRequest('conversation_id required', 'conversation_required');
      const idem = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key');
      if (!idem || String(idem).trim() === '') throw badRequest('Idempotency-Key header is required', 'dataset_idempotency_key_required');
      const declaredRaw = c.req.header('content-length');
      const declared = declaredRaw != null ? Number(declaredRaw) : null;
      if (declared !== null && declared > maxBytes) throw payloadTooLarge('Payload too large', 'dataset_too_large');
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;

      // 真流式：请求体按块喂给三段式上传，整个文件不进内存。
      // 之前这里只校验头就回 201，字节根本没落盘。
      const filename =
        url.searchParams.get('filename') ??
        c.req.header('x-filename') ??
        'dataset';
      const stream = c.req.raw.body;
      const body: AsyncIterable<Uint8Array> =
        stream !== null
          ? (Readable.fromWeb(stream as never) as unknown as AsyncIterable<Uint8Array>)
          : (async function* () {})();

      const record = await deps.datasetService.uploadStream(
        {
          workspace: own.workspace,
          sessionId,
          conversationId,
          owner: { orgId: own.workspace.orgId, userId: own.workspace.userId },
          originalFilename: filename,
          mimeType: c.req.header('content-type') ?? null,
          declaredSize: declared,
          idempotencyKey: idem,
        },
        body,
      );
      c.header('X-Trace-Id', traceId);
      return c.json({ ...toResponse(record), session_id: sessionId, trace_id: traceId }, 201 as never);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const raw = err instanceof Error ? err.message : String(err);
      const redacted = redactPhysicalRoots(raw, roots);
      const code = err instanceof HttpError ? err.code : undefined;
      const payload: Record<string, unknown> = { error: redacted };
      if (code !== undefined) payload.code = code;
      payload.trace_id = traceId;
      if (code !== undefined) payload.detail = { code, message: redacted };
      c.header('X-Trace-Id', traceId);
      return c.json(payload, status as never);
    }
  };

  app.post('/sessions/:sessionId/datasets', handleUpload);
  app.post('/conversations/:conversationId/datasets', handleUpload);

  // GET list
  const handleList = async (c: import('hono').Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const sessionId = c.req.param('sessionId') ?? url.searchParams.get('session_id') ?? '';
    const conversationId = c.req.param('conversationId') ?? url.searchParams.get('conversation_id') ?? '';
    const traceId = traceIdFrom(c);
    let roots: readonly string[] = [];
    try {
      if (!sessionId) throw badRequest('session_id required', 'session_required');
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const datasets = await deps.datasetService.list(sessionId, {
        orgId: own.workspace.orgId,
        userId: own.workspace.userId,
      });
      c.header('X-Trace-Id', traceId);
      return c.json({
        datasets: datasets.map(toResponse),
        total: datasets.length,
        trace_id: traceId,
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const raw = err instanceof Error ? err.message : String(err);
      const redacted = redactPhysicalRoots(raw, roots);
      c.header('X-Trace-Id', traceId);
      return c.json({ error: redacted, code: (err as HttpError).code, trace_id: traceId }, status as never);
    }
  };
  app.get('/sessions/:sessionId/datasets', handleList);
  app.get('/conversations/:conversationId/datasets', handleList);
  app.get('/datasets', handleList);

  app.get('/sessions/:sessionId/datasets/:datasetId', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const datasetId = c.req.param('datasetId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const record = await deps.datasetService.get(datasetId, {
        orgId: own.workspace.orgId,
        userId: own.workspace.userId,
      });
      if (record === null || record.sessionId !== sessionId) {
        throw new HttpError(404, 'Dataset not found', 'dataset_not_found');
      }
      return c.json(toResponse(record));
    } catch (err) {
      const mapped = datasetHttpError(err, roots);
      return c.json(errorBody(mapped, roots), mapped.status as never);
    }
  });

  app.get('/sessions/:sessionId/datasets/:datasetId/content', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const datasetId = c.req.param('datasetId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const record = await deps.datasetService.get(datasetId, {
        orgId: own.workspace.orgId,
        userId: own.workspace.userId,
      });
      // 归属不符与不存在同一个 404：存在性不能泄漏。
      if (record === null || record.sessionId !== sessionId) {
        throw new HttpError(404, 'Dataset not found', 'dataset_not_found');
      }
      const physical = await deps.datasetService.resolveContentPath(record, own.workspace);
      const stream = Readable.toWeb(createReadStream(physical)) as ReadableStream;
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': record.mimeType,
          'content-length': String(record.sizeBytes),
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (err) {
      const mapped = datasetHttpError(err, roots);
      return c.json(errorBody(mapped, roots), mapped.status as never);
    }
  });
}

function datasetHttpError(err: unknown, roots: readonly string[]): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof DatasetError) {
    return new HttpError(err.status, redactPhysicalRoots(err.message, roots), err.code);
  }
  const raw = err instanceof Error ? err.message : String(err);
  return new HttpError(500, redactPhysicalRoots(raw, roots));
}
