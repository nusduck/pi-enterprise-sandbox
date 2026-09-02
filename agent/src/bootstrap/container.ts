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
import { CreateRunService } from '../application/create-run-service.js';
import { GetRunService } from '../application/get-run-service.js';
import { CancelRunService } from '../application/cancel-run-service.js';
import { ExecuteRunService } from '../application/execute-run-service.js';
import { RunRecoveryService } from '../application/run-recovery-service.js';
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
import { PINNED_PI_SDK_VERSION } from '../infrastructure/dsh/constants.js';
import {
  createRepositoryBundle,
  resolveMysqlUrlFromEnv,
  resolveRedisUrlFromEnv,
  resolveWorkerExecutorFactory,
} from './container-env.js';
import { buildPiRunExecutorFactory } from './container-run-executor.js';
import { buildSkillManagerFactory } from './container-skill-manager.js';
import { McpDiscoveryState } from './container-mcp.js';

// Re-exported so bootstrap callers keep one entry point for the container.
export {
  assertWorkerSandboxServiceToken,
  createRepositoryBundle,
  resolveMysqlUrlFromEnv,
  resolveRedisUrlFromEnv,
  resolveSkillRootsForRun,
  resolveWorkerExecutorFactory,
} from './container-env.js';

/** 过渡期宽松类型：容器装配的对象几乎都还是 JS。 */
type Loose = any;

/** 构造期可注入的缝。生产不传，走真实实现；测试用它避开真连接。 */
export interface ServiceContainerOptions {
  readonly generateId?: () => string;
  readonly now?: () => Date;
  readonly runExecutorFactory?: Loose;
  readonly createMysqlKnex?: Loose;
  readonly createRedisClient?: Loose;
  readonly createRunQueue?: Loose;
  readonly destroyMysqlKnex?: Loose;
  readonly destroyRedisClient?: Loose;
  readonly destroyRunQueue?: Loose;
}

export class ServiceContainer {
  // TS 要求类字段显式声明；JS 里它们只在构造器里赋值。逐条列出来还有个好处：
  // 容器持有的可变状态一眼可见，不必读完整个构造器。
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  mysqlUrl: Loose;
  redisUrl: Loose;
  generateId: () => string;
  now: () => Date;
  /** Explicit factory only — no silent production stub. */
  runExecutorFactory: Loose;
  _opts: ServiceContainerOptions;
  knex: import('knex').Knex | null = null;
  redis: Loose = null;
  runQueueHandle: Loose = null;
  started = false;
  /**
   * After a successful start then shutdown, instance is terminal (no restart).
   * Failed start cleans up and allows retry (startPromise cleared).
   */
  shutdownDone = false;
  startPromise: Promise<ServiceContainer> | null = null;
  shutdownPromise: Promise<void> | null = null;
  readonly #mcp: McpDiscoveryState;

  constructor(
    env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
    opts: ServiceContainerOptions = {},
  ) {
    this.env = env;
    this.mysqlUrl = resolveMysqlUrlFromEnv(env);
    this.redisUrl = resolveRedisUrlFromEnv(env);
    this.generateId = opts.generateId ?? ulid;
    this.now = opts.now ?? (() => new Date());
    /** Explicit factory only — no silent production stub. */
    this.runExecutorFactory = opts.runExecutorFactory ?? null;
    this._opts = opts;

    this.knex = null;
    this.redis = null;
    this.runQueueHandle = null;
    this.started = false;
    /**
     * After a successful start then shutdown, instance is terminal (no restart).
     * Failed start cleans up and allows retry (startPromise cleared).
     * @type {boolean}
     */
    this.shutdownDone = false;
    this.startPromise = null;
    this.shutdownPromise = null;
    /**
     * Latest MCP discovery snapshot (may be incomplete after a cold-start
     * failure). Refreshed by {@link preflightMcpServers}; incomplete results
     * are not permanent — later forced refreshes can recover tools.
     */
    this.#mcp = new McpDiscoveryState();
  }

  /** @see McpDiscoveryState.preflight */
  async preflightMcpServers(opts: { force?: boolean } = {}) {
    return this.#mcp.preflight(opts);
  }

  /** @see McpDiscoveryState.readiness */
  getMcpReadiness() {
    return this.#mcp.readiness();
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
   */
  createDefaultModelResolver(): (
    agentVersion: Loose,
    selection?: { modelId?: string | null },
  ) => Promise<Loose> {
    const env = this.env;
    return async (agentVersion, selection: { modelId?: string | null } = {}) => {
      const { bindAgentVersionConfig, resolveConcreteModel } = await import(
        '../infrastructure/dsh/agent-version-bindings.js'
      );
      const { resolveModel, toPiModel, buildCachedRegistry, resolveDefaultModelId } =
        await import('../infrastructure/model-registry.js');
      const bound = bindAgentVersionConfig(agentVersion);
      if (bound.model) {
        if (selection.modelId && String((bound.model as Loose).id) !== selection.modelId) {
          return resolveConcreteModel(
            bound,
            toPiModel(resolveModel(selection.modelId, { env }), {
              baseUrl: String(env.LLMIO_BASE_URL || '').trim(),
            }),
          );
        }
        return resolveConcreteModel(bound, null);
      }
      const policy: Loose = bound.modelPolicy || {};
      const ref =
        policy.reference && typeof policy.reference === 'object'
          ? (policy.reference as Record<string, unknown>)
          : policy.modelRef && typeof policy.modelRef === 'object'
            ? (policy.modelRef as Record<string, unknown>)
            : {};
      const modelId =
        (typeof selection.modelId === 'string' && selection.modelId.trim()) ||
        (typeof policy.modelId === 'string' && policy.modelId.trim()) ||
        (typeof policy.id === 'string' && policy.id.trim()) ||
        (typeof ref.modelId === 'string' && String(ref.modelId).trim()) ||
        (typeof ref.id === 'string' && String(ref.id).trim()) ||
        (env.MODEL_ID && String(env.MODEL_ID).trim()) ||
        resolveDefaultModelId(buildCachedRegistry(env));
      const entry = resolveModel(modelId, { env, useCached: true });
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
   * Build a per-Run SkillManager factory for the skill-lifecycle extension.
   * @returns {Promise<(runContext: object) => object | null>}
   */
  async createSkillManagerFactory() {
    return buildSkillManagerFactory(this.env);
  }

  /**
   * Pi runtime factory constructor/factory (PR-05 slice A).
   * Does **not** enable production RunExecutor — worker still fail-fast without
   * an explicit runExecutorFactory (slice B wires the executor).
   */
  createPiRuntimeFactory(
    opts: {
      sessionAdapter?: { captureSnapshotPayload?: Loose; dispose?: Loose };
      extensionFactories?: unknown[];
      loadSdk?: () => Promise<Loose>;
    } = {},
  ) {
    // Lazy class load so import of container stays free of SDK side effects.
    return import('../infrastructure/dsh/runtime-factory.js').then(
      async ({ DshRuntimeFactory }) => {
        // 2026-08-31（ADR 0009 D9 / 计划 H7.4）：这里原本构造一个
        // `createPiMcpResolver(...)` 传给 `DshRuntimeFactory`。那个参数
        // **runtime-factory 从来没读过**——又一个终止在被忽略的参数上的装配
        // （与 extensionBundleFactory 同形）。MCP 现在由 overlay 里的
        // `dsh-mcp-client` 实例负责，一台服务器一个插件，与官方 dsh 一致。
        const { primarySkillRoot } = await import('../skills/paths.js');
        const { resolveSkillMountRoots } = await import('../skills/manager.js');
        // Process-wide default: the system tier only. The user tier is
        // per-caller, so the executor passes `additionalSkillPaths` per Run —
        // scanning the whole user base here would put every tenant's skills
        // into every prompt.
        const { systemRoot } = resolveSkillMountRoots(this.env);
        const skillRoots = [systemRoot];
        return new DshRuntimeFactory({
          sessionAdapter: opts.sessionAdapter,
          extensionFactories: opts.extensionFactories,
          loadSdk: opts.loadSdk,
          defaultCwd:
            this.env.AGENT_PI_DEFAULT_CWD ||
            this.env.AGENT_SESSION_WORKSPACE_CWD ||
            undefined,
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
   * @param {object} [deps]
   */
  createPiSessionAdapter(deps = {}) {
    void deps;
    return Promise.resolve({
      captureSnapshotPayload(sm, opts) {
        return { header: sm.getHeader(), entries: sm.getEntries(), cwd: opts?.cwd };
      },
      async dispose() {},
    });
  }

  /**
   * Pure platform event projector (no I/O).
   */
  createPlatformEventProjector() {
    return import('../infrastructure/dsh/event-projector.js').then(
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
        (error as Loose).code = 'SANDBOX_INTERNAL_HMAC_REQUIRED';
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
   */
  createSessionRecoveryService(
    opts: {
      transactionManager?: { run: Loose };
      createRepositories?: (db: Loose) => Loose;
    } = {},
  ) {
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
     *   eventProjectionMode?: 'session-subscribe' | 'observability' | 'both',
     *   sessionLockManager?: any,
   *   piRuntimeFactory?: any,
   *   sessionAdapter?: any,
   *   projector?: any,
   *   recoveryService?: SessionRecoveryService,
   *   sandboxSessionProvisioner?: any,
   *   promptImageLoader?: Function,
   *   sessionLockRenewIntervalMs?: number,
   *   steerPollIntervalMs?: number,
     *   mcpSecretResolver?: Function,
   *   mcpRuntimeRoot?: string,
   * }} opts
   * @returns {Promise<import('../application/run-executor.js').RunExecutorFactory>}
   */
  async createPiRunExecutorFactory(opts) {
    return buildPiRunExecutorFactory(this, opts);
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
    // Owner-scoped Sandbox HTTP client factory (X-API-Key + X-Acting-*).
    // This is the browser/session public adapter, not the run-fenced HMAC plane;
    // conversation delete has no Run or fence token.
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
    const errors: unknown[] = [];

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
export function createServiceContainer(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  opts: ServiceContainerOptions = {},
): ServiceContainer {
  return new ServiceContainer(env, opts);
}
