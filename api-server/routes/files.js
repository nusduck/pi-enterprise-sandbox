/**
 * Routes: file download / upload / artifact-download proxy to Sandbox.
 */
import * as sb from '../services/sandbox-client.js';
import { authFromRequest } from '../services/sandbox-client.js';
import { config, AUTH_HEADER } from '../config.js';

/**
 * Headers for sandbox file proxies: service key + browser Bearer (never acting*).
 * @param {import('node:http').IncomingMessage | null | undefined} req
 */
function sandboxProxyHeaders(req, extra = {}) {
  const h = { ...AUTH_HEADER, ...extra };
  const auth = authFromRequest(req);
  if (auth.authorization) {
    h.Authorization = auth.authorization;
  }
  return h;
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

  const sanUrl = `${config.SANDBOX_BASE_URL}/sessions/${sessionId}/files/download?path=${encodeURIComponent(filePath)}`;
  const sanRes = await fetch(sanUrl, { headers: sandboxProxyHeaders(req) });

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
  });

  for await (const chunk of sanRes.body) {
    res.write(chunk);
  }
  res.end();
}

/**
 * GET /api/files/artifact-download?session_id=xxx&artifact_id=yyy
 * Stream a registered artifact (P7 deliverable path).
 */
export async function handleArtifactDownload(parsedUrl, res, req = null) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const artifactId = parsedUrl.searchParams.get('artifact_id');

  if (!sessionId || !artifactId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id and artifact_id required' }));
    return;
  }

  const sanPath = sb.artifactDownloadPath(sessionId, artifactId);
  const sanUrl = `${config.SANDBOX_BASE_URL}${sanPath}`;
  const sanRes = await fetch(sanUrl, { headers: sandboxProxyHeaders(req) });

  if (!sanRes.ok) {
    res.writeHead(sanRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Artifact not found in sandbox' }));
    return;
  }

  const disposition = sanRes.headers.get('content-disposition')
    || `attachment; filename="${artifactId}"`;

  res.writeHead(200, {
    'Content-Type': sanRes.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': disposition,
    'Content-Length': sanRes.headers.get('content-length') || '',
  });

  for await (const chunk of sanRes.body) {
    res.write(chunk);
  }
  res.end();
}

/**
 * POST /api/files/upload?session_id=xxx
 * Forward raw multipart body to sandbox.
 */
export async function handleFileUpload(parsedUrl, rawBody, contentType, res, req = null) {
  const sessionId = parsedUrl.searchParams.get('session_id');

  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id required' }));
    return;
  }

  const sanRes = await fetch(`${config.SANDBOX_BASE_URL}/sessions/${sessionId}/files/upload`, {
    method: 'POST',
    headers: sandboxProxyHeaders(req, {
      'Content-Type': contentType,
      'Content-Length': String(rawBody.length),
    }),
    body: rawBody,
  });

  const data = await sanRes.json();
  const status = sanRes.ok ? 201 : sanRes.status;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
