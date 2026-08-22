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
  ensureAgentPiAgentDir,
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
 *   agentDir?: string,
 *   sessionLockManager?: any,
 *   piRuntimeFactory?: any,
 *   sessionAdapter?: any,
 *   projector?: any,
 *   recoveryService?: SessionRecoveryService,
 *   sandboxSessionProvisioner?: any,
 *   promptImageLoader?: Function,
 *   sessionLockRenewIntervalMs?: number,
 *   steerPollIntervalMs?: number,
 *   mcpResolver?: Function | object | null,
 *   mcpSecretResolver?: Function,
 *   mcpRuntimeRoot?: string,
 *   subagentSpawnPort?: { spawn: Function, getStatuses: Function },
 *   taskStateStore?: object,
 *   otelToolSpans?: boolean,
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

  // Assembly gate: concrete agentDir on disk before any job runs.
  const agentDir =
    opts.agentDir != null && String(opts.agentDir).trim()
      ? (() => {
          const d = path.resolve(String(opts.agentDir).trim());
          mkdirSync(d, { recursive: true, mode: 0o755 });
          return d;
        })()
      : ensureAgentPiAgentDir(container.env);

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
      agentDir,
    }));
  const projector =
    opts.projector ?? (await container.createPlatformEventProjector());
  const recoveryService =
    opts.recoveryService ?? container.createSessionRecoveryService();
  const sandboxSessionProvisioner =
    opts.sandboxSessionProvisioner ??
    (await container.createSandboxSessionProvisioner());

  // PR-08: per-run sandbox-bridge transport from durable runContext
  // (orgId/userId/traceId). Never process-global client with null auth/trace.
  let extensionBundleFactory = opts.extensionBundleFactory;
  if (typeof extensionBundleFactory !== 'function') {
    // Platform risk table: resolved once per factory, not per run, so a bad
    // config file fails at startup instead of mid-conversation.
    const { resolveToolRiskPolicy } = await import('../../config.js');
    const toolRiskPolicy =
      opts.toolRiskPolicy ?? resolveToolRiskPolicy(container.env);
    const skillManagerFactory =
      opts.skillManagerFactory !== undefined
        ? opts.skillManagerFactory
        : await container.createSkillManagerFactory();
    // Audit truncation limits: env-tunable so operators can trade run_events
    // row size for fuller audit fidelity (defaults keep historical sizes).
    const obsTruncationLimits = {
      deltaTruncateLimit:
        opts.deltaTruncateLimit ??
        positiveIntEnv(container.env.AGENT_OBS_DELTA_TRUNCATE, 512),
      thinkingTruncateLimit:
        opts.thinkingTruncateLimit ??
        positiveIntEnv(container.env.AGENT_OBS_THINKING_TRUNCATE, 2048),
    };
    // OTel tool spans only when an OTLP endpoint is configured; otherwise the
    // observability extension keeps its cheap no-op path.
    const otel =
      opts.otelToolSpans ??
      Boolean(
        String(
          container.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
            container.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
            '',
        ).trim(),
      );
    // Durable sub-agent port. Built once per factory and bound lazily per call
    // so a not-yet-started container does not break assembly; the extension is
    // only constructed for AgentVersions that enable subagent-spawn.
    const subagentSpawnPort =
      opts.subagentSpawnPort ?? createSubagentSpawnPort(container);
    // task-state store: durable todo/memory backed by the same MySQL authority.
    const taskStateStore = opts.taskStateStore ?? createTaskStateStore(container);
    const bundleDeps = {
      toolRiskPolicy,
      skillManagerFactory,
      subagentSpawnPort,
      taskStateStore,
      otel,
      ...obsTruncationLimits,
    };
    const {
      createSandboxBridgeExtensionBundleFactory,
      createRunScopedSandboxBridgeTransport,
      createSandboxBridgeHttpTransport,
    } = await import(
      '../infrastructure/sandbox/sandbox-bridge-http-transport.js'
    );
    if (opts.sandboxTransport) {
      // Explicit static transport (tests / advanced inject only).
      extensionBundleFactory = createSandboxBridgeExtensionBundleFactory({
        sandboxTransport: opts.sandboxTransport,
        extraDeps: bundleDeps,
      });
    } else {
      const internalKeyring = String(
        container.env.SANDBOX_INTERNAL_HMAC_KEYRING || '',
      ).trim();
      const internalActiveKid = String(
        container.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '',
      ).trim();
      // Signed internal plane is the only route to Sandbox: fail fast rather
      // than boot a runtime whose every sandbox tool dies at call time.
      if (!internalKeyring || !internalActiveKid) {
        throw new Error(
          'SANDBOX_INTERNAL_HMAC_KEYRING and SANDBOX_INTERNAL_HMAC_ACTIVE_KID are required (see .env.example)',
        );
      }
      let createInternalReadTransport = null;
      let createInternalExecutionTransport = null;
      let createInternalFilesWriteTransport = null;
      let createInternalArtifactTransport = null;
      let createInternalProcessTransport = null;
      let createInternalSearchTransport = null;
      {
        const {
          createInternalFilesReadTransport,
          createInternalSkillsReadTransport,
        } = await import(
          '../infrastructure/sandbox/internal-files-read-http.js'
        );
        createInternalReadTransport = (runContext) =>
          {
            const readOptions = {
            baseUrl: container.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
            keyring: internalKeyring,
            activeKid: internalActiveKid,
            allowInsecureHttp: true,
            traceState: runContext?.traceState,
            };
            const files = createInternalFilesReadTransport(readOptions);
            const skills = createInternalSkillsReadTransport(readOptions);
            return { ...files, readSkill: skills.readFile };
          };
        const { createInternalExecutionTransport: createExecutionTransport } =
          await import(
            '../infrastructure/sandbox/internal-execution-http.js'
          );
        createInternalExecutionTransport = (runContext) =>
          createExecutionTransport({
            baseUrl: container.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
            keyring: internalKeyring,
            activeKid: internalActiveKid,
            allowInsecureHttp: true,
            traceState: runContext?.traceState,
          });
        const { createInternalFilesWriteTransport: createFilesWriteTransport } = await import(
          '../infrastructure/sandbox/internal-files-write-http.js'
        );
        createInternalFilesWriteTransport = (runContext) =>
          createFilesWriteTransport({
            baseUrl: container.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
            keyring: internalKeyring,
            activeKid: internalActiveKid,
            allowInsecureHttp: true,
            traceState: runContext?.traceState,
          });
        const { createInternalArtifactSubmitTransport } = await import(
          '../infrastructure/sandbox/internal-artifact-submit-http.js'
        );
        createInternalArtifactTransport = (runContext) =>
          createInternalArtifactSubmitTransport({
            baseUrl: container.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
            keyring: internalKeyring,
            activeKid: internalActiveKid,
            allowInsecureHttp: true,
            traceState: runContext?.traceState,
          });
        const { createInternalProcessTransport: createProcessTransport } =
          await import(
            '../infrastructure/sandbox/internal-process-http.js'
          );
        createInternalProcessTransport = (runContext) =>
          createProcessTransport({
            baseUrl: container.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
            keyring: internalKeyring,
            activeKid: internalActiveKid,
            allowInsecureHttp: true,
            traceState: runContext?.traceState,
          });
        const { createInternalSearchTransport: createSearchTransport } =
          await import('../infrastructure/sandbox/internal-search-http.js');
        createInternalSearchTransport = (runContext) =>
          createSearchTransport({
            baseUrl: container.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
            keyring: internalKeyring,
            activeKid: internalActiveKid,
            allowInsecureHttp: true,
            traceState: runContext?.traceState,
          });
      }
      extensionBundleFactory = createSandboxBridgeExtensionBundleFactory({
        extraDeps: bundleDeps,
        createTransportForRun: (runContext) =>
          createRunScopedSandboxBridgeTransport(runContext, {
            createTransport: createSandboxBridgeHttpTransport,
            createInternalReadTransport,
            createInternalExecutionTransport,
            createInternalFilesWriteTransport,
            createInternalArtifactTransport,
            createInternalProcessTransport,
            createInternalSearchTransport,
          }),
      });
    }
  }

  const promptImageLoader =
    opts.promptImageLoader ??
    (async (input) => {
      const [{ createSandboxClient }, { loadPromptImagesFromAttachmentStore }] =
        await Promise.all([
          import('../infrastructure/sandbox/sandbox-client.js'),
          import('../infrastructure/pi/prompt-image-loader.js'),
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

  return createPiRunExecutorFactory({
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
    agentDir,
    sessionLockRenewIntervalMs: opts.sessionLockRenewIntervalMs,
    steerPollIntervalMs:
      opts.steerPollIntervalMs ??
      (Number(container.env.AGENT_STEER_POLL_INTERVAL_MS) || undefined),
    toolBudget: resolvePiRunToolBudget(container.env),
    extensionBundleFactory,
    eventProjectionMode: opts.eventProjectionMode,
  });
}
