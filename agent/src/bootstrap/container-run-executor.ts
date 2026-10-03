/**
 * Assembly of the per-Run DSH executor factory.
 *
 * The container's single largest wiring step: repositories, session lock,
 * recovery, sandbox provisioning, the DSH runtime factory and the extension
 * bundle are all resolved here and handed to createDshRunExecutorFactory. Kept
 * out of container.js so the container stays a directory of services rather
 * than one long assembly script.
 */

import {
  assertWorkerSandboxServiceToken,
  publishedSkillBase,
  resolveRunSkillPaths,
  resolveSkillRootsForRun,
  systemSkillCatalog,
} from './container-env.js';
import {
  createDshRunExecutorFactory,
} from '../application/dsh-run-executor.js';
import {
  resolveDshRunToolBudget,
} from '../application/dsh-run-tool-budget.js';
import { bindAgentVersionConfig } from '../infrastructure/dsh/agent-version-bindings.js';
import { resolveRunSkills } from '../skills/run-skills.js';
import type { ServiceContainer } from './container.js';
import type { PlatformEventProjector } from '../infrastructure/dsh/event-projector.js';
import type { SessionRecoveryService } from '../application/session-recovery-service.js';
import {
  projectSkillDiagnostics,
  type RunSkillDiagnostic,
} from '../application/run-skill-diagnostics.js';

/** 子 Agent 队列端口与执行器装配的最小容器形状：只用容器已有的公开方法与字段。 */
interface SubagentPort {
  spawn(input: Record<string, unknown>): Promise<unknown>;
  getStatuses(input: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}
interface SessionLockManagerLike {
  acquire(agentSessionId: string, ownerToken: string): Promise<boolean>;
  renew(agentSessionId: string, ownerToken: string): Promise<boolean>;
  release(agentSessionId: string, ownerToken: string): Promise<boolean>;
  renewIntervalMs?: number;
}
interface DshRuntimeFactoryLike {
  create(input: Record<string, unknown>): Promise<unknown>;
}
interface SessionAdapterLike {
  captureSnapshotPayload(sm: unknown, opts?: unknown): unknown;
  dispose?(): unknown;
}
interface SandboxProvisionerLike {
  ensure(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
interface PromptImageInput extends Record<string, unknown> {
  readonly traceId?: unknown;
  readonly traceState?: unknown;
  readonly workspaceId?: unknown;
  readonly sandboxSessionId?: unknown;
  readonly attachments?: unknown;
  readonly signal?: unknown;
  readonly scope?: { readonly orgId?: unknown; readonly userId?: unknown } & Record<string, unknown>;
}

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
function createSubagentSpawnPort(container: ServiceContainer): SubagentPort {
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
    spawn: async (input) =>
      (await build()).spawn(
        input as { toolCallId: string; parentRunId: string; orgId: string; userId: string; task: string }, // reason: 队列透传的引用原样转交，由服务做字段校验
      ),
    getStatuses: async (input) =>
      (await build()).getStatuses(
        input as { parentRunId: string; orgId: string; userId: string }, // reason: 队列透传的引用原样转交，由服务做字段校验
      ),
  };
}

/**
 * Explicit DshRunExecutor factory (PR-05 slice B).
 *
 * @param {import('./container.js').ServiceContainer} container
 *
 * Requires modelResolver + workspaceResolver (+ typically extensionFactories /
 * resource configuration for the runtime). Production workers call this via
 * {@link ensureWorkerRunExecutorFactory} with default resolvers; callers may
 * still inject a custom factory on the container constructor.
 */

/**
 * `buildDshRunExecutorFactory` 的选项：按 L3 工厂实际消费的最小形状声明。
 * 不确定的句柄用已有的领域类型（投影器/恢复服务）或最小结构接口。
 */
export interface DshRunExecutorFactoryOptions {
  readonly modelResolver: (agentVersion: object) => object | Promise<object>;
  readonly workspaceResolver: (agentSession: object) => string | Promise<string>;
  readonly extensionFactories?: unknown[];
  readonly eventProjectionMode?: 'session-subscribe' | 'observability' | 'both';
  readonly sessionLockManager?: SessionLockManagerLike;
  readonly dshRuntimeFactory?: DshRuntimeFactoryLike;
  readonly sessionAdapter?: SessionAdapterLike;
  readonly projector?: PlatformEventProjector;
  readonly recoveryService?: SessionRecoveryService;
  readonly sandboxSessionProvisioner?: SandboxProvisionerLike;
  /** 入参携带 trace 与归属信息；按实际读取的字段声明最小形状。 */
  readonly promptImageLoader?: (
    input: PromptImageInput,
  ) => Promise<Array<{ type: 'image'; data: string; mimeType: string }>>;
  readonly sessionLockRenewIntervalMs?: number;
  readonly steerPollIntervalMs?: number;
  readonly subagentSpawnPort?: SubagentPort;
  readonly taskStateStore?: object;
  readonly otelToolSpans?: boolean;
  readonly sandboxTransport?: unknown;
  readonly toolRiskPolicy?: unknown;
  readonly skillManagerFactory?: unknown;
  readonly deltaTruncateLimit?: number;
  readonly thinkingTruncateLimit?: number;
  /** model 带 provider/id 等字段，形状由模型目录决定，暂不收紧。 */
  readonly requestAuthResolver?: (model: Record<string, unknown>, agentVersion: Record<string, unknown>) => object | Promise<object>;
  /**
   * 每个 Run 的 skill 根目录。返回 `string[]`——写 `unknown` 会让
   * DshRunExecutor 的依赖声明对不上（它要的就是路径数组）。
   */
  readonly skillRootsForRun?: (
    identity: object,
    skillPolicy?: unknown,
  ) => unknown[] | Promise<unknown[]>;
}

export async function buildDshRunExecutorFactory(
  container: ServiceContainer,
  opts: DshRunExecutorFactoryOptions,
) {
  if (typeof opts?.modelResolver !== 'function') {
    throw new Error(
      'createDshRunExecutorFactory requires modelResolver(agentVersion)',
    );
  }
  if (typeof opts?.workspaceResolver !== 'function') {
    throw new Error(
      'createDshRunExecutorFactory requires workspaceResolver(agentSession)',
    );
  }
  if (!container.knex || !container.redis) {
    throw new Error(
      'ServiceContainer must be started with MySQL and Redis before createDshRunExecutorFactory',
    );
  }


  // Worker Sandbox tools need service token + acting headers (not anonymous).
  if (!opts.sandboxTransport) {
    assertWorkerSandboxServiceToken(container.env);
  }

  const sessionLockManager =
    opts.sessionLockManager ?? (await container.createSessionLockManager());
  const sessionAdapter =
    opts.sessionAdapter ?? (await container.createDshSessionAdapter());
  const dshRuntimeFactory =
    opts.dshRuntimeFactory ??
    (await container.createDshRuntimeFactory({
      sessionAdapter,
      extensionFactories: opts.extensionFactories,
    }));
  const projector =
    opts.projector ?? (await container.createPlatformEventProjector());
  const recoveryService =
    opts.recoveryService ?? container.createSessionRecoveryService();
  const sandboxSessionProvisioner =
    opts.sandboxSessionProvisioner ??
    (await container.createSandboxSessionProvisioner());

  // 通往 exec 的唯一路径是 `@dsh/runtime` 的 remote-fs/shell/jobs（HMAC RPC），
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
              input.workspaceId || sandboxSessionId,
              attachmentId,
              { signal },
            ),
        },
        sandboxSessionId: input.sandboxSessionId as string, // reason: 附件加载的会话标识原样透传，由加载器校验
        attachments: input.attachments as Array<{ attachmentId: string; mimeType: string; size?: number | null }>, // reason: 附件清单原样透传，由加载器逐项校验
        signal: input.signal as AbortSignal | undefined, // reason: 调用方的中止信号原样透传，缺失时加载器按无信号处理
      });
    });

  // 建成变量而不是内联字面量：内联时多余属性检查会对不在
  // DshRunExecutorFactoryOptions 里的字段报错，而这里刻意多带了几个
  // 装配期用得到、执行器本身不读的项。
  const factoryOpts = {
    transactionManager: container.getTransactionManager(),
    createRepositories: (db) => container.createRepositories(db),
    sessionLockManager,
    dshRuntimeFactory,
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
    // Per-Run skills: system tier filtered by the bound `skillPolicy`, the
    // pinned org versions, and this caller's ledger-verified published versions
    // (ADR 0015 D1 / design §3.3 S1). Never discovered by scanning.
    skillRootsForRun:
      opts.skillRootsForRun ??
      ((identity, skillPolicy) =>
        resolveRunSkillPaths(container.env, identity, {
          listEnabled: (owner) =>
            container.createRepositories(container.knex).skillEnablements.listForOwner(owner),
          // org 层账本：Run 解析必须能回答「这个 (name, digest) 存在吗、什么状态」。
          // **没有它，`skillPolicy.org` 的每个条目都会被判成 missing 并静默排除**——
          // 配置说「带这个共享技能」而实际一个都不带，且症状只是一条诊断。
          // 所以这条依赖是 org 绑定能否生效的关键，不是可选优化。
          readOrgVersion: (input) =>
            container.createRepositories(container.knex).orgSkills.getVersion({
              orgId: input.orgId,
              name: input.name,
              contentDigest: input.contentDigest,
            }).then((row) => (row ? { status: row.status } : undefined)),
          skillPolicy: skillPolicy as never,
        })),
    generateId: container.generateId,
    now: container.now,
    projector,
    recoveryService,
    sandboxSessionProvisioner,
    sessionLockRenewIntervalMs: opts.sessionLockRenewIntervalMs,
    steerPollIntervalMs:
      opts.steerPollIntervalMs ??
      (Number(container.env.AGENT_STEER_POLL_INTERVAL_MS) || undefined),
    toolBudget: resolveDshRunToolBudget(container.env),
    riskOverrides: toolRiskPolicy,
    // 子 Agent 的 durable 面（ADR 0009 D6 / 计划 H5）。2026-08-31 之前它只挂在
    // `subagentSpawnPort` 上，而那个 port 只喂给 `extensionBundleFactory`
    // ——一条终止在被忽略的参数上的死链（见本文件上方注释）。与此同时
    // `durable-subagent.ts` 的 provider 用的是进程内队列：Worker 一重启子 Run 全丢，
    // 正是那个 provider 文件头说要避免的事。
    subagentSpawnPort: opts.subagentSpawnPort ?? createSubagentSpawnPort(container),
    eventProjectionMode: opts.eventProjectionMode,
  };
  return createDshRunExecutorFactory(factoryOpts);
}

/**
 * `run.started` 诊断的生产来源：给 `ExecuteRunService` 的 `resolveSkillDiagnostics`。
 *
 * 在写 `run.started` 之前、与执行期共用 `resolveRunSkills` 算一次（同一份绑定
 * policy、同一批账本与文件核对），只把 `{ name, reason }` 投影出去。算不出
 * （版本不存在、账本/文件失败）时返回空数组——诊断是可观测性，不改变执行期
 * fail-closed 的 Run 失败语义（执行器自己还会再算一次并按原逻辑处理）。
 */
export function createRunSkillDiagnosticsResolver(container: ServiceContainer): (
  input: { run: Record<string, unknown> | null | undefined; scope: { orgId: string; userId: string } },
) => Promise<RunSkillDiagnostic[]> {
  return async ({ run, scope }) => {
    try {
      const repos = container.createRepositories(container.knex);
      const agentVersionId = run?.agentVersionId ? String(run.agentVersionId) : '';
      if (!agentVersionId) return [];
      const agentVersion = await repos.catalog.getVersionById(agentVersionId);
      if (!agentVersion) return [];
      const bound = bindAgentVersionConfig(agentVersion);
      const identity = { orgId: scope.orgId, userId: scope.userId };
      const roots = resolveSkillRootsForRun(container.env, identity);
      const systemRoot = roots[0];
      if (!systemRoot) return [];
      const base = publishedSkillBase(container.env);
      const resolved = await resolveRunSkills({
        orgId: String(scope.orgId),
        userId: String(scope.userId),
        userPhysicalBase: base,
        orgPhysicalBase: base,
        systemRoot,
        allSystemNames: await systemSkillCatalog(container.env).names(),
        policy: (bound.skillPolicy ?? null) as never,
        deps: {
          listEnabled: (owner) => repos.skillEnablements.listForOwner(owner),
          readOrgVersion: (input) =>
            repos.orgSkills.getVersion({
              orgId: input.orgId,
              name: input.name,
              contentDigest: input.contentDigest,
            }).then((row) => (row ? { status: row.status } : undefined)),
        },
      });
      return [...projectSkillDiagnostics(resolved.diagnostics)];
    } catch {
      return [];
    }
  };
}

