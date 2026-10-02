/**
 * 公共面会话归属校验——对应已退役的 Python 执行面（旧 `sandbox/security/ownership.py`，现为本模块）的 `require_owned_session`。
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
import type { WorkspacePolicyStore } from '../../db/repositories/workspace-policies.js';

export interface ActingHeaders {
  readonly orgId?: string | undefined;
  readonly userId?: string | undefined;
  readonly role?: string | undefined;
}

export interface OwnershipContext {
  readonly workspace: WorkspaceContext;
  readonly physicalRoots: readonly string[];
}

/**
 * 这次公共面请求要用工作区做什么（design `agent-output-review.md` §3.3）。
 *
 * 这张表是 E1–E7 的执行口径，三种模式对应**两组不同的判据**：
 *
 * - `read`（默认，最严）：工作区**字节**的读取——列表、读取、预览、下载、
 *   `ls/find/grep`、进程日志、数据集读取。审核工作区里一律 404（E5/E6）。
 *   不关的话发起人能直接下载 `submit_artifact` 的源文件，或者 `cat` 出交付物内容。
 * - `artifact`：**产物面**（E1–E4）。判据不是工作区策略而是**产物可见性**
 *   （`ArtifactService` 只列/只发 `released`）。这里放行不代表泄漏：review 会话
 *   的产物列表本来就该是「只列 released 的空列表」，而不是 404——设计 §3.3 把
 *   E1 写成「只列 released」，不是「拒绝」。
 * - `upload`：写入。**照常允许**（E7）：发起人得能提供材料，而写进去的东西
 *   不会因此泄漏（他读不到这个工作区）。
 *
 * 缺省是 `read`：忘了传模式只会更严，不会放行。
 */
export type WorkspaceAccess = 'read' | 'artifact' | 'upload';

export interface OwnershipDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (
    orgId: string,
    userId: string,
  ) => readonly { name: string; sourcePath: string }[];
  /**
   * 工作区交付策略（ADR 0016 D1）。省略 = 没有工作区需要审核（单测/本地装配）。
   * `createExecApp` 生产与测试装配都会给。
   */
  readonly workspacePolicies?: WorkspacePolicyStore | undefined;
}

function physicalRootsOf(ctx: WorkspaceContext): readonly string[] {
  return [ctx.workspaceRoot, ctx.tempRoot, ctx.systemSkillRoot, ...ctx.enabledSkillPackages.map((p) => p.sourcePath)];
}

/**
 * 审核工作区的**工作区字节**读路径一律 404（design §3.3 E5/E6）。
 *
 * 三个方向都是刻意的：
 * - **404，不是 403**：请求方本来就该认为这个工作区"没有可读的东西"，用 403
 *   等于确认它存在（AGENTS.md §2 跨租户一律 404 的同一条理由）。
 * - **查询失败 → 503**：不能把「策略读不到」当成「不需要审核」，那是 fail-open。
 * - **`artifact` / `upload` 不受影响**：E1–E4 由产物可见性判，E7 明确要求照常上传。
 */
async function assertWorkspaceReadable(
  workspaceId: string,
  deps: OwnershipDeps,
  rawPhysicalRootsForRedact: readonly string[],
  access: WorkspaceAccess,
): Promise<void> {
  if (access !== 'read') return;
  const policies = deps.workspacePolicies;
  if (policies === undefined) return;
  let delivery: Awaited<ReturnType<WorkspacePolicyStore['deliveryOf']>>;
  try {
    delivery = await policies.deliveryOf(workspaceId);
  } catch (err) {
    // 不脱敏物理路径也没关系：这里不把底层错误文本透出去，只给一个稳定码。
    void err;
    const message = redactPhysicalRoots('Workspace not available', rawPhysicalRootsForRedact);
    throw new HttpError(503, message, 'workspace_policy_unavailable');
  }
  if (delivery === 'review') {
    const message = redactPhysicalRoots('Not found', rawPhysicalRootsForRedact);
    throw new HttpError(404, message, 'not_found');
  }
}

export function parseActingHeaders(headers: Record<string, string | undefined>): ActingHeaders {
  const orgId = headers['x-acting-organization-id'] ?? headers['X-Acting-Organization-Id'];
  const userId = headers['x-acting-user-id'] ?? headers['X-Acting-User-Id'];
  const role = headers['x-acting-role'] ?? headers['X-Acting-Role'];
  return { orgId, userId, role };
}

/**
 * 四个公共路由共用的 acting 头采集（F17 合并）。
 *
 * 各路由显式传自己需要的 key 列表，行为与合并前各写一份时逐字节一致：
 * - artifacts / processes：org + user
 * - files：org + user + role
 * - datasets：org + user + conversation（conversation 头只用于路由参数解析，
 *   `parseActingHeaders` 本来就不读它）
 */
export function actingHeadersFrom(
  c: import('hono').Context,
  keys: readonly string[],
): Record<string, string | undefined> {
  const h: Record<string, string | undefined> = {};
  for (const k of keys) {
    const v = c.req.header(k);
    if (v !== undefined) h[k] = v;
  }
  return h;
}

export async function requireOwnedSession(
  sessionId: string,
  deps: OwnershipDeps,
  acting: ActingHeaders,
  rawPhysicalRootsForRedact: readonly string[] = [],
  access: WorkspaceAccess = 'read',
): Promise<OwnershipContext> {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw notFound('session_id required');
  }
  // 无 acting 时视为未认证——按 Python `require_owned_session` 的行为 404
  if (!acting.orgId || !acting.userId) {
    const msg = redactPhysicalRoots('Process not found', rawPhysicalRootsForRedact);
    throw new HttpError(404, msg, 'not_found');
  }
  // 交付策略必须**在**归属校验之前读：这是纵深防御的第二道，而 review 工作区
  // 的读路径要在任何文件系统访问之前就被拒掉。
  await assertWorkspaceReadable(sessionId, deps, rawPhysicalRootsForRedact, access);
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
      // 公共面**不带系统名单**（`systemSkillPackages` 省略）：浏览器侧没有
      // AgentVersion 绑定。公共面的文件路由只服务 `workspaceRoot` 之下的路径（见
      // `public/files.ts`），也从不构造隔离 profile，所以这里维持 ADR 0015 之前的形状。
    };
    return { workspace: ctx, physicalRoots: physicalRootsOf(ctx) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = redactPhysicalRoots(msg, rawPhysicalRootsForRedact);
    // 任何路径校验失败都映射为 404，保持与 Python 的 `HTTPException(404)` 一致
    throw new HttpError(404, redacted, 'not_found');
  }
}
