/** Artifact list and cross-conversation Import routes. */
import { createSandboxClient } from '../services/sandbox-client.js';
import {
  authorizeSandboxSession,
  resolveTrustedAuth,
} from '../application/run-access-service.js';
import { ensureAgentSession } from '../services/agent-client.js';

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

/**
 * POST /api/conversations/:conversationId/artifact-imports
 * Body: { artifact_id, target_filename? }
 */
export async function handleImportArtifact(
  conversationId,
  body,
  res,
  req = null,
) {
  const artifactId = String(body?.artifact_id || body?.artifactId || '').trim();
  const targetFilenameRaw =
    body?.target_filename ?? body?.targetFilename ?? null;
  const targetFilename =
    targetFilenameRaw == null ? null : String(targetFilenameRaw).trim();

  if (!artifactId) {
    json(res, 400, {
      error: 'artifact_id is required',
      code: 'artifact_id_required',
    });
    return;
  }
  if (targetFilenameRaw != null && (!targetFilename || targetFilename.length > 256)) {
    json(res, 400, {
      error: 'target_filename must be between 1 and 256 characters',
      code: 'target_filename_invalid',
    });
    return;
  }

  try {
    const auth = await resolveTrustedAuth(req);
    const target = await ensureAgentSession(conversationId, {
      auth,
      traceId: req?.traceId || null,
    });
    const sessionId = String(target?.session_id || '').trim();
    if (!sessionId) {
      const error = new Error('Target session unavailable');
      error.status = 503;
      error.code = 'target_session_unavailable';
      throw error;
    }

    // Resolve formal owner IDs through Agent before the Sandbox hop. Browser
    // identities are external IDs and must never be forwarded as Artifact
    // owner scope.
    const sessionAccess = await authorizeSandboxSession(sessionId, req, {
      conversationId,
      traceId: req?.traceId || null,
    });
    const client = createSandboxClient({
      auth: sessionAccess.sandboxAuth,
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    const data = await client.importArtifact(
      sessionId,
      artifactId,
      targetFilename,
    );
    json(res, 201, {
      ...data,
      target_conversation_id:
        data?.target_conversation_id || conversationId,
      target_session_id: data?.target_session_id || sessionId,
    });
  } catch (err) {
    console.error('[artifacts] import:', err.message);
    const status = Number(err?.status) || 500;
    json(res, status, {
      error:
        status >= 500
          ? 'Artifact import unavailable'
          : err.message || 'Artifact import failed',
      code: err?.code,
    });
  }
}
