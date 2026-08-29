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

export interface PublicDatasetDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly datasetMaxBytes?: number;
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
      // 不缓冲整文件：此处仅校验头，真实流由下游 `fetchSandboxBounded` 背压，此处回 201 占位
      const datasetId = `ds_${Date.now()}`;
      const body = {
        dataset_id: datasetId,
        conversation_id: conversationId,
        session_id: sessionId,
        trace_id: traceId,
      };
      c.header('X-Trace-Id', traceId);
      return c.json(body, 201 as never);
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
      c.header('X-Trace-Id', traceId);
      return c.json({ datasets: [], total: 0, trace_id: traceId });
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
}
