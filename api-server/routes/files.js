/**
 * Routes: file download / upload proxy to Sandbox.
 */
import * as sb from '../services/sandbox-client.js';
import { config, AUTH_HEADER } from '../config.js';

/**
 * GET /api/files/download?session_id=xxx&path=yyy
 * Stream a file from sandbox workspace to the client.
 */
export async function handleFileDownload(parsedUrl, res) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  const filePath = parsedUrl.searchParams.get('path');

  if (!sessionId || !filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id and path required' }));
    return;
  }

  const sanUrl = `${config.SANDBOX_BASE_URL}/sessions/${sessionId}/files/download?path=${encodeURIComponent(filePath)}`;
  const sanRes = await fetch(sanUrl, { headers: { ...AUTH_HEADER } });

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
 * POST /api/files/upload?session_id=xxx
 * Forward raw multipart body to sandbox.
 */
export async function handleFileUpload(parsedUrl, rawBody, contentType, res) {
  const sessionId = parsedUrl.searchParams.get('session_id');

  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_id required' }));
    return;
  }

  const sanRes = await fetch(`${config.SANDBOX_BASE_URL}/sessions/${sessionId}/files/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(rawBody.length),
      ...AUTH_HEADER,
    },
    body: rawBody,
  });

  const data = await sanRes.json();
  const status = sanRes.ok ? 201 : sanRes.status;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
