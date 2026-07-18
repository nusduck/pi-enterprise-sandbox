/**
 * Dataset streaming proxy (PR-09 / plan §17).
 *
 * POST /api/conversations/:conversationId/datasets?session_id=
 *   Streams multipart body to Sandbox without holding the full file in the
 *   Node heap (temp spill with backpressure, then stream to Sandbox).
 *
 * GET  /api/conversations/:conversationId/datasets?session_id=
 * GET  /api/datasets?session_id=
 */
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { config } from '../config.js';
import * as sb from '../services/sandbox-client.js';
import { authFromRequest } from '../services/sandbox-client.js';
import { resolveTrustedAuth } from '../application/run-access-service.js';
import {
  discardRequestBody,
  mapUploadErrorBody,
  resolveUploadTraceId,
  sandboxProxyHeaders,
  spillRequestToTempFile,
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

  const contentType = req.headers['content-type'] || 'application/octet-stream';
  // Same envelope as attachment proxy (~50MB file + multipart overhead)
  const maxBytes = 55 * 1024 * 1024;
  const declared = parseInt(req.headers['content-length'] || '0', 10);
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

  let spill = null;
  try {
    // Stream inbound body to temp file (not heap Buffer.concat)
    spill = await spillRequestToTempFile(req, maxBytes);
  } catch (err) {
    if (err && (err.status === 413 || err.code === 'attachment_too_large' || err.code === 'dataset_too_large')) {
      writeJson(
        res,
        413,
        {
          error: err.message || 'Payload too large',
          code: 'dataset_too_large',
        },
        traceId,
      );
      return;
    }
    console.error('[datasets] spill failed:', err);
    writeJson(res, 500, { error: 'Upload failed' }, traceId);
    return;
  }

  try {
    const size = spill.size || (await stat(spill.filePath)).size;
    let ownerCtx = { conversationId };
    try {
      const auth = await resolveTrustedAuth(req);
      if (auth?.actingOrganizationId) {
        ownerCtx = {
          ...ownerCtx,
          orgId: auth.actingOrganizationId,
          userId: auth.actingUserId,
        };
      }
    } catch {
      // resolveTrustedAuth may 401 when auth required; sandbox will enforce.
    }
    const headers = sandboxProxyHeaders(req, {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'X-Trace-Id': traceId,
      ...datasetOwnershipHeaders(req, ownerCtx),
    });

    // Pipe spill → sandbox with duplex stream (no full-buffer re-read into heap)
    const bodyStream = createReadStream(spill.filePath);
    const sanRes = await fetch(
      `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/datasets`,
      {
        method: 'POST',
        headers,
        body: bodyStream,
        duplex: 'half',
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
        ? { ...data, conversation_id: data.conversation_id || conversationId, trace_id: data.trace_id || sandboxTrace }
        : data;
    writeJson(res, sanRes.status === 200 ? 201 : sanRes.status || 201, successBody, sandboxTrace);
  } catch (err) {
    console.error('[datasets] upload proxy failed:', err);
    writeJson(res, 500, { error: err.message || 'Upload failed' }, traceId);
  } finally {
    if (spill?.dir) {
      rm(spill.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * GET list datasets for a session.
 * @param {URL} parsedUrl
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleListDatasets(parsedUrl, res, req = null) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const traceId = resolveUploadTraceId(req);
  if (!sessionId) {
    writeJson(res, 400, { error: 'session_id required' }, traceId);
    return;
  }
  try {
    const headers = sandboxProxyHeaders(req, datasetOwnershipHeaders(req));
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
    writeJson(res, err.status || 500, { error: err.message || 'Failed to list datasets' }, traceId);
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
