/**
 * Routes: file download / upload / artifact-download proxy to Sandbox.
 *
 * Upload streams the inbound request (or a temp-file spill) to Sandbox so large
 * multipart bodies are never held fully in the Node heap.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sb from '../services/sandbox-client.js';
import { config, AUTH_HEADER } from '../config.js';
import {
  authorizeSandboxSession,
  requireSessionWorkspaceId,
  type ReqWithTrace,
} from '../application/run-access-service.js';
import {
  boundRequestTraceContext,
  createTraceId,
  resolveRequestTraceContext,
  traceCarrierHeaders,
} from '../application/trace-context.js';

/**
 * Upload streams the request body up before Sandbox answers, so its deadline
 * has to cover the transfer, not just Sandbox think time. Downloads only wait
 * for headers — the body is piped out afterwards, unbounded by design.
 */
export const UPLOAD_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Bounded proxy fetch to Sandbox (AGENTS.md §2 — no unbounded outbound call).
 *
 * The deadline covers everything up to the response headers, then is cleared:
 * a stalled Sandbox can no longer pin a browser request and a BFF socket open,
 * while a large body still streams for as long as it needs.
 */
export async function fetchSandboxBounded(
  url: string,
  init: RequestInit = {},
  deadlineMs: number = config.SANDBOX_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const { signal: externalSignal, ...rest } = init;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = setTimeout(() => controller.abort(), deadlineMs);
  const onAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await fetch(url, { ...rest, signal: controller.signal });
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return resp;
  } catch (err) {
    // A caller-driven abort (browser hung up) keeps its own error.
    if (controller.signal.aborted && !externalSignal?.aborted) {
      const timeout = new Error(
        `Sandbox request timed out after ${deadlineMs}ms`,
      ) as Error & { code: string; status: number };
      timeout.code = 'SANDBOX_TIMEOUT';
      timeout.status = 504;
      throw timeout;
    }
    throw err;
  } finally {
    if (timer !== null) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Write a 504 for a Sandbox proxy deadline; rethrow anything else.
 */
function handleSandboxProxyError(err: any, res: ServerResponse, message: string): void {
  if (err?.code !== 'SANDBOX_TIMEOUT') throw err;
  if (!res.headersSent) {
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message, code: 'SANDBOX_TIMEOUT' }));
  } else if (!res.writableEnded) {
    res.end();
  }
}

/**
 * Headers for sandbox file proxies: service key + browser Bearer (never acting*).
 */
export function sandboxProxyHeaders(
  req: IncomingMessage | ReqWithTrace | null | undefined,
  extra: Record<string, string> = {},
  trustedAuth: any = null,
): Record<string, string> {
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
  const h: Record<string, string> = { ...AUTH_HEADER, ...safeExtra };
  // Once Agent has resolved the formal owner, use only the service token plus
  // acting headers. Forwarding a browser JWT here would take precedence in
  // Sandbox actor resolution and reintroduce the external/internal ID-domain
  // mismatch this hop is responsible for avoiding — so a missing trustedAuth
  // is a programming error, never a reason to fall back to the browser token.
  if (!trustedAuth?.actingUserId || !trustedAuth?.actingOrganizationId) {
    throw new Error(
      'sandboxProxyHeaders requires a resolved trustedAuth (actingUserId + actingOrganizationId)',
    );
  }
  h['X-Acting-User-Id'] = String(trustedAuth.actingUserId);
  h['X-Acting-Organization-Id'] = String(trustedAuth.actingOrganizationId);
  if (trustedAuth.actingRole) h['X-Acting-Role'] = String(trustedAuth.actingRole);
  // Forward the BFF's current W3C span, including opaque tracestate. Direct
  // route-unit callers get a fresh valid context instead of a UUID-shaped id.
  const context =
    (req as ReqWithTrace)?.traceContext ||
    boundRequestTraceContext(trustedAuth) ||
    resolveRequestTraceContext(req?.headers || {
      'X-Trace-Id': safeExtra['X-Trace-Id'],
      traceparent: safeExtra['traceparent'],
      tracestate: safeExtra['tracestate'],
    });
  Object.assign(h, traceCarrierHeaders(context));
  return h;
}


export function resolveUploadTraceId(req: IncomingMessage | ReqWithTrace | null | undefined): string {
  const fromReq =
    (req && (req.headers['x-trace-id'] || req.headers['X-Trace-Id'])) || null;
  if (fromReq) return String(fromReq);
  return createTraceId();
}

/**
 * Map sandbox error body into a stable BFF envelope.
 * Preserves structured `{code, message}` detail when present.
 */
export function mapUploadErrorBody(status: number, data: any, traceId?: string | null): any {
  const withTrace = (obj: any) => {
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
 */
export function discardRequestBody(req: IncomingMessage | null | undefined, res: ServerResponse | null = null): void {
  if (!req) return;
  try {
    req.resume?.();
  } catch { /* ignore */ }

  const destroy = () => {
    try {
      if (req.complete !== true) req.destroy?.();
    } catch { /* ignore */ }
  };

  if (!res || typeof res.once !== 'function') {
    destroy();
    return;
  }
  res.once('finish', destroy);
  res.once('close', destroy);
}

/**
 * Write a JSON response with X-Trace-Id for upload correlation.
 */
function writeUploadJson(res: ServerResponse, status: number, body: unknown, traceId?: string | null): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (traceId) headers['X-Trace-Id'] = traceId;
  const payload =
    traceId && body && typeof body === 'object' && (body as any).trace_id == null
      ? { ...(body as any), trace_id: traceId }
      : body;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

/**
 * Spill an IncomingMessage body to a temp file (streaming, not heap buffer).
 */
export async function spillRequestToTempFile(
  req: IncomingMessage,
  maxBytes: number = 60 * 1024 * 1024,
): Promise<{ dir: string; filePath: string; size: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-upload-'));
  const filePath = join(dir, 'body.bin');
  let size = 0;
  const out = createWriteStream(filePath);

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: any) => {
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
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          const err = new Error('Payload too large') as Error & { code: string; status: number };
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
      const onErr = (err: any) => fail(err);
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
export async function handleFileDownload(
  parsedUrl: URL,
  res: ServerResponse,
  req: (IncomingMessage & ReqWithTrace) | null = null,
): Promise<void> {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const filePath = parsedUrl.searchParams.get('path');

  if (!sessionId || !filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id and path required' }));
    return;
  }

  let sessionAccess;
  let workspaceId: string;
  try {
    sessionAccess = await authorizeSandboxSession(sessionId, req, {
      traceId: req?.traceId || null,
    });
    workspaceId = requireSessionWorkspaceId(sessionAccess);
  } catch (err: any) {
    const status = Number(err?.status) || 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: status >= 500 ? 'File service unavailable' : err.message,
      code: err?.code,
    }));
    return;
  }

  const sanUrl = `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(workspaceId)}/files/download?path=${encodeURIComponent(filePath)}`;
  let sanRes: Response;
  try {
    sanRes = await fetchSandboxBounded(sanUrl, {
      headers: sandboxProxyHeaders(req, {}, sessionAccess.sandboxAuth),
    });
  } catch (err) {
    handleSandboxProxyError(err, res, 'File service timed out');
    return;
  }

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

  if (sanRes.body) {
    for await (const chunk of sanRes.body as any) {
      res.write(chunk);
    }
  }
  res.end();
}

function isAsciiHeaderValue(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && /^[\x20-\x7E]+$/.test(value) && !/[\r\n]/.test(value);
}

function asciiFilenameFallback(name: string): string {
  const base = String(name || 'download').split(/[/\\]/).pop() || 'download';
  const match = base.match(/(\.[A-Za-z0-9]{1,8})$/);
  const ext = match ? match[1]!.toLowerCase() : '';
  const body = ext ? base.slice(0, -ext.length) : base;
  let ascii = '';
  for (const ch of body) {
    const code = ch.codePointAt(0)!;
    ascii += code >= 0x20 && code <= 0x7e ? ch : '_';
  }
  ascii = ascii.replace(/[_\s.]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'download';
  return `${ascii}${ext}`.slice(0, 200);
}

/**
 * Prefer Sandbox Content-Disposition. Never fall back to the ULID artifact_id —
 * that name has no extension, so browsers save as `artifact-download`.
 */
export function artifactDownloadDisposition(headers: Headers | Record<string, string> | null | undefined): string {
  const get = (name: string) => {
    if (!headers) return '';
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) || '';
    return (headers as Record<string, string>)[name] || (headers as Record<string, string>)[name.toLowerCase()] || '';
  };
  const disposition = get('content-disposition');
  if (disposition && /filename\s*\*?=/i.test(disposition) && isAsciiHeaderValue(disposition)) {
    return disposition;
  }
  const encoded = get('x-artifact-filename');
  if (isAsciiHeaderValue(encoded)) {
    let decoded = 'download';
    try {
      decoded = decodeURIComponent(encoded) || 'download';
    } catch {
      decoded = 'download';
    }
    const ascii = asciiFilenameFallback(decoded);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  }
  return 'attachment; filename="download"';
}


/**
 * GET /api/files/artifact-download?session_id=xxx&artifact_id=yyy
 * Stream a registered artifact (P7 / PR-09 deliverable path).
 *
 * Ownership is enforced by Sandbox (session + actor). BFF never accepts an
 * arbitrary workspace path as an artifact — only artifact_id.
 * Streams with backpressure; client disconnect stops the pipe.
 */
export async function handleArtifactDownload(
  parsedUrl: URL,
  res: ServerResponse,
  req: (IncomingMessage & ReqWithTrace) | null = null,
): Promise<void> {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const artifactId = parsedUrl.searchParams.get('artifact_id');

  if (!sessionId || !artifactId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id and artifact_id required' }));
    return;
  }

  let sessionAccess;
  let workspaceId: string;
  try {
    sessionAccess = await authorizeSandboxSession(sessionId, req, {
      traceId: req?.traceId || null,
    });
    workspaceId = requireSessionWorkspaceId(sessionAccess);
  } catch (err: any) {
    const status = Number(err?.status) || 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: status >= 500 ? 'Artifact service unavailable' : err.message,
      code: err?.code,
    }));
    return;
  }

  const sanPath = sb.artifactDownloadPath(workspaceId, artifactId);
  const sanUrl = `${config.SANDBOX_BASE_URL}${sanPath}`;
  let sanRes: Response;
  try {
    sanRes = await fetchSandboxBounded(sanUrl, {
      headers: sandboxProxyHeaders(req, {}, sessionAccess.sandboxAuth),
    });
  } catch (err) {
    handleSandboxProxyError(err, res, 'Artifact service timed out');
    return;
  }

  if (!sanRes.ok) {
    res.writeHead(sanRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Artifact not found in sandbox' }));
    return;
  }

  const contentType = sanRes.headers.get('content-type') || 'application/octet-stream';
  // Type safety: never forward HTML/SVG as navigable content
  const safeType =
    /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)/i.test(contentType)
      ? 'application/octet-stream'
      : contentType;

  const headers: Record<string, string> = {
    'Content-Type': safeType,
    'Content-Disposition': artifactDownloadDisposition(sanRes.headers),
    'X-Content-Type-Options': 'nosniff',
  };
  const encodedName = sanRes.headers.get('x-artifact-filename');
  if (encodedName && isAsciiHeaderValue(encodedName)) {
    headers['X-Artifact-Filename'] = encodedName;
  }
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
      (sanRes.body as any)?.cancel?.();
    } catch { /* ignore */ }
  };
  if (req) req.on('close', onClose);

  try {
    if (!sanRes.body) {
      res.end();
      return;
    }
    for await (const chunk of sanRes.body as any) {
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
 */
export async function handleFileUpload(
  parsedUrl: URL,
  req: IncomingMessage & ReqWithTrace,
  res: ServerResponse,
): Promise<void> {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const traceId = resolveUploadTraceId(req);

  if (!sessionId) {
    discardRequestBody(req, res);
    writeUploadJson(res, 400, { error: 'session_id required' }, traceId);
    return;
  }

  const contentType = req.headers['content-type'] || 'application/octet-stream';
  const idem =
    req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || null;

  // Prefer Content-Length based limit (~50MB file + multipart overhead)
  const maxBytes = 55 * 1024 * 1024;
  const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
  if (declared > maxBytes) {
    // Drain/destroy so the client is not stuck sending a rejected body.
    discardRequestBody(req, res);
    writeUploadJson(
      res,
      413,
      { error: 'Payload too large', code: 'attachment_too_large' },
      traceId,
    );
    return;
  }

  let sessionAccess;
  let workspaceId: string;
  try {
    sessionAccess = await authorizeSandboxSession(sessionId, req, { traceId });
    workspaceId = requireSessionWorkspaceId(sessionAccess);
  } catch (err: any) {
    discardRequestBody(req, res);
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

  let spill: { dir: string; filePath: string; size: number } | null = null;
  try {
    // Stream inbound body to temp file (not heap Buffer.concat)
    spill = await spillRequestToTempFile(req, maxBytes);
  } catch (err: any) {
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
    const sanRes = await fetchSandboxBounded(
      `${config.SANDBOX_BASE_URL}/sessions/${encodeURIComponent(workspaceId)}/files/upload`,
      {
        method: 'POST',
        headers,
        body: bodyStream,
        duplex: 'half',
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
  } catch (err: any) {
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

