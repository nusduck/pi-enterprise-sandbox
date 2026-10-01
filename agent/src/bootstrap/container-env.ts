/**
 * Environment and wiring helpers for the service container.
 *
 * Pure resolution of what the process was configured with — DSH agent dir,
 * MySQL/Redis URLs, per-run skill roots, the repository bundle, the worker
 * executor factory — plus the production token assertion that fails closed.
 * No service construction and no I/O beyond ensuring the agent dir exists.
 */

import { OrganizationRepository } from '../infrastructure/mysql/repositories/organization-repository.js';
import { ExternalReferenceRepository } from '../infrastructure/mysql/repositories/external-reference-repository.js';
import { AgentCatalogRepository } from '../infrastructure/mysql/repositories/agent-catalog-repository.js';
import { ConversationRepository } from '../infrastructure/mysql/repositories/conversation-repository.js';
import { AgentSessionRepository } from '../infrastructure/mysql/repositories/agent-session-repository.js';
import { AgentSessionSnapshotRepository } from '../infrastructure/mysql/repositories/agent-session-snapshot-repository.js';
import { MessageRepository } from '../infrastructure/mysql/repositories/message-repository.js';
import { SessionJournalRepository } from '../infrastructure/mysql/repositories/session-journal-repository.js';
import { RunRepository } from '../infrastructure/mysql/repositories/run-repository.js';
import { RunEventRepository } from '../infrastructure/mysql/repositories/run-event-repository.js';
import { TraceSpanRepository } from '../infrastructure/mysql/repositories/trace-span-repository.js';
import { IdempotencyRepository } from '../infrastructure/mysql/repositories/idempotency-repository.js';
import { ToolExecutionRepository } from '../infrastructure/mysql/repositories/tool-execution-repository.js';
import { ApprovalRepository } from '../infrastructure/mysql/repositories/approval-repository.js';
import { InteractionRepository } from '../infrastructure/mysql/repositories/interaction-repository.js';
import { TaskStateRepository } from '../infrastructure/mysql/repositories/task-state-repository.js';
import { SandboxAuditEventRepository } from '../infrastructure/mysql/repositories/sandbox-audit-event-repository.js';
import { A2aCredentialRepository } from '../infrastructure/mysql/repositories/a2a-credential-repository.js';
import { A2aTaskRepository } from '../infrastructure/mysql/repositories/a2a-task-repository.js';
import { A2aAuditRepository } from '../infrastructure/mysql/repositories/a2a-audit-repository.js';
import { ArtifactRepository } from '../infrastructure/mysql/repositories/artifact-repository.js';
import { ProcessExecutionRepository } from '../infrastructure/mysql/repositories/process-execution-repository.js';
import { CronJobRepository } from '../infrastructure/mysql/repositories/cron-job-repository.js';
import { SkillEnablementRepository } from '../infrastructure/mysql/repositories/skill-enablement-repository.js';
import { OrgSkillRepository } from '../infrastructure/mysql/repositories/org-skill-repository.js';
import { AgentVersionSkillRefRepository } from '../infrastructure/mysql/repositories/agent-version-skill-ref-repository.js';
import { SkillShareRequestRepository } from '../infrastructure/mysql/repositories/skill-share-request-repository.js';
import { AuthCredentialRepository } from '../infrastructure/mysql/repositories/auth-credential-repository.js';
import { BrowserAuthSessionRepository } from '../infrastructure/mysql/repositories/browser-auth-session-repository.js';
import { SsoIdentityRepository } from '../infrastructure/mysql/repositories/sso-identity-repository.js';
import { AgentAccessRepository } from '../infrastructure/mysql/repositories/agent-access-repository.js';
import { MemberRoleRepository } from '../infrastructure/mysql/repositories/member-role-repository.js';
import { ReviewRepository } from '../infrastructure/mysql/repositories/review-repository.js';
import { OutboxRepository } from '../infrastructure/outbox/outbox-repository.js';
import { createStubRunExecutor } from '../application/run-executor.js';
import * as skillPathsModule from '../skills/paths.js';
import { SystemSkillCatalog } from '../skills/system-catalog.js';
import {
  resolveRunSkills,
  type ResolveRunSkillsDeps,
  type RunSkillPathEntry,
} from '../skills/run-skills.js';
import type { SkillPolicy } from '@dsh/contract/skill-policy.js';

/** 身份来自不可信来源，两个字段都可能缺；解析失败时降级到系统层。 */
export interface IdentityLike {
  readonly orgId?: unknown;
  readonly userId?: unknown;
}

/**
 * Fail-closed: worker Sandbox calls need service API token when not stub.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 */
export function assertWorkerSandboxServiceToken(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
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
 * 用户层与 org 层共用的**发布存储基根**（`SKILLS_USER_ROOT`）。
 *
 * 只有这一处读它。org 层取 `<base>/<orgId>/_org`，用户层取 `<base>/<orgId>/<userId>`；
 * 两处各读一次环境变量、各自写默认值，迟早会漂成「发布到 A、运行读 B」——那种不一致
 * 的症状是发布成功但 Run 里看不到，很难从现象追到根因。
 */
export function publishedSkillBase(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const fallback = skillPathsModule.USER_SKILL_ROOT;
  return String(
    env?.SKILLS_USER_ROOT || env?.AGENT_SKILLS_USER_ROOT || fallback,
  ).trim() || fallback;
}

/**
 * 进程级系统 Skill 目录（ADR 0015 D4）。
 *
 * **必须与配置面用同一份**：`skillPolicy.system.names` 的「这个名字在不在当前
 * release」在保存时（配置面）与起 Run 时（这里）是同一个判定。两份独立实例虽然
 * 读同一个目录，但各自有 TTL 缓存，会出现「保存时认得、起 Run 时不认得」的窗口。
 * 目录自己带 5 秒 TTL 缓存，进程级单例不引入陈旧问题。
 */
let sharedSystemSkillCatalog: SystemSkillCatalog | null = null;

export function systemSkillCatalog(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): SystemSkillCatalog {
  if (sharedSystemSkillCatalog === null) {
    sharedSystemSkillCatalog = new SystemSkillCatalog({
      root: String(
        env?.SKILLS_ROOT || env?.AGENT_SKILLS_ROOT || skillPathsModule.SYSTEM_SKILL_ROOT,
      ).trim(),
    });
  }
  return sharedSystemSkillCatalog;
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
export function resolveSkillRootsForRun(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  identity: IdentityLike | null,
): string[] {
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
 * 一个 Run 可见的 Skill（ADR 0015 D1，design §3/§6.1）：系统层（**按绑定过滤后的
 * 名单**）+ org 层（钉摘要、核对过账本）+ 用户层（既有 S1 账本核对）。
 *
 * 返回的是 `RunSkillPathEntry[]` 而不是裸字符串数组：系统层现在带**名单**，
 * 而发现与 exec 挂载必须同构——只给一个目录，provider 会把整棵树都扫出来。
 *
 * 解析本身在 `skills/run-skills.ts`（可单测的纯逻辑）；这里只负责把进程环境
 * （系统根、用户/org 发布存储根、系统目录）接上。
 *
 * 身份不合法时只给系统层，与 `resolveSkillRootsForRun` 同样降级。
 */
export async function resolveRunSkillPaths(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  identity: IdentityLike | null,
  deps: {
    listEnabled: (owner: { orgId: string; userId: string }) => Promise<
      ReadonlyArray<{ name: string; contentDigest: string }>
    >;
    /** 本 Run 绑定的 `skillPolicy`；`null` = 省略 = 当前行为。 */
    skillPolicy?: SkillPolicy | null;
    /** 当前 release 的系统包名与描述（配置面与 Run 解析共用同一份目录）。 */
    systemSkillNames?: readonly string[];
    /** org 层账本读取（P2 起接入）；缺省视为「本 org 还没有 org 层」。 */
    readOrgVersion?: ResolveRunSkillsDeps['readOrgVersion'];
    logger?: { warn: (...args: unknown[]) => void };
  },
): Promise<RunSkillPathEntry[]> {
  const roots = resolveSkillRootsForRun(env, identity);
  const systemRoot = roots[0];
  // 系统目录未注入时按「release 里没有系统包」处理：`all` 展开为空、`allowlist`
  // 的每个名字都会写 `not_in_release` 诊断。宁可少挂，不可静默多挂。
  const allSystemNames = deps.systemSkillNames
    ?? (await systemSkillCatalog(env).names());
  if (!identity || roots.length < 2) {
    // 身份不合法：只给系统层，这仍然与既有的降级行为一致（拿不到调用者身份就
    // 不给用户层）。系统名单仍**显式列出**：Agent 侧发现与 exec 挂载只认同一种
    // 形状（结构化 + 名单），「不给名单」在 exec 那边是兼容期旧 Agent 的语义。
    // 这里展开成当前 release 的全部名字，可见集合与旧行为相同，形状不再含混。
    return [Object.freeze({
      kind: 'system',
      root: systemRoot,
      filtered: true,
      names: Object.freeze([...allSystemNames]),
    })];
  }
  const userPhysicalBase = publishedSkillBase(env);
  const orgId = String(identity.orgId);
  const userId = String(identity.userId);
  const resolved = await resolveRunSkills({
    orgId,
    userId,
    userPhysicalBase,
    orgPhysicalBase: userPhysicalBase,
    systemRoot,
    allSystemNames,
    policy: deps.skillPolicy ?? null,
    deps: {
      listEnabled: deps.listEnabled,
      ...(deps.readOrgVersion ? { readOrgVersion: deps.readOrgVersion } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    },
  });
  return [...resolved.discoverable];
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveMysqlUrlFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
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
export function resolveRedisUrlFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  const url =
    env.AGENT_REDIS_URL ||
    env.REDIS_URL ||
    '';
  return String(url).trim() || null;
}

/**
 * 仓储 opts。原来的 JSDoc 只声明了 `now`，而仓储实际还收 `generateId`——
 * 那正是这里曾经几处 `@ts-expect-error` 的全部原因：声明少了字段，不是类型系统的问题。
 */
export interface RepositoryBundleOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

export function createRepositoryBundle(
  db: import('knex').Knex | import('knex').Knex.Transaction,
  opts: RepositoryBundleOptions = {},
) {
  const now = opts.now ?? (() => new Date());
  const traceSpans = new TraceSpanRepository(db, { now });
  return {
    organizations: new OrganizationRepository(db, { now }),
    externalRefs: new ExternalReferenceRepository(db, { now }),
    catalog: new AgentCatalogRepository(db, { now }),
    conversations: new ConversationRepository(db),
    sessions: new AgentSessionRepository(db, { now }),
    /** PR-05 acceleration snapshots (not sole truth). */
    sessionSnapshots: new AgentSessionSnapshotRepository(db, { now }),
    messages: new MessageRepository(db),
    /** PR-05 long-term session JSONL journal (messages-backed). */
    journal: new SessionJournalRepository(db, {
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
    /** Agent working memory: session todo list + owner-scoped note log. */
    taskState: new TaskStateRepository(db, {
      now,
      generateId: opts.generateId,
    }),
    sandboxAudit: new SandboxAuditEventRepository(db, { now }),
    outbox: new OutboxRepository(db, { now }),
    /** PR-12 A2A protocol. */
    a2aCredentials: new A2aCredentialRepository(db, { now }),
    a2aTasks: new A2aTaskRepository(db, { now }),
    a2aAudit: new A2aAuditRepository(db, { now }),
    artifacts: new ArtifactRepository(db),
    processExecutions: new ProcessExecutionRepository(db),
    cronJobs: new CronJobRepository(db, { now }),
    skillEnablements: new SkillEnablementRepository(db, {
      now,
      generateId: opts.generateId,
    }),
    /** org 层共享 Skill 的账本（ADR 0015 D5）。org 作用域，没有 userId 维度。 */
    orgSkills: new OrgSkillRepository(db, {
      now,
      generateId: opts.generateId,
    }),
    /** AgentVersion → Skill 引用账本（ADR 0015 D5）：吊销影响面与 GC 判定的依据。 */
    agentVersionSkillRefs: new AgentVersionSkillRefRepository(db, { now }),
    /** 共享申请账本（ADR 0015 D6）。 */
    skillShareRequests: new SkillShareRequestRepository(db, {
      now,
      generateId: opts.generateId,
    }),
    authCredentials: new AuthCredentialRepository(db, { now }),
    /** 可撤销浏览器会话账本（design sso-integration-reservation §5.2）。 */
    browserAuthSessions: new BrowserAuthSessionRepository(db, { now }),
    /** 公司 SSO `(iss, sub)` → 平台用户关联（design sso-oidc-dev §3）。 */
    ssoIdentities: new SsoIdentityRepository(db, { now }),
    /** 智能体可见范围与按成员授予（design agent-visibility §3）。 */
    agentAccess: new AgentAccessRepository(db, { now }),
    /** 平台角色账本（admin / reviewer）：授予、撤销与审计（design rbac-roles §2）。 */
    memberRoles: new MemberRoleRepository(db, { now }),
    /** 审核账本（design agent-output-review §5.1）：任务 / 交付物 / 材料 / 审计。 */
    reviews: new ReviewRepository(db, { now }),
  };
}

/**
 * 进程级默认的**系统层清单**（ADR 0015 D4 / design §8）。
 *
 * 消费面有两个：Run 的发现（runtime-factory 只认按名过滤的 provider）与 exec 的
 * 挂载（`systemSkills` 名单）。两者必须同构，所以形状只有一种——
 * **结构化 + 显式名单**。裸目录字符串会被两边一起读成「解析不出名单」，
 * 结果是系统层凭空消失；名字取自与配置面/Run 解析共用的那份系统目录
 * （`systemSkillCatalog`，同一个 TTL 缓存，不会出现「保存时认得、起 Run 时不认得」）。
 */
export async function defaultSystemSkillRoots(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  systemRoot: string,
): Promise<readonly unknown[]> {
  const names = await systemSkillCatalog(env).names();
  return [Object.freeze({
    kind: 'system',
    root: systemRoot,
    filtered: true,
    names: Object.freeze([...names]),
  })];
}

/**
 * Whether stub RunExecutor is allowed for worker (never production default).
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @param {{ runExecutorFactory?: Function|null }} opts
 */
export function resolveWorkerExecutorFactory(env: NodeJS.ProcessEnv | Record<string, string | undefined>, opts: Record<string, any> = {}) {
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
