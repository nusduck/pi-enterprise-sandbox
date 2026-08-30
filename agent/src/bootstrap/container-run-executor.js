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

/**
 * Parse a positive-integer env value with fallback (invalid/absent → default).
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntEnv(raw, fallback) {
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
 * @param {import('./container.js').ServiceContainer} container
 * @returns {{ spawn: Function, getStatuses: Function }}
 */
function createSubagentSpawnPort(container) {
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
 * Durable task-state store (session todo list + owner-scoped notes).
 *
 * Each call runs in its own transaction: `replaceTodos` deletes the old list
 * before inserting the new one, so a crash between the two must not leave the
 * session with no plan at all.
 *
 * @param {import('./container.js').ServiceContainer} container
 * @returns {{ replaceTodos: Function, getTodos: Function, appendMemory: Function, searchMemory: Function }}
 */
function createTaskStateStore(container) {
  const inTx = (fn) =>
    container
      .getTransactionManager()
      .run(async (trx) => fn(container.createRepositories(trx).taskState));
  return {
    replaceTodos: (input) => inTx((repo) => repo.replaceTodos(input)),
    getTodos: (input) => inTx((repo) => repo.getTodos(input)),
    appendMemory: (input) => inTx((repo) => repo.appendMemory(input)),
    searchMemory: (input) => inTx((repo) => repo.searchMemory(input)),
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
 *
 * @param {{
 *   modelResolver: (agentVersion: object) => object | Promise<object>,
 *   workspaceResolver: (agentSession: object) => string | Promise<string>,
 *   extensionFactories?: unknown[],
 *   extensionBundleFactory?: (runContext: object, deps: object) => unknown[],
 *   eventProjectionMode?: 'session-subscribe' | 'observability' | 'both',
 *   sessionLockManager?: any,
 *   piRuntimeFactory?: any,
 *   sessionAdapter?: any,
 *   projector?: any,
 *   recoveryService?: SessionRecoveryService,
 *   sandboxSessionProvisioner?: any,
 *   promptImageLoader?: (input: object) => Promise<Array<{ type: 'image', data: string, mimeType: string }>>,
 *   sessionLockRenewIntervalMs?: number,
 *   steerPollIntervalMs?: number,
 *   mcpResolver?: Function | object | null,
 *   mcpSecretResolver?: Function,
 *   mcpRuntimeRoot?: string,
 *   subagentSpawnPort?: { spawn: Function, getStatuses: Function },
 *   taskStateStore?: object,
 *   otelToolSpans?: boolean,
 *   sandboxTransport?: any,
 *   toolRiskPolicy?: any,
 *   skillManagerFactory?: any,
 *   deltaTruncateLimit?: number,
 *   thinkingTruncateLimit?: number,
 *   requestAuthResolver?: (model: object, agentVersion: object) => object | Promise<object>,
 *   skillRootsForRun?: (identity: object) => unknown,
 * }} opts
 * @returns {Promise<import('../application/run-executor.js').RunExecutorFactory>}
 */
export async function buildPiRunExecutorFactory(container, opts) {
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
  if (typeof opts.extensionBundleFactory !== 'function' && !opts.sandboxTransport) {
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
  // `extensions/` 之后就是 `return []`。整条链路（约 170 行、连同
  // toolRiskPolicy / skillManagerFactory / subagentSpawnPort / taskStateStore
  // 这些只喂给它的依赖）终止在一个被 `runtime-factory.create()` 忽略的参数上。
  //
  // 唯一有实际作用的是 `toolRiskPolicy`：它被解析出来却同样丢掉了，现在改为
  // 直接传给策略装配（`InstallPolicyOptions.riskOverrides`）。
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

  // Built as a variable (not an inline literal) so the excess-property check
  // does not fire on `skillRootsForRun` if a caller still uses a narrower
  // factory options type. PiRunExecutor now declares the field in JSDoc.
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
    // 生产不再构造 extension bundle（见上方注释）。保留这个形参只为测试注入：
    // 若哪天又有人在生产接上非空 bundle，`runtime-factory.create()` 仍然忽略它，
    // 所以真要恢复扩展机制得先在那边接收。
    ...(typeof opts.extensionBundleFactory === 'function'
      ? { extensionBundleFactory: opts.extensionBundleFactory }
      : {}),
    eventProjectionMode: opts.eventProjectionMode,
  };
  return createPiRunExecutorFactory(factoryOpts);
}
