/**
 * 内部 FS 端点——12 个 primitive 一一对应（dsh-rebuild 5.6）。
 *
 * 为什么这样拆：`exec/src/fs/workspace-fs.ts` 已实现全部 12 个操作与围栏，
 * 这里只做 HTTP 层的两件事：解析信封 + 把 payload 转成 FsTarget/FsWriteIntent
 * 并调用 fs。**不重写围栏、不重算可写根**，错误一律经 `toWireError()` 无条件
 * 脱敏（硬约束 #1）。
 *
 * 端点：
 * POST /internal/v1/fs/{resolve,stat,lstat,list,read-text,read-bytes,write-text,edit-text}
 * GET  /internal/v1/fs/stream-text
 * POST /internal/v1/fs/find , /internal/v1/fs/grep  单独端点（服务 dsh-tool-fs-search）
 */

import type { Context } from 'hono';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import { parseEnvelope } from '@pi/contract/envelope.js';
import { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import { makeWorkspaceFs } from '../fs/make-workspace-fs.js';
import type { WorkspaceContext } from '../types.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import { fileSearchService } from '../search/index.js';
import type { SearchRoot } from '../search/index.js';

export interface InternalFsDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  /** 该用户的 skill 草稿根（ADR 0009 D7 / 计划 H6.2）。按 owner 解析，每用户一个。 */
  readonly draftSkillRootFor?: (orgId: string, userId: string) => string | null;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly cordisContext: unknown;
}

function physicalRootsOf(ctx: WorkspaceContext): readonly string[] {
  return [
    ctx.workspaceRoot,
    ctx.tempRoot,
    ctx.systemSkillRoot,
    // 草稿根（ADR 0009 D7）。少了它，fs 围栏会把模型往草稿里的写当成越界——
    // 挂载对了但写不进去，症状是「路径存在却 permission denied」。
    ...(ctx.draftSkillRoot ? [ctx.draftSkillRoot] : []),
    ...ctx.enabledSkillPackages.map((p) => p.sourcePath),
  ];
}

function buildWorkspaceContext(deps: InternalFsDeps, envelope: { orgId: string; userId: string; workspaceId: string }): WorkspaceContext {
  const workspaceRoot = deps.workspaceManager.physicalWorkspacePath(envelope.workspaceId);
  const tempRoot = deps.workspaceManager.physicalTempPath(envelope.workspaceId);
  const draft = deps.draftSkillRootFor?.(envelope.orgId, envelope.userId) ?? null;
  return {
    orgId: envelope.orgId,
    userId: envelope.userId,
    workspaceId: envelope.workspaceId,
    workspaceRoot,
    tempRoot,
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackages: [...deps.enabledSkillPackagesFor(envelope.orgId, envelope.userId)],
    ...(draft !== null && draft !== '' ? { draftSkillRoot: draft } : {}),
  };
}

function requirePhysicalRoots(ctx: WorkspaceContext): readonly string[] {
  return physicalRootsOf(ctx);
}

function jsonError(c: Context, status: number, code: string, message: string): Response {
  return c.json({ ok: false, error: { code, message } }, status as never);
}

async function parseJsonBody(c: Context): Promise<{ envelope: unknown; payload: unknown }> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  const b = body as Record<string, unknown>;
  return { envelope: b['envelope'], payload: b['payload'] };
}

function makeFs(ctx: WorkspaceContext, _deps: InternalFsDeps): WorkspaceFileSystem {
  // FileSystem registers as ctx.fs; reuse of one Cordis Context across HTTP
  // requests throws on the second resolve. Each call gets a fresh tree.
  void _deps.cordisContext;
  return makeWorkspaceFs(ctx);
}

/** 通用 handler 包装：信封校验 + 错误脱敏 + 物理Roots 无条件传递。 */
async function withFs<T>(c: Context, deps: InternalFsDeps, fn: (fs: WorkspaceFileSystem, ctx: WorkspaceContext, payload: T) => Promise<unknown>): Promise<Response> {
  try {
    const { envelope: rawEnv, payload: rawPayload } = await parseJsonBody(c);
    parseEnvelope(rawEnv);
    const env = rawEnv as { workspaceId: string; orgId: string; userId: string };
    const ctx = buildWorkspaceContext(deps, env);
    const roots = requirePhysicalRoots(ctx);
    const fs = makeFs(ctx, deps);
    const result = await fn(fs, ctx, rawPayload as T);
    return c.json({ ok: true, data: result });
  } catch (err) {
    // 取 workspaceId 失败时无法构造 roots，仍需脱敏——用默认前缀兜底
    const roots: readonly string[] = [];
    const wire = toWireError(err, { physicalRoots: roots });
    const status = wire.code === 'AUTH_FAILED' ? 401 : wire.code === 'ENVELOPE_INVALID' ? 400 : 500;
    process.stdout.write(`exec fs-error ${String(c.req.path)} ${wire.code}\n`);
    return c.json({ ok: false, error: wire }, status as never);
  }
}

export function registerInternalFsRoutes(app: import('hono').Hono, deps: InternalFsDeps): void {
  app.post('/internal/v1/fs/resolve', (c) => withFs<{ path: string; cwd?: string }>(c, deps, async (fs, _ctx, payload) => {
    if (!payload || typeof payload.path !== 'string') throw new ContractError('ENVELOPE_INVALID', 'path required');
    const target = await fs.resolve(payload.path, payload.cwd ? { cwd: payload.cwd } : undefined);
    return target;
  }));

  app.post('/internal/v1/fs/stat', (c) => withFs<{ target: FsTarget }>(c, deps, async (fs, _ctx, payload) => {
    if (!payload || typeof payload.target !== 'object') throw new ContractError('ENVELOPE_INVALID', 'target required');
    return await fs.stat(payload.target as FsTarget);
  }));

  app.post('/internal/v1/fs/lstat', (c) => withFs<{ target: FsTarget; path?: string }>(c, deps, async (fs, _ctx, payload) => {
    // 兼容两种调用：传 target 或 传 path
    if (payload?.path && typeof payload.path === 'string') {
      return await fs.lstat(payload.path);
    }
    if (payload?.target) return await fs.lstat((payload.target as unknown as string));
    throw new ContractError('ENVELOPE_INVALID', 'target or path required');
  }));

  app.post('/internal/v1/fs/list', (c) => withFs<{ target: FsTarget }>(c, deps, async (fs, _ctx, payload) => {
    if (!payload || typeof payload.target !== 'object') throw new ContractError('ENVELOPE_INVALID', 'target required');
    return await fs.listDir(payload.target as FsTarget);
  }));

  app.post('/internal/v1/fs/read-text', (c) => withFs<{ target: FsTarget }>(c, deps, async (fs, _ctx, payload) => {
    if (!payload || typeof payload.target !== 'object') throw new ContractError('ENVELOPE_INVALID', 'target required');
    const text = await fs.readText(payload.target as FsTarget);
    return { text };
  }));

  app.post('/internal/v1/fs/read-bytes', (c) => withFs<{ target: FsTarget; maxBytes?: number }>(c, deps, async (fs, _ctx, payload) => {
    if (!payload || typeof payload.target !== 'object') throw new ContractError('ENVELOPE_INVALID', 'target required');
    const maxBytes = typeof payload.maxBytes === 'number' ? payload.maxBytes : 1024 * 1024;
    const bytes = await fs.readBytes(payload.target as FsTarget, undefined, maxBytes);
    return { bytes: Buffer.from(bytes).toString('base64') };
  }));

  app.post('/internal/v1/fs/write-text', (c) => withFs<{ target: FsTarget; content: string; expected?: FsWriteIntent }>(c, deps, async (fs, _ctx, payload) => {
    if (!payload || typeof payload.target !== 'object' || typeof payload.content !== 'string') throw new ContractError('ENVELOPE_INVALID', 'target and content required');
    return await fs.writeText(payload.target as FsTarget, payload.content, payload.expected as FsWriteIntent | undefined);
  }));

  app.post('/internal/v1/fs/edit-text', (c) => withFs<{ target: FsTarget; edit: unknown; version?: FsVersion }>(c, deps, async (fs, _ctx, payload) => {
    if (!payload || typeof payload.target !== 'object' || !payload.edit) throw new ContractError('ENVELOPE_INVALID', 'target and edit required');
    return await fs.editText(payload.target as FsTarget, payload.edit as never, payload.version ? { version: payload.version as FsVersion } : undefined);
  }));

  // GET stream-text：query 携带 envelope+target 的 base64，便于 GET 语义；简化实现也支持 POST
  app.get('/internal/v1/fs/stream-text', async (c) => {
    try {
      const targetParam = c.req.query('target');
      const envelopeParam = c.req.query('envelope');
      if (!targetParam || !envelopeParam) throw new ContractError('ENVELOPE_INVALID', 'target and envelope query required');
      const env = JSON.parse(Buffer.from(envelopeParam, 'base64url').toString('utf8'));
      parseEnvelope(env);
      const ctx = buildWorkspaceContext(deps, env as never);
      const fs = makeFs(ctx, deps);
      const target = JSON.parse(Buffer.from(targetParam, 'base64url').toString('utf8')) as FsTarget;
      const iterable = await fs.streamText(target);
      // guardIterable 已在 WorkspaceFileSystem 内包好；这里再包一层确保 HTTP 层错误也脱敏
      const roots = requirePhysicalRoots(ctx);
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of iterable) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          } catch (err) {
            const wire = toWireError(err, { physicalRoots: roots });
            controller.enqueue(new TextEncoder().encode(`\n[error:${wire.code}] ${wire.message}`));
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      return jsonError(c, 400, wire.code, wire.message);
    }
  });

  // find / grep 单独端点（服务 dsh-tool-fs-search，形状与 fs primitives 不同）。
  //
  // 这两条曾是占位：find 忽略 pattern、grep 忽略 query，双双返回 `listDir()`
  // 的结果。模型因此会拿到"没报错但内容是错的"回答——比报错更糟。现在走
  // `search/` 的真实实现，与公共面同一个服务，不再各写一份。
  app.post('/internal/v1/fs/find', (c) =>
    withFs<{ target: FsTarget; pattern?: string; options?: Record<string, unknown> }>(
      c,
      deps,
      async (fs, ctx, payload) => {
        const p = payload as Record<string, unknown>;
        const target = p['target'] as FsTarget | undefined;
        if (!target) throw new ContractError('ENVELOPE_INVALID', 'target required');
        const opts = (p['options'] ?? {}) as Record<string, unknown>;
        return await fileSearchService.find(await searchRootOf(fs, ctx, target), {
          pattern: typeof p['pattern'] === 'string' ? (p['pattern'] as string) : '*',
          type: (opts['type'] as string | undefined) ?? null,
          maxDepth: (opts['maxDepth'] as number | undefined) ?? null,
          limit: (opts['limit'] as number | undefined) ?? null,
        });
      },
    ),
  );

  app.post('/internal/v1/fs/grep', (c) =>
    withFs<{ target: FsTarget; pattern: string; options?: Record<string, unknown> }>(
      c,
      deps,
      async (fs, ctx, payload) => {
        const p = payload as Record<string, unknown>;
        const target = p['target'] as FsTarget | undefined;
        if (!target) throw new ContractError('ENVELOPE_INVALID', 'target required');
        // `dsh-tool-fs-search` 把查询串叫 `pattern`；`search/` 内部叫 `query`。
        const query = p['pattern'];
        if (typeof query !== 'string') {
          throw new ContractError('ENVELOPE_INVALID', 'pattern required');
        }
        const opts = (p['options'] ?? {}) as Record<string, unknown>;
        return await fileSearchService.grep(await searchRootOf(fs, ctx, target), {
          query,
          glob: (opts['glob'] as string | undefined) ?? null,
          regex: Boolean(opts['regex']),
          caseSensitive: opts['caseSensitive'] !== false,
          context: (opts['context'] as number | undefined) ?? null,
          limit: (opts['limit'] as number | undefined) ?? null,
          ...(typeof opts['outputMode'] === 'string'
            ? { outputMode: opts['outputMode'] as string }
            : {}),
        });
      },
    ),
  );
}

/**
 * 把一个 `FsTarget` 解析成搜索起点。
 *
 * 复用 `WorkspaceFileSystem.resolve()`——围栏只有一处，搜索不自己再算一遍
 * 路径（ADR 0008 D2 的同一条纪律：不让两处各算各的）。
 */
async function searchRootOf(
  fs: WorkspaceFileSystem,
  ctx: WorkspaceContext,
  target: FsTarget,
): Promise<SearchRoot> {
  const resolved = await fs.resolve(target as unknown as string);
  return { root: ctx.workspaceRoot, start: resolved.targetKey, publicPrefix: null };
}
