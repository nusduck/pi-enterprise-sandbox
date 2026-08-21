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
        extraDeps: { toolRiskPolicy, skillManagerFactory },
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
      }
      extensionBundleFactory = createSandboxBridgeExtensionBundleFactory({
        extraDeps: { toolRiskPolicy, skillManagerFactory },
        createTransportForRun: (runContext) =>
          createRunScopedSandboxBridgeTransport(runContext, {
            createTransport: createSandboxBridgeHttpTransport,
            createInternalReadTransport,
            createInternalExecutionTransport,
            createInternalFilesWriteTransport,
            createInternalArtifactTransport,
            createInternalProcessTransport,
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
