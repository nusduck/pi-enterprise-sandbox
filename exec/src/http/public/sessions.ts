/**
 * 公共面会话删除路由——`DELETE /sessions/:sessionId`（会话工作区 GC）。
 *
 * 为什么存在：agent 删除/归档会话时调
 * `DELETE {SANDBOX_BASE_URL}/sessions/{sandboxSessionId}`（见 agent
 * `conversation-service.ts` 的 `#cleanupSandboxWorkspaces`）。此前 exec 公共面
 * 只有 `/sessions/:id/files|processes|datasets|artifacts` 子路由，这条请求必然
 * 失败、agent 侧 fail-soft 只打日志，工作区目录从不删除、磁盘只增不减。
 *
 * 鉴权：与 files/processes **同一套**会话鉴权与作用域解析——acting 用户/组织
 * 来自已校验的服务端身份头（BFF/agent 转发，浏览器直传已被剥掉）；缺失或会话
 * id 非法 → 404，不用 403（跨租户一律 404，存在性本身不泄漏）。服务间
 * `X-API-Key` 由总路由的 `/sessions/*` 中间件先验。
 *
 * 语义（幂等）：
 * - 先终止该会话所有仍在运行的托管作业：复用 `MySqlJobRegistry.kill()` 现有
 *   终止路径（SIGTERM 经活句柄 `cancel()` + 身份校验补发；SIGKILL 升级由句柄/
 *   执行面既有的宽限完成，不另写一套）。逐个 best-effort——单个作业控制不可用
 *   （如 Worker 重启后无活句柄）不阻塞 GC，当次删不掉的由下次启动的孤儿回收兜底。
 * - 再删除该会话的工作区目录 + 配对的持久 temp（XDG home 在 temp 之下，随 temp
 *   一同清理，不构成第四个存储根）。产物快照/数据集 blob 落在控制面共享根
 *   （按 org/artifact 组织，非会话专属目录），不在这里删；作业账本行经上面的
 *   kill 已进终态，保留作 durable 历史（`JobStore` 无删除能力，不新建表/迁移）。
 * - 已删除/从未创建 → `200 {"removed": false}`；本次删除 → `200 {"removed": true}`。
 *
 * 路径一律从 `requireOwnedSession` 解析出的工作区上下文得出，绝不拼接请求参数；
 * 删除前断言目标非空且为绝对路径（fail-closed 500）。真正的目录穿越屏障是
 * `workspace/ids.ts` 的不透明 id 校验 + `joinContained`，这里是第二道断言。
 *
 * 审核工作区：`delete` 模式不受 `assertWorkspaceReadable` 的读封锁（E5/E6 只封
 * 字节读；GC 必须能删 review 会话），但多一道组织绑定检查——策略表的创建组织
 * （HMAC 内部面 ensure 时经已校验 claims 写入，只能设置不能撤销）与调用方 acting
 * 组织不一致 → 404。direct 工作区没有策略行，仍走轻量归属（上游 agent/BFF 已做过
 * owner 校验，这里是纵深第二道，与 files/processes 同口径）。
 *
 * 错误文本经 `redactPhysicalRoots` 无条件脱敏（`physicalRoots` 必传无默认值）。
 */

import path from 'node:path';
import { access } from 'node:fs/promises';
import { Hono } from 'hono';
import { errorBody, HttpError, notFound } from './errors.js';
import { actingHeadersFrom, parseActingHeaders, requireOwnedSession } from './ownership.js';
import { redactPhysicalRoots } from '../../fs/redact.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import type { MySqlJobRegistry } from '../../shell/job-registry.js';
import { isTerminalJobStatus } from '../../shell/job-types.js';
import type { WorkspacePolicyStore } from '../../db/repositories/workspace-policies.js';

export interface PublicSessionDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (
    orgId: string,
    userId: string,
  ) => readonly { name: string; sourcePath: string }[];
  readonly jobRegistry: MySqlJobRegistry;
  /** 工作区交付策略（ADR 0016 D1）；省略 = 无审核绑定检查（单测/本地装配）。 */
  readonly workspacePolicies?: WorkspacePolicyStore | undefined;
}

/** 本路由采集的 acting 头（与 files 同口径，见 `ownership.ts` 的 `actingHeadersFrom`）。 */
const ACTING_KEYS = ['x-acting-organization-id', 'x-acting-user-id', 'x-acting-role'] as const;

/** 会话作业列表的上限：GC 必须看到该会话的全部托管作业（进程路由的单页上限是 1000）。 */
const SESSION_JOB_LIST_LIMIT = 1000;

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除前的 fail-closed 断言：目标必须是由会话记录派生的非空绝对路径。
 * 真正的穿越屏障在 `validateOpaqueId` + `joinContained`；这里拦的是
 * "派生逻辑本身返回了不可删除的东西"（如空串/相对路径），失败即 500。
 */
function assertDeletablePath(target: string, physicalRoots: readonly string[]): void {
  if (!target || !path.isAbsolute(target)) {
    throw new HttpError(
      500,
      redactPhysicalRoots('Workspace path unavailable', physicalRoots),
    );
  }
}

export function registerPublicSessionRoutes(app: Hono, deps: PublicSessionDeps): void {
  // DELETE /sessions/:sessionId → 200 {removed}
  app.delete('/sessions/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingHeadersFrom(c, ACTING_KEYS));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots, 'delete');
      roots = own.physicalRoots;

      // 审核工作区的组织绑定：与创建组织不一致 → 404（跨租户一律 404）。
      if (deps.workspacePolicies !== undefined) {
        let boundOrg: string | null;
        try {
          boundOrg = await deps.workspacePolicies.reviewOwnerOf(sessionId);
        } catch (err) {
          void err;
          throw new HttpError(
            503,
            redactPhysicalRoots('Workspace not available', roots),
            'workspace_policy_unavailable',
          );
        }
        if (boundOrg !== null && boundOrg !== own.workspace.orgId) {
          throw notFound(redactPhysicalRoots('Not found', roots));
        }
      }

      const owner = {
        orgId: own.workspace.orgId,
        userId: own.workspace.userId,
        workspaceId: sessionId,
      };

      // 先终止仍在运行的托管作业（复用 registry 现有终止路径，逐个 best-effort）。
      // 作业列表读不到（如存储抖动）不阻塞 GC：信号能发就发，目录一定要删
      // （agent 的 GC 是 one-shot，不重试；删不掉就是永久泄漏）。
      const jobs = await deps.jobRegistry.list(owner, SESSION_JOB_LIST_LIMIT).catch(() => []);
      for (const job of jobs) {
        if (isTerminalJobStatus(job.status)) continue;
        await deps.jobRegistry.kill(job.id, owner).catch(() => {});
      }

      // 再删该工作区全部作业的落盘输出：作业 id 只从持久化账本里取
      // （`deleteJobOutputsForOwner` 内部走 `store.listByOwner`，生产即 MySQL），
      // 不按目录名猜。best-effort——删不掉不阻塞目录 GC。
      await deps.jobRegistry.deleteJobOutputsForOwner(owner).catch(() => {});

      // 再删目录：工作区 + 配对 temp。路径只从会话上下文取，不碰请求原文。
      const workspaceRoot = own.workspace.workspaceRoot;
      const tempRoot = own.workspace.tempRoot;
      assertDeletablePath(workspaceRoot, roots);
      assertDeletablePath(tempRoot, roots);
      if (workspaceRoot === tempRoot) {
        throw new HttpError(
          500,
          redactPhysicalRoots('Workspace path unavailable', roots),
        );
      }
      const hadWorkspace = await pathExists(workspaceRoot);
      const hadTemp = await pathExists(tempRoot);
      if (!hadWorkspace && !hadTemp) {
        return c.json({ removed: false });
      }
      try {
        await deps.workspaceManager.removeWorkspace(sessionId);
      } catch (err) {
        // `removeWorkspace` 的 message 构造时已脱敏；这里经 errorBody 再兜底一次。
        if (err instanceof HttpError) throw err;
        const raw = err instanceof Error ? err.message : String(err);
        throw new HttpError(500, redactPhysicalRoots(raw, roots));
      }
      return c.json({ removed: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });
}
