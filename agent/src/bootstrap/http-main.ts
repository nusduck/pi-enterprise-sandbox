/**
 * Agent HTTP process entry (PR-04 T4).
 * Explicit start of container + listen. No worker/BullMQ consumer in this process.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  config,
  validateProductionConfig,
  effectiveConfig,
} from '../../config.js';
import { createServiceContainer } from './container.js';
import {
  publishedSkillBase,
  resolveRunSkillPaths,
  resolveSkillRootsForRun,
  systemSkillCatalog,
} from './container-env.js';
import { parseSkillPolicy, type SkillPolicy } from '@dsh/contract/skill-policy.js';
import {
  OrgSkillAdminService,
  createOrgSkillAdminHandler,
} from '../application/org-skill-admin-service.js';
import { collectStaleOrgSkillVersions } from '../skills/org-gc.js';
import {
  SkillShareService,
  createSkillShareHandler,
} from '../application/skill-share-service.js';
import {
  publishOrgSkillFromPublishedVersion,
} from '../skills/org-publish.js';
import { readPublishedVersion, readPublishedVersionManifest } from '../skills/enablement.js';
import { emitSkillAudit } from '../skills/audit.js';
import { listActiveOrgSkillPackages } from '../skills/org-catalog.js';
import type {
  PublishedSkillRootEntry,
  SystemSkillRootEntry,
} from '../skills/run-skills.js';
import { ExternalIdentityResolver } from '../application/parent/external-identity-resolver.js';
import { createSkillManager } from '../skills/manager.js';
import { draftSkillRootFor } from '../skills/paths.js';
import {
  mutateSkillWithLedger,
  resolveSkillVersionGcGraceMs,
} from '../application/skill-enablement-service.js';
import { createAgentHttpServer } from './create-http-server.js';
import { isDataPlaneReachable } from './worker-probe.js';
import { getExtensionDiagnostics as projectExtensionDiagnostics } from '../application/extension-diagnostics-service.js';
import { startTelemetry } from '../infrastructure/telemetry.js';
import { BrowserAuthService } from '../application/browser-auth-service.js';
import { createSsoLogin } from './sso-login-wiring.js';
import { createMemberRoleService } from './member-role-wiring.js';
import { createReviewService } from './review-wiring.js';
import {
  emailNotificationCapability,
  resolveEmailNotificationConfig,
} from '../infrastructure/notification/email-config.js';

/**
 * Build the lightweight observability columns for the operator Run list.
 * Model identity is emitted by model.request.* events, while token usage is
 * emitted by assistant message.completed events. Neither belongs on the Run
 * state row itself, so this projection deliberately reads only durable events.
 */
export function summarizeRunObservability(
  events: Array<{ eventType?: string; payloadJson?: unknown }>,
) {
  let modelId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;

  for (const event of events || []) {
    const data = event?.payloadJson;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const payload = data as Record<string, unknown>;
    if (String(event.eventType || '').toLowerCase().startsWith('model.request.')) {
      const model = payload.model;
      const candidate =
        payload.modelId ??
        payload.model_id ??
        (model && typeof model === 'object' && !Array.isArray(model)
          ? (model as Record<string, unknown>).id
          : null);
      if (typeof candidate === 'string' && candidate.trim()) {
        modelId = candidate.trim();
      }
    }
    const usage = payload.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const u = usage as Record<string, unknown>;
    const input = Number(u.inputTokens ?? u.input_tokens ?? u.input ?? 0);
    const output = Number(u.outputTokens ?? u.output_tokens ?? u.output ?? 0);
    const total = Number(u.totalTokens ?? u.total_tokens ?? u.total ?? 0);
    if (!Number.isFinite(input) || !Number.isFinite(output) || !Number.isFinite(total)) {
      continue;
    }
    hasUsage = true;
    inputTokens += Math.max(0, input);
    outputTokens += Math.max(0, output);
    totalTokens += total > 0 ? total : Math.max(0, input) + Math.max(0, output);
  }

  return {
    modelId,
    usage: hasUsage
      ? {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
        }
      : null,
  };
}

/**
 * Agent Card 的 Skill 描述（ADR 0015 §4.3）：`skillPolicy.system` 展开成当前 release
 * 里的名字与描述，`skillPolicy.org` 按钉住的摘要取描述。
 *
 * **`user` 层不进卡**：它随调用者变化，写进卡就是把「某个用户的私有能力」当成
 * Agent 的对外能力播出去。系统名字在 release 里已消失时跳过（配置保存后 release
 * 变了），与 Run 解析写 `not_in_release` 诊断是同一件事的两个出口。
 */
export async function skillsFromPolicy(
  policy: SkillPolicy,
  catalogEntries?: readonly { readonly name: string; readonly description: string }[],
): Promise<unknown[]> {
  const catalog = catalogEntries
    ?? (await systemSkillCatalog(process.env).list());
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const out: Array<{ name: string; description: string }> = [];
  const wanted = policy.system.mode === 'all'
    ? catalog.map((entry) => entry.name)
    : policy.system.mode === 'none'
      ? []
      : policy.system.names;
  for (const name of wanted) {
    const entry = byName.get(name);
    if (entry) out.push({ name: entry.name, description: entry.description });
  }
  for (const binding of policy.org) {
    out.push({
      name: binding.name,
      description: `Organization skill ${binding.name} (${binding.contentDigest.slice(0, 12)})`,
    });
  }
  return out;
}

/**
 * Build the A2A artifact byte authority. It resolves the task's durable Run
 * and Agent Session under the credential owner before asking Sandbox for an
 * artifact by opaque id. Filesystem paths are never accepted or forwarded.
 */
export function createA2aArtifactByteStreamer(deps: {
  createRepositories: (db?: any) => any;
  db?: any;
  artifactDownloadTransport: { downloadArtifact: (...args: any[]) => any };
}) {
  if (typeof deps?.createRepositories !== 'function') {
    throw new Error('createA2aArtifactByteStreamer requires repositories');
  }
  if (typeof deps?.artifactDownloadTransport?.downloadArtifact !== 'function') {
    throw new Error(
      'createA2aArtifactByteStreamer requires internal artifact transport',
    );
  }

  return async ({ principal, mapping, artifact, traceId, traceState, req }) => {
    const scope = {
      orgId: principal.orgId,
      userId: principal.serviceUserId,
    };
    const repos = deps.createRepositories(deps.db);
    const run = await repos.runs.getById(mapping.runId, scope);
    if (!run) {
      return { body: null };
    }
    const session = await repos.sessions.getById(run.agentSessionId, scope);
    if (
      !session?.sandboxSessionId ||
      session.agentSessionId !== run.agentSessionId ||
      session.conversationId !== run.conversationId ||
      !Number.isSafeInteger(session.executionFenceToken) ||
      session.executionFenceToken <= 0 ||
      typeof traceId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(traceId)
    ) {
      return { body: null };
    }

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req?.once?.('close', onClose);
    try {
      return await deps.artifactDownloadTransport.downloadArtifact(
        {
          artifactId: artifact.artifactId,
          identity: {
            orgId: principal.orgId,
            userId: principal.serviceUserId,
            conversationId: run.conversationId,
            agentSessionId: run.agentSessionId,
            runId: run.runId,
            sandboxSessionId: session.sandboxSessionId,
            traceId,
            executionFenceToken: session.executionFenceToken,
          },
          expectedSizeBytes: artifact.sizeBytes ?? null,
          expectedSha256: artifact.sha256,
        },
        {
          signal: abort.signal,
          ...(traceState ? { traceState } : {}),
        },
      );
    } finally {
      req?.off?.('close', onClose);
    }
  };
}

export async function startHttpMain(env: NodeJS.ProcessEnv = process.env) {
  try {
    validateProductionConfig(env);
  } catch (err) {
    console.error(`[agent-server] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const telemetry = await startTelemetry(env, {
    serviceName: 'dsh-enterprise-agent-http',
  });

  const container = createServiceContainer(env);
  await container.preflightMcpServers();
  const requireDataPlane =
    String(env.DEPLOYMENT_ENV || env.NODE_ENV || '').toLowerCase() ===
      'production' ||
    Boolean(String(env.AGENT_DATABASE_URL || '').trim());

  let httpServices: Awaited<
    ReturnType<typeof container.createHttpServices>
  > | null = null;

  if (requireDataPlane) {
    // 不再支持启动时自动迁移：schema 由 DBA 按发布包执行，这里只做只读核对。
    await container.start({
      role: 'agent-http',
      connectMysql: true,
      connectRedis: true,
    });
    httpServices = await container.createHttpServices();
  } else {
    console.warn(
      '[agent-server] AGENT_DATABASE_URL unset — HTTP up for /health only; create/get return 503',
    );
  }

  // 执行面 readiness 看 exec `/ready`，不是 liveness 的 `/health`（K8s 部署评审 K1）。
  // 模块加载失败时 fail-closed：探针恒报 unreachable，而不是跳过这一项。
  let sandboxReadyCheck: () => Promise<{ status?: string } | null>;
  try {
    const mod = await import('../infrastructure/sandbox/sandbox-client.js');
    sandboxReadyCheck = () => mod.checkReady();
  } catch {
    sandboxReadyCheck = async () => null;
  }

  // Skills are per-caller: the bundled tier plus that user's own directory.
  // Without an identity on the request there is no user tier to project, and
  // the process-wide roots list bundled packages only.
  const resolveOwner = httpServices
    ? async (auth: object) => {
        const repos = httpServices.createRepositories(httpServices.knex);
        return new ExternalIdentityResolver({
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        }).resolveOwner(auth as never);
      }
    : null;

  const getExtensionDiagnostics = async (
    options: {
      auth?: object | null;
      [key: string]: unknown;
    } = {},
  ) => {
    const identity = options.auth && resolveOwner
      ? await resolveOwner(options.auth)
      : null;
    // The user tier comes from the enablement ledger, verified against the
    // published store — the same set a Run would load (design §3.3 S1).
    const runSkills = identity
      ? await resolveRunSkillPaths(env, identity, {
          listEnabled: (owner) =>
            httpServices.createRepositories(httpServices.knex).skillEnablements.listForOwner(owner),
        })
      : null;
    // 用户层/org 层来自账本并核对过发布存储，与 Run 会加载的是同一份（ADR 0015 D1）。
    // 系统层现在只贡献「根」：选中的名单由 provider 过滤，不再扫整棵树。
    const skillRoots = runSkills
      ? runSkills
        .filter((entry): entry is SystemSkillRootEntry => entry.kind === 'system')
        .map((entry) => entry.root)
      : config.SKILL_ROOTS;
    // 按层分开：能力页要能分辨来源（用户自己启用的 vs 组织共享的）。
    // 用户层来自该调用者的启用账本（与 Run 加载的是同一份）；org 层来自**本 org 的
    // 已发布 active 版本**（design §7.2），不是某个 AgentVersion 的绑定——
    // 绑定清单是每 Run 算的，用它会让刚发布、还没被绑定的共享 Skill 从页面上消失。
    const userSkills = runSkills
      ? runSkills.filter((entry): entry is PublishedSkillRootEntry => entry.kind === 'user')
      : [];
    const orgSkills = identity
      ? await listActiveOrgSkillPackages({
          orgId: String(identity.orgId),
          publishedBase: publishedSkillBase(env),
          orgSkills: httpServices.createRepositories(httpServices.knex).orgSkills,
        })
      : [];
    return projectExtensionDiagnostics({
      ...options,
      skillRoots,
      userSkills,
      orgSkills,
      draftSkillRoot: identity ? draftSkillRootFor(identity) : null,
      mcpServers: config.MCP_SERVERS,
      mcpDiscovery: container.getMcpReadiness(),
      toolRiskPolicy: config.TOOL_RISK_POLICY,
    });
  };

  const mutateSkill = resolveOwner
    ? async ({ auth, action, name }) => {
        const owner = await resolveOwner(auth);
        const manager = createSkillManager({
          identity: owner,
          skillRoots: resolveSkillRootsForRun(env, owner),
          draftSkillRoot: draftSkillRootFor(owner),
          // org 层保留名（ADR 0015 D7）：**排除原作者自己**——被提升过的 Skill 的
          // 原作者要能继续启用新版本，否则他没法迭代（design §7.3）。别人占用同名会被
          // 启用闸门拒掉，而不是让两个同名 Skill 撞在一条发现路径上。
          reservedOrgNames: await reservedOrgSkillNames(owner),
        });
        return mutateSkillWithLedger({
          action,
          name,
          owner,
          manager,
          transactionManager: httpServices.transactionManager,
          ledgerFor: (trx) => httpServices.createRepositories(trx).skillEnablements,
          graceMs: resolveSkillVersionGcGraceMs(env),
        });
      }
    : null;

  /**
   * 本 org 被 org 层占用的名字，**排除调用者自己已提升的**（ADR 0015 D7 / design §7.3）。
   *
   * 作者豁免是刻意的：被提升过的 Skill 原作者要继续迭代草稿，就必须还能启用自己新版本；
   * 没有豁免他就只能换名字。别人仍被挡住。
   */
  /**
   * 外部主体 → **内部 ULID**（ADR 0015 P2/P3 的 org 层与共享申请账本）。
   *
   * 两张账本的 `org_id` 都是 `CHAR(26)` 且带 `→ organizations.org_id` 外键，`user_id`
   * 与 `users.user_id` 同域；Run 期的 org 身份也是内部 ULID。BFF 投过来的
   * `X-Acting-Organization-Id` 是**外部主体**（开发栈里是 `org_bootstrap`），直接写进
   * 账本会被外键拒绝，而**查**会静默命中零行——申请看起来提交成功、队列里却什么也没有。
   * 所以解析只在这一处做，服务内部一律拿内部 ULID。
   */
  const resolveSkillLedgerOwner = async (auth: {
    externalOrgId: string;
    externalUserId: string;
    role?: string | null;
  }): Promise<{ orgId: string; userId: string }> => {
    if (!httpServices) throw new Error('Agent data plane not started');
    const repos = httpServices.createRepositories(httpServices.knex);
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    const owner = await resolver.resolveOwner(auth as never);
    return { orgId: owner.orgId, userId: owner.userId };
  };

  const reservedOrgSkillNames = async (owner: { orgId: string; userId: string }) => {
    if (!httpServices) return [];
    const rows = await httpServices.createRepositories(httpServices.knex).orgSkills.reservedNamesForOrg({
      orgId: owner.orgId,
      excludeAuthorUserId: owner.userId,
    });
    return [...rows];
  };

  /**
   * 共享申请与审批（ADR 0015 §7.2/§7.3）。
   *
   * 两个依赖各自对应流程里的一步事实，都不是顺手能算出来的：
   * - `enabledVersionOf`：申请的是**已启用（已发布）**的摘要，不是草稿。草稿模型可写，
   *   批准一个会变的目录等于批准移动目标；
   * - `publishFromPublished`：复制字节到 org 层并在内部重算摘要，不一致即拒绝。
   *   名字占用（design §7.1，一个名字只能由同一作者续版）由 `publishVersion`
   *   在名字锁内判定，不在这里先读。
   */
  const skillShare = httpServices && resolveOwner
    ? createSkillShareHandler(new SkillShareService({
      resolveOwner: resolveSkillLedgerOwner,
      requests: httpServices.createRepositories(httpServices.knex).skillShareRequests,
      orgSkills: httpServices.createRepositories(httpServices.knex).orgSkills,
      enabledVersionOf: async ({ orgId, userId, name }) => {
        const row = await httpServices.createRepositories(httpServices.knex)
          .skillEnablements.get(name, { orgId, userId });
        return row ? { contentDigest: row.contentDigest } : null;
      },
      publishFromPublished: async (input) => publishOrgSkillFromPublishedVersion(
        {
          orgSkills: httpServices.createRepositories(httpServices.knex).orgSkills,
          publishedBase: publishedSkillBase(env),
          systemSkillNames: async () => (await systemSkillCatalog(env).names()),
          resolvePublishedPackageDir: async ({ requesterUserId, name, contentDigest }) => {
            const orgRoot = publishedSkillBase(env);
            const ownerRoot = `${orgRoot.replace(/\/+$/, '')}/${input.orgId}/${requesterUserId}`;
            const check = await readPublishedVersion(ownerRoot, name, contentDigest);
            return check.ok ? { packageDir: check.paths.packageDir } : null;
          },
        },
        {
          orgId: input.orgId,
          requesterUserId: input.requesterUserId,
          name: input.name,
          contentDigest: input.contentDigest,
          originRequestId: input.originRequestId,
          publishedByUserId: input.publishedByUserId,
          ...(input.setCurrent !== undefined ? { setCurrent: input.setCurrent } : {}),
          // 名字来源判定在 publishVersion 的锁内：批准谁的申请就带谁。
          ...(input.expectedOriginUserId !== undefined
            ? { expectedOriginUserId: input.expectedOriginUserId }
            : {}),
        },
      ).then((published) => ({ contentDigest: published.version.contentDigest })),
      manifestOfRequestedVersion: async ({ orgId, requesterUserId, name, contentDigest }) => {
        const ownerRoot = `${publishedSkillBase(env).replace(/\/+$/, '')}/${orgId}/${requesterUserId}`;
        const listing = await readPublishedVersionManifest(ownerRoot, name, contentDigest);
        if (!listing.ok) return null;
        const ok = listing as {
          files: Array<{ path: string; bytes: number }>;
          skillMd: string;
          truncated: boolean;
        };
        return { files: ok.files, skillMd: ok.skillMd, truncated: ok.truncated };
      },
      audit: (event) => {
        emitSkillAudit({
          action: event.action,
          result: event.result,
          skill_name: event.name,
          summary: event.requestId ? `request=${event.requestId}` : undefined,
          ...(event.reason ? { error: event.reason } : {}),
          meta: { orgId: event.orgId, userId: event.userId },
        });
      },
    }))
    : null;

  const uploadSkillDraft = resolveOwner
    ? async ({ auth, filename, archiveBytes }: { auth: any; filename: string; archiveBytes: Buffer }) => {
        const owner = await resolveOwner(auth);
        const manager = createSkillManager({
          identity: owner,
          skillRoots: resolveSkillRootsForRun(env, owner),
          draftSkillRoot: draftSkillRootFor(owner),
        });
        return manager.installDraftArchive({
          archiveBytes,
          archiveName: filename,
        });
      }
    : null;

  /**
   * org 层共享 Skill 的管理员操作面（ADR 0015 §7.2）。
   *
   * 依赖里有**两个物理根**，不要合并：
   * - `publishedBase` 是用户层与 org 层共用的发布存储基根（`SKILLS_USER_ROOT`），
   *   org 层取 `<base>/<orgId>/_org`；
   * - `tmpRoot` 只是解包临时区，放在系统临时目录——放进发布存储会让半成品被列表
   *   接口与 GC 当成一个真实的包。
   */
  const orgSkillAdmin = httpServices && resolveOwner
    ? createOrgSkillAdminHandler(new OrgSkillAdminService({
      resolveOwner: resolveSkillLedgerOwner,
      orgSkills: httpServices.createRepositories(httpServices.knex).orgSkills,
      // 与 Run 解析读的是同一个变量、同一个默认值：两处不一致会让「发布到 A、
      // 运行读 B」，症状是发布成功但 Run 里看不到。
      publishedBase: publishedSkillBase(env),
      systemSkillNames: async () => (await systemSkillCatalog(env).names()),
      // 吊销的影响面：谁的下一个 Run 会因为这个版本被吊销而丢挂载。读引用账本
      // 而不是扫 `config_json`——后者既慢又不可靠（那是 JSON，不是可索引的事实），
      // 而漏报会让运维以为没人受影响。
      affectedAgentVersions: (input) =>
        httpServices.createRepositories(httpServices.knex).agentVersionSkillRefs
          .listVersionsForSkill(input),
      // 每次发布 / 改指针 / 弃用 / 吊销之后跑一次回收（design §5.3 明说不加后台定时器）。
      // 回收判定只认「引用 / current / 宽限期」三条，与吊销状态无关——`revoked` 的字节
      // 保留到满足这三条才删，便于事后审计。
      collectStaleVersions: async ({ orgId }) => {
        const gc = await collectStaleOrgSkillVersions(
          { db: httpServices.knex, publishedBase: publishedSkillBase(env) },
          { orgId },
        );
        return {
          removedCount: gc.removedCount,
          racedDigests: gc.names.flatMap((entry) => entry.racedDigests),
        };
      },
    }))
    : null;

  const notReady = async () => {
    const err = new Error('Agent data plane not started');
    // @ts-ignore
    err.code = 'MYSQL_CONFIG_ERROR';
    throw err;
  };

  const listRuns = httpServices
    ? async ({ auth, conversationId, status, limit }) => {
        const { ExternalIdentityResolver } = await import(
          '../application/parent/external-identity-resolver.js'
        );
        const repos = httpServices.createRepositories(httpServices.knex);
        const resolver = new ExternalIdentityResolver({
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        });
        const owner = await resolver.resolveOwner(auth);
        const runs = await repos.runs.list(
          { orgId: owner.orgId, userId: owner.userId },
          {
            conversationId: conversationId || undefined,
            status: status || undefined,
            limit: limit || 50,
          },
        );
        const scope = { orgId: owner.orgId, userId: owner.userId };
        // Batch-load AgentSessions so each run can carry sandbox_session_id for
        // browser artifact download/export/upload rehydration.
        const sessionByAgentId = new Map();
        if (repos.sessions?.getById) {
          // repos 经 knex 出来是 any，`new Set(any)` 会塌成 Set<unknown>，
          // 所以显式给出元素类型——它由紧跟着的 `id is string` 断言保证。
          const uniqueAgentSessionIds = [
            ...new Set<string>(
              runs
                .map((run) => run.agentSessionId)
                .filter((id): id is string => typeof id === 'string' && Boolean(id)),
            ),
          ];
          await Promise.all(
            uniqueAgentSessionIds.map(async (agentSessionId) => {
              try {
                const session = await repos.sessions.getById(
                  agentSessionId,
                  scope,
                );
                if (session) sessionByAgentId.set(agentSessionId, session);
              } catch {
                /* leave missing; presentGetRunResponse emits null session_id */
              }
            }),
          );
        }
        return Promise.all(
          runs.map(async (run) => {
            const events = await repos.runEvents.listByRun(run.runId, scope, {
              limit: 500,
            });
            const session = sessionByAgentId.get(run.agentSessionId) || null;
            return {
              ...run,
              sandboxSessionId:
                session?.sandboxSessionId ?? run.sandboxSessionId ?? null,
              workspaceId: session?.workspaceId ?? run.workspaceId ?? null,
              ...summarizeRunObservability(events),
            };
          }),
        );
      }
    : null;

  const listToolExecutions = httpServices
    ? async ({ runId, auth }) => {
        const { ExternalIdentityResolver } = await import(
          '../application/parent/external-identity-resolver.js'
        );
        const repos = httpServices.createRepositories(httpServices.knex);
        const resolver = new ExternalIdentityResolver({
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        });
        const owner = await resolver.resolveOwner(auth);
        return repos.toolExecutions.listByRun(runId, {
          orgId: owner.orgId,
          userId: owner.userId,
        });
      }
    : null;

  // 平台角色账本（design rbac-roles）：admin HTTP 面才需要它，所以在这里装配而不是
  // 在容器里——`container.ts` 是行数棘轮盯着的热点，新增职责按 design §11 放新模块。
  const memberRoleService = httpServices
    ? createMemberRoleService({
        env,
        db: httpServices.knex,
        createRepositories: httpServices.createRepositories,
        transactionManager: httpServices.transactionManager,
        generateId: container.generateId,
      })
    : null;

  // 审核员面（design agent-output-review §7）：与成员角色面同一理由放这里。
  // exec 客户端凭据缺失时仍返回 service（列表/详情可用），需要字节的调用 503。
  const reviewService = httpServices
    ? createReviewService({
        env,
        db: httpServices.knex,
        createRepositories: httpServices.createRepositories,
        transactionManager: httpServices.transactionManager,
        generateId: container.generateId,
        now: container.now,
      })
    : null;

  let browserAuthService = null;
  if (httpServices) {
    const repos = httpServices.createRepositories(httpServices.knex);
    browserAuthService = new BrowserAuthService({
      credentials: repos.authCredentials,
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
      // 可撤销会话账本：生产工厂注入真实仓储（design sso-integration-reservation §5.2）。
      sessions: repos.browserAuthSessions,
      // 角色权威是 member_roles；名单引导与「部署锁定」判定都在服务里（design §3）。
      memberRoles: memberRoleService,
      generateId: container.generateId,
      secret: env.SANDBOX_JWT_SECRET,
      issuer: env.SANDBOX_JWT_ISSUER,
      audience: env.SANDBOX_JWT_AUDIENCE,
      ttlSeconds: Number(env.SANDBOX_JWT_TTL_SECONDS),
      allowPublicRegister:
        String(env.SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER || 'true').toLowerCase() !== 'false',
      // 与 worker 同一份判定：配置不全时账户页的开关禁用，打开会被 422 拒绝。
      notificationCapability: emailNotificationCapability(resolveEmailNotificationConfig(env)),
      ...createSsoLogin.options(env),
    });
    // 公司 SSO（design sso-oidc-dev）：未打开时不挂，兑换接口 503。
    browserAuthService.ssoLogin = createSsoLogin.service({
      env,
      repos,
      auth: browserAuthService,
      generateId: container.generateId,
    });
  }

  type RequestHandler = { handle: (...args: any[]) => any };
  let a2aHandler: RequestHandler | null = null;
  let a2aAdminHandler: RequestHandler | null = null;
  if (httpServices?.a2aCredentialService && httpServices?.a2aTaskService) {
    const { createA2aHttpHandler } = await import(
      '../presentation/a2a/http-handler.js'
    );
    const {
      authSubjectsFromRequest,
      readBody,
      json,
    } = await import(
      '../presentation/http/request-response.js'
    );
    const {
      resolveRequestTraceId,
      resolveRequestTraceContext,
    } = await import(
      '../presentation/http/trace-context.js'
    );
    const internalKeyring = String(
      env.SANDBOX_INTERNAL_HMAC_KEYRING || '',
    ).trim();
    const internalActiveKid = String(
      env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '',
    ).trim();
    let streamArtifactBytes = null;
    if (internalKeyring && internalActiveKid) {
      const { createInternalArtifactDownloadTransport } = await import(
        '../infrastructure/sandbox/internal-artifact-download-http.js'
      );
      const artifactDownloadTransport =
        createInternalArtifactDownloadTransport({
          baseUrl: env.SANDBOX_BASE_URL || config.SANDBOX_BASE_URL,
          keyring: internalKeyring,
          activeKid: internalActiveKid,
          allowInsecureHttp: true,
        });
      streamArtifactBytes = createA2aArtifactByteStreamer({
        createRepositories: httpServices.createRepositories,
        db: httpServices.knex,
        artifactDownloadTransport,
      });
    }
    a2aHandler = createA2aHttpHandler({
      credentialService: httpServices.a2aCredentialService,
      taskService: httpServices.a2aTaskService,
      streamService: httpServices.a2aStreamService,
      publicBaseUrl: env.A2A_PUBLIC_BASE_URL || config.A2A_PUBLIC_BASE_URL || '',
      deploymentEnv: env.DEPLOYMENT_ENV || env.NODE_ENV || config.DEPLOYMENT_ENV,
      allowDevHostFallback:
        String(env.A2A_ALLOW_DEV_HOST_FALLBACK || '').toLowerCase() === 'true' ||
        config.A2A_ALLOW_DEV_HOST_FALLBACK === true,
      artifactDownloadSecret:
        env.A2A_ARTIFACT_DOWNLOAD_SECRET ||
        config.A2A_ARTIFACT_DOWNLOAD_SECRET ||
        '',
      streamArtifactBytes,
      createRepositories: httpServices.createRepositories,
      db: httpServices.knex,
      resolveTraceId: resolveRequestTraceId,
      resolveTraceContext: resolveRequestTraceContext,
      readBody,
      json,
      // Bundled skill packages (repo skills/ or container /home/sandbox/skill).
      // config 上没有 SYSTEM_SKILL_ROOT 这个键（config.ts 导出的是
      // SKILLS_ROOT / SKILL_ROOTS / DEFAULT_SKILL_ROOTS），原来那一档回落
      // 永远是 undefined。env 侧的 SYSTEM_SKILL_ROOT 保留：它是环境变量名。
      skillRoot: env.SKILLS_ROOT || env.SYSTEM_SKILL_ROOT || config.SKILLS_ROOT || '',
      resolveAgentMeta: async (agentId) => {
        try {
          const repos = httpServices.createRepositories(httpServices.knex);
          const def = await repos.catalog.getDefinitionById(agentId);
          if (!def) return null;
          let skills: unknown[] = [];
          if (def.activeVersionId) {
            try {
              const ver = await repos.catalog.getVersionById(def.activeVersionId);
              const cfg = ver?.configJson;
              if (cfg && typeof cfg === 'object') {
                // ADR 0015 §4.3：有 `skillPolicy` 的版本按**有效绑定**出卡
                // （system 展开名单 + org 条目），没有的沿用 legacy `skills`。
                // user 层**不进**卡——它随调用者变化，不是 Agent 的对外能力。
                const policy = parseSkillPolicy(
                  (cfg as Record<string, unknown>)['skillPolicy'],
                ).policy;
                if (policy !== null) {
                  skills = await skillsFromPolicy(policy);
                } else if (Array.isArray((cfg as Record<string, unknown>)['skills'])) {
                  skills = (cfg as Record<string, unknown>)['skills'] as unknown[];
                }
              }
            } catch {
              skills = [];
            }
          }
          const description =
            (typeof def.description === 'string' && def.description.trim()) ||
            `Enterprise agent "${def.name}" (DSH Enterprise Sandbox)`;
          return {
            name: def.name,
            description,
            skills,
          };
        } catch {
          return null;
        }
      },
    });
    const { createA2aAdminHttpHandler } = await import(
      '../presentation/a2a/admin-http-handler.js'
    );
    a2aAdminHandler = createA2aAdminHttpHandler({
      credentialService: httpServices.a2aCredentialService,
      createRepositories: httpServices.createRepositories,
      db: httpServices.knex,
      generateId: container.generateId,
      publicBaseUrl:
        env.A2A_PUBLIC_BASE_URL || config.A2A_PUBLIC_BASE_URL || '',
      authSubjectsFromRequest,
      resolveTraceId: resolveRequestTraceId,
      readBody,
      json,
    });
  }

  const server = createAgentHttpServer({
    createRunService: httpServices?.createRunService ?? {
      execute: notReady,
    },
    getRunService: httpServices?.getRunService ?? { execute: notReady },
    cancelRunService: httpServices?.cancelRunService ?? {
      execute: notReady,
    },
    steerRunService: httpServices?.steerRunService ?? { execute: notReady },
    followUpService: httpServices?.followUpService ?? { execute: notReady },
    eventQueryService: httpServices?.eventQueryService ?? {
      listEvents: notReady,
    },
    traceQueryService: httpServices?.traceQueryService ?? null,
    eventSseService: httpServices?.eventSseService ?? null,
    a2aHandler,
    a2aAdminHandler,
    conversationService: httpServices?.conversationService ?? null,
    approvalQueryService: httpServices?.approvalQueryService ?? null,
    approvalDecisionService: httpServices?.approvalDecisionService ?? null,
    interactionResponseService: httpServices?.interactionResponseService ?? null,
    cronJobService: httpServices?.cronJobService ?? null,
    agentCatalogService: httpServices?.agentCatalogService ?? null,
    adminRunQueryService: httpServices?.adminRunQueryService ?? null,
    ownerIdentityService: httpServices?.ownerIdentityService ?? null,
    memberRoleService,
    reviewService,
    listRuns,
    listToolExecutions,
    browserAuthService,
    config,
    sandboxReadyCheck,
    // /ready requires a reachable data plane: MySQL `SELECT 1` + Redis `PING` (same as
    // the Worker probe). Health-only mode (container not started) → 503.
    dataPlaneReady: () => isDataPlaneReachable(container),
    mcpReadiness: () => container.getMcpReadiness(),
    getExtensionDiagnostics,
    mutateSkill,
    uploadSkillDraft,
    orgSkillAdmin,
    skillShare,
    activeRunHint: () => 0,
  });

  const port = Number(env.PORT) || config.PORT || 4100;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(undefined));
  });

  console.log(
    `[agent-server] dsh-enterprise-agent v4.0.0 (${config.DEPLOYMENT_ENV}/${config.NODE_ENV}) on port ${port}`,
  );
  console.log(
    '[agent-server] Effective config:',
    JSON.stringify(effectiveConfig()),
  );
  console.log(
    '[agent-server] Run authority: MySQL Create/Get/Cancel/Steer/Follow-up services',
  );

  try {
    const readiness = await sandboxReadyCheck();
    if (readiness?.status === 'ready') {
      console.log('[agent-server] Sandbox ready');
    } else {
      console.warn('[agent-server] Sandbox not ready — /ready stays 503 until it is');
    }
  } catch {
    console.warn('[agent-server] Sandbox readiness check failed');
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agent-server] ${signal} — shutting down`);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    try {
      await container.shutdown();
    } catch (err) {
      console.error('[agent-server] container shutdown error');
    }
    try {
      await telemetry.shutdown();
    } catch {
      console.error('[agent-server] telemetry shutdown error');
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return { server, container, port };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  startHttpMain().catch((err) => {
    console.error(
      '[agent-server] fatal:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
