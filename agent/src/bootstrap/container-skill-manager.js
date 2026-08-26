/**
 * Per-Run SkillManager assembly for the skill-lifecycle extension.
 *
 * Split out of `container.js` so the container stays an assembly index:
 * this is the only place that knows how a caller's identity, their Skill
 * roots and an owner-scoped Sandbox client combine into one manager.
 */

/**
 * Build a per-Run SkillManager factory for the skill-lifecycle extension.
 *
 * The manager must be per-Run because the writable skill directory is
 * per-user (`<base>/<orgId>/<userId>`): one process-wide manager would give
 * every tenant the same install target. Uploaded archives are fetched by
 * attachment id through an owner-scoped Sandbox client; no filesystem source
 * path crosses the service boundary.
 *
 * @returns {Promise<(runContext: object) => object | null>}
 */
export async function buildSkillManagerFactory(env) {
  const [{ createSkillManager, resolveSkillRoots }, { createSandboxClient }] =
    await Promise.all([
      import('../skills/manager.js'),
      import('../infrastructure/sandbox/sandbox-client.js'),
    ]);

  return (runContext, lifecycleDeps = {}) => {
    const orgId = runContext?.orgId;
    const userId = runContext?.userId;
    const sandboxSessionId = String(runContext?.sandboxSessionId || '').trim();
    if (orgId == null || userId == null || !sandboxSessionId) return null;
    let manager;
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
        downloadArchive: ({ attachmentId, signal }) =>
          sandboxClient.downloadDatasetContent(sandboxSessionId, attachmentId, {
            signal,
          }),
        // A package the model built in this session. Sandbox resolves the
        // logical path against the workspace/temp roots of the owning
        // session only, so a Skill-root path is rejected there as well as by
        // the tool's own guard.
        downloadWorkspaceArchive: ({ path: sourcePath, signal }) =>
          sandboxClient.downloadFileStream(sandboxSessionId, sourcePath, { signal }),
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
        err?.message || err,
      );
      return null;
    }
    return manager.userSkillRoot ? manager : null;
  };
}
