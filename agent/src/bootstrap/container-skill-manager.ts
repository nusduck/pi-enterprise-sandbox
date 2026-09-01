/**
 * Per-Run SkillManager assembly for the skill-lifecycle extension.
 *
 * Split out of `container.js` so the container stays an assembly index:
 * this is the only place that knows how a caller's identity, their Skill
 * roots and an owner-scoped Sandbox client combine into one manager.
 */

/** 过渡期宽松类型：容器与仓储仍是 JS，编造精确类型会谎报现状。 */
type Loose = any;

/**
 * 每个 Run 的上下文。只列本模块用得到的字段。
 *
 * 身份三件套用 `unknown`——它们来自不可信来源，下面必须显式判空并 String()；
 * trace 字段是内部生成的字符串，声明成 unknown 反而会逼出无谓的断言。
 */
export interface RunContextLike {
  readonly orgId?: unknown;
  readonly userId?: unknown;
  readonly sandboxSessionId?: unknown;
  readonly workspaceId?: unknown;
  readonly traceId?: string | undefined;
  readonly traceState?: string | undefined;
  readonly conversationId?: unknown;
  readonly agentSessionId?: unknown;
  readonly runId?: unknown;
}

export type SkillManagerFactory = (
  runContext: RunContextLike | null | undefined,
  lifecycleDeps?: { getAgentSession?: () => unknown },
) => Loose;

/**
 * Build a per-Run SkillManager factory for the skill-lifecycle extension.
 *
 * The manager must be per-Run because the writable skill directory is
 * per-user (`<base>/<orgId>/<userId>`): one process-wide manager would give
 * every tenant the same install target. Uploaded archives are fetched by
 * attachment id through an owner-scoped Sandbox client; no filesystem source
 * path crosses the service boundary.
 */
export async function buildSkillManagerFactory(
  env: NodeJS.ProcessEnv,
): Promise<SkillManagerFactory> {
  const [{ createSkillManager, resolveSkillRoots, draftSkillRootFor }, { createSandboxClient }] =
    await Promise.all([
      import('../skills/manager.js'),
      import('../infrastructure/sandbox/sandbox-client.js'),
    ]);

  return (runContext, lifecycleDeps = {}) => {
    const orgId = runContext?.orgId;
    const userId = runContext?.userId;
    const sandboxSessionId = String(runContext?.sandboxSessionId || '').trim();
    const workspaceId = String(runContext?.workspaceId || sandboxSessionId).trim();
    if (orgId == null || userId == null || !sandboxSessionId) return null;
    let manager: Loose;
    try {
      const sandboxClient = createSandboxClient({
        traceId: runContext?.traceId,
        traceState: runContext?.traceState,
        auth: {
          actingUserId: String(userId),
          actingOrganizationId: String(orgId),
        },
      });
      manager = createSkillManager({
        identity: { orgId, userId },
        skillRoots: resolveSkillRoots(env, { orgId, userId }),
        // 上传解包到这个用户自己的草稿根（ADR 0009 D7 / 计划 H6.7），
        // 而不是直接写已启用根——上传与模型创建从此走同一条启用闸门。
        draftSkillRoot: draftSkillRootFor({ orgId, userId }),
        downloadArchive: ({ attachmentId, signal }) =>
          sandboxClient.downloadDatasetContent(workspaceId, attachmentId, {
            signal,
          }),
        // A package the model built in this session. Sandbox resolves the
        // logical path against the workspace/temp roots of the owning
        // session only, so a Skill-root path is rejected there as well as by
        // the tool's own guard.
        downloadWorkspaceArchive: ({ path: sourcePath, signal }) =>
          sandboxClient.downloadFileStream(workspaceId, sourcePath, { signal }),
        getAgentSession:
          typeof lifecycleDeps.getAgentSession === 'function'
            ? lifecycleDeps.getAgentSession
            : undefined,
        getMeta: () => ({
          orgId,
          userId,
          conversationId: runContext?.conversationId,
          sessionId: runContext?.agentSessionId,
          runId: runContext?.runId,
          traceId: runContext?.traceId,
        }),
      });
    } catch (err) {
      // A malformed identity must not take the whole Run down; the Run just
      // runs without skill lifecycle tools.
      console.warn(
        '[skills] could not resolve per-user skill directory:',
        (err as Error | null)?.message || err,
      );
      return null;
    }
    return manager.userSkillRoot ? manager : null;
  };
}
