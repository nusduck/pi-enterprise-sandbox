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
import { toWireError } from '@pi/contract/errors.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import type { MySqlJobRegistry } from '../../shell/job-registry.js';
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
}

export function createPublicRouter(deps: PublicRouterDeps): Hono {
  const app = new Hono();

  registerPublicFilesRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    ...(deps.maxFileBytes !== undefined ? { maxFileBytes: deps.maxFileBytes } : {}),
  });
  registerPublicArtifactRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
  });
  registerPublicDatasetRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
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
