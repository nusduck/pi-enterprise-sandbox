/**
 * Exec HTTP 应用：健康检查 + 内部 HMAC 面 + 公共会话面。
 * main.ts 只负责从环境装配依赖并 listen。
 */
import { Hono } from 'hono';
import { createInternalRouter, type InternalRouterDeps } from './router.js';
import { registerInternalMcpRoutes } from './internal-mcp.js';
import { ArtifactService } from '../artifact/service.js';
import { DatasetService } from '../dataset/service.js';
import { makeWorkspaceFs } from '../fs/make-workspace-fs.js';
import { createPublicRouter, type PublicRouterDeps } from './public/router.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { readWorkspaceLifecycleConfig } from '../workspace/env-config.js';
import { MySqlJobRegistry } from '../shell/job-registry.js';
import { InMemoryJobStore } from '../shell/job-store-memory.js';
import { MySqlJobStore } from '../shell/job-store-mysql.js';
import { MySqlArtifactStore } from '../db/repositories/artifacts.js';
import { MySqlDatasetStore } from '../db/repositories/datasets.js';
import { MySqlQuotaStore, InMemoryQuotaStore } from '../workspace/quota-store.js';
import type { QuotaStore } from '../workspace/quota-store.js';
import { WorkspaceQuotaLedger } from '../workspace/quota-ledger.js';
import { InProcessWorkspaceLock } from '../workspace/lock.js';
import type { JobStore } from '../shell/job-types.js';
import {
  createExecDbPool,
  readExecDbConfig,
  ExecDbConfigError,
  type ExecDbConfig,
} from '../db/client.js';
import type { Pool } from 'mysql2/promise';
import { AGENT_SKILL_PATH } from '../isolation/profile.js';
import fs from 'node:fs';
import path from 'node:path';

const OWNER_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Resolve only this owner's published package directories; never scan the base root. */
export function enabledSkillPackagesFromRoot(
  base: string,
  orgId: string,
  userId: string,
): readonly { name: string; sourcePath: string }[] {
  if (!base || !OWNER_SEGMENT_RE.test(orgId) || !OWNER_SEGMENT_RE.test(userId)) return [];
  const ownerRoot = path.join(path.resolve(base), orgId, userId);
  try {
    return fs.readdirSync(ownerRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SKILL_NAME_RE.test(entry.name))
      .filter((entry) => {
        const skillMd = path.join(ownerRoot, entry.name, 'SKILL.md');
        try {
          return fs.lstatSync(skillMd).isFile();
        } catch {
          return false;
        }
      })
      .map((entry) => ({ name: entry.name, sourcePath: path.join(ownerRoot, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface ExecAppDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly jobRegistry: MySqlJobRegistry;
  readonly keyring: string;
  readonly systemSkillRoot: string;
  readonly bwrapExecutable: string;
  readonly allowCidr?: readonly string[];
  readonly enabledSkillPackagesFor?: InternalRouterDeps['enabledSkillPackagesFor'];
  /**
   * 该用户的 skill 草稿根（ADR 0009 D7 / 计划 H6.2）。
   *
   * 省略时草稿面整体关闭：既不挂载也不可写。缺省是**关**而不是开，
   * 因为一个可写且不进上下文的根是新增的攻击面，要由部署显式打开。
   */
  readonly draftSkillRootFor?: (orgId: string, userId: string) => string | null;
  readonly modeFor?: InternalRouterDeps['modeFor'];
  readonly artifactService?: ArtifactService;
  readonly datasetService?: DatasetService;
  /**
   * 配额预留账本的存储。不传则用内存实现（单测/本地）。产物与数据集共用
   * 同一个账本，所以这里只有一处，不是每个服务一份。
   */
  readonly quotaStore?: QuotaStore;
  /** MCP 窄桥的 bearer token；空串表示该桥不可用（回 503）。 */
  readonly mcpInternalToken?: string;
  /**
   * 公共面的服务间令牌（`SANDBOX_API_TOKEN`）。**必填**，因为"要不要做服务间
   * 鉴权"是一个必须显式做的决定：省略默认关掉的话，正是 exec 从 Python 换到
   * TS 时丢掉这道校验的原因。`null` = 本装配显式不做（单测/本地直连）。
   */
  readonly publicApiToken: string | null;
}

export function createExecApp(deps: ExecAppDeps): Hono {
  const skills = deps.enabledSkillPackagesFor ?? (() => []);
  const modeFor = deps.modeFor ?? (() => 'workspace-write' as const);
  // 产物与数据集共用**同一个**配额账本。以前它们各自在构造函数里默认装配一个
  // `InMemoryQuotaStore`，于是同一个工作区的两类写入各算各的——1024MB 的额度
  // 实际能被用掉两份；再加上内存实现重启即忘，配额只是个摆设。
  const quotaLedger = new WorkspaceQuotaLedger(
    deps.quotaStore ?? new InMemoryQuotaStore(),
    new InProcessWorkspaceLock(),
    { defaultQuotaMb: 1024 },
  );
  const artifactService =
    deps.artifactService ?? new ArtifactService(makeWorkspaceFs, undefined, { quotaLedger });
  const datasetService =
    deps.datasetService ?? new DatasetService(makeWorkspaceFs, undefined, { quotaLedger });

  const internal: InternalRouterDeps = {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: skills,
    ...(deps.draftSkillRootFor ? { draftSkillRootFor: deps.draftSkillRootFor } : {}),
    bwrapExecutable: deps.bwrapExecutable,
    modeFor,
    jobRegistry: deps.jobRegistry,
    keyring: deps.keyring,
    ...(deps.allowCidr !== undefined ? { allowCidr: deps.allowCidr } : {}),
    artifactService,
  };
  const pub: PublicRouterDeps = {
    apiToken: deps.publicApiToken,
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: skills,
    jobRegistry: deps.jobRegistry,
    artifactService,
    datasetService,
  };

  const app = new Hono();
  const health = (c: { json: (body: unknown) => Response }) => c.json({ status: 'ok' });
  app.get('/health', health);
  app.get('/ready', health);
  app.get('/health/live', health);
  app.get('/health/ready', health);
  app.route('/', createInternalRouter(internal));
  app.route('/', createPublicRouter(pub));

  // MCP 窄桥：独立 token、独立路径前缀，**不**走 HMAC/CIDR 中间件。
  // 挂在这里而不是 createInternalRouter 里，正是为了让"facade 够不到
  // /internal/v1/*"这条性质在代码结构上看得见。
  registerInternalMcpRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    bwrapExecutable: deps.bwrapExecutable,
    artifactService,
    internalToken: deps.mcpInternalToken ?? '',
  });
  return app;
}

function execDbEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const raw = env['EXEC_DATABASE_URL'] ?? env['SANDBOX_DATABASE_URL'] ?? env['DATABASE_URL'];
  if (raw === undefined || raw.trim() === '') return env;
  return {
    ...env,
    DATABASE_URL: raw.replace(/^mysql\+pymysql:/, 'mysql:'),
  };
}

export function readExecDbConfigFromSandboxEnv(env: NodeJS.ProcessEnv = process.env): ExecDbConfig {
  return readExecDbConfig(execDbEnv(env));
}

export interface ExecRuntime {
  readonly app: Hono;
  /**
   * 启动期孤儿回收。**必须在 listen 之前 await**——`MySqlJobRegistry.recoverOrphans()`
   * 的注释从第一天就写着"启动期调用（用户路由挂载之前）"，但在 2026-09-04 之前
   * 没有任何人调它：exec 每重启一次，上一轮 `running`/`stopping` 的行就永远留在
   * 那个状态。它们不只是脏数据——`countActiveForOwner` 把 `running`/`stopping`
   * 都算进每 owner 的并发上限，僵尸行攒够 20 条，这个 owner 就再也起不了新作业。
   */
  recoverOrphans(): Promise<number>;
  dispose(): Promise<void>;
}

/**
 * 从环境装配生产依赖。HMAC keyring 缺失则 fail-closed。
 * MySQL 配得上就用 durable 的 Job/Artifact/Dataset 仓储；否则仅非 production 回退内存。
 */
export function createExecAppFromEnv(env: NodeJS.ProcessEnv = process.env): ExecRuntime {
  const keyring = String(env['SANDBOX_INTERNAL_HMAC_KEYRING'] ?? '').trim();
  const activeKid = String(env['SANDBOX_INTERNAL_HMAC_ACTIVE_KID'] ?? '').trim();
  if (!keyring || !activeKid) {
    throw new Error(
      'SANDBOX_INTERNAL_HMAC_KEYRING and SANDBOX_INTERNAL_HMAC_ACTIVE_KID are required',
    );
  }
  // 公共面的服务令牌与 HMAC keyring 同等对待：缺了就起不来，而不是开着一个
  // 谁都能调的会话面。compose 与 `.env.example` 两侧一直都配了这个值。
  const publicApiToken = String(env['SANDBOX_API_TOKEN'] ?? '').trim();
  if (!publicApiToken) {
    throw new Error('SANDBOX_API_TOKEN is required (public session plane would be unauthenticated)');
  }

  const workspaceManager = new WorkspaceManager(readWorkspaceLifecycleConfig(env));
  let pool: Pool | undefined;
  let store: JobStore;
  // 产物/数据集的元数据和作业账本走**同一个池、同一次 fail-closed 判定**：
  // 三者要么一起落库，要么一起留在内存。曾经只接了 JobStore，产物与数据集
  // 静默回退内存实现，容器一重启 `GET /sessions/:id/artifacts` 就整片变空。
  let artifactService: ArtifactService | undefined;
  let datasetService: DatasetService | undefined;
  let quotaStore: QuotaStore | undefined;
  try {
    const cfg = readExecDbConfigFromSandboxEnv(env);
    pool = createExecDbPool(cfg);
    store = new MySqlJobStore(pool);
    quotaStore = new MySqlQuotaStore(pool);
    const quotaLedger = new WorkspaceQuotaLedger(quotaStore, new InProcessWorkspaceLock(), {
      defaultQuotaMb: 1024,
    });
    artifactService = new ArtifactService(makeWorkspaceFs, new MySqlArtifactStore(pool), {
      quotaLedger,
    });
    datasetService = new DatasetService(makeWorkspaceFs, new MySqlDatasetStore(pool), {
      quotaLedger,
    });
  } catch (err) {
    if (!(err instanceof ExecDbConfigError)) throw err;
    const deployment = String(env['DEPLOYMENT_ENV'] ?? env['NODE_ENV'] ?? '').toLowerCase();
    if (deployment === 'production') {
      throw new Error('exec requires DATABASE_URL / EXEC_DB_* in production');
    }
    store = new InMemoryJobStore();
  }

  const jobRegistry = new MySqlJobRegistry(store);
  const userSkillRoot = String(env['SANDBOX_USER_SKILLS_ROOT'] ?? '').trim();
  const app = createExecApp({
    workspaceManager,
    jobRegistry,
    keyring,
    systemSkillRoot: env['SANDBOX_SKILLS_ROOT'] ?? AGENT_SKILL_PATH,
    enabledSkillPackagesFor: (orgId, userId) =>
      enabledSkillPackagesFromRoot(userSkillRoot, orgId, userId),
    // skill 草稿根（ADR 0009 D7 / 计划 H6.2）。**默认关**：一个可写且不进上下文
    // 的根是新增面，要由部署显式打开（`SANDBOX_SKILL_DRAFT_ROOT`）。
    // 打开后按 owner 分目录——每用户一个，与已启用包的 `<base>/<org>/<user>` 同规矩，
    // 否则一个用户造的包会出现在另一个用户的沙箱里。
    ...(String(env['SANDBOX_SKILL_DRAFT_ROOT'] ?? '').trim() !== ''
      ? {
          draftSkillRootFor: (orgId: string, userId: string): string | null => {
            const base = String(env['SANDBOX_SKILL_DRAFT_ROOT']).trim();
            const safe = (v: string): string | null =>
              /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) ? v : null;
            const o = safe(orgId);
            const u = safe(userId);
            // 身份段不合法时**不给草稿根**，而不是拼一个可能穿越的路径。
            return o !== null && u !== null ? `${base.replace(/\/+$/, '')}/${o}/${u}` : null;
          },
        }
      : {}),
    bwrapExecutable: env['SANDBOX_BWRAP_PATH'] ?? '/usr/bin/bwrap',
    mcpInternalToken: env['SANDBOX_MCP_INTERNAL_TOKEN'] ?? '',
    publicApiToken,
    ...(artifactService !== undefined ? { artifactService } : {}),
    ...(datasetService !== undefined ? { datasetService } : {}),
    ...(quotaStore !== undefined ? { quotaStore } : {}),
  });

  return {
    app,
    recoverOrphans: () => jobRegistry.recoverOrphans(),
    async dispose() {
      if (pool !== undefined) await pool.end();
    },
  };
}
