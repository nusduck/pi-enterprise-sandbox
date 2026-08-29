/**
 * 内部 Session 端点——POST /internal/v1/sessions/ensure（dsh-rebuild 5.6）。
 *
 * 职责：幂等地确保 `workspaceId` 对应的物理工作区 + 持久 temp 已就绪。
 * 复用 `WorkspaceManager.initWorkspace()`，幂等且 0700。
 */

import { internalClaimsByRequest } from './internal-claims.js';
import type { Hono } from 'hono';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import { parseEnvelope } from '@pi/contract/envelope.js';
import type { WorkspaceManager } from '../workspace/manager.js';

function workspaceIdFromBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  }
  const rec = body as Record<string, unknown>;
  if (rec['envelope'] != null) {
    return parseEnvelope(rec['envelope']).workspaceId;
  }
  // Agent internal-session-http sends `{ workspaceId }` (no envelope wrapper).
  const workspaceId = String(rec['workspaceId'] ?? '').trim();
  if (!workspaceId) {
    throw new ContractError('ENVELOPE_INVALID', 'workspaceId is required');
  }
  return workspaceId;
}

export function registerInternalSessionRoutes(app: Hono, deps: { workspaceManager: WorkspaceManager }): void {
  app.post('/internal/v1/sessions/ensure', async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      const workspaceId = workspaceIdFromBody(body);
      const roots = await deps.workspaceManager.initWorkspace(workspaceId);
      const claims = internalClaimsByRequest.get(c.req.raw);
      return c.json({
        ok: true,
        data: roots,
        workspaceId,
        sandboxSessionId: claims?.sandbox_session_id ?? null,
        agentSessionId: claims?.agent_session_id ?? null,
        status: 'ACTIVE',
      });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      const status = wire.code === 'ENVELOPE_INVALID' ? 400 : 500;
      return c.json({ ok: false, error: wire }, status as never);
    }
  });
}
