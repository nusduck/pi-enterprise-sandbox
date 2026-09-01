/**
 * Exec 内部面总路由——把 HMAC + CIDR + 各内部子路由粘起来。
 *
 * 这是 W3-A 的唯一组合入口（_shared #3：入口只做组合）。
 * 所有内部请求必须：1) 过 CIDR，2) 过 HMAC（含 body_sha256），3) 信封必带 workspaceId。
 * 错误一律经 `toWireError` 脱敏后以 RpcFailure 形式返回，不泄漏物理路径。
 */

import { Hono } from 'hono';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import type { InternalHmacKeyringInput } from '@pi/contract/hmac.js';
import { isIpAllowed, readInternalAllowCidr } from '../security/cidr.js';
import { verifyInternalRequest } from '../security/hmac.js';
import { internalClaimsByRequest } from './internal-claims.js';
import { registerInternalFsRoutes } from './internal-fs.js';
import { registerInternalShellRoutes } from './internal-shell.js';
import { registerInternalJobsRoutes } from './internal-jobs.js';
import { registerInternalArtifactRoutes } from './internal-artifact.js';
import { registerInternalSessionRoutes } from './internal-session.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { MySqlJobRegistry } from '../shell/job-registry.js';
import { ArtifactService } from '../artifact/service.js';
import { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import type { WorkspaceContext } from '../types.js';

export interface InternalRouterDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  /** 该用户的 skill 草稿根（ADR 0009 D7 / 计划 H6.2）。 */
  readonly draftSkillRootFor?: (orgId: string, userId: string) => string | null;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly cordisContext: unknown;
  readonly bwrapExecutable: string;
  readonly modeFor: (workspaceId: string) => 'read-only' | 'workspace-write';
  readonly jobRegistry: MySqlJobRegistry;
  readonly keyring: InternalHmacKeyringInput;
  readonly allowCidr?: readonly string[];
  /** 产物服务；不传则进程内默认装配（与公共面共用同一份控制面存储）。 */
  readonly artifactService?: ArtifactService;
}

function getClientIp(c: import('hono').Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp.trim();
  // Hono 未直接暴露 remoteAddr，取 header 兜底；取不到时用 127.0.0.1 放行本地测试
  return '127.0.0.1';
}

export function createInternalRouter(deps: InternalRouterDeps): Hono {
  const app = new Hono();

  const allowCidr = deps.allowCidr ?? readInternalAllowCidr(process.env as NodeJS.ProcessEnv);

  // 全局前置：CIDR + HMAC（对 /internal/v1/* 生效）
  app.use('/internal/v1/*', async (c, next) => {
    const ip = getClientIp(c);
    if (!isIpAllowed(ip, allowCidr)) {
      const wire = toWireError(new ContractError('AUTH_FAILED', 'ip not allowed'), { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, 403 as never);
    }

    const method = c.req.method;
    const url = new URL(c.req.url);
    const path = url.pathname;
    // 用 clone 读取 rawBody，避免消费原始请求体导致下游 c.req.json() 读不到
    let rawBody: Uint8Array;
    try {
      const clone = c.req.raw.clone();
      rawBody = new Uint8Array(await clone.arrayBuffer());
    } catch {
      rawBody = new Uint8Array(0);
    }
    const auth = c.req.header('authorization');
    try {
      const claims = verifyInternalRequest(auth, { keyring: deps.keyring, rawBody, method, path });
      internalClaimsByRequest.set(c.req.raw, claims);
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      process.stdout.write(`exec ${method} ${path} 401\n`);
      return c.json({ ok: false, error: wire }, 401 as never);
    }
    await next();
    process.stdout.write(`exec ${method} ${path} ${c.res.status}\n`);
  });

  registerInternalFsRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    ...(deps.draftSkillRootFor ? { draftSkillRootFor: deps.draftSkillRootFor } : {}),
    cordisContext: deps.cordisContext,
  });
  registerInternalShellRoutes(app, {
    workspaceManager: deps.workspaceManager,
    jobRegistry: deps.jobRegistry,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    ...(deps.draftSkillRootFor ? { draftSkillRootFor: deps.draftSkillRootFor } : {}),
    bwrapExecutable: deps.bwrapExecutable,
    modeFor: deps.modeFor,
  });
  registerInternalJobsRoutes(app, { jobRegistry: deps.jobRegistry });
  registerInternalArtifactRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    artifactService:
      deps.artifactService ??
      new ArtifactService(
        (ws: WorkspaceContext) => new WorkspaceFileSystem(new CordisContext() as never, ws),
      ),
  });
  registerInternalSessionRoutes(app, { workspaceManager: deps.workspaceManager });

  // 兜底错误处理：任何未捕获的抛错都脱敏后 500
  app.onError((err, c) => {
    const wire = toWireError(err, { physicalRoots: [] });
    return c.json({ ok: false, error: wire }, 500 as never);
  });

  return app;
}
