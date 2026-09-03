/**
 * Dataset streaming proxy (PR-09 / plan §17).
 *
 * POST /api/conversations/:conversationId/datasets?session_id=
 *   Streams multipart body to Sandbox without holding the full file in the
 *   Node heap or writing a BFF-side temp file.
 *
 * GET  /api/conversations/:conversationId/datasets?session_id=
 * GET  /api/datasets?session_id=
 */
/**
 * Dataset streaming proxy (PR-09 / plan §17).
 *
 * POST /api/conversations/:conversationId/datasets?session_id=
 *   Streams multipart body to Sandbox without holding the full file in the
 *   Node heap or writing a BFF-side temp file.
 *
 * GET  /api/conversations/:conversationId/datasets?session_id=
 * GET  /api/datasets?session_id=
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import {
  authorizeSandboxSession,
  type AuthorizeSandboxSessionResult,
  type ReqWithTrace,
} from '../application/run-access-service.js';
import {
  discardRequestBody,
  fetchSandboxBounded,
  mapUploadErrorBody,
  resolveUploadTraceId,
  sandboxProxyHeaders,
  UPLOAD_RESPONSE_TIMEOUT_MS,
} from './files.js';

function writeJson(res: ServerResponse, status: number, body: unknown, traceId?: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (traceId) headers['X-Trace-Id'] = traceId;
  const payload =
    traceId && body && typeof body === 'object' && (body as any).trace_id == null
      ? { ...(body as any), trace_id: traceId }
      : body;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function workspaceIdFor(sessionAccess: AuthorizeSandboxSessionResult | null | undefined): string {
  const workspaceId = String(
    sessionAccess?.access?.workspace_id || sessionAccess?.access?.workspaceId || '',
  ).trim();
  if (!workspaceId) {
    const err = new Error('Session workspace unavailable') as Error & { status: number; code: string };
    err.status = 503;
    err.code = 'SESSION_WORKSPACE_UNAVAILABLE';
    throw err;
  }
  return workspaceId;
}

/** Keep the public dataset contract keyed by sandbox_session_id. */
function projectDatasetSession(data: any, sandboxSessionId: string, sessionAccess: AuthorizeSandboxSessionResult | null | undefined): any {
  if (!data || typeof data !== 'object') return data;
  const agentSessionId = String(
    sessionAccess?.access?.agent_session_id || sessionAccess?.access?.agentSessionId || '',
  ).trim();
  const project = (row: any) => {
    if (!row || typeof row !== 'object') return row;
    return {
      ...row,
      session_id: sandboxSessionId,
      sandbox_session_id: sandboxSessionId,
      ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
    };
  };
  if (Array.isArray(data.datasets)) {
    return { ...data, datasets: data.datasets.map(project) };
  }
  return project(data);
}

/**
 * Build sandbox ownership headers for dataset formal rows.
 * Tenant principals (org/user) come only from trusted server context
 * (resolveTrustedAuth / session) — never from browser X-Org-Id / X-User-Id.
 */
export function datasetOwnershipHeaders(
  req?: ReqWithTrace | IncomingMessage | null,
  ctx: { conversationId?: string | null; orgId?: string; userId?: string } = {},
): Record<string, string> {
  const h: Record<string, string> = {};
  const conv =
    ctx.conversationId ||
    (req && (req.headers['x-conversation-id'] || req.headers['X-Conversation-Id'])) ||
    null;
  if (conv) h['X-Conversation-Id'] = String(conv);
  // Never forward client X-Org-Id / X-User-Id (cross-tenant formal stamp risk).
  if (ctx.orgId) h['X-Org-Id'] = String(ctx.orgId);
  if (ctx.userId) h['X-User-Id'] = String(ctx.userId);
  return h;
}

export interface BoundedUploadBody {
  stream: Transform;
  readonly bytesRead: number;
  readonly limitError: any;
}

/**
 * Bound an inbound upload without buffering it. `IncomingMessage.pipe()` and
 * this Transform's high-water marks propagate downstream fetch backpressure
 * to the browser socket.
 */
export function createBoundedDatasetUploadBody(req: IncomingMessage, maxBytes: number): BoundedUploadBody {
  let bytesRead = 0;
  let limitError: any = null;
  const stream = new Transform({
    readableHighWaterMark: 64 * 1024,
    writableHighWaterMark: 64 * 1024,
    transform(chunk, encoding, callback) {
      const chunkBytes = Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, encoding);
      bytesRead += chunkBytes;
      if (bytesRead > maxBytes) {
        limitError = Object.assign(new Error('Payload too large'), {
          code: 'dataset_too_large',
          status: 413,
          maxBytes,
        });
        callback(limitError);
        return;
      }
      callback(null, chunk);
    },
  });
  req.pipe(stream);
  return {
    stream,
    get bytesRead() {
      return bytesRead;
    },
    get limitError() {
      return limitError;
    },
  };
}


/**
 * POST dataset upload — stream to sandbox /sessions/:id/datasets
 *
 * @param {string} conversationId
 * @param {URL} parsedUrl
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleDatasetUpload(
  conversationId: string,
  parsedUrl: URL,
  req: IncomingMessage & ReqWithTrace,
  res: ServerResponse,
): Promise<void> {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const traceId = resolveUploadTraceId(req);

  if (!sessionId) {
    discardRequestBody(req, res);
    writeJson(res, 400, { error: 'session_id required', code: 'session_required' }, traceId);
    return;
  }
  if (!conversationId) {
    discardRequestBody(req, res);
    writeJson(
      res,
      400,
      { error: 'conversation_id required', code: 'conversation_required' },
      traceId,
    );
    return;
  }

  // Validate the durable-write contract before piping any request bytes.
  const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
  if (!idempotencyKey) {
    discardRequestBody(req, res);
    writeJson(
      res,
      400,
      {
        error: 'Idempotency-Key header is required',
        code: 'dataset_idempotency_key_required',
      },
      traceId,
    );
    return;
  }

  const contentType = req.headers['content-type'] || 'application/octet-stream';
  const maxBytes = config.DATASET_UPLOAD_MAX_BYTES;
  const declaredRaw = req.headers['content-length'];
  const declared = declaredRaw == null ? null : Number(declaredRaw);
  if (declared != null && declared > maxBytes) {
    discardRequestBody(req, res);
    writeJson(
      res,
      413,
      { error: 'Payload too large', code: 'dataset_too_large' },
      traceId,
    );
    return;
  }

  let sessionAccess: AuthorizeSandboxSessionResult;
  try {
    // Resolve the formal owner before any byte is read or forwarded to
    // Sandbox. Agent maps the external browser subject to internal ULIDs.
    sessionAccess = await authorizeSandboxSession(sessionId, req, {
      conversationId,
      traceId,
    });
  } catch (err: any) {
    discardRequestBody(req, res);
    const status = Number(err?.status) || 500;
    const message =
      status >= 500
        ? 'Authentication failed'
        : err?.message || 'Authentication required';
    writeJson(
      res,
      status,
      { error: message, code: err?.code || 'dataset_auth_failed' },
      traceId,
    );
    return;
  }

  let workspaceId: string;
  try {
    workspaceId = workspaceIdFor(sessionAccess);
  } catch (err: any) {
    discardRequestBody(req, res);
    writeJson(res, err.status || 503, { error: err.message, code: err.code }, traceId);
    return;
  }

  const headers = sandboxProxyHeaders(req, {
    'Content-Type': contentType,
    'X-Trace-Id': traceId,
    ...(req.headers['x-filename']
      ? { 'X-Filename': String(req.headers['x-filename']) }
      : {}),
    ...datasetOwnershipHeaders(req, { conversationId }),
  }, sessionAccess.sandboxAuth);
  if (declared != null && Number.isSafeInteger(declared) && declared >= 0) {
    headers['Content-Length'] = String(declared);
  }
  headers['Idempotency-Key'] = idempotencyKey;

  const upstreamAbort = new AbortController();
  let clientDisconnected = false;
  const abortUpstream = () => {
    clientDisconnected = true;
    if (!upstreamAbort.signal.aborted) upstreamAbort.abort();
  };
  const onRequestAborted = () => abortUpstream();
  const onRequestClose = () => {
    if ((req as any).aborted || req.complete === false) abortUpstream();
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abortUpstream();
  };
  req.once?.('aborted', onRequestAborted);
  req.once?.('close', onRequestClose);
  res.once?.('close', onResponseClose);

  const bounded = createBoundedDatasetUploadBody(req, maxBytes);
  try {
    const sanRes = await fetchSandboxBounded(
      `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(workspaceId)}/datasets`,
      {
        method: 'POST',
        headers,
        body: bounded.stream,
        duplex: 'half',
        signal: upstreamAbort.signal,
      } as RequestInit,
      UPLOAD_RESPONSE_TIMEOUT_MS,
    );

    const text = await sanRes.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || 'Invalid sandbox response' };
    }

    const sandboxTrace = sanRes.headers.get('x-trace-id') || traceId;
    if (!sanRes.ok) {
      let mappedStatus = sanRes.status;
      const code =
        (data && data.detail && data.detail.code) ||
        (data && data.code) ||
        '';
      if (
        sanRes.status === 400 &&
        (code === 'dataset_too_large' || code === 'workspace_quota_exceeded')
      ) {
        mappedStatus = 413;
      }
      writeJson(
        res,
        mappedStatus,
        mapUploadErrorBody(mappedStatus, data, sandboxTrace),
        sandboxTrace,
      );
      return;
    }

    const successBody =
      data && typeof data === 'object'
        ? {
            ...projectDatasetSession(data, sessionId, sessionAccess),
            conversation_id: data.conversation_id || conversationId,
            trace_id: data.trace_id || sandboxTrace,
          }
        : data;
    writeJson(
      res,
      sanRes.status === 200 ? 201 : sanRes.status || 201,
      successBody,
      sandboxTrace,
    );
  } catch (err: any) {
    if (bounded.limitError || err?.cause?.code === 'dataset_too_large') {
      req.unpipe?.(bounded.stream);
      req.resume?.();
      if (!res.destroyed && !res.writableEnded) {
        writeJson(
          res,
          413,
          { error: 'Payload too large', code: 'dataset_too_large' },
          traceId,
        );
      }
      return;
    }
    if (clientDisconnected || upstreamAbort.signal.aborted) return;
    console.error('[datasets] upload proxy failed:', err);
    if (!res.destroyed && !res.writableEnded) {
      writeJson(res, 500, { error: err.message || 'Upload failed' }, traceId);
    }
  } finally {
    req.off?.('aborted', onRequestAborted);
    req.off?.('close', onRequestClose);
    res.off?.('close', onResponseClose);
    req.unpipe?.(bounded.stream);
    bounded.stream.destroy();
    if (!clientDisconnected && req.complete === false) req.resume?.();
  }
}

/**
 * GET list datasets for a session.
 */
export async function handleListDatasets(
  parsedUrl: URL,
  res: ServerResponse,
  req: (IncomingMessage & ReqWithTrace) | null = null,
  conversationId: string | null = null,
): Promise<void> {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const traceId = resolveUploadTraceId(req);
  if (!sessionId) {
    writeJson(res, 400, { error: 'session_id required' }, traceId);
    return;
  }
  try {
    const sessionAccess = await authorizeSandboxSession(sessionId, req, {
      conversationId,
      traceId,
    });
    const workspaceId = workspaceIdFor(sessionAccess);
    const headers = sandboxProxyHeaders(
      req,
      {
        'X-Trace-Id': traceId,
        ...datasetOwnershipHeaders(req, { conversationId }),
      },
      sessionAccess.sandboxAuth,
    );
    const sanRes = await fetchSandboxBounded(
      `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(workspaceId)}/datasets`,
      { headers },
    );
    const text = await sanRes.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || 'Invalid sandbox response' };
    }
    writeJson(
      res,
      sanRes.status,
      projectDatasetSession(data, sessionId, sessionAccess),
      sanRes.headers.get('x-trace-id') || traceId,
    );
  } catch (err: any) {
    console.error('[datasets] list:', err.message);
    const status = Number(err?.status) || 500;
    writeJson(
      res,
      status,
      {
        error:
          status >= 500
            ? 'Dataset list unavailable'
            : err.message || 'Failed to list datasets',
        code: err.code,
      },
      traceId,
    );
  }
}

