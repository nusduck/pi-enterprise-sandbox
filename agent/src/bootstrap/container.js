/**
 * Production composition root (PR-04 T4).
 *
 * Builds MySQL + Redis infrastructure and application services from env.
 * Import / construct does **not** open connections. Call {@link start} explicitly.
 * Never falls back to SQLite or in-memory stores.
 *
 * Sensitive DSNs never appear in thrown error messages (validators already sanitize).
 */

import { TransactionManager } from '../infrastructure/mysql/transaction-manager.js';
import { OrganizationRepository } from '../infrastructure/mysql/repositories/organization-repository.js';
import { ExternalReferenceRepository } from '../infrastructure/mysql/repositories/external-reference-repository.js';
import { AgentCatalogRepository } from '../infrastructure/mysql/repositories/agent-catalog-repository.js';
import { ConversationRepository } from '../infrastructure/mysql/repositories/conversation-repository.js';
import { AgentSessionRepository } from '../infrastructure/mysql/repositories/agent-session-repository.js';
import { AgentSessionSnapshotRepository } from '../infrastructure/mysql/repositories/agent-session-snapshot-repository.js';
import { MessageRepository } from '../infrastructure/mysql/repositories/message-repository.js';
import { PiSessionJournalRepository } from '../infrastructure/mysql/repositories/pi-session-journal-repository.js';
import { RunRepository } from '../infrastructure/mysql/repositories/run-repository.js';
import { RunEventRepository } from '../infrastructure/mysql/repositories/run-event-repository.js';
import { TraceSpanRepository } from '../infrastructure/mysql/repositories/trace-span-repository.js';
import { IdempotencyRepository } from '../infrastructure/mysql/repositories/idempotency-repository.js';
import { ToolExecutionRepository } from '../infrastructure/mysql/repositories/tool-execution-repository.js';
import { ApprovalRepository } from '../infrastructure/mysql/repositories/approval-repository.js';
import { InteractionRepository } from '../infrastructure/mysql/repositories/interaction-repository.js';
import { SandboxAuditEventRepository } from '../infrastructure/mysql/repositories/sandbox-audit-event-repository.js';
import { A2aCredentialRepository } from '../infrastructure/mysql/repositories/a2a-credential-repository.js';
import { A2aTaskRepository } from '../infrastructure/mysql/repositories/a2a-task-repository.js';
import { A2aAuditRepository } from '../infrastructure/mysql/repositories/a2a-audit-repository.js';
import { ArtifactRepository } from '../infrastructure/mysql/repositories/artifact-repository.js';
import { ProcessExecutionRepository } from '../infrastructure/mysql/repositories/process-execution-repository.js';
import { CronJobRepository } from '../infrastructure/mysql/repositories/cron-job-repository.js';
import { OutboxRepository } from '../infrastructure/outbox/outbox-repository.js';
import { CreateRunService } from '../application/create-run-service.js';
import { GetRunService } from '../application/get-run-service.js';
import { CancelRunService } from '../application/cancel-run-service.js';
import { ExecuteRunService } from '../application/execute-run-service.js';
import { RunRecoveryService } from '../application/run-recovery-service.js';
import { createStubRunExecutor } from '../application/run-executor.js';
import { createPiRunExecutorFactory } from '../application/pi-run-executor.js';
import { resolvePiRunToolBudget } from '../application/pi-run-tool-budget.js';
import { SessionRecoveryService } from '../application/session-recovery-service.js';
import { RunEventQueryService } from '../application/run-event-query-service.js';
import { TraceQueryService } from '../application/trace-query-service.js';
import { RunEventSseService } from '../application/run-event-sse-service.js';
import { ConversationService } from '../application/conversation-service.js';
import { ApprovalQueryService } from '../application/approval-query-service.js';
import { ApprovalDecisionService } from '../application/approval-decision-service.js';
import { InteractionResponseService } from '../application/interaction-response-service.js';
import { SteerRunService } from '../application/steer-run-service.js';
import { FollowUpService } from '../application/follow-up-service.js';
import { CronJobService } from '../application/cron-job-service.js';
import { A2aCredentialService } from '../application/a2a/credential-service.js';
import { A2aTaskService } from '../application/a2a/task-service.js';
import { A2aStreamService } from '../application/a2a/stream-service.js';
import { buildArtifactDownloadUri as mintArtifactDownloadUri } from '../application/a2a/artifact-download.js';
import { ulid } from '../domain/shared/ulid.js';
import { createRunWorkerRuntime } from './run-worker.js';
import { PINNED_PI_SDK_VERSION } from '../infrastructure/pi/pi-runtime-factory.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
// Static: skill path policy is pure path math with no SDK side effects, and
// resolveSkillRootsForRun runs on the per-Run hot path.
import * as skillPathsModule from '../skills/paths.js';

/**
 * Resolve concrete AGENT_PI_AGENT_DIR for PiRuntimeFactory.create().
 * Local default: `{cwd}/.runtime/agent/pi-agent-home`.
 * Containers set AGENT_PI_AGENT_DIR explicitly to `/app/pi-agent-home`.
 * Empty/missing env is OK only when the default path can be ensured on disk.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveAgentPiAgentDir(env = process.env) {
  const raw = String(env.AGENT_PI_AGENT_DIR || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd(), '.runtime', 'agent', 'pi-agent-home');
}

/**
 * Ensure agentDir exists and is usable before first Pi runtime create.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {string} absolute path
 */
export function ensureAgentPiAgentDir(env = process.env) {
  const dir = resolveAgentPiAgentDir(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const e = new Error(
      `AGENT_PI_AGENT_DIR is required and must be creatable (path=${dir}): ${msg}`,
    );
    // @ts-ignore
    e.code = 'PI_AGENT_DIR_REQUIRED';
    throw e;
  }
  return dir;
}

/**
 * Fail-closed: worker Sandbox calls need service API token when not stub.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 */
export function assertWorkerSandboxServiceToken(env = process.env) {
  const token = String(env.SANDBOX_API_TOKEN || '').trim();
  if (token) return token;
  const deployment = String(
    env.DEPLOYMENT_ENV || env.NODE_ENV || '',
  ).toLowerCase();
  const authOn =
    String(env.SANDBOX_AUTH_ENABLED || '').toLowerCase() === 'true' ||
    String(env.SANDBOX_AUTH_ENABLED || '') === '1';
  if (deployment === 'production' || authOn) {
    const e = new Error(
      'SANDBOX_API_TOKEN is required for agent-worker Sandbox ownership ' +
        '(service X-API-Key + durable X-Acting-* headers). ' +
        'Production must set a strong secret; development compose may use the ' +
        'dev-only placeholder default when SANDBOX_AUTH_ENABLED=true.',
    );
    // @ts-ignore
    e.code = 'SANDBOX_API_TOKEN_REQUIRED';
    throw e;
  }
  return '';
}

/**
 * Skill roots one Run may read: the bundled system tier plus that caller's own
 * `<orgId>/<userId>` directory.
 *
 * Resolved per Run rather than once per process — the user tier is per-user, so
 * a process-wide list would put every tenant's installed skills into every
 * prompt. A malformed identity degrades to system-only instead of throwing.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @param {{ orgId?: unknown, userId?: unknown } | null} identity
 * @returns {string[]}
 */
export function resolveSkillRootsForRun(env, identity) {
  const {
    SYSTEM_SKILL_ROOT,
    USER_SKILL_ROOT,
    skillRootsForIdentity,
  } = skillPathsModule;
  const systemRoot = String(
    env?.SKILLS_ROOT || env?.AGENT_SKILLS_ROOT || SYSTEM_SKILL_ROOT,
  ).trim();
  const userRootBase = String(
    env?.SKILLS_USER_ROOT || env?.AGENT_SKILLS_USER_ROOT || USER_SKILL_ROOT,
  ).trim();
  try {
    return skillRootsForIdentity(identity, { systemRoot, userRootBase });
  } catch {
    return [systemRoot];
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveMysqlUrlFromEnv(env = process.env) {
  const url =
    env.AGENT_DATABASE_URL ||
    env.MYSQL_URL ||
    env.DATABASE_URL ||
    '';
  return String(url).trim() || null;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveRedisUrlFromEnv(env = process.env) {
  const url =
    env.AGENT_REDIS_URL ||
    env.REDIS_URL ||
    '';
  return String(url).trim() || null;
}

/**
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db
 * @param {{ now?: () => Date }} [opts]
 */
export function createRepositoryBundle(db, opts = {}) {
  const now = opts.now ?? (() => new Date());
  const traceSpans = new TraceSpanRepository(db, { now });
  return {
    organizations: new OrganizationRepository(db, { now }),
    externalRefs: new ExternalReferenceRepository(db, { now }),
    catalog: new AgentCatalogRepository(db, { now }),
    conversations: new ConversationRepository(db),
    sessions: new AgentSessionRepository(db, { now }),
    /** PR-05 acceleration snapshots (not sole truth). */
    sessionSnapshots: new AgentSessionSnapshotRepository(db, {
      now,
      runtimePiSdkVersion: opts.runtimePiSdkVersion ?? PINNED_PI_SDK_VERSION,
    }),
    messages: new MessageRepository(db),
    /** PR-05 long-term Pi JSONL journal (messages-backed). */
    journal: new PiSessionJournalRepository(db, {
      now,
      generateId: opts.generateId,
    }),
    runs: new RunRepository(db, { now }),
    runEvents: new RunEventRepository(db, { traceSpans }),
    traceSpans,
    idempotency: new IdempotencyRepository(db, { now }),
    /** PR-06 B2: durable tool ledger + policy audit + approvals. */
    toolExecutions: new ToolExecutionRepository(db, { now }),
    approvals: new ApprovalRepository(db, { now }),
    interactions: new InteractionRepository(db, { now }),
    sandboxAudit: new SandboxAuditEventRepository(db, { now }),
    outbox: new OutboxRepository(db, { now }),
    /** PR-12 A2A protocol. */
    a2aCredentials: new A2aCredentialRepository(db, { now }),
    a2aTasks: new A2aTaskRepository(db, { now }),
    a2aAudit: new A2aAuditRepository(db, { now }),
    artifacts: new ArtifactRepository(db),
    processExecutions: new ProcessExecutionRepository(db),
    cronJobs: new CronJobRepository(db, { now }),
  };
}

/**
 * Whether stub RunExecutor is allowed for worker (never production default).
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @param {{ runExecutorFactory?: Function|null }} opts
 */
export function resolveWorkerExecutorFactory(env, opts = {}) {
  if (typeof opts.runExecutorFactory === 'function') {
    return opts.runExecutorFactory;
  }
  const allowStub =
    String(env.AGENT_ALLOW_STUB_EXECUTOR || '').toLowerCase() === 'true';
  const deployment = String(
    env.DEPLOYMENT_ENV || env.NODE_ENV || '',
  ).toLowerCase();
  const isProd = deployment === 'production';
  if (allowStub && !isProd) {
    return () => createStubRunExecutor();
  }
  return null;
}

export class ServiceContainer {
  /**
   * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
   * @param {{
   *   generateId?: () => string,
   *   now?: () => Date,
   *   runExecutorFactory?: Function | null,
   *   createMysqlKnex?: Function,
   *   createRedisClient?: Function,
   *   createRunQueue?: Function,
   *   destroyMysqlKnex?: Function,
   *   destroyRedisClient?: Function,
   *   destroyRunQueue?: Function,
   * }} [opts]
   */
  constructor(env = process.env, opts = {}) {
    this.env = env;
    this.mysqlUrl = resolveMysqlUrlFromEnv(env);
    this.redisUrl = resolveRedisUrlFromEnv(env);
    this.generateId = opts.generateId ?? ulid;
    this.now = opts.now ?? (() => new Date());
    /** Explicit factory only — no silent production stub. */
    this.runExecutorFactory = opts.runExecutorFactory ?? null;
    this._opts = opts;

    /** @type {import('knex').Knex | null} */
    this.knex = null;
    /** @type {any} */
    this.redis = null;
    /** @type {any} */
    this.runQueueHandle = null;
    /** @type {boolean} */
    this.started = false;
    /**
     * After a successful start then shutdown, instance is terminal (no restart).
     * Failed start cleans up and allows retry (startPromise cleared).
     * @type {boolean}
     */
    this.shutdownDone = false;
    /** @type {Promise<ServiceContainer> | null} */
    this.startPromise = null;
    /** @type {Promise<void> | null} */
    this.shutdownPromise = null;
    /**
     * Latest MCP discovery snapshot (may be incomplete after a cold-start
     * failure). Refreshed by {@link preflightMcpServers}; incomplete results
     * are not permanent — later force/cooldown refreshes can recover tools.
     */
    this.mcpDiscovery = null;
    /** @type {number} epoch ms of last discovery attempt */
    this.mcpDiscoveryAt = 0;
    /** @type {Promise<object> | null} */
    this.mcpDiscoveryPromise = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.mcpRediscoveryTimer = null;
  }

  /**
   * Connect enabled MCP_SERVERS_JSON entries and run adapter-owned tools/list
   * discovery. Retries transient Streamable-HTTP → SSE 405 races at worker
   * boot. Incomplete snapshots are retained for /ready diagnostics but can be
   * refreshed (force or cooldown) so runs are not stuck without MCP forever.
   *
   * @param {{
   *   force?: boolean,
   *   maxAttempts?: number,
   *   retryCooldownMs?: number,
   * }} [opts]
   */
  async preflightMcpServers(opts = {}) {
    const force = opts.force === true;
    const retryCooldownMs = Number.isFinite(opts.retryCooldownMs)
      ? Math.max(0, Number(opts.retryCooldownMs))
      : 30_000;
    const maxAttempts = Math.max(
      1,
      Math.min(5, Number.isFinite(opts.maxAttempts) ? Number(opts.maxAttempts) : 3),
    );

    if (this.mcpDiscovery && !force) {
      const complete =
        this.mcpDiscovery.ready === true ||
        Number(this.mcpDiscovery.serverCount ?? 0) === 0 ||
        Number(this.mcpDiscovery.toolCount ?? 0) > 0;
      if (complete) return this.mcpDiscovery;
      const age = Date.now() - (this.mcpDiscoveryAt || 0);
      if (age < retryCooldownMs) return this.mcpDiscovery;
      // Incomplete and cooldown elapsed → fall through to rediscover.
    }
    if (this.mcpDiscoveryPromise) return this.mcpDiscoveryPromise;

    this.mcpDiscoveryPromise = import(
      '../infrastructure/mcp/pi-mcp-adapter-factory.js'
    )
      .then(async ({ createEnvironmentSecretResolver, discoverEnabledMcpServers }) => {
        const secretResolver = createEnvironmentSecretResolver(this.env);
        const cwd =
          this.env.AGENT_PI_DEFAULT_CWD ||
          this.env.AGENT_SESSION_WORKSPACE_CWD ||
          undefined;
        const serverRegistry = this.env.MCP_SERVERS_JSON || '[]';

        /** @type {object | null} */
        let snapshot = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          snapshot = await discoverEnabledMcpServers({
            serverRegistry,
            secretResolver,
            cwd,
          });
          if (
            snapshot.ready === true ||
            Number(snapshot.serverCount ?? 0) === 0 ||
            Number(snapshot.toolCount ?? 0) > 0
          ) {
            break;
          }
          if (attempt < maxAttempts) {
            const delayMs = 750 * attempt;
            console.warn(
              `[agent-mcp] discovery incomplete (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }

        this.mcpDiscovery = snapshot;
        this.mcpDiscoveryAt = Date.now();
        for (const server of snapshot?.servers ?? []) {
          if (server.status === 'connected') {
            console.log(
              `[agent-mcp] MCP Server connected id=${server.serverId} tools=${server.toolCount}`,
            );
          } else {
            console.error(
              `[agent-mcp] MCP readiness error id=${server.serverId}: ${server.error}`,
            );
          }
        }
        // Background rediscovery if still incomplete so a later run can pick
        // up tools without a process restart.
        this.#ensureMcpRediscoveryLoop();
        return snapshot;
      })
      .finally(() => {
        this.mcpDiscoveryPromise = null;
      });
    return this.mcpDiscoveryPromise;
  }

  /**
   * When bootstrap discovery left servers unreachable, periodically re-probe
   * so worker runs can gain MCP tools without a restart.
   */
  #ensureMcpRediscoveryLoop() {
    if (this.mcpRediscoveryTimer) return;
    if (this.mcpDiscovery?.ready === true) return;
    if (Number(this.mcpDiscovery?.serverCount ?? 0) === 0) return;
    this.mcpRediscoveryTimer = setInterval(() => {
      if (this.mcpDiscovery?.ready === true || Number(this.mcpDiscovery?.toolCount ?? 0) > 0) {
        if (this.mcpRediscoveryTimer) {
          clearInterval(this.mcpRediscoveryTimer);
          this.mcpRediscoveryTimer = null;
        }
        return;
      }
      void this.preflightMcpServers({ force: true, maxAttempts: 2 }).catch((err) => {
        console.error(
          '[agent-mcp] background rediscovery failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }, 30_000);
    if (typeof this.mcpRediscoveryTimer.unref === 'function') {
      this.mcpRediscoveryTimer.unref();
    }
  }

  getMcpReadiness() {
    return (
      this.mcpDiscovery ?? {
        ready: false,
        serverCount: 0,
        toolCount: 0,
        servers: [],
        mcpServers: [],
      }
    );
  }

  /**
   * Open MySQL / Redis connections. Concurrent callers share one startPromise.
   * On failure, all partially-created handles are destroyed and start may retry.
   * @param {{
   *   migrate?: boolean,
   *   connectMysql?: boolean,
   *   connectRedis?: boolean,
   * }} [opts]
   */
  async start(opts = {}) {
    if (this.shutdownDone) {
      throw new Error(
        'ServiceContainer was shut down; create a new instance to restart',
      );
    }
    if (this.started) return this;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.#startOnce(opts).then(
      (self) => {
        this.started = true;
        return self;
      },
      async (err) => {
        this.startPromise = null;
        await this.#rollbackPartialStart();
        throw err;
      },
    );
    return this.startPromise;
  }

  /**
   * @param {{
   *   migrate?: boolean,
   *   connectMysql?: boolean,
   *   connectRedis?: boolean,
   * }} opts
   */
  async #startOnce(opts) {
    const connectMysql = opts.connectMysql !== false;
    const connectRedis = opts.connectRedis !== false;

    if (connectMysql) {
      if (!this.mysqlUrl) {
        throw new Error(
          'AGENT_DATABASE_URL (mysql:// or mysql2://) is required to start the Agent data plane',
        );
      }
      const createMysqlKnex =
        this._opts.createMysqlKnex ||
        (
          await import('../infrastructure/mysql/client.js')
        ).createMysqlKnex;
      const { assertMysqlConnectionUrl } = await import(
        '../infrastructure/mysql/client.js'
      );
      assertMysqlConnectionUrl(this.mysqlUrl);
      this.knex = createMysqlKnex(this.mysqlUrl);
      await this.knex.raw('SELECT 1');

      if (opts.migrate === true) {
        const { migrateLatest } = await import(
          '../infrastructure/mysql/migrate.js'
        );
        await migrateLatest(this.knex);
      }
    }

    if (connectRedis) {
      if (!this.redisUrl) {
        throw new Error(
          'AGENT_REDIS_URL or REDIS_URL (redis:// or rediss://) is required to start Agent coordination',
        );
      }
      const redisMod = await import('../infrastructure/redis/index.js');
      const createRedisClient =
        this._opts.createRedisClient || redisMod.createRedisClient;
      const createRunQueue =
        this._opts.createRunQueue || redisMod.createRunQueue;
      redisMod.assertRedisConnectionUrl(this.redisUrl);
      this.redis = createRedisClient(this.redisUrl);
      this.runQueueHandle = createRunQueue(this.redisUrl, {
        queueName: this.env.AGENT_RUNS_QUEUE_NAME || undefined,
      });
    }

    return this;
  }

  /** Destroy any handles opened during a failed start. */
  async #rollbackPartialStart() {
    const errors = [];
    if (this.runQueueHandle) {
      try {
        const destroy =
          this._opts.destroyRunQueue ||
          (await import('../infrastructure/redis/run-queue.js')).destroyRunQueue;
        await destroy(this.runQueueHandle);
      } catch (err) {
        errors.push(err);
      }
      this.runQueueHandle = null;
    }
    if (this.redis) {
      try {
        const destroy =
          this._opts.destroyRedisClient ||
          (await import('../infrastructure/redis/client.js')).destroyRedisClient;
        await destroy(this.redis);
      } catch (err) {
        errors.push(err);
      }
      this.redis = null;
    }
    if (this.knex) {
      try {
        const destroy =
          this._opts.destroyMysqlKnex ||
          (await import('../infrastructure/mysql/client.js')).destroyMysqlKnex;
        await destroy(this.knex);
      } catch (err) {
        errors.push(err);
      }
      this.knex = null;
    }
    this.started = false;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'ServiceContainer start rollback failures');
    }
  }

  /**
   * Synchronous check for a **pre-injected** worker executor factory (or non-prod stub).
   * Production workers obtain the real factory via {@link ensureWorkerRunExecutorFactory}
   * (async, after MySQL/Redis start) inside {@link createWorkerServices}.
   */
  requireWorkerExecutorFactory() {
    if (typeof this.runExecutorFactory === 'function') {
      return this.runExecutorFactory;
    }
    const factory = resolveWorkerExecutorFactory(this.env, {});
    if (!factory) {
      const err = new Error(
        'Run executor factory is not pre-configured. Production workers wire the Pi factory in createWorkerServices (ensureWorkerRunExecutorFactory). For offline tests inject runExecutorFactory, or set AGENT_ALLOW_STUB_EXECUTOR=true in non-production only.',
      );
      // @ts-ignore
      err.code = 'RUN_EXECUTOR_NOT_CONFIGURED';
      throw err;
    }
    return factory;
  }

  /**
   * Default modelResolver: AgentVersion embedded model, else modelPolicy id /
   * MODEL_ID registry entry → pi-ai Model (LLMIO baseUrl/apiKey from env).
   * @returns {(agentVersion: object, selection?: { modelId?: string|null }) => Promise<object>}
   */
  createDefaultModelResolver() {
    const env = this.env;
    return async (agentVersion, selection = {}) => {
      const { bindAgentVersionConfig, resolveConcreteModel } = await import(
        '../infrastructure/pi/pi-runtime-factory.js'
      );
      const { resolveModel, toPiModel } = await import(
        '../infrastructure/model-registry.js'
      );
      const bound = bindAgentVersionConfig(agentVersion);
      if (bound.model) {
        if (selection.modelId && String(bound.model.id) !== selection.modelId) {
          return resolveConcreteModel(
            bound,
            toPiModel(resolveModel(selection.modelId, { env }), {
              baseUrl: String(env.LLMIO_BASE_URL || '').trim(),
            }),
          );
        }
        return resolveConcreteModel(bound, null);
      }
      const policy = bound.modelPolicy || {};
      const ref =
        policy.reference && typeof policy.reference === 'object'
          ? /** @type {Record<string, unknown>} */ (policy.reference)
          : policy.modelRef && typeof policy.modelRef === 'object'
            ? /** @type {Record<string, unknown>} */ (policy.modelRef)
            : {};
      const modelId =
        (typeof selection.modelId === 'string' && selection.modelId.trim()) ||
        (typeof policy.modelId === 'string' && policy.modelId.trim()) ||
        (typeof policy.id === 'string' && policy.id.trim()) ||
        (typeof ref.modelId === 'string' && String(ref.modelId).trim()) ||
        (typeof ref.id === 'string' && String(ref.id).trim()) ||
        (env.MODEL_ID && String(env.MODEL_ID).trim()) ||
        'deepseek-v4-flash';
      const entry = resolveModel(modelId, { env });
      const baseUrl = String(env.LLMIO_BASE_URL || '').trim();
      const piModel = toPiModel(entry, {
        baseUrl,
      });
      return resolveConcreteModel(bound, piModel);
    };
  }

  /**
   * Default workspaceResolver: logical Pi cwd from env (Agent does not mount
   * physical workspace volumes; Sandbox owns physical roots).
   * @returns {(agentSession: object) => Promise<string>}
   */
  createDefaultWorkspaceResolver() {
    const env = this.env;
    return async (_agentSession) => {
      const cwd = String(
        env.AGENT_SESSION_WORKSPACE_CWD || env.AGENT_PI_DEFAULT_CWD || '',
      ).trim();
      if (!cwd) {
        throw new Error(
          'AGENT_SESSION_WORKSPACE_CWD (or AGENT_PI_DEFAULT_CWD) is required for the worker Pi executor',
        );
      }
      return cwd;
    };
  }

  /**
   * Resolve or build the worker RunExecutor factory.
   * Order: explicit inject → non-prod stub allowlist → production Pi factory.
   * Never uses stub under DEPLOYMENT_ENV/NODE_ENV=production.
   * @returns {Promise<Function>}
   */
  async ensureWorkerRunExecutorFactory() {
    if (typeof this.runExecutorFactory === 'function') {
      return this.runExecutorFactory;
    }
    const stub = resolveWorkerExecutorFactory(this.env, {});
    if (stub) {
      this.runExecutorFactory = stub;
      return stub;
    }
    if (!this.knex || !this.redis) {
      const err = new Error(
        'ServiceContainer must be started with MySQL and Redis before wiring the worker Pi RunExecutor factory',
      );
      // @ts-ignore
      err.code = 'RUN_EXECUTOR_NOT_CONFIGURED';
      throw err;
    }
    const factory = await this.createPiRunExecutorFactory({
      modelResolver: this.createDefaultModelResolver(),
      workspaceResolver: this.createDefaultWorkspaceResolver(),
    });
    this.runExecutorFactory = factory;
    return factory;
  }

  isDataPlaneReady() {
    return this.started && this.knex != null && this.redis != null;
  }

  /**
   * @returns {TransactionManager}
   */
  getTransactionManager() {
    if (!this.knex) throw new Error('ServiceContainer MySQL not started');
    return new TransactionManager(this.knex);
  }

  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} [db]
   */
  createRepositories(db) {
    const executor = db ?? this.knex;
    if (!executor) throw new Error('ServiceContainer MySQL not started');
    return createRepositoryBundle(executor, {
      now: this.now,
      generateId: this.generateId,
    });
  }

  /**
   * Ref-only queue enqueue bound to BullMQ when started.
   */
  createRunQueueAdapter() {
    if (!this.runQueueHandle?.queue) {
      throw new Error('ServiceContainer Redis run queue not started');
    }
    const queue = this.runQueueHandle.queue;
    return {
      /**
       * @param {{ runId: string, orgId: string, traceId: string }} ref
       * @param {import('bullmq').JobsOptions} [options]
       */
      enqueue: async (ref, options) => {
        const { enqueueRunJob } = await import(
          '../infrastructure/redis/run-queue.js'
        );
        return enqueueRunJob(queue, ref, options);
      },
    };
  }

  createCancelSignal() {
    if (!this.redis) throw new Error('ServiceContainer Redis not started');
    // Lazy class load
    return import('../infrastructure/redis/cancel-signal.js').then(
      ({ CancelSignal }) => new CancelSignal(this.redis),
    );
  }

  createLeaseManager() {
    if (!this.redis) throw new Error('ServiceContainer Redis not started');
    return import('../infrastructure/redis/lease-manager.js').then(
      ({ LeaseManager }) =>
        new LeaseManager(this.redis, {
          ttlMs: Number(this.env.AGENT_RUN_LEASE_TTL_MS) || undefined,
          renewIntervalMs:
            Number(this.env.AGENT_RUN_LEASE_RENEW_INTERVAL_MS) || undefined,
        }),
    );
  }

  /**
   * Redis session lock manager (PR-05). Coordination only — never Session status.
   * Lazy import; requires started Redis.
   */
  createSessionLockManager() {
    if (!this.redis) throw new Error('ServiceContainer Redis not started');
    return import('../infrastructure/redis/session-lock-manager.js').then(
      ({ SessionLockManager }) =>
        new SessionLockManager(this.redis, {
          ttlMs: Number(this.env.AGENT_SESSION_LOCK_TTL_MS) || undefined,
          renewIntervalMs:
            Number(this.env.AGENT_SESSION_LOCK_RENEW_INTERVAL_MS) || undefined,
        }),
    );
  }

  /**
   * Pi runtime factory constructor/factory (PR-05 slice A).
   * Does **not** enable production RunExecutor — worker still fail-fast without
   * an explicit runExecutorFactory (slice B wires the executor).
   *
   * @param {{
   *   sessionAdapter?: import('../infrastructure/pi/pi-session-adapter.js').PiSessionAdapter,
   *   extensionFactories?: unknown[],
   *   loadSdk?: () => Promise<any>,
   *   mcpResolver?: Function | object | null,
   *   mcpSecretResolver?: Function,
   *   mcpRuntimeRoot?: string,
   * }} [opts]
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
  async createSkillManagerFactory() {
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
          skillRoots: resolveSkillRoots(this.env, { orgId, userId }),
          downloadArchive: ({ attachmentId, signal }) =>
            sandboxClient.downloadDatasetContent(sandboxSessionId, attachmentId, {
              signal,
            }),
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

  createPiRuntimeFactory(opts = {}) {
    // Lazy class load so import of container stays free of SDK side effects.
    // agentDir must be concrete before PiRuntimeFactory.create() (fail at assembly).
    const agentDir =
      opts.agentDir != null && String(opts.agentDir).trim()
        ? path.resolve(String(opts.agentDir).trim())
        : ensureAgentPiAgentDir(this.env);
    return import('../infrastructure/pi/pi-runtime-factory.js').then(
      async ({ PiRuntimeFactory }) => {
        let mcpResolver = opts.mcpResolver;
        if (mcpResolver === undefined) {
          const {
            createEnvironmentSecretResolver,
            createPiMcpResolver,
          } = await import('../infrastructure/mcp/pi-mcp-adapter-factory.js');
          await this.preflightMcpServers();
          // Live getter: background rediscovery updates mcpDiscovery and the
          // next run sees newly connected tools without rebuilding the factory.
          mcpResolver = createPiMcpResolver({
            serverRegistry: this.env.MCP_SERVERS_JSON || '[]',
            secretResolver:
              opts.mcpSecretResolver ??
              createEnvironmentSecretResolver(this.env),
            runtimeRoot:
              opts.mcpRuntimeRoot || this.env.AGENT_MCP_RUNTIME_ROOT || undefined,
            getDefaultMcpServers: () => this.getMcpReadiness().mcpServers ?? [],
          });
        }
        const { primarySkillRoot } = await import('../skills/paths.js');
        const { resolveSkillMountRoots } = await import('../skills/manager.js');
        // Process-wide default: the system tier only. The user tier is
        // per-caller, so the executor passes `additionalSkillPaths` per Run —
        // scanning the whole user base here would put every tenant's skills
        // into every prompt.
        const { systemRoot } = resolveSkillMountRoots(this.env);
        const skillRoots = [systemRoot];
        return new PiRuntimeFactory({
          sessionAdapter: opts.sessionAdapter,
          extensionFactories: opts.extensionFactories,
          loadSdk: opts.loadSdk,
          mcpResolver,
          defaultCwd:
            this.env.AGENT_PI_DEFAULT_CWD ||
            this.env.AGENT_SESSION_WORKSPACE_CWD ||
            undefined,
          agentDir,
          // Progressive skill disclosure: scan formal skill mount into loader
          // → formatSkillsForPrompt (not Pi product docs under node_modules).
          additionalSkillPaths: skillRoots,
          skillRoot: primarySkillRoot(skillRoots),
          workspaceRoot:
            this.env.AGENT_SESSION_WORKSPACE_CWD ||
            this.env.AGENT_PI_DEFAULT_CWD ||
            '/home/sandbox/workspace',
        });
      },
    );
  }

  /**
   * Pi session adapter (JSONL materialize + SessionManager.open).
   * @param {ConstructorParameters<typeof import('../infrastructure/pi/pi-session-adapter.js').PiSessionAdapter>[0]} [deps]
   */
  createPiSessionAdapter(deps = {}) {
    return import('../infrastructure/pi/pi-session-adapter.js').then(
      ({ PiSessionAdapter }) => new PiSessionAdapter(deps),
    );
  }

  /**
   * Pure platform event projector (no I/O).
   */
  createPlatformEventProjector() {
    return import('../infrastructure/pi/platform-event-projector.js').then(
      ({ PlatformEventProjector }) => new PlatformEventProjector(),
    );
  }

  /**
   * Formal Agent -> Sandbox session provisioning transport shared by the HTTP
   * pre-upload path and the worker pre-runtime path.
   */
  async createSandboxSessionProvisioner() {
    const keyring = String(
      this.env.SANDBOX_INTERNAL_HMAC_KEYRING || '',
    ).trim();
    const activeKid = String(
      this.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '',
    ).trim();
    const deployment = String(
      this.env.DEPLOYMENT_ENV || this.env.NODE_ENV || '',
    ).toLowerCase();
    if (!keyring || !activeKid) {
      if (deployment === 'production') {
        const error = new Error(
          'SANDBOX_INTERNAL_HMAC_KEYRING and SANDBOX_INTERNAL_HMAC_ACTIVE_KID ' +
            'are required for production SandboxSession provisioning',
        );
        error.code = 'SANDBOX_INTERNAL_HMAC_REQUIRED';
        throw error;
      }
      return null;
    }
    const { createInternalSessionProvisioner } = await import(
      '../infrastructure/sandbox/internal-session-http.js'
    );
    return createInternalSessionProvisioner({
      baseUrl: this.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
      keyring,
      activeKid,
      allowInsecureHttp: true,
    });
  }

  /**
   * Session recovery + atomic journal/snapshot checkpoint service (PR-05 slice B).
   * Requires started MySQL (or inject transactionManager).
   *
   * @param {{
   *   transactionManager?: { run: Function },
   *   createRepositories?: (db: any) => any,
   * }} [opts]
   */
  createSessionRecoveryService(opts = {}) {
    const tx = opts.transactionManager ?? this.getTransactionManager();
    const createRepositories =
      opts.createRepositories ?? ((db) => this.createRepositories(db));
    return new SessionRecoveryService({
      transactionManager: tx,
      createRepositories,
      generateId: this.generateId,
      now: this.now,
      runtimePiSdkVersion: PINNED_PI_SDK_VERSION,
    });
  }

  /**
   * Explicit PiRunExecutor factory (PR-05 slice B).
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
  async createPiRunExecutorFactory(opts) {
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
    if (!this.knex || !this.redis) {
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
        : ensureAgentPiAgentDir(this.env);

    // Worker Sandbox tools need service token + acting headers (not anonymous).
    if (typeof opts.extensionBundleFactory !== 'function' && !opts.sandboxTransport) {
      assertWorkerSandboxServiceToken(this.env);
    }

    const sessionLockManager =
      opts.sessionLockManager ?? (await this.createSessionLockManager());
    const sessionAdapter =
      opts.sessionAdapter ?? (await this.createPiSessionAdapter());
    const piRuntimeFactory =
      opts.piRuntimeFactory ??
      (await this.createPiRuntimeFactory({
        sessionAdapter,
        extensionFactories: opts.extensionFactories,
        mcpResolver: opts.mcpResolver,
        mcpSecretResolver: opts.mcpSecretResolver,
        mcpRuntimeRoot: opts.mcpRuntimeRoot,
        agentDir,
      }));
    const projector =
      opts.projector ?? (await this.createPlatformEventProjector());
    const recoveryService =
      opts.recoveryService ?? this.createSessionRecoveryService();
    const sandboxSessionProvisioner =
      opts.sandboxSessionProvisioner ??
      (await this.createSandboxSessionProvisioner());

    // PR-08: per-run sandbox-bridge transport from durable runContext
    // (orgId/userId/traceId). Never process-global client with null auth/trace.
    let extensionBundleFactory = opts.extensionBundleFactory;
    if (typeof extensionBundleFactory !== 'function') {
      // Platform risk table: resolved once per factory, not per run, so a bad
      // config file fails at startup instead of mid-conversation.
      const { resolveToolRiskPolicy } = await import('../../config.js');
      const toolRiskPolicy =
        opts.toolRiskPolicy ?? resolveToolRiskPolicy(this.env);
      const skillManagerFactory =
        opts.skillManagerFactory !== undefined
          ? opts.skillManagerFactory
          : await this.createSkillManagerFactory();
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
          this.env.SANDBOX_INTERNAL_HMAC_KEYRING || '',
        ).trim();
        const internalActiveKid = String(
          this.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '',
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
              baseUrl: this.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
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
              baseUrl: this.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
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
              baseUrl: this.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
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
              baseUrl: this.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
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
              baseUrl: this.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
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
      transactionManager: this.getTransactionManager(),
      createRepositories: (db) => this.createRepositories(db),
      sessionLockManager,
      piRuntimeFactory,
      sessionAdapter,
      modelResolver: opts.modelResolver,
      promptImageLoader,
      workspaceResolver: opts.workspaceResolver,
      requestAuthResolver:
        opts.requestAuthResolver ??
        (String(this.env.LLMIO_API_KEY || '').trim()
          ? async (model) => ({
              provider: model.provider,
              apiKey: String(this.env.LLMIO_API_KEY).trim(),
            })
          : undefined),
      // Per-Run skill roots: system tier + this caller's own directory.
      skillRootsForRun:
        opts.skillRootsForRun ??
        ((identity) => resolveSkillRootsForRun(this.env, identity)),
      generateId: this.generateId,
      now: this.now,
      projector,
      recoveryService,
      sandboxSessionProvisioner,
      agentDir,
      sessionLockRenewIntervalMs: opts.sessionLockRenewIntervalMs,
      steerPollIntervalMs:
        opts.steerPollIntervalMs ??
        (Number(this.env.AGENT_STEER_POLL_INTERVAL_MS) || undefined),
      toolBudget: resolvePiRunToolBudget(this.env),
      extensionBundleFactory,
      eventProjectionMode: opts.eventProjectionMode,
    });
  }

  /**
   * HTTP-facing application services (after start with MySQL+Redis).
   */
  async createHttpServices() {
    if (!this.knex) throw new Error('ServiceContainer MySQL not started');
    const tx = this.getTransactionManager();
    const createRepositories = (db) => this.createRepositories(db);
    const runQueue = this.createRunQueueAdapter();
    const cancelSignal = await this.createCancelSignal();

    const createRunService = new CreateRunService({
      transactionManager: tx,
      createRepositories,
      generateId: this.generateId,
      now: this.now,
      runQueue,
    });
    // Cron keeps the same durable CreateRun flow but is explicitly labelled in
    // the Run fact table so trace/audit/UI can distinguish unattended work.
    const cronCreateRunService = new CreateRunService({
      transactionManager: tx,
      createRepositories,
      generateId: this.generateId,
      now: this.now,
      runQueue,
      source: 'cron',
    });
    const cronJobService = new CronJobService({
      transactionManager: tx,
      createRepositories,
      db: this.knex,
      createRunService: cronCreateRunService,
      generateId: this.generateId,
      now: this.now,
    });
    const getRunService = new GetRunService({
      createRepositories,
      db: this.knex,
      transactionManager: null,
    });
    const cancelRunService = new CancelRunService({
      transactionManager: tx,
      createRepositories,
      generateId: this.generateId,
      now: this.now,
      cancelSignal,
    });
    const steerRunService = new SteerRunService({
      transactionManager: tx,
      createRepositories,
      generateId: this.generateId,
      now: this.now,
    });
    const followUpService = new FollowUpService({ createRunService });
    const eventQueryService = new RunEventQueryService({
      createRepositories,
      db: this.knex,
    });
    const traceQueryService = new TraceQueryService({
      createRepositories,
      db: this.knex,
    });
    const sessionProvisioner = await this.createSandboxSessionProvisioner();
    // Owner-scoped Sandbox HTTP client factory (X-API-Key + X-Acting-*), same
    // transport ProcessAccessService already uses — not the internal HMAC
    // plane (that's run-fenced; conversation delete has no run/fence token).
    const { createSandboxClient } = await import(
      '../infrastructure/sandbox/sandbox-client.js'
    );
    const conversationService = new ConversationService({
      transactionManager: tx,
      createRepositories,
      db: this.knex,
      generateId: this.generateId,
      now: this.now,
      sessionProvisioner,
      createSandboxClient,
    });
    const approvalQueryService = new ApprovalQueryService({
      createRepositories,
      db: this.knex,
    });
    const approvalDecisionService = new ApprovalDecisionService({
      transactionManager: tx,
      createRepositories,
      runQueue,
      generateId: this.generateId,
      now: this.now,
    });
    const interactionResponseService = new InteractionResponseService({
      transactionManager: tx,
      createRepositories,
      runQueue,
      generateId: this.generateId,
      now: this.now,
    });

    // Redis stream is optional acceleration; MySQL remains history authority.
    let runEventStream = null;
    try {
      if (this.redis) {
        const { RunEventStream } = await import(
          '../infrastructure/redis/run-event-stream.js'
        );
        runEventStream = new RunEventStream(this.redis);
      }
    } catch {
      runEventStream = null;
    }

    const eventSseService = new RunEventSseService({
      eventQueryService,
      runEventStream,
    });

    // Mint only capability URLs backed by the HTTP process' owner-scoped
    // Sandbox byte streamer. Missing any required value keeps file.uri disabled.
    const a2aPublicBaseUrl = String(
      this.env.A2A_PUBLIC_BASE_URL || '',
    ).trim();
    const a2aArtifactDownloadSecret = String(
      this.env.A2A_ARTIFACT_DOWNLOAD_SECRET || '',
    ).trim();
    const sandboxInternalHmacKeyring = String(
      this.env.SANDBOX_INTERNAL_HMAC_KEYRING || '',
    ).trim();
    const sandboxInternalHmacActiveKid = String(
      this.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '',
    ).trim();
    const buildArtifactDownloadUri =
      a2aPublicBaseUrl &&
      a2aArtifactDownloadSecret &&
      sandboxInternalHmacKeyring &&
      sandboxInternalHmacActiveKid
        ? (input) =>
            mintArtifactDownloadUri({
              ...input,
              baseUrl: a2aPublicBaseUrl,
              secret: a2aArtifactDownloadSecret,
            })
        : null;

    const a2aCredentialService = new A2aCredentialService({
      createRepositories,
      transactionManager: tx,
      db: this.knex,
      generateId: this.generateId,
      now: this.now,
    });
    const a2aTaskService = new A2aTaskService({
      createRunService,
      getRunService,
      cancelRunService,
      steerRunService,
      followUpService,
      eventQueryService,
      createRepositories,
      transactionManager: tx,
      db: this.knex,
      generateId: this.generateId,
      now: this.now,
      defaultProvider: 'a2a',
      buildArtifactDownloadUri,
      requireAudit: true,
    });
    const a2aStreamService = new A2aStreamService({
      taskService: a2aTaskService,
      eventQueryService,
      getRunService,
      runEventStream,
      buildArtifactDownloadUri,
    });

    return {
      createRunService,
      cronJobService,
      getRunService,
      cancelRunService,
      steerRunService,
      followUpService,
      eventQueryService,
      traceQueryService,
      conversationService,
      approvalQueryService,
      approvalDecisionService,
      interactionResponseService,
      eventSseService,
      runEventStream,
      a2aCredentialService,
      a2aTaskService,
      a2aStreamService,
      createRepositories,
      transactionManager: tx,
      knex: this.knex,
    };
  }

  /**
   * Worker runtime + execute/recovery services.
   * Wires real Pi RunExecutor factory after start (or non-prod stub when allowed).
   * Never leaves production without an executor factory.
   */
  async createWorkerServices() {
    if (!this.knex || !this.redis) {
      throw new Error('ServiceContainer must be started with MySQL and Redis');
    }
    const runExecutorFactory = await this.ensureWorkerRunExecutorFactory();
    const tx = this.getTransactionManager();
    const createRepositories = (db) => this.createRepositories(db);
    const runQueue = this.createRunQueueAdapter();
    const cancelSignal = await this.createCancelSignal();
    const leaseManager = await this.createLeaseManager();

    const executeRunService = new ExecuteRunService({
      transactionManager: tx,
      createRepositories,
      leaseManager,
      cancelSignal,
      runExecutorFactory,
      generateId: this.generateId,
      now: this.now,
      leaseRenewIntervalMs:
        Number(this.env.AGENT_RUN_LEASE_RENEW_INTERVAL_MS) || undefined,
    });

    const recoveryService = new RunRecoveryService({
      transactionManager: tx,
      createRepositories,
      runQueue,
      generateId: this.generateId,
      now: this.now,
      leaseManager,
    });

    const workerRuntime = createRunWorkerRuntime({
      transactionManager: tx,
      createRepositories,
      leaseManager,
      runQueue,
      cancelSignal,
      runExecutorFactory,
      generateId: this.generateId,
      now: this.now,
      leaseRenewIntervalMs:
        Number(this.env.AGENT_RUN_LEASE_RENEW_INTERVAL_MS) || undefined,
    });

    const cronCreateRunService = new CreateRunService({
      transactionManager: tx,
      createRepositories,
      generateId: this.generateId,
      now: this.now,
      runQueue,
      source: 'cron',
    });
    const cronJobService = new CronJobService({
      transactionManager: tx,
      createRepositories,
      db: this.knex,
      createRunService: cronCreateRunService,
      generateId: this.generateId,
      now: this.now,
    });

    return {
      executeRunService,
      recoveryService,
      workerRuntime,
      runQueue,
      cancelSignal,
      leaseManager,
      runExecutorFactory,
      cronJobService,
      createRepositories,
      transactionManager: tx,
    };
  }

  /**
   * Outbox publisher loop deps (lazy Redis stream).
   */
  async createOutboxPublisher() {
    if (!this.knex || !this.redis) {
      throw new Error('ServiceContainer must be started with MySQL and Redis');
    }
    const { OutboxPublisher } = await import(
      '../infrastructure/outbox/outbox-publisher.js'
    );
    const { OutboxRepository } = await import(
      '../infrastructure/outbox/outbox-repository.js'
    );
    const { RunEventStream } = await import(
      '../infrastructure/redis/run-event-stream.js'
    );
    const repository = new OutboxRepository(this.knex, { now: this.now });
    const stream = new RunEventStream(this.redis);
    return new OutboxPublisher({ repository, stream });
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.#shutdownOnce();
    return this.shutdownPromise;
  }

  async #shutdownOnce() {
    if (this.shutdownDone) return;
    this.shutdownDone = true;
    /** @type {unknown[]} */
    const errors = [];

    if (this.mcpRediscoveryTimer) {
      clearInterval(this.mcpRediscoveryTimer);
      this.mcpRediscoveryTimer = null;
    }

    if (this.runQueueHandle) {
      try {
        const destroy =
          this._opts.destroyRunQueue ||
          (await import('../infrastructure/redis/run-queue.js')).destroyRunQueue;
        await destroy(this.runQueueHandle);
      } catch (err) {
        errors.push(err);
      }
      this.runQueueHandle = null;
    }

    if (this.redis) {
      try {
        const destroy =
          this._opts.destroyRedisClient ||
          (await import('../infrastructure/redis/client.js')).destroyRedisClient;
        await destroy(this.redis);
      } catch (err) {
        errors.push(err);
      }
      this.redis = null;
    }

    if (this.knex) {
      try {
        const destroy =
          this._opts.destroyMysqlKnex ||
          (await import('../infrastructure/mysql/client.js')).destroyMysqlKnex;
        await destroy(this.knex);
      } catch (err) {
        errors.push(err);
      }
      this.knex = null;
    }

    this.started = false;
    this.startPromise = null;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'ServiceContainer shutdown failures');
    }
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @param {object} [opts]
 */
export function createServiceContainer(env = process.env, opts = {}) {
  return new ServiceContainer(env, opts);
}
