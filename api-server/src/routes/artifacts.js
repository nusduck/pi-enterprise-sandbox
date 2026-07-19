/**
 * Route: GET /api/artifacts?session_id= — list artifacts for a sandbox session
 */
import { createSandboxClient } from '../services/sandbox-client.js';
import { authorizeSandboxSession } from '../application/run-access-service.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * GET /api/artifacts?session_id=
 */
export async function handleListArtifacts(parsedUrl, res, req = null) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  if (!sessionId) {
    json(res, 400, { error: 'session_id is required' });
    return;
  }
  try {
    const sessionAccess = await authorizeSandboxSession(sessionId, req, {
      traceId: req?.traceId || null,
    });
    const client = createSandboxClient({ auth: sessionAccess.sandboxAuth });
    const data = await client.listArtifacts(sessionId);
    json(res, 200, data);
  } catch (err) {
    console.error('[artifacts] list:', err.message);
    const status = Number(err?.status) || 500;
    json(res, status, {
      error: status >= 500 ? 'Artifact list unavailable' : err.message || 'Failed to list artifacts',
      code: err?.code,
    });
  }
}
