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
import {
  assertProductionQuotaBackend,
  readChildQuotaConfig,
  readHardBackendAsserted,
  readQuotaLedgerConfig,
  readWorkspaceLifecycleConfig,
} from '../workspace/env-config.js';
import type { ChildQuotaConfig } from '../workspace/child-quota.js';
import {
  readShellResourceLimits,
  unenforcedLimitDiagnostics,
  type ShellResourceLimits,
} from '../shell/resource-limits.js';
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
  closeExecDbPool,
  createExecDbPool,
  readExecDbConfig,
  ExecDbConfigError,
  type ExecDbConfig,
} from '../db/client.js';
import type { ExecDbPool as Pool } from '../db/failover-pool.js';
import { assertExecDbConfigWithoutPassword } from '../startup-credentials.js';
import { assertSchemaMatchesManifest } from '../db/schema-verify.js';
import { AGENT_SKILL_PATH } from '../isolation/profile.js';
import { ContractError } from '@dsh/contract/errors.js';
import {
  parseSkillVersionSidecar,
  skillVersionPaths,
  type EnabledSkillRef,
} from '@dsh/contract/skill-manifest.js';
import type { EnabledSkillPackage } from '../types.js';
import { preflightCheck } from '../isolation/bubblewrap.js';
import { buildPreflightProfile } from '../isolation/preflight.js';
import { readControlPlaneRoots } from '../artifact/control-plane-storage.js';
import { assertValidAllowCidrList, readInternalAllowCidr } from '../security/cidr.js';
import {
  evaluateExecReadiness,
  type ExecReadiness,
  type IsolationState,
  type StorageRoot,
} from './readiness.js';
import { DataSourceService } from '../datasource/service.js';
import { plaintextExecEnvSecrets, readDataSourceCatalog } from '../datasource/catalog.js';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OWNER_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function packageUnavailable(name: string): ContractError {
  return new ContractError('SKILL_PACKAGE_UNAVAILABLE', `skill package unavailable: ${name}`);
}

/** 缺失类错误归到「这个包不可用」；其余（权限、I/O、挂载掉线）归到「存储不可用」。 */
function classifySkillStoreError(err: unknown, name: string): ContractError {
  if (err instanceof ContractError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return packageUnavailable(name);
  return new ContractError('SKILL_STORE_UNAVAILABLE', 'user skill store is unavailable');
}

/**
 * 按请求携带的启用清单解析这个 owner 要挂载的包（design §3.3 S1）。
 *
 * 只核对清单点名的版本目录与侧车，**从不扫目录**；清单为空时不触碰存储。
 * 以前这里扫 owner 目录并在任何异常时返回 `[]`：挂载掉线被当成「用户没有 Skill」，
 * 目录里有什么就挂什么，与 Agent 账本无关。现在：
 * - 版本目录不是普通目录（含符号链接）、缺 SKILL.md、侧车缺失或与清单不符
 *   → `SKILL_PACKAGE_UNAVAILABLE`；
 * - 存储未配置、无权限或 I/O 失败 → `SKILL_STORE_UNAVAILABLE`。
 */
export function enabledSkillPackagesFromManifest(
  base: string,
  orgId: string,
  userId: string,
  manifest: readonly EnabledSkillRef[] = [],
): readonly EnabledSkillPackage[] {
  if (manifest.length === 0) return [];
  if (!base) throw new ContractError('SKILL_STORE_UNAVAILABLE', 'user skill store is not configured');
  if (!OWNER_SEGMENT_RE.test(orgId) || !OWNER_SEGMENT_RE.test(userId)) {
    throw new ContractError('ENVELOPE_INVALID', 'owner identity is invalid');
  }
  const ownerRoot = path.join(path.resolve(base), orgId, userId);
  const packages = manifest.map((ref) => {
    const paths = skillVersionPaths(ownerRoot, ref.name, ref.contentDigest);
    let sidecarText: string;
    try {
      const pkg = fs.lstatSync(paths.packageDir);
      const skillMd = fs.lstatSync(path.join(paths.packageDir, 'SKILL.md'));
      if (!pkg.isDirectory() || !skillMd.isFile()) throw packageUnavailable(ref.name);
      sidecarText = fs.readFileSync(paths.sidecar, 'utf8');
    } catch (err) {
      throw classifySkillStoreError(err, ref.name);
    }
    const sidecar = parseSkillVersionSidecar(sidecarText);
    if (sidecar === null || sidecar.name !== ref.name || sidecar.contentDigest !== ref.contentDigest) {
      throw packageUnavailable(ref.name);
    }
    return { name: ref.name, sourcePath: paths.packageDir };
  });
  return packages.sort((a, b) => a.name.localeCompare(b.name));
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
  /**
   * `/ready` 与 `/health/ready` 的判定。省略时这两条路由返回 503——没接预检的装配
   * 不能自称可接流量（fail-closed）。`/health`、`/health/live` 不受影响。
   */
  readonly readiness?: (() => Promise<ExecReadiness>) | undefined;
  /**
   * 执行面限额（前台预算、输出上限、命名空间内部 rlimit）。**生产装配必须传**：
   * 不传时 shell 路由退回 `DEFAULT_SHELL_RESOURCE_LIMITS`，那只适合单测。
   */
  readonly resourceLimits?: ShellResourceLimits;
  /** 子进程磁盘配额监控配置。不传即不做准入与采样。 */
  readonly childQuota?: ChildQuotaConfig;
  /** 数据源（design `sandbox-data-sources.md`）。不传即未配置：带清单的执行一律拒绝。 */
  readonly dataSources?: DataSourceService;
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
    ...(deps.resourceLimits !== undefined ? { resourceLimits: deps.resourceLimits } : {}),
    ...(deps.childQuota !== undefined ? { childQuota: deps.childQuota } : {}),
    ...(deps.quotaStore !== undefined ? { quotaStore: deps.quotaStore } : {}),
    ...(deps.dataSources !== undefined ? { dataSources: deps.dataSources } : {}),
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
  // liveness：进程活着就 200，不查依赖。
  const health = (c: { json: (body: unknown) => Response }) => c.json({ status: 'ok' });
  app.get('/health', health);
  app.get('/health/live', health);
  // readiness：见 readiness.ts。
  const ready = async (c: { json: (body: unknown, status: 200 | 503) => Response }) => {
    if (deps.readiness === undefined) {
      return c.json({ status: 'not_ready', reason: 'readiness_not_configured' }, 503);
    }
    let result: ExecReadiness;
    try {
      result = await deps.readiness();
    } catch {
      result = { ready: false, body: { status: 'not_ready' } };
    }
    return c.json(result.body, result.ready ? 200 : 503);
  };
  app.get('/ready', ready);
  app.get('/health/ready', ready);
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
    // 与内部 Shell 路由同一份限额/配额：外部 MCP 命令不能绕过（复核 F1）。
    ...(deps.resourceLimits !== undefined ? { resourceLimits: deps.resourceLimits } : {}),
    ...(deps.childQuota !== undefined ? { childQuota: deps.childQuota } : {}),
    ...(deps.quotaStore !== undefined ? { quotaStore: deps.quotaStore } : {}),
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
  /**
   * 启动期 schema 只读核对（ADR 0011 D6）。**必须在 `recoverOrphans()` 之前 await**：
   * 回收会写 `exec_jobs`，结构不对时不能先动账本。未配数据库（非生产内存模式）时为空操作。
   */
  verifySchema(): Promise<void>;
  /**
   * 启动期存储与隔离预检（design §9.2）。**在 `verifySchema()` 之后、`recoverOrphans()`
   * 之前 await**：建出（或确认）四个数据根，再用探针 profile 真跑一次 bwrap。任何一步
   * 失败都抛出、`/ready` 保持 503；从未调用时 `/ready` 也是 503（`isolation: unchecked`）。
   */
  preflight(): Promise<void>;
  /** 收到关停信号时调用：`/ready` 立即变 503，不再探测依赖。 */
  markShuttingDown(): void;
  /** 生效的内部面来源白名单（`EXEC_INTERNAL_ALLOW_CIDR`）。空 = 拒绝全部内部面请求。 */
  readonly internalAllowCidr: readonly string[];
  dispose(): Promise<void>;
}

/**
 * 从环境装配生产依赖。HMAC keyring 缺失则 fail-closed。
 * MySQL 配得上就用 durable 的 Job/Artifact/Dataset 仓储；否则仅非 production 回退内存。
 */
export function createExecAppFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    /** DBPM 下发的 UPDRDB 口令（`resolveExecDbPassword()`）。配了数据库就必须给。 */
    readonly dbPassword?: string | undefined;
    /** DBPM 下发的数据源口令（`fetchDataSourcePasswords()`），id → 口令。 */
    readonly dataSourcePasswords?: ReadonlyMap<string, string>;
  } = {},
): ExecRuntime {
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

  // 内部面来源白名单从传入的 env 读（此前由 router 读 process.env，忽略了这里的 env）。
  // 非法条目拒绝启动；空列表不拒启，但内部面拒绝全部请求（main.ts 会告警）。
  const internalAllowCidr = readInternalAllowCidr(env);
  assertValidAllowCidrList(internalAllowCidr);

  // 资源限额与配额：在建任何依赖之前读，配错就不要启动。
  // `readShellResourceLimits` 对范围外的值抛错，不静默换成默认值——
  // 「配置写错了但服务照常启动」是 R1 那一类问题最难发现的形态。
  const resourceLimits = readShellResourceLimits(env);
  const childQuota = readChildQuotaConfig(env);
  const ledgerConfig = readQuotaLedgerConfig(env);
  const deployment = String(env['DEPLOYMENT_ENV'] ?? env['NODE_ENV'] ?? '').toLowerCase();
  if (deployment === 'production') {
    // 正数配额 = 对外的多租户磁盘隔离声明。声明了就必须同时开监控并由运维
    // 确认外部硬配额；两者缺一不可，缺了就 fail-closed 拒启，不降级放行。
    assertProductionQuotaBackend(childQuota, readHardBackendAsserted(env));
  }
  for (const note of unenforcedLimitDiagnostics(resourceLimits)) {
    process.stderr.write(`exec NOTICE: ${note}\n`);
  }
  // 数据库口令只来自 DBPM（design `sandbox-data-sources.md` §3.1）：生产环境里
  // `SANDBOX_EXEC_ENV_*` 不能再夹带看起来像口令的键；开发环境只告警。
  const plaintextSecrets = plaintextExecEnvSecrets(env);
  if (plaintextSecrets.length > 0) {
    const message = `SANDBOX_EXEC_ENV_* must not carry database passwords (${plaintextSecrets.join(', ')}); use SANDBOX_DATA_SOURCES_JSON + DBPM`;
    if (deployment === 'production') throw new Error(message);
    process.stderr.write(`exec WARNING: ${message}\n`);
  }

  const lifecycle = readWorkspaceLifecycleConfig(env);
  const workspaceManager = new WorkspaceManager(lifecycle);
  const controlRoots = readControlPlaneRoots(env);
  const dataSources = new DataSourceService({
    catalog: readDataSourceCatalog(env),
    passwords: opts.dataSourcePasswords ?? new Map(),
    socketRoot: path.join(controlRoots.controlRoot, 'dbs'),
  });
  const storageRoots: readonly StorageRoot[] = [
    { name: 'workspaces', path: lifecycle.workspacesBaseRoot },
    { name: 'tmp', path: lifecycle.tempBaseRoot },
    { name: 'artifacts', path: controlRoots.artifactsRoot },
    { name: 'control', path: controlRoots.controlRoot },
  ];
  let isolation: IsolationState = 'unchecked';
  let shuttingDown = false;
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
    // 口令只来自 DBPM：配置里夹口令或没取到口令都直接失败，不回退内存仓储。
    assertExecDbConfigWithoutPassword(cfg);
    if (opts.dbPassword === undefined) {
      throw new Error('exec database password must be fetched from DBPM before assembly');
    }
    pool = createExecDbPool({ ...cfg, password: opts.dbPassword });
    store = new MySqlJobStore(pool);
    quotaStore = new MySqlQuotaStore(pool);
    // 额度来自 `SANDBOX_WORKSPACE_QUOTA_MB`（Compose 默认 500），不是一个
    // 与配置无关的 1024——写死的那个值让控制面账本与运维声明长期对不上（R1）。
    const quotaLedger = new WorkspaceQuotaLedger(quotaStore, new InProcessWorkspaceLock(), {
      defaultQuotaMb: ledgerConfig.defaultQuotaMb,
    });
    artifactService = new ArtifactService(makeWorkspaceFs, new MySqlArtifactStore(pool), {
      quotaLedger,
    });
    datasetService = new DatasetService(makeWorkspaceFs, new MySqlDatasetStore(pool), {
      quotaLedger,
    });
  } catch (err) {
    if (!(err instanceof ExecDbConfigError)) throw err;
    if (deployment === 'production') {
      throw new Error('exec requires DATABASE_URL / EXEC_DB_* in production');
    }
    store = new InMemoryJobStore();
  }

  const jobRegistry = new MySqlJobRegistry(store);
  const userSkillRoot = String(env['SANDBOX_USER_SKILLS_ROOT'] ?? '').trim();
  const systemSkillRoot = env['SANDBOX_SKILLS_ROOT'] ?? AGENT_SKILL_PATH;
  const bwrapExecutable = env['SANDBOX_BWRAP_PATH'] ?? '/usr/bin/bwrap';
  const dbPool = pool;
  const app = createExecApp({
    readiness: () =>
      evaluateExecReadiness({
        pingDatabase: dbPool === undefined ? undefined : () => dbPool.query('SELECT 1'),
        storageRoots,
        isolation: () => isolation,
        shuttingDown: () => shuttingDown,
      }),
    workspaceManager,
    jobRegistry,
    keyring,
    systemSkillRoot,
    enabledSkillPackagesFor: (orgId, userId, manifest) =>
      enabledSkillPackagesFromManifest(userSkillRoot, orgId, userId, manifest),
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
    bwrapExecutable,
    allowCidr: internalAllowCidr,
    mcpInternalToken: env['SANDBOX_MCP_INTERNAL_TOKEN'] ?? '',
    publicApiToken,
    resourceLimits,
    childQuota,
    ...(artifactService !== undefined ? { artifactService } : {}),
    ...(datasetService !== undefined ? { datasetService } : {}),
    ...(quotaStore !== undefined ? { quotaStore } : {}),
    ...(dataSources.configured ? { dataSources } : {}),
  });

  return {
    app,
    recoverOrphans: () => jobRegistry.recoverOrphans(),
    async verifySchema() {
      if (pool === undefined) return;
      await assertSchemaMatchesManifest(pool, { role: 'exec' });
    },
    async preflight() {
      // 已存在的根不改权限；新建的按 0700。只读挂载或无权限在这里就失败，不等到第一个请求。
      for (const root of storageRoots) {
        await mkdir(root.path, { recursive: true, mode: 0o700 });
      }
      // 上一轮进程被杀时没机会关的数据源 socket 目录，在接流量之前清掉。
      await dataSources.removeStaleSockets();
      isolation = 'unchecked';
      try {
        preflightCheck(bwrapExecutable, buildPreflightProfile({ systemSkillRoot }));
        isolation = 'ok';
      } catch (err) {
        isolation = 'unavailable';
        throw err;
      }
    },
    markShuttingDown() {
      shuttingDown = true;
    },
    internalAllowCidr,
    async dispose() {
      // 尽力而为：关池时 mysql2 会把未建成连接的错误再抛一次，不能让它盖过真正的启动失败。
      if (pool !== undefined) await closeExecDbPool(pool);
    },
  };
}
