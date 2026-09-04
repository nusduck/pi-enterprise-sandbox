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
import { PEER_IP_HEADER } from './node-listener.js';
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
  readonly bwrapExecutable: string;
  readonly modeFor: (workspaceId: string) => 'read-only' | 'workspace-write';
  readonly jobRegistry: MySqlJobRegistry;
  readonly keyring: InternalHmacKeyringInput;
  readonly allowCidr?: readonly string[];
  /** 产物服务；不传则进程内默认装配（与公共面共用同一份控制面存储）。 */
  readonly artifactService?: ArtifactService;
}

/**
 * 请求的对端地址。**只认监听器注入的 `x-exec-peer-ip`**，不看
 * `X-Forwarded-For` / `X-Real-IP`：内部面前面没有反向代理，这两个头谁都能伪造，
 * 而它们是 CIDR 白名单的唯一输入。以前还会在两个头都取不到时兜底成
 * `127.0.0.1`——等于给任何拿不到对端地址的路径发一张通行证。
 *
 * 取不到时返回空串：白名单为空（默认）时 `isIpAllowed` 照样放行，配了白名单
 * 就一律拒——fail-closed。
 */
function getClientIp(c: import('hono').Context): string {
  return (c.req.header(PEER_IP_HEADER) ?? '').trim();
}

/**
 * 内部面的请求行日志。**默认关闭**（`EXEC_HTTP_LOG=1` 打开）：它以前是两行裸
 * `process.stdout.write`，既没有结构、也没有开关，还会把单测控制台刷满。
 * 只输出方法/路径/状态码——路径里不含 query，不会带出参数。
 */
function logRequest(method: string, path: string, status: number): void {
  if (process.env['EXEC_HTTP_LOG'] !== '1') return;
  process.stdout.write(
    `${JSON.stringify({ svc: 'exec', method, path, status })}\n`,
  );
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
      logRequest(method, path, 401);
      return c.json({ ok: false, error: wire }, 401 as never);
    }
    await next();
    logRequest(method, path, c.res.status);
  });

  registerInternalFsRoutes(app, {
    workspaceManager: deps.workspaceManager,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackagesFor: deps.enabledSkillPackagesFor,
    ...(deps.draftSkillRootFor ? { draftSkillRootFor: deps.draftSkillRootFor } : {}),
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
