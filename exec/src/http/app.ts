/**
 * Exec HTTP 应用：健康检查 + 内部 HMAC 面 + 公共会话面。
 * main.ts 只负责从环境装配依赖并 listen。
 */
import { Hono } from 'hono';
import { Context } from '@deepseek-ai/cordis';
import { createInternalRouter, type InternalRouterDeps } from './router.js';
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
  readonly modeFor?: InternalRouterDeps['modeFor'];
  readonly cordisContext?: unknown;
}

export function createExecApp(deps: ExecAppDeps): Hono {
  const skills = deps.enabledSkillPackagesFor ?? (() => []);
  const modeFor = deps.modeFor ?? (() => 'workspace-write' as const);
  const cordisContext = deps.cordisContext ?? new Context();
  const internal: InternalRouterDeps = {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: skills,
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
    bwrapExecutable: env['SANDBOX_BWRAP_PATH'] ?? '/usr/bin/bwrap',
  });

  return {
    app,
    async dispose() {
      if (pool !== undefined) await pool.end();
    },
  };
}
