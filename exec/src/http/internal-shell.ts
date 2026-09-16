/**
 * 内部 Shell 端点——对应 `dsh-shell` 的 run/start（dsh-rebuild 5.6）。
 *
 * 每个 spawn 必经 `IsolatedShellExecutor` → `process-runner` → `render`
 * （W2-A 硬要求），本文件只做 HTTP 层：信封校验 + 参数解析 + 结果脱敏。
 * 限额、配额准入/采样与取消融合在 `shell/guarded-execution.ts`，MCP 窄桥
 * 调同一份（修复后复核 F1：最初只接在这里，窄桥漏掉了）。
 *
 * 2026-09-16 的审查在这里发现三个接线断点（R1/R2/R4），本文件是三者的
 * 汇合点，所以修复也集中在这里：
 *
 * 1. **参数被静默丢弃**（R4）：以前只挑 `command`/`timeoutMs`，Agent 发的
 *    `workdir`/`stdin`/`env`/`stdoutMaxBytes` 一律丢掉，HTTP 仍然 200。现在
 *    整个请求体走 `@pi/contract/shell-payload.js` 的共用解析器，非法字段在
 *    执行前拒绝（400），合法字段原样传到执行器。
 * 2. **资源限额从未生效**（R1）：`SANDBOX_MAX_PROCESS_COUNT` 等变量在
 *    `exec/src` 里一个消费者都没有。现在装配层把 `ShellResourceLimits`
 *    传进来，逐条落到 `IsolatedShellExecutor`。
 * 3. **子进程配额监控从未启动**（R1）：`evaluateChildQuota` /
 *    `ChildWorkspaceQuotaWatch` 只存在于定义链里。现在前台与后台两条路径
 *    都做准入 + 采样，超额就终止这次执行（及其后代），并在结束/取消/
 *    spawn 失败的每一条出口停掉采样器。
 * 4. **取消到不了执行面**（R2）：前台路由把 `c.req.raw.signal` 融合进
 *    执行的 AbortSignal，客户端断开连接时 bwrap 进程树跟着被终止，不再
 *    留下一个仍在写文件的孤儿命令。
 */

import type { Hono } from 'hono';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import { parseEnvelope } from '@pi/contract/envelope.js';
import { parseEnabledSkills, type EnabledSkillRef } from '@pi/contract/skill-manifest.js';
import {
  parseShellRunPayload,
  parseShellStartPayload,
  SANDBOX_TEMP_PATH,
  SANDBOX_WORKSPACE_PATH,
  type ShellPayload,
  type ShellPayloadLimits,
} from '@pi/contract/shell-payload.js';
import { deniedProcessHandle, deniedRunResult } from '../shell/executor.js';
import type { MySqlJobRegistry } from '../shell/job-registry.js';
import type { ShellResourceLimits } from '../shell/resource-limits.js';
import {
  effectiveResourceLimits,
  makeLimitedExecutor,
  quotaGateFor,
  runGuardedForeground,
  type GuardedExecutionDeps,
} from '../shell/guarded-execution.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { EnabledSkillPackagesResolver, WorkspaceContext } from '../types.js';

export interface InternalShellDeps extends GuardedExecutionDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly jobRegistry: MySqlJobRegistry;
  readonly systemSkillRoot: string;
  /**
   * 该用户的 skill 草稿根（ADR 0009 D7 / 计划 H6.2）。
   *
   * 与 `enabledSkillPackagesFor` 一样按 owner 解析——每用户一个目录，
   * 一个用户造的包不会出现在另一个用户的沙箱里。
   */
  readonly draftSkillRootFor?: (orgId: string, userId: string) => string | null;
  readonly enabledSkillPackagesFor: EnabledSkillPackagesResolver;
  readonly modeFor: (workspaceId: string) => 'read-only' | 'workspace-write';
}

function buildContext(
  deps: InternalShellDeps,
  env: { orgId: string; userId: string; workspaceId: string },
  enabledSkills: readonly EnabledSkillRef[],
): WorkspaceContext {
  const draft = deps.draftSkillRootFor?.(env.orgId, env.userId) ?? null;
  return {
    orgId: env.orgId,
    userId: env.userId,
    workspaceId: env.workspaceId,
    workspaceRoot: deps.workspaceManager.physicalWorkspacePath(env.workspaceId),
    tempRoot: deps.workspaceManager.physicalTempPath(env.workspaceId),
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackages: [...deps.enabledSkillPackagesFor(env.orgId, env.userId, enabledSkills)],
    ...(draft !== null && draft !== '' ? { draftSkillRoot: draft } : {}),
  };
}

function rootsOf(ctx: WorkspaceContext): readonly string[] {
  return [
    ctx.workspaceRoot,
    ctx.tempRoot,
    ctx.systemSkillRoot,
    // 草稿根必须进这份「允许的物理根」清单，否则 fs 围栏会把模型往草稿里的
    // 写当成越界——挂载对了但写不进去，症状是「路径存在却 permission denied」。
    ...(ctx.draftSkillRoot ? [ctx.draftSkillRoot] : []),
    ...ctx.enabledSkillPackages.map((p) => p.sourcePath),
  ];
}

async function parseBody(
  c: import('hono').Context,
): Promise<{ envelope: unknown; payload: unknown; enabledSkills: readonly EnabledSkillRef[] }> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  const b = body as Record<string, unknown>;
  return { envelope: b['envelope'], payload: b['payload'], enabledSkills: parseEnabledSkills(b['enabledSkills']) };
}

/** 服务端上限：请求里的 `timeoutMs`/`stdoutMaxBytes` 只能要更小的值。 */
function payloadLimitsOf(limits: ShellResourceLimits): ShellPayloadLimits {
  return {
    maxTimeoutMs: limits.executionTimeoutMs,
    // 字符上限 → 字节天花板，换算规则与 `IsolatedShellExecutor.outputCapBytes` 同源。
    maxStdoutBytes: limits.maxOutputChars * 4,
    maxStdinBytes: 1_000_000,
    maxEnvEntries: 64,
  };
}

/** 逻辑 workdir 还原成执行器认识的字符串形态（executor 内部会再解析一次）。 */
function workdirString(payload: ShellPayload): string {
  const root = payload.workdir.scope === 'temp' ? SANDBOX_TEMP_PATH : SANDBOX_WORKSPACE_PATH;
  return payload.workdir.relative === '' ? root : `${root}/${payload.workdir.relative}`;
}

export function registerInternalShellRoutes(app: Hono, deps: InternalShellDeps): void {
  const limits = effectiveResourceLimits(deps);
  const payloadLimits = payloadLimitsOf(limits);

  app.post('/internal/v1/shell/run', async (c) => {
    try {
      const { envelope: rawEnv, payload, enabledSkills } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as { orgId: string; userId: string; workspaceId: string };
      const ctx = buildContext(deps, env, enabledSkills);
      const executor = makeLimitedExecutor(deps, ctx, deps.modeFor(env.workspaceId));
      const parsed = parseShellRunPayload(payload, payloadLimits);

      const spec = executor.resolve({
        command: parsed.command,
        workdir: workdirString(parsed),
        ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        ...(parsed.stdoutMaxBytes !== undefined ? { stdoutMaxBytes: parsed.stdoutMaxBytes } : {}),
        ...(parsed.stdin !== undefined ? { stdin: parsed.stdin } : {}),
        ...(parsed.env !== undefined ? { env: { ...parsed.env } } : {}),
      });
      // 准入、采样与取消融合（客户端断开 + 配额报警）在共享编排里，
      // MCP 窄桥走同一份（复核 F1）。超额/测量失败一律 fail-closed：不 spawn，
      // 把原因如实交给模型。
      const outcome = await runGuardedForeground({
        gate: quotaGateFor(deps, ctx),
        clientSignal: c.req.raw.signal,
        run: (signal) => executor.run({ ...spec, signal }),
      });
      if (outcome.kind === 'denied') {
        return c.json({
          ok: true,
          data: deniedRunResult(ctx, executor.mode, outcome.message, spec.timeoutMs),
        });
      }
      return c.json({ ok: true, data: outcome.result });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post('/internal/v1/shell/start', async (c) => {
    try {
      const { envelope: rawEnv, payload, enabledSkills } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as { orgId: string; userId: string; workspaceId: string };
      const ctx = buildContext(deps, env, enabledSkills);
      const roots = rootsOf(ctx);
      const executor = makeLimitedExecutor(deps, ctx, deps.modeFor(env.workspaceId));
      const parsed = parseShellStartPayload(payload, payloadLimits);
      const spec = executor.resolve({
        command: parsed.command,
        workdir: workdirString(parsed),
        ...(parsed.stdoutMaxBytes !== undefined ? { stdoutMaxBytes: parsed.stdoutMaxBytes } : {}),
        ...(parsed.stdin !== undefined ? { stdin: parsed.stdin } : {}),
        ...(parsed.env !== undefined ? { env: { ...parsed.env } } : {}),
      });

      const gate = quotaGateFor(deps, ctx);
      const admission = await gate.admit();

      const snapshot = await deps.jobRegistry.start({
        ...(parsed.id !== undefined ? { id: parsed.id } : {}),
        kind: 'bash',
        label: parsed.command,
        owner: {
          orgId: env.orgId,
          userId: env.userId,
          workspaceId: env.workspaceId,
          ...(parsed.runId !== undefined ? { runId: parsed.runId } : {}),
        },
        physicalRoots: roots,
        run: () => {
          // 准入不通过就不 spawn：句柄立刻结算成 killed，原因进 stderr。
          const handle = admission.allow
            ? executor.start(spec)
            : deniedProcessHandle(ctx, executor.mode, admission.message);
          const stopWatch = admission.allow
            ? gate.watch(() => {
                void handle.kill();
              })
            : async (): Promise<void> => undefined;
          const live = handle as typeof handle & {
            pid?: number | null;
            pgid?: number | null;
            writeStdin?: (data: string, eof: boolean) => void;
          };
          return {
            pid: live.pid ?? null,
            pgid: live.pgid ?? undefined,
            cancel: () => {
              void handle.kill();
            },
            done: handle.done
              // 采样器必须跟着作业收尾——不论正常结束、被杀还是 spawn 失败。
              .finally(() => stopWatch())
              .then(() => ({
                status: handle.status === 'completed' ? ('completed' as const) : ('killed' as const),
                exitCode: handle.exitCode,
                signal: handle.signal,
              })),
            readOutput: () => handle.readOutput(),
            ...(live.writeStdin ? { writeStdin: live.writeStdin.bind(handle) } : {}),
          };
        },
      });
      return c.json({ ok: true, data: snapshot });
    } catch (err) {
      return failure(c, err);
    }
  });
}

/** 统一的失败响应：`toWireError` 兜底脱敏；请求体非法归 400，其余 500。 */
function failure(c: import('hono').Context, err: unknown): Response {
  const wire = toWireError(err, { physicalRoots: [] });
  const status = wire.code === 'ENVELOPE_INVALID' ? 400 : 500;
  return c.json({ ok: false, error: wire }, status as never);
}
