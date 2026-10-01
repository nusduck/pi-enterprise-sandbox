/**
 * 内部 Session 端点——POST /internal/v1/sessions/ensure（dsh-rebuild 5.6）。
 *
 * 职责：幂等地确保 `workspaceId` 对应的物理工作区 + 持久 temp 已就绪。
 * 复用 `WorkspaceManager.initWorkspace()`，幂等且 0700。
 *
 * 2026-10-01（design `agent-output-review.md` §3.1）：同一个请求可以带
 * `delivery: "review"`，把工作区标成「交付物需人工审核」。**只能设置、不能
 * 撤销**——策略在会话创建时按绑定版本固定，一个能撤销的接口就是一个能把
 * 审核关掉的后门，而这条路的调用方是模型可达的。写入失败必须让整个 ensure
 * 失败：回 200 却让审核没生效，比直接报错危险得多。
 */

import { internalClaimsByRequest } from './internal-claims.js';
import type { Hono } from 'hono';
import { ContractError, toWireError } from '@dsh/contract/errors.js';
import { parseEnvelope } from '@dsh/contract/envelope.js';
import { parseSessionDelivery } from '@dsh/contract/delivery-policy.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { WorkspacePolicyStore } from '../db/repositories/workspace-policies.js';

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

/** 请求体里的 `delivery`；形状不对时抛 `ContractError`（→ 400），不静默忽略。 */
function deliveryFromBody(body: unknown): 'review' | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  try {
    return parseSessionDelivery((body as Record<string, unknown>)['delivery']);
  } catch (err) {
    throw new ContractError(
      'ENVELOPE_INVALID',
      err instanceof Error ? err.message : 'delivery is invalid',
    );
  }
}

export function registerInternalSessionRoutes(
  app: Hono,
  deps: { workspaceManager: WorkspaceManager; workspacePolicies: WorkspacePolicyStore },
): void {
  app.post('/internal/v1/sessions/ensure', async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      const workspaceId = workspaceIdFromBody(body);
      const delivery = deliveryFromBody(body);
      const roots = await deps.workspaceManager.initWorkspace(workspaceId);
      const claims = internalClaimsByRequest.get(c.req.raw);
      if (delivery === 'review') {
        // org 只从**已校验的**令牌 claims 取，绝不从请求体取（那会让调用方把
        // 策略写到别的租户名下）。HMAC 面在进这个 handler 之前已经验过令牌。
        const orgId = String(claims?.org_id ?? '').trim();
        if (!orgId) {
          throw new ContractError(
            'ENVELOPE_INVALID',
            'delivery=review requires an organization in the verified token claims',
          );
        }
        await deps.workspacePolicies.rememberReview(workspaceId, orgId);
      }
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
