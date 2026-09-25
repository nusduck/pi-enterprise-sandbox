/** Artifact list and cross-conversation Import routes. */
import type { ServerResponse } from 'node:http';
import { createSandboxClient } from '../services/sandbox-client.js';
import {
  authorizeSandboxSession,
  requireSessionWorkspaceId as requireWorkspaceId,
  resolveTrustedAuth,
  type AuthorizeSandboxSessionResult,
  type ReqWithTrace,
} from '../application/run-access-service.js';
import { ensureAgentSession } from '../services/agent-client.js';
import { resolveOwnerIdentity } from '../services/agent-identity-client.js';

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}


/** Query keys the library forwards to exec; anything else is dropped. */
const LIBRARY_KEYS = ['q', 'kind', 'cursor', 'limit'] as const;

/**
 * GET /api/artifacts (no session_id) — the caller's artifact library across
 * conversations. Owner ids come from the Agent, never from the browser; the
 * exec hop uses the least-privileged role.
 */
async function listLibrary(parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    const owner = await resolveOwnerIdentity({ auth, traceId: req?.traceId || null });
    const client = createSandboxClient({
      auth: { actingUserId: owner.userId, actingOrganizationId: owner.orgId, actingRole: 'user' },
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    const query = new URLSearchParams();
    for (const key of LIBRARY_KEYS) {
      const value = parsedUrl.searchParams.get(key);
      if (value != null && value !== '') query.set(key, value);
    }
    json(res, 200, await client.listLibraryArtifacts(query));
  } catch (err: any) {
    console.error('[artifacts] library:', err.message);
    const status = Number(err?.status) || 500;
    json(res, status, {
      error: status >= 500 ? 'Artifact library unavailable' : err.message || 'Failed to list artifacts',
      code: err?.code,
    });
  }
}

/**
 * GET /api/artifacts?session_id=   — one conversation's artifacts
 * GET /api/artifacts               — the library (see listLibrary)
 */
export async function handleListArtifacts(parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const sessionId = parsedUrl.searchParams.get('session_id');
  if (!sessionId) {
    await listLibrary(parsedUrl, res, req);
    return;
  }
  try {
    const sessionAccess = await authorizeSandboxSession(sessionId, req, {
      traceId: req?.traceId || null,
    });
    const client = createSandboxClient({ auth: sessionAccess.sandboxAuth });
    const data = await client.listArtifacts(requireWorkspaceId(sessionAccess));
    json(res, 200, data);
  } catch (err: any) {
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
  conversationId: string,
  body: any,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<void> {
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
      const error = new Error('Target session unavailable') as Error & { status: number; code: string };
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
    const workspaceId = requireWorkspaceId(sessionAccess);
    const client = createSandboxClient({
      auth: sessionAccess.sandboxAuth,
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    const data = await client.importArtifact(
      workspaceId,
      artifactId,
      targetFilename,
    );
    json(res, 201, {
      ...data,
      target_conversation_id: data?.target_conversation_id || conversationId,
      // The Sandbox hop is keyed by workspace_id, but the public contract
      // remains keyed by the target sandbox session.
      target_session_id: sessionId,
    });
  } catch (err: any) {
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

