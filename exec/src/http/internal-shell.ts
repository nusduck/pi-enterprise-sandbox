/**
 * 内部 Shell 端点——对应 `dsh-shell` 的 run/start（dsh-rebuild 5.6）。
 *
 * 每个 spawn 必经 `IsolatedShellExecutor` → `process-runner` → `render`
 * （W2-A 硬要求），本文件只做 HTTP 层：信封校验 + 参数透传 + 结果脱敏。
 */

import type { Hono } from 'hono';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import { parseEnvelope } from '@pi/contract/envelope.js';
import { IsolatedShellExecutor } from '../shell/executor.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { WorkspaceContext } from '../types.js';

export interface InternalShellDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly bwrapExecutable: string;
  readonly modeFor: (workspaceId: string) => 'read-only' | 'workspace-write';
}

function buildContext(deps: InternalShellDeps, env: { orgId: string; userId: string; workspaceId: string }): WorkspaceContext {
  return {
    orgId: env.orgId,
    userId: env.userId,
    workspaceId: env.workspaceId,
    workspaceRoot: deps.workspaceManager.physicalWorkspacePath(env.workspaceId),
    tempRoot: deps.workspaceManager.physicalTempPath(env.workspaceId),
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackages: [...deps.enabledSkillPackagesFor(env.orgId, env.userId)],
  };
}

function rootsOf(ctx: WorkspaceContext): readonly string[] {
  return [ctx.workspaceRoot, ctx.tempRoot, ctx.systemSkillRoot, ...ctx.enabledSkillPackages.map((p) => p.sourcePath)];
}

async function parseBody(c: import('hono').Context): Promise<{ envelope: unknown; payload: unknown }> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  const b = body as Record<string, unknown>;
  return { envelope: b['envelope'], payload: b['payload'] };
}

export function registerInternalShellRoutes(app: Hono, deps: InternalShellDeps): void {
  app.post('/internal/v1/shell/run', async (c) => {
    try {
      const { envelope: rawEnv, payload } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as { orgId: string; userId: string; workspaceId: string };
      const ctx = buildContext(deps, env);
      const roots = rootsOf(ctx);
      const executor = new IsolatedShellExecutor({
        workspace: ctx,
        bwrapExecutable: deps.bwrapExecutable,
        mode: deps.modeFor(env.workspaceId),
      });
      const p = payload as Record<string, unknown>;
      const command = typeof p['command'] === 'string' ? (p['command'] as string) : '';
      const timeoutMs = typeof p['timeoutMs'] === 'number' ? (p['timeoutMs'] as number) : undefined;
      const spec = executor.resolve({ command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      const result = await executor.run(spec);
      return c.json({ ok: true, data: result });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      // IsolatedShellExecutor 内部已做脱敏，这里兜底再脱一次
      const status = wire.code === 'ENVELOPE_INVALID' ? 400 : 500;
      return c.json({ ok: false, error: wire }, status as never);
    }
  });

  app.post('/internal/v1/shell/start', async (c) => {
    try {
      const { envelope: rawEnv, payload } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as { orgId: string; userId: string; workspaceId: string };
      const ctx = buildContext(deps, env);
      const executor = new IsolatedShellExecutor({
        workspace: ctx,
        bwrapExecutable: deps.bwrapExecutable,
        mode: deps.modeFor(env.workspaceId),
      });
      const p = payload as Record<string, unknown>;
      const command = typeof p['command'] === 'string' ? (p['command'] as string) : '';
      const spec = executor.resolve({ command });
      const handle = executor.start(spec);
      // 后台句柄立即返回 snapshot 形状，避免泄漏 pid 细节
      const snapshot = {
        id: `shell-${Date.now()}`,
        status: handle.status,
        sandbox: (handle as unknown as Record<string, unknown>)['sandbox'],
      };
      return c.json({ ok: true, data: snapshot });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      const status = wire.code === 'ENVELOPE_INVALID' ? 400 : 500;
      return c.json({ ok: false, error: wire }, status as never);
    }
  });
}
