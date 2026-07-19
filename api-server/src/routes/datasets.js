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
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { authorizeSandboxSession } from '../application/run-access-service.js';
import {
  discardRequestBody,
  mapUploadErrorBody,
  resolveUploadTraceId,
  sandboxProxyHeaders,
} from './files.js';

function writeJson(res, status, body, traceId) {
  const headers = { 'Content-Type': 'application/json' };
  if (traceId) headers['X-Trace-Id'] = traceId;
  const payload =
    traceId && body && typeof body === 'object' && body.trace_id == null
      ? { ...body, trace_id: traceId }
      : body;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

/**
 * Build sandbox ownership headers for dataset formal rows.
 * Tenant principals (org/user) come only from trusted server context
 * (resolveTrustedAuth / session) — never from browser X-Org-Id / X-User-Id.
 * @param {import('node:http').IncomingMessage | null | undefined} req
 * @param {{ conversationId?: string, orgId?: string, userId?: string }} [ctx]
 */
export function datasetOwnershipHeaders(req, ctx = {}) {
  const h = {};
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

/**
 * Bound an inbound upload without buffering it. `IncomingMessage.pipe()` and
 * this Transform's high-water marks propagate downstream fetch backpressure
 * to the browser socket.
 *
 * @param {import('node:stream').Readable} req
 * @param {number} maxBytes
 */
export function createBoundedDatasetUploadBody(req, maxBytes) {
  let bytesRead = 0;
  let limitError = null;
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
export async function handleDatasetUpload(conversationId, parsedUrl, req, res) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const traceId = resolveUploadTraceId(req);

  if (!sessionId) {
    discardRequestBody(req);
    writeJson(res, 400, { error: 'session_id required', code: 'session_required' }, traceId);
    return;
  }
  if (!conversationId) {
    discardRequestBody(req);
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
    discardRequestBody(req);
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
  if (declared > maxBytes) {
    discardRequestBody(req);
    writeJson(
      res,
      413,
      { error: 'Payload too large', code: 'dataset_too_large' },
      traceId,
    );
    return;
  }

  let sessionAccess;
  try {
    // Resolve the formal owner before any byte is read or forwarded to
    // Sandbox. Agent maps the external browser subject to internal ULIDs.
    sessionAccess = await authorizeSandboxSession(sessionId, req, {
      conversationId,
      traceId,
    });
  } catch (err) {
    discardRequestBody(req);
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

  const headers = sandboxProxyHeaders(req, {
    'Content-Type': contentType,
    'X-Trace-Id': traceId,
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
    if (req.aborted || req.complete === false) abortUpstream();
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abortUpstream();
  };
  req.once?.('aborted', onRequestAborted);
  req.once?.('close', onRequestClose);
  res.once?.('close', onResponseClose);

  const bounded = createBoundedDatasetUploadBody(req, maxBytes);
  try {
    const sanRes = await fetch(
      `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/datasets`,
      {
        method: 'POST',
        headers,
        body: bounded.stream,
        duplex: 'half',
        signal: upstreamAbort.signal,
      },
    );

    const text = await sanRes.text();
    let data;
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
            ...data,
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
  } catch (err) {
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
 * @param {URL} parsedUrl
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleListDatasets(
  parsedUrl,
  res,
  req = null,
  conversationId = null,
) {
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
    const headers = sandboxProxyHeaders(
      req,
      {
        'X-Trace-Id': traceId,
        ...datasetOwnershipHeaders(req, { conversationId }),
      },
      sessionAccess.sandboxAuth,
    );
    const sanRes = await fetch(
      `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/datasets`,
      { headers },
    );
    const text = await sanRes.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || 'Invalid sandbox response' };
    }
    writeJson(res, sanRes.status, data, sanRes.headers.get('x-trace-id') || traceId);
  } catch (err) {
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

/**
 * Improve artifact download with client disconnect abort + backpressure.
 * Re-exported behaviour used by files.js handleArtifactDownload — kept here
 * for dataset/artifact PR cohesion tests.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ReadableStream|AsyncIterable} body
 */
export async function pipeWithBackpressure(req, res, body) {
  let aborted = false;
  const onClose = () => {
    aborted = true;
  };
  req.on('close', onClose);
  try {
    for await (const chunk of body) {
      if (aborted || res.writableEnded || res.destroyed) break;
      const ok = res.write(chunk);
      if (!ok) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}
