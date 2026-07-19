/**
 * Routes: file download / upload / artifact-download proxy to Sandbox.
 *
 * Upload streams the inbound request (or a temp-file spill) to Sandbox so large
 * multipart bodies are never held fully in the Node heap.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sb from '../services/sandbox-client.js';
import { authFromRequest } from '../services/sandbox-client.js';
import { config, AUTH_HEADER } from '../config.js';
import { authorizeSandboxSession } from '../application/run-access-service.js';
import {
  boundRequestTraceContext,
  createTraceId,
  resolveRequestTraceContext,
  traceCarrierHeaders,
} from '../application/trace-context.js';

/**
 * Headers for sandbox file proxies: service key + browser Bearer (never acting*).
 * @param {import('node:http').IncomingMessage | null | undefined} req
 * @param {Record<string, string>} [extra]
 * @param {{ actingUserId?: string, actingOrganizationId?: string, actingRole?: string } | null} [trustedAuth]
 */
export function sandboxProxyHeaders(req, extra = {}, trustedAuth = null) {
  // Never copy acting headers from the browser. The optional third argument is
  // populated only after BFF-side identity resolution and is therefore safe to
  // use for Sandbox's owner-scoped public adapters.
  const safeExtra = { ...extra };
  for (const key of [
    'X-Acting-User-Id',
    'X-Acting-Organization-Id',
    'X-Acting-Role',
    'x-acting-user-id',
    'x-acting-organization-id',
    'x-acting-role',
  ]) {
    delete safeExtra[key];
  }
  const h = { ...AUTH_HEADER, ...safeExtra };
  if (trustedAuth?.actingUserId && trustedAuth?.actingOrganizationId) {
    h['X-Acting-User-Id'] = String(trustedAuth.actingUserId);
    h['X-Acting-Organization-Id'] = String(trustedAuth.actingOrganizationId);
    if (trustedAuth.actingRole) h['X-Acting-Role'] = String(trustedAuth.actingRole);
  }
  const auth = authFromRequest(req);
  // Once Agent has resolved the formal owner, use only the service token plus
  // acting headers. Forwarding a browser JWT here would take precedence in
  // Sandbox actor resolution and reintroduce the external/internal ID-domain
  // mismatch this hop is responsible for avoiding.
  if (!trustedAuth && auth.authorization) {
    h.Authorization = auth.authorization;
  }
  // Forward the BFF's current W3C span, including opaque tracestate. Direct
  // route-unit callers get a fresh valid context instead of a UUID-shaped id.
  const context =
    req?.traceContext ||
    boundRequestTraceContext(trustedAuth) ||
    resolveRequestTraceContext(req?.headers || {
      'X-Trace-Id': safeExtra['X-Trace-Id'],
      traceparent: safeExtra.traceparent,
      tracestate: safeExtra.tracestate,
    });
  Object.assign(h, traceCarrierHeaders(context));
  return h;
}

/**
 * Resolve a stable X-Trace-Id for an upload request (browser → BFF → sandbox).
 * @param {import('node:http').IncomingMessage | null | undefined} req
 * @param {string} [fallback]
 */
export function resolveUploadTraceId(req, fallback) {
  const fromReq =
    (req && (req.headers['x-trace-id'] || req.headers['X-Trace-Id'])) || null;
  if (fromReq) return String(fromReq);
  if (fallback) return String(fallback);
  return createTraceId();
}

/**
 * Map sandbox error body into a stable BFF envelope.
 * Preserves structured `{code, message}` detail when present.
 * @param {number} status
 * @param {any} data
 * @param {string} [traceId]
 */
export function mapUploadErrorBody(status, data, traceId) {
  const withTrace = (obj) => {
    if (traceId && obj && obj.trace_id == null) obj.trace_id = traceId;
    return obj;
  };
  if (data && typeof data === 'object') {
    const detail = data.detail;
    if (detail && typeof detail === 'object' && detail.code) {
      return withTrace({
        error: detail.message || detail.code,
        code: detail.code,
        detail,
        trace_id: data.trace_id || traceId,
      });
    }
    if (typeof detail === 'string') {
      return withTrace({ error: detail, detail, code: data.code });
    }
    if (data.error) {
      return withTrace({
        error: data.error,
        code: data.code || undefined,
        detail: data.detail,
        trace_id: data.trace_id,
      });
    }
  }
  if (status === 413) {
    return withTrace({
      error: 'Payload too large',
      code: 'attachment_too_large',
    });
  }
  return withTrace({ error: (data && data.error) || 'Upload failed' });
}

/**
 * Stop reading the inbound body so early error responses do not leave the
 * socket half-open while the client keeps sending multipart data.
 * @param {import('node:http').IncomingMessage | null | undefined} req
 */
export function discardRequestBody(req) {
  if (!req) return;
  try {
    req.resume?.();
  } catch { /* ignore */ }
  try {
    req.destroy?.();
  } catch { /* ignore */ }
}

/**
 * Write a JSON response with X-Trace-Id for upload correlation.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {string} [traceId]
 */
function writeUploadJson(res, status, body, traceId) {
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
 * Spill an IncomingMessage body to a temp file (streaming, not heap buffer).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<{ dir: string, filePath: string, size: number }>}
 */
export async function spillRequestToTempFile(req, maxBytes = 60 * 1024 * 1024) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-upload-'));
  const filePath = join(dir, 'body.bin');
  let size = 0;
  const out = createWriteStream(filePath);

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          req.removeListener?.('data', onData);
          req.removeListener?.('end', onEnd);
          req.removeListener?.('error', onErr);
        } catch { /* ignore */ }
        out.destroy();
        reject(err);
      };
      const onData = (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          const err = new Error('Payload too large');
          err.code = 'attachment_too_large';
          err.status = 413;
          try { req.destroy?.(); } catch { /* ignore */ }
          fail(err);
          return;
        }
        if (!out.write(chunk)) {
          req.pause?.();
          out.once('drain', () => req.resume?.());
        }
      };
      const onEnd = () => {
        if (settled) return;
        out.end(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      };
      const onErr = (err) => fail(err);
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onErr);
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return { dir, filePath, size };
}

/**
 * GET /api/files/download?session_id=xxx&path=yyy
 * Stream a raw workspace file from sandbox (e.g. user uploads inspection).
 * Agent deliverables should use handleArtifactDownload instead.
 */
export async function handleFileDownload(parsedUrl, res, req = null) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const filePath = parsedUrl.searchParams.get('path');

  if (!sessionId || !filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id and path required' }));
    return;
  }

  let sessionAccess;
  try {
    sessionAccess = await authorizeSandboxSession(sessionId, req, {
      traceId: req?.traceId || null,
    });
  } catch (err) {
    const status = Number(err?.status) || 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: status >= 500 ? 'File service unavailable' : err.message,
      code: err?.code,
    }));
    return;
  }

  const sanUrl = `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/files/download?path=${encodeURIComponent(filePath)}`;
  const sanRes = await fetch(sanUrl, {
    headers: sandboxProxyHeaders(req, {}, sessionAccess.sandboxAuth),
  });

  if (!sanRes.ok) {
    res.writeHead(sanRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found in sandbox' }));
    return;
  }

  const disposition = sanRes.headers.get('content-disposition')
    || `attachment; filename="${filePath.split('/').pop()}"`;

  res.writeHead(200, {
    'Content-Type': sanRes.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': disposition,
    'Content-Length': sanRes.headers.get('content-length') || '',
    'X-Trace-Id': sanRes.headers.get('x-trace-id') || '',
  });

  for await (const chunk of sanRes.body) {
    res.write(chunk);
  }
  res.end();
}

/**
 * GET /api/files/artifact-download?session_id=xxx&artifact_id=yyy
 * Stream a registered artifact (P7 / PR-09 deliverable path).
 *
 * Ownership is enforced by Sandbox (session + actor). BFF never accepts an
 * arbitrary workspace path as an artifact — only artifact_id.
 * Streams with backpressure; client disconnect stops the pipe.
 */
export async function handleArtifactDownload(parsedUrl, res, req = null) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const artifactId = parsedUrl.searchParams.get('artifact_id');

  if (!sessionId || !artifactId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id and artifact_id required' }));
    return;
  }

  let sessionAccess;
  try {
    sessionAccess = await authorizeSandboxSession(sessionId, req, {
      traceId: req?.traceId || null,
    });
  } catch (err) {
    const status = Number(err?.status) || 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: status >= 500 ? 'Artifact service unavailable' : err.message,
      code: err?.code,
    }));
    return;
  }

  const sanPath = sb.artifactDownloadPath(sessionId, artifactId);
  const sanUrl = `${config.SANDBOX_BASE_URL}${sanPath}`;
  const sanRes = await fetch(sanUrl, {
    headers: sandboxProxyHeaders(req, {}, sessionAccess.sandboxAuth),
  });

  if (!sanRes.ok) {
    res.writeHead(sanRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Artifact not found in sandbox' }));
    return;
  }

  const disposition = sanRes.headers.get('content-disposition')
    || `attachment; filename="${artifactId}"`;
  const contentType = sanRes.headers.get('content-type') || 'application/octet-stream';
  // Type safety: never forward HTML/SVG as navigable content
  const safeType =
    /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)/i.test(contentType)
      ? 'application/octet-stream'
      : contentType;

  const headers = {
    'Content-Type': safeType,
    'Content-Disposition': disposition,
    'X-Content-Type-Options': 'nosniff',
  };
  const len = sanRes.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  const sha = sanRes.headers.get('x-artifact-sha256');
  if (sha) headers['X-Artifact-Sha256'] = sha;
  const trace = sanRes.headers.get('x-trace-id');
  if (trace) headers['X-Trace-Id'] = trace;

  res.writeHead(200, headers);

  let aborted = false;
  const onClose = () => {
    aborted = true;
    try {
      sanRes.body?.cancel?.();
    } catch { /* ignore */ }
  };
  if (req) req.on('close', onClose);

  try {
    if (!sanRes.body) {
      res.end();
      return;
    }
    for await (const chunk of sanRes.body) {
      if (aborted || res.writableEnded || res.destroyed) break;
      const ok = res.write(chunk);
      if (!ok) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    if (req) req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

/**
 * POST /api/files/upload?session_id=xxx
 * Stream multipart body to sandbox (temp-file spill; no full heap buffer).
 *
 * @param {URL} parsedUrl
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleFileUpload(parsedUrl, req, res) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const traceId = resolveUploadTraceId(req);

  if (!sessionId) {
    discardRequestBody(req);
    writeUploadJson(res, 400, { error: 'session_id required' }, traceId);
    return;
  }

  const contentType = req.headers['content-type'] || 'application/octet-stream';
  const idem =
    req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || null;

  // Prefer Content-Length based limit (~50MB file + multipart overhead)
  const maxBytes = 55 * 1024 * 1024;
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > maxBytes) {
    // Drain/destroy so the client is not stuck sending a rejected body.
    discardRequestBody(req);
    writeUploadJson(
      res,
      413,
      { error: 'Payload too large', code: 'attachment_too_large' },
      traceId,
    );
    return;
  }

  let sessionAccess;
  try {
    sessionAccess = await authorizeSandboxSession(sessionId, req, { traceId });
  } catch (err) {
    discardRequestBody(req);
    const status = Number(err?.status) || 500;
    writeUploadJson(
      res,
      status,
      {
        error: status >= 500 ? 'File service unavailable' : err.message,
        code: err?.code,
      },
      traceId,
    );
    return;
  }

  let spill = null;
  try {
    // Stream inbound body to temp file (not heap Buffer.concat)
    spill = await spillRequestToTempFile(req, maxBytes);
  } catch (err) {
    if (err && (err.status === 413 || err.code === 'attachment_too_large')) {
      writeUploadJson(
        res,
        413,
        {
          error: err.message || 'Payload too large',
          code: 'attachment_too_large',
        },
        traceId,
      );
      return;
    }
    console.error('[files] upload spill failed:', err);
    writeUploadJson(res, 500, { error: 'Upload failed' }, traceId);
    return;
  }

  try {
    const size = spill.size || (await stat(spill.filePath)).size;
    // Propagate the same trace id so browser/BFF/sandbox share one id
    const headers = sandboxProxyHeaders(
      req,
      {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'X-Trace-Id': traceId,
      },
      sessionAccess.sandboxAuth,
    );
    if (idem) {
      headers['Idempotency-Key'] = String(idem);
    }

    // Stream file to sandbox via fetch (Readable stream body)
    const bodyStream = createReadStream(spill.filePath);
    const sanRes = await fetch(
      `${config.SANDBOX_BASE_URL}/sessions/${sessionId}/files/upload`,
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

    const status = sanRes.status === 201 || sanRes.ok ? (sanRes.status || 201) : sanRes.status;
    const sandboxTrace = sanRes.headers.get('x-trace-id') || traceId;

    if (!sanRes.ok) {
      // Normalize 400 size errors to 413 when sandbox still returns 400 for size
      let mappedStatus = status;
      const code =
        (data && data.detail && data.detail.code) ||
        (data && data.code) ||
        '';
      if (
        status === 400 &&
        (code === 'attachment_too_large' || code === 'workspace_quota_exceeded')
      ) {
        mappedStatus = 413;
      }
      writeUploadJson(
        res,
        mappedStatus,
        mapUploadErrorBody(mappedStatus, data, sandboxTrace),
        sandboxTrace,
      );
      return;
    }

    // Echo sandbox payload; ensure trace is always present for correlation
    const successBody =
      data && typeof data === 'object'
        ? { ...data, trace_id: data.trace_id || sandboxTrace }
        : data;
    writeUploadJson(res, status === 200 ? 201 : status, successBody, sandboxTrace);
  } catch (err) {
    console.error('[files] upload proxy failed:', err);
    writeUploadJson(
      res,
      500,
      { error: err.message || 'Upload failed' },
      traceId,
    );
  } finally {
    if (spill?.dir) {
      rm(spill.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
