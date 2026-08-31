/**
 * Exec HTTP 应用：健康检查 + 内部 HMAC 面 + 公共会话面。
 * main.ts 只负责从环境装配依赖并 listen。
 */
import { Hono } from 'hono';
import { Context } from '@deepseek-ai/cordis';
import { createInternalRouter, type InternalRouterDeps } from './router.js';
import { registerInternalMcpRoutes } from './internal-mcp.js';
import { ArtifactService } from '../artifact/service.js';
import { makeWorkspaceFs } from '../fs/make-workspace-fs.js';
import { createPublicRouter, type PublicRouterDeps } from './public/router.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { readWorkspaceLifecycleConfig } from '../workspace/env-config.js';
import { MySqlJobRegistry } from '../shell/job-registry.js';
import { InMemoryJobStore } from '../shell/job-store-memory.js';
import { MySqlJobStore } from '../shell/job-store-mysql.js';
import type { JobStore } from '../shell/job-types.js';
import {
  createExecDbPool,
  readExecDbConfig,
  ExecDbConfigError,
  type ExecDbConfig,
} from '../db/client.js';
import type { Pool } from 'mysql2/promise';
import { AGENT_SKILL_PATH } from '../isolation/profile.js';

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
  readonly cordisContext?: unknown;
  /** MCP 窄桥的 bearer token；空串表示该桥不可用（回 503）。 */
  readonly mcpInternalToken?: string;
}

export function createExecApp(deps: ExecAppDeps): Hono {
  const skills = deps.enabledSkillPackagesFor ?? (() => []);
  const modeFor = deps.modeFor ?? (() => 'workspace-write' as const);
  const cordisContext = deps.cordisContext ?? new Context();
  const internal: InternalRouterDeps = {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: skills,
    ...(deps.draftSkillRootFor ? { draftSkillRootFor: deps.draftSkillRootFor } : {}),
    cordisContext,
    bwrapExecutable: deps.bwrapExecutable,
    modeFor,
    jobRegistry: deps.jobRegistry,
    keyring: deps.keyring,
    ...(deps.allowCidr !== undefined ? { allowCidr: deps.allowCidr } : {}),
  };
  const pub: PublicRouterDeps = {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: skills,
    jobRegistry: deps.jobRegistry,
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
    artifactService: new ArtifactService(makeWorkspaceFs),
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
  dispose(): Promise<void>;
}

/**
 * 从环境装配生产依赖。HMAC keyring 缺失则 fail-closed。
 * MySQL 配得上就用 durable JobStore；否则仅非 production 回退内存。
 */
export function createExecAppFromEnv(env: NodeJS.ProcessEnv = process.env): ExecRuntime {
  const keyring = String(env['SANDBOX_INTERNAL_HMAC_KEYRING'] ?? '').trim();
  const activeKid = String(env['SANDBOX_INTERNAL_HMAC_ACTIVE_KID'] ?? '').trim();
  if (!keyring || !activeKid) {
    throw new Error(
      'SANDBOX_INTERNAL_HMAC_KEYRING and SANDBOX_INTERNAL_HMAC_ACTIVE_KID are required',
    );
  }

  const workspaceManager = new WorkspaceManager(readWorkspaceLifecycleConfig(env));
  let pool: Pool | undefined;
  let store: JobStore;
  try {
    const cfg = readExecDbConfigFromSandboxEnv(env);
    pool = createExecDbPool(cfg);
    store = new MySqlJobStore(pool);
  } catch (err) {
    if (!(err instanceof ExecDbConfigError)) throw err;
    const deployment = String(env['DEPLOYMENT_ENV'] ?? env['NODE_ENV'] ?? '').toLowerCase();
    if (deployment === 'production') {
      throw new Error('exec requires DATABASE_URL / EXEC_DB_* in production');
    }
    store = new InMemoryJobStore();
  }

  const jobRegistry = new MySqlJobRegistry(store);
  const app = createExecApp({
    workspaceManager,
    jobRegistry,
    keyring,
    systemSkillRoot: env['SANDBOX_SKILLS_ROOT'] ?? AGENT_SKILL_PATH,
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
  });

  return {
    app,
    async dispose() {
      if (pool !== undefined) await pool.end();
    },
  };
}
