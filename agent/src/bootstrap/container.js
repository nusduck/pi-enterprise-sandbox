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
import { A2aCredentialService } from '../application/a2a/credential-service.js';
import { A2aTaskService } from '../application/a2a/task-service.js';
import { A2aStreamService } from '../application/a2a/stream-service.js';
import { buildArtifactDownloadUri as mintArtifactDownloadUri } from '../application/a2a/artifact-download.js';
import { ulid } from '../domain/shared/ulid.js';
import { createRunWorkerRuntime } from './run-worker.js';
import { PINNED_PI_SDK_VERSION } from '../infrastructure/pi/pi-runtime-factory.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve concrete AGENT_PI_AGENT_DIR for PiRuntimeFactory.create().
 * Default: `{cwd}/pi-agent-home` (Docker WORKDIR /app → /app/pi-agent-home).
 * Empty/missing env is OK only when the default path can be ensured on disk.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveAgentPiAgentDir(env = process.env) {
  const raw = String(env.AGENT_PI_AGENT_DIR || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd(), 'pi-agent-home');
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
    /** Immutable per-process MCP startup discovery snapshot. */
    this.mcpDiscovery = null;
    /** @type {Promise<object> | null} */
    this.mcpDiscoveryPromise = null;
  }

  /**
   * Connect enabled MCP_SERVERS_JSON entries and run adapter-owned tools/list
   * discovery once per Agent process. Failures are retained for /ready rather
   * than being silently converted into an empty tool list.
   */
  async preflightMcpServers() {
    if (this.mcpDiscovery) return this.mcpDiscovery;
    if (this.mcpDiscoveryPromise) return this.mcpDiscoveryPromise;
    this.mcpDiscoveryPromise = import(
      '../infrastructure/mcp/pi-mcp-adapter-factory.js'
    )
      .then(async ({ createEnvironmentSecretResolver, discoverEnabledMcpServers }) => {
        const snapshot = await discoverEnabledMcpServers({
          serverRegistry: this.env.MCP_SERVERS_JSON || '[]',
          secretResolver: createEnvironmentSecretResolver(this.env),
          cwd:
            this.env.AGENT_PI_DEFAULT_CWD ||
            this.env.AGENT_SESSION_WORKSPACE_CWD ||
            undefined,
        });
        this.mcpDiscovery = snapshot;
        for (const server of snapshot.servers) {
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
        return snapshot;
      })
      .finally(() => {
        this.mcpDiscoveryPromise = null;
      });
    return this.mcpDiscoveryPromise;
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
   * @returns {(agentVersion: object) => Promise<object>}
   */
  createDefaultModelResolver() {
    const env = this.env;
    return async (agentVersion) => {
      const { bindAgentVersionConfig, resolveConcreteModel } = await import(
        '../infrastructure/pi/pi-runtime-factory.js'
      );
      const { resolveModel, toPiModel } = await import(
        '../infrastructure/model-registry.js'
      );
      const bound = bindAgentVersionConfig(agentVersion);
      if (bound.model) {
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
          const mcpDiscovery = await this.preflightMcpServers();
          mcpResolver = createPiMcpResolver({
            serverRegistry: this.env.MCP_SERVERS_JSON || '[]',
            secretResolver:
              opts.mcpSecretResolver ??
              createEnvironmentSecretResolver(this.env),
            runtimeRoot:
              opts.mcpRuntimeRoot || this.env.AGENT_MCP_RUNTIME_ROOT || undefined,
            defaultMcpServers: mcpDiscovery.mcpServers,
          });
        }
        const {
          normalizeSkillRoots,
          primarySkillRoot,
        } = await import('../skills/paths.js');
        const skillRoots = normalizeSkillRoots(
          this.env.SKILLS_ROOT || this.env.AGENT_SKILLS_ROOT
            ? [String(this.env.SKILLS_ROOT || this.env.AGENT_SKILLS_ROOT).trim()]
            : undefined,
        );
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
        });
      } else {
        const { createSandboxClient } = await import(
          '../infrastructure/sandbox/sandbox-client.js'
        );
        const internalKeyring = String(
          this.env.SANDBOX_INTERNAL_HMAC_KEYRING || '',
        ).trim();
        const internalActiveKid = String(
          this.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '',
        ).trim();
        let createInternalReadTransport = null;
        let createInternalExecutionTransport = null;
        let createInternalFilesWriteTransport = null;
        let createInternalArtifactTransport = null;
        let createInternalProcessTransport = null;
        if (internalKeyring && internalActiveKid) {
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
          createTransportForRun: (runContext) =>
            createRunScopedSandboxBridgeTransport(runContext, {
              createSandboxClient,
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

    return createPiRunExecutorFactory({
      transactionManager: this.getTransactionManager(),
      createRepositories: (db) => this.createRepositories(db),
      sessionLockManager,
      piRuntimeFactory,
      sessionAdapter,
      modelResolver: opts.modelResolver,
      workspaceResolver: opts.workspaceResolver,
      requestAuthResolver:
        opts.requestAuthResolver ??
        (String(this.env.LLMIO_API_KEY || '').trim()
          ? async (model) => ({
              provider: model.provider,
              apiKey: String(this.env.LLMIO_API_KEY).trim(),
            })
          : undefined),
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
    const conversationService = new ConversationService({
      transactionManager: tx,
      createRepositories,
      db: this.knex,
      generateId: this.generateId,
      now: this.now,
      sessionProvisioner,
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

    return {
      executeRunService,
      recoveryService,
      workerRuntime,
      runQueue,
      cancelSignal,
      leaseManager,
      runExecutorFactory,
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
