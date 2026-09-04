/**
 * 公共面总路由——把 files/artifacts/datasets/processes 四组路由粘起来。
 *
 * 这是 W3-C 的唯一组合入口（_shared #3）：入口只做组合，不重写协议解析、
 * 归属校验、脱敏（各子路由已各自落实无条件脱敏）。公共面走会话作用域，
 * 不走 HMAC（HMAC 仅内部面，见 dsh-rebuild 5.7），因此这里不挂 HMAC/CIDR 中间件。
 *
 * 对 BFF 逐字节不变的含义：挂载后的路径、status、header、body 形状与
 * Python `sandbox/routers/{files,artifact/api/public,datasets,session_processes}`
 * 完全一致，api-server 的 `sandbox-client` 与 `routes/{files,artifacts,datasets,processes}.js`
 * 无需改动即可切到 exec。
 */

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { toWireError } from '@pi/contract/errors.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import type { MySqlJobRegistry } from '../../shell/job-registry.js';
import { ArtifactService } from '../../artifact/service.js';
import { DatasetService } from '../../dataset/service.js';
import type { ArtifactStore } from '../../db/repositories/artifacts.js';
import { makeWorkspaceFs } from '../../fs/make-workspace-fs.js';
import type { DatasetStore } from '../../db/repositories/datasets.js';

import { registerPublicFilesRoutes } from './files.js';
import { registerPublicArtifactRoutes } from './artifacts.js';
import { registerPublicDatasetRoutes } from './datasets.js';
import { registerPublicProcessRoutes } from './processes.js';



export interface PublicRouterDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly jobRegistry: MySqlJobRegistry;
  readonly datasetMaxBytes?: number;
  readonly maxFileBytes?: number;
  /** 产物服务。不传则按进程内默认装配（测试与本地开发用）。 */
  readonly artifactService?: ArtifactService;
  readonly artifactStore?: ArtifactStore;
  readonly datasetService?: DatasetService;
  readonly datasetStore?: DatasetStore;
  /**
   * 服务间令牌（`SANDBOX_API_TOKEN`）。BFF 每次代理都带 `X-API-Key`——
   * compose 与 `.env.example` 一直要求两侧配同一个值，但 exec 这边从来没有
   * 校验过：调用方以为有门，服务方根本没开。非空即启用校验；`null` 是
   * **显式**声明"这个装配不做服务间鉴权"（单测与本地直连用），
   * `createExecAppFromEnv` 永远给非空值。
   */
  readonly apiToken: string | null;
}

/** 常量时间比较（AGENTS.md §2：令牌比较必须常量时间）。 */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPublicRouter(deps: PublicRouterDeps): Hono {
  const app = new Hono();

  // 服务间鉴权。放在归属校验之前：没有服务令牌的请求连"这个会话存不存在"
  // 都不该问出来。会话归属仍由各路由的 `requireOwnedSession` 再判一次——
  // 这枚令牌只证明"你是 BFF"，不证明"这个会话是你的"。
  const apiToken = deps.apiToken;
  if (typeof apiToken === 'string' && apiToken !== '') {
    for (const prefix of ['/sessions/*', '/conversations/*', '/datasets', '/datasets/*']) {
      app.use(prefix, async (c, next) => {
        if (!tokenMatches(c.req.header('x-api-key'), apiToken)) {
          const wire = toWireError(new Error('service token required'), { physicalRoots: [] });
          return c.json({ ok: false, error: { ...wire, message: 'service token required' } }, 401);
        }
        await next();
      });
    }
  }

  registerPublicFilesRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    ...(deps.maxFileBytes !== undefined ? { maxFileBytes: deps.maxFileBytes } : {}),
  });
  const artifactService =
    deps.artifactService ??
    (deps.artifactStore !== undefined
      ? new ArtifactService(makeWorkspaceFs, deps.artifactStore)
      : new ArtifactService(makeWorkspaceFs));
  registerPublicArtifactRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    artifactService,
  });
  const datasetService =
    deps.datasetService ??
    (deps.datasetStore !== undefined
      ? new DatasetService(makeWorkspaceFs, deps.datasetStore)
      : new DatasetService(makeWorkspaceFs));
  registerPublicDatasetRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    datasetService,
    ...(deps.datasetMaxBytes !== undefined ? { datasetMaxBytes: deps.datasetMaxBytes } : {}),
  });
  registerPublicProcessRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    jobRegistry: deps.jobRegistry,
  });

  // 兜底：任何未捕获的抛错都经 contract 脱敏后 500，且不泄漏物理路径
  app.onError((err, c) => {
    const wire = toWireError(err, { physicalRoots: [] });
    return c.json({ error: wire.message, code: wire.code }, 500 as never);
  });

  return app;
}
