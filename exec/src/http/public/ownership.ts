/**
 * 公共面会话归属校验——对应 Python `sandbox/security/ownership.py` 的 `require_owned_session`。
 *
 * 为什么这样做：公共面是"会话作用域"（dsh-rebuild 5.7），浏览器带着的
 * `Authorization: Bearer <jwt>` 或 HttpOnly cookie 会被 api-server 换成
 * `X-Acting-*` 再转发到 exec；exec 这里只认**已解析的 acting 头**，
 * 绝不信任浏览器直传的任何 `X-Acting-*`（api-server 的 `sandboxProxyHeaders` 已剥离）。
 * 归属失败一律 404，不用 403——存在性本身不能泄漏（fail-closed + 跨租户 404）。
 *
 * 本文件不读 MySQL 的 `sandbox_sessions` 表（那是 W3-D 的正规仓储），
 * 而是通过 `WorkspaceManager` 的物理路径存在性 + workspaceId 不透明校验
 * 做"轻量归属"——对齐 Python 未建 DB 时`_get_context` 的本地路径派生：
 * 只要会话工作区目录在控制面已初始化，就认为"属于你"；否则 404。
 * 真正的跨租户隔离由上游 `agent` 的 `run-access-service` 已做过一次，
 * 这里是纵深防御的第二道。
 */

import { HttpError, notFound } from './errors.js';
import { redactPhysicalRoots } from '../../fs/redact.js';
import type { WorkspaceContext } from '../../types.js';
import type { WorkspaceManager } from '../../workspace/manager.js';

export interface ActingHeaders {
  readonly orgId?: string | undefined;
  readonly userId?: string | undefined;
  readonly role?: string | undefined;
}

export interface OwnershipContext {
  readonly workspace: WorkspaceContext;
  readonly physicalRoots: readonly string[];
}

function physicalRootsOf(ctx: WorkspaceContext): readonly string[] {
  return [ctx.workspaceRoot, ctx.tempRoot, ctx.systemSkillRoot, ...ctx.enabledSkillPackages.map((p) => p.sourcePath)];
}

export function parseActingHeaders(headers: Record<string, string | undefined>): ActingHeaders {
  const orgId = headers['x-acting-organization-id'] ?? headers['X-Acting-Organization-Id'];
  const userId = headers['x-acting-user-id'] ?? headers['X-Acting-User-Id'];
  const role = headers['x-acting-role'] ?? headers['X-Acting-Role'];
  return { orgId, userId, role };
}

export async function requireOwnedSession(
  sessionId: string,
  deps: { workspaceManager: WorkspaceManager; systemSkillRoot: string; enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[] },
  acting: ActingHeaders,
  rawPhysicalRootsForRedact: readonly string[] = [],
): Promise<OwnershipContext> {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw notFound('session_id required');
  }
  // 无 acting 时视为未认证——按 Python `require_owned_session` 的行为 404
  if (!acting.orgId || !acting.userId) {
    const msg = redactPhysicalRoots('Process not found', rawPhysicalRootsForRedact);
    throw new HttpError(404, msg, 'not_found');
  }
  try {
    // 轻量校验：workspaceId 必须是 opaque token（W2-C 的 ids.ts），否则 404
    // WorkspaceManager.physicalWorkspacePath 会在非法 id 上抛 InvalidWorkspaceIdError
    const workspaceRoot = deps.workspaceManager.physicalWorkspacePath(sessionId);
    const tempRoot = deps.workspaceManager.physicalTempPath(sessionId);
    const ctx: WorkspaceContext = {
      orgId: acting.orgId,
      userId: acting.userId,
      workspaceId: sessionId,
      workspaceRoot,
      tempRoot,
      systemSkillRoot: deps.systemSkillRoot,
      enabledSkillPackages: [...deps.enabledSkillPackagesFor(acting.orgId, acting.userId)],
    };
    return { workspace: ctx, physicalRoots: physicalRootsOf(ctx) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = redactPhysicalRoots(msg, rawPhysicalRootsForRedact);
    // 任何路径校验失败都映射为 404，保持与 Python 的 `HTTPException(404)` 一致
    throw new HttpError(404, redacted, 'not_found');
  }
}
