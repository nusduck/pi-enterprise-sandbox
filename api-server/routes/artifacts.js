/**
 * Route: GET /api/artifacts?session_id= — list artifacts for a sandbox session
 */
import * as sb from '../services/sandbox-client.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * GET /api/artifacts?session_id=
 */
export async function handleListArtifacts(parsedUrl, res) {
  const sessionId = parsedUrl.searchParams.get('session_id');
  if (!sessionId) {
    json(res, 400, { error: 'session_id is required' });
    return;
  }
  try {
    const data = await sb.listArtifacts(sessionId);
    json(res, 200, data);
  } catch (err) {
    console.error('[artifacts] list:', err.message);
    json(res, err.status || 500, { error: err.message || 'Failed to list artifacts' });
  }
}
