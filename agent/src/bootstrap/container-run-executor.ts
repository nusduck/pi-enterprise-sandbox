/**
 * Assembly of the per-Run Pi executor factory.
 *
 * The container's single largest wiring step: repositories, session lock,
 * recovery, sandbox provisioning, the Pi runtime factory and the extension
 * bundle are all resolved here and handed to createPiRunExecutorFactory. Kept
 * out of container.js so the container stays a directory of services rather
 * than one long assembly script.
 */

import {
  assertWorkerSandboxServiceToken,
  resolveSkillRootsForRun,
} from './container-env.js';
import { createPiRunExecutorFactory } from '../application/pi-run-executor.js';
import { resolvePiRunToolBudget } from '../application/pi-run-tool-budget.js';
import { SessionRecoveryService } from '../application/session-recovery-service.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** 过渡期宽松类型：容器与应用服务仍是 JS。 */
type Loose = any;

/** Parse a positive-integer env value with fallback (invalid/absent → default). */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Durable sub-agent spawn port.
 *
 * The service is constructed per call rather than once, because MySQL and the
 * BullMQ queue only exist after the container has started, and this factory
 * can be assembled before that. Construction is cheap (repositories are made
 * per transaction anyway); the durable state lives entirely in MySQL.
 *
 */
function createSubagentSpawnPort(container: Loose): { spawn: Loose; getStatuses: Loose } {
  const build = async () => {
    const { SubagentSpawnService } = await import(
      '../application/subagent-spawn-service.js'
    );
    return new SubagentSpawnService({
      transactionManager: container.getTransactionManager(),
      createRepositories: (db) => container.createRepositories(db),
      generateId: container.generateId,
      now: container.now,
      runQueue: container.createRunQueueAdapter(),
      maxDepth: positiveIntEnv(container.env.AGENT_SUBAGENT_MAX_DEPTH, undefined),
      maxConcurrent: positiveIntEnv(
        container.env.AGENT_SUBAGENT_MAX_CONCURRENT,
        undefined,
      ),
    });
  };
  return {
    spawn: async (input) => (await build()).spawn(input),
    getStatuses: async (input) => (await build()).getStatuses(input),
  };
}

/**
 * Explicit PiRunExecutor factory (PR-05 slice B).
 *
 * @param {import('./container.js').ServiceContainer} container
 *
 * Requires modelResolver + workspaceResolver (+ typically extensionFactories /
 * resource configuration for the runtime). Production workers call this via
 * {@link ensureWorkerRunExecutorFactory} with default resolvers; callers may
 * still inject a custom factory on the container constructor.
 */

/**
 * `buildPiRunExecutorFactory` 的选项。由 JSDoc 转成真接口。
 *
 * 大部分字段仍是 `Loose`：它们承载的对象（容器、仓储、应用服务）都还是 JS，
 * 给它们编造精确类型会谎报现状。等 application/ 与 infrastructure/ 转完，
 * 这里会自然收紧。
 */
export interface PiRunExecutorFactoryOptions {
  readonly modelResolver: (agentVersion: object) => object | Promise<object>;
  readonly workspaceResolver: (agentSession: object) => string | Promise<string>;
  readonly extensionFactories?: unknown[];
  readonly eventProjectionMode?: 'session-subscribe' | 'observability' | 'both';
  readonly sessionLockManager?: Loose;
  readonly piRuntimeFactory?: Loose;
  readonly sessionAdapter?: Loose;
  readonly projector?: Loose;
  readonly recoveryService?: Loose;
  readonly sandboxSessionProvisioner?: Loose;
  /** 入参携带 trace 与归属信息；这里不收紧成具体接口，它由 Run 上下文拼出。 */
  readonly promptImageLoader?: (
    input: Loose,
  ) => Promise<Array<{ type: 'image'; data: string; mimeType: string }>>;
  readonly sessionLockRenewIntervalMs?: number;
  readonly steerPollIntervalMs?: number;
  readonly mcpResolver?: Loose;
  readonly mcpSecretResolver?: Loose;
  readonly mcpRuntimeRoot?: string;
  readonly subagentSpawnPort?: { spawn: Loose; getStatuses: Loose };
  readonly taskStateStore?: object;
  readonly otelToolSpans?: boolean;
  readonly sandboxTransport?: Loose;
  readonly toolRiskPolicy?: Loose;
  readonly skillManagerFactory?: Loose;
  readonly deltaTruncateLimit?: number;
  readonly thinkingTruncateLimit?: number;
  /** model 带 provider/id 等字段，形状由模型目录决定，暂不收紧。 */
  readonly requestAuthResolver?: (model: Loose, agentVersion: Loose) => object | Promise<object>;
  /**
   * 每个 Run 的 skill 根目录。返回 `string[]`——写 `unknown` 会让
   * PiRunExecutor 的依赖声明对不上（它要的就是路径数组）。
   */
  readonly skillRootsForRun?: (identity: object) => string[];
}

export async function buildPiRunExecutorFactory(
  container: Loose,
  opts: PiRunExecutorFactoryOptions,
) {
  if (typeof opts?.modelResolver !== 'function') {
    throw new Error(
      'createPiRunExecutorFactory requires modelResolver(agentVersion)',
    );
  }
  if (typeof opts?.workspaceResolver !== 'function') {
    throw new Error(
      'createPiRunExecutorFactory requires workspaceResolver(agentSession)',
    );
  }
  if (!container.knex || !container.redis) {
    throw new Error(
      'ServiceContainer must be started with MySQL and Redis before createPiRunExecutorFactory',
    );
  }


  // Worker Sandbox tools need service token + acting headers (not anonymous).
  if (!opts.sandboxTransport) {
    assertWorkerSandboxServiceToken(container.env);
  }

  const sessionLockManager =
    opts.sessionLockManager ?? (await container.createSessionLockManager());
  const sessionAdapter =
    opts.sessionAdapter ?? (await container.createPiSessionAdapter());
  const piRuntimeFactory =
    opts.piRuntimeFactory ??
    (await container.createPiRuntimeFactory({
      sessionAdapter,
      extensionFactories: opts.extensionFactories,
      mcpResolver: opts.mcpResolver,
      mcpSecretResolver: opts.mcpSecretResolver,
      mcpRuntimeRoot: opts.mcpRuntimeRoot,
    }));
  const projector =
    opts.projector ?? (await container.createPlatformEventProjector());
  const recoveryService =
    opts.recoveryService ?? container.createSessionRecoveryService();
  const sandboxSessionProvisioner =
    opts.sandboxSessionProvisioner ??
    (await container.createSandboxSessionProvisioner());

  // 通往 exec 的唯一路径是 `@pi/runtime` 的 remote-fs/shell/jobs（HMAC RPC），
  // 由 `infrastructure/dsh/runtime-factory.js` 按 Run 装配。
  //
  // 这里曾经**并行**构造第二套：5 个 `internal-*-http` 传输 →
  // `createRunScopedSandboxBridgeTransport` → `createSandboxBridgeExtensionBundleFactory`
  // → `createEnterpriseExtensionBundle()`，而最后那个函数在 W6-A 删除
  // `extensions/` 之后就是 `return []`。整条链路终止在一个被
  // `runtime-factory.create()` 忽略的参数上。
  //
  // 2026-08-31（计划 H8）`extensionBundleFactory` 这个形参本身也删掉了，
  // 连同它带的那批依赖一起接回真正的消费者：
  //   toolRiskPolicy    → executor 合并租户层后按 Run 传给策略装配
  //   subagentSpawnPort → durable 子 Agent 的队列/结果存储（H5）
  //   governanceRecorder→ durable 审批（H4.3）
  const { resolveToolRiskPolicy } = await import('../../config.js');
  const toolRiskPolicy = opts.toolRiskPolicy ?? resolveToolRiskPolicy(container.env);

  // 内部面 HMAC 是通往 exec 的唯一凭据：缺了就 fail fast，不要起一个每个
  // 工具调用都会在调用时才死的运行时。
  const internalKeyring = String(container.env.SANDBOX_INTERNAL_HMAC_KEYRING || '').trim();
  const internalActiveKid = String(container.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '').trim();
  if (!internalKeyring || !internalActiveKid) {
    throw new Error(
      'SANDBOX_INTERNAL_HMAC_KEYRING and SANDBOX_INTERNAL_HMAC_ACTIVE_KID are required (see .env.example)',
    );
  }

  const promptImageLoader =
    opts.promptImageLoader ??
    (async (input) => {
      const [{ createSandboxClient }, { loadPromptImagesFromAttachmentStore }] =
        await Promise.all([
          import('../infrastructure/sandbox/sandbox-client.js'),
          import('../infrastructure/dsh/prompt-image-loader.js'),
        ]);
      const sandboxClient = createSandboxClient({
        traceId: input.traceId,
        traceState: input.traceState,
        auth: {
          actingUserId: input.scope.userId,
          actingOrganizationId: input.scope.orgId,
        },
      });
      return loadPromptImagesFromAttachmentStore({
        attachmentStore: {
          download: ({ attachmentId, sandboxSessionId, signal }) =>
            sandboxClient.downloadDatasetContent(
              sandboxSessionId,
              attachmentId,
              { signal },
            ),
        },
        sandboxSessionId: input.sandboxSessionId,
        attachments: input.attachments,
        signal: input.signal,
      });
    });

  // 建成变量而不是内联字面量：内联时多余属性检查会对不在
  // PiRunExecutorFactoryOptions 里的字段报错，而这里刻意多带了几个
  // 装配期用得到、执行器本身不读的项。
  const factoryOpts = {
    transactionManager: container.getTransactionManager(),
    createRepositories: (db) => container.createRepositories(db),
    sessionLockManager,
    piRuntimeFactory,
    sessionAdapter,
    modelResolver: opts.modelResolver,
    promptImageLoader,
    workspaceResolver: opts.workspaceResolver,
    requestAuthResolver:
      opts.requestAuthResolver ??
      (String(container.env.LLMIO_API_KEY || '').trim()
        ? async (model) => ({
            provider: model.provider,
            apiKey: String(container.env.LLMIO_API_KEY).trim(),
          })
        : undefined),
    // Per-Run skill roots: system tier + this caller's own directory.
    skillRootsForRun:
      opts.skillRootsForRun ??
      ((identity) => resolveSkillRootsForRun(container.env, identity)),
    generateId: container.generateId,
    now: container.now,
    projector,
    recoveryService,
    sandboxSessionProvisioner,
    sessionLockRenewIntervalMs: opts.sessionLockRenewIntervalMs,
    steerPollIntervalMs:
      opts.steerPollIntervalMs ??
      (Number(container.env.AGENT_STEER_POLL_INTERVAL_MS) || undefined),
    toolBudget: resolvePiRunToolBudget(container.env),
    riskOverrides: toolRiskPolicy,
    // 子 Agent 的 durable 面（ADR 0009 D6 / 计划 H5）。2026-08-31 之前它只挂在
    // `subagentSpawnPort` 上，而那个 port 只喂给 `extensionBundleFactory`
    // ——一条终止在被忽略的参数上的死链（见本文件上方注释）。与此同时
    // `durable-subagent.ts` 的 provider 用的是进程内队列：Worker 一重启子 Run 全丢，
    // 正是那个 provider 文件头说要避免的事。
    subagentSpawnPort: opts.subagentSpawnPort ?? createSubagentSpawnPort(container),
    eventProjectionMode: opts.eventProjectionMode,
  };
  return createPiRunExecutorFactory(factoryOpts);
}
