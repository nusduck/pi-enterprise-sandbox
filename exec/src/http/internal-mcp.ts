/**
 * MCP facade 专用的**窄桥**：`/internal/mcp/v1/*` 八条路由。
 * 移植自 `sandbox/routers/mcp_internal.py` + `sandbox/mcp/runtime.py`。
 *
 * **这条桥为什么单独存在**：facade（`exec/src/mcp/`）是整个系统里唯一对外
 * 暴露的进程。它持有的 `SANDBOX_MCP_INTERNAL_TOKEN` 只够走这八条路由，
 * 够不到 `/internal/v1/*` 那套 HMAC 内部面。把 facade 的凭据泄漏出去，
 * 攻击面到此为止——这是它值得单独部署的全部理由，也是这个文件不能被并进
 * `router.ts` 的原因。
 *
 * 2026-08-29 之前 exec **一条都没实现**，而 facade 一直在调它们，所以整个
 * MCP 面是断的（gap-audit 的 P0-3）。
 *
 * ## Model Experience
 * 外部 MCP 客户端的模型看到的是 facade 翻译过的结果。本文件的错误形状
 * （`{detail: {code, message}}`）是 facade `safeBridgeError()` 那张封闭表的
 * 输入——码要稳定，文案不重要。
 *
 * ## Known Limitations and Deferred Work
 * - `context/ensure` 只建工作区，不落 MySQL 会话表：facade 自己在 Redis 里
 *   持有 context→identity 的映射，exec 侧不需要第二份权威。
 */

import type { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { makeWorkspaceFs } from '../fs/make-workspace-fs.js';
import { IsolatedShellExecutor } from '../shell/executor.js';
import { fileSearchService } from '../search/index.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import { ArtifactError } from '../artifact/service.js';
import type { ArtifactService } from '../artifact/service.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { WorkspaceContext } from '../types.js';

export interface InternalMcpDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly bwrapExecutable: string;
  readonly artifactService: ArtifactService;
  /** 空串表示未配置——那时整条桥回 503，而不是用空 token 比对。 */
  readonly internalToken: string;
  readonly maxCodeLength?: number;
  readonly maxCommandLength?: number;
  readonly maxFileSizeBytes?: number;
  readonly maxTimeoutSeconds?: number;
}

const DEFAULTS = {
  maxCodeLength: 200_000,
  maxCommandLength: 20_000,
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxTimeoutSeconds: 300,
};

/** 26 位 Crockford——与 facade 的 `newUlid()` 同一形状。 */
const FORMAL_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * 严格 bearer：恰好一个 Authorization 头、`Bearer ` 前缀、token 无空白、
 * 定长时间比对。逐条对应 Python `require_mcp_internal_auth`。
 */
function bearerOk(header: string | null, expected: string): boolean {
  if (expected === '' || header === null) return false;
  // Headers 会把重复的 Authorization 合并成 ", " 分隔；含分隔逗号即视为多个。
  if (header.includes(', ')) return false;
  if (/[^\x00-\x7f]/.test(header)) return false;
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '' || token !== token.trim() || /\s/.test(token)) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireFormalId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !FORMAL_ID_RE.test(value)) {
    throw new BridgeError('PATH_INVALID', `invalid ${field}`, 400);
  }
  return value;
}

function requireString(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || value === '' || value.length > max) {
    throw new BridgeError('PATH_INVALID', `invalid ${field}`, 400);
  }
  return value;
}

function clampTimeout(value: unknown, max: number): number {
  const n = value === undefined || value === null ? 120 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new BridgeError('PATH_INVALID', 'timeout_seconds exceeds MCP limit', 400);
  }
  return n;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.py': 'text/x-python',
  '.html': 'text/html',
};

function guessMime(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? 'text/plain';
}

export function registerInternalMcpRoutes(app: Hono, deps: InternalMcpDeps): void {
  const limits = { ...DEFAULTS, ...deps };

  app.use('/internal/mcp/v1/*', async (c, next) => {
    const expected = deps.internalToken.trim();
    if (expected === '') {
      // 未配置就整条桥不可用。用空 token 去比对会让检查恒假，那是靠巧合。
      return c.json({ detail: 'Service temporarily unavailable' }, 503);
    }
    if (!bearerOk(c.req.header('authorization') ?? null, expected)) {
      return c.json({ detail: 'Invalid or missing MCP internal authentication' }, 401);
    }
    await next();
  });

  /** 把身份解析成 WorkspaceContext，并确保工作区与持久 temp 已建好。 */
  async function contextOf(payload: Record<string, unknown>): Promise<WorkspaceContext> {
    const sandboxSessionId = requireFormalId(payload['sandbox_session_id'], 'sandbox_session_id');
    const workspaceId = requireFormalId(payload['workspace_id'], 'workspace_id');
    await deps.workspaceManager.initWorkspace(workspaceId);
    return {
      // MCP facade 是单租户外部客户端，用 session 身份当归属维度。
      orgId: sandboxSessionId,
      userId: sandboxSessionId,
      workspaceId,
      workspaceRoot: deps.workspaceManager.physicalWorkspacePath(workspaceId),
      tempRoot: deps.workspaceManager.physicalTempPath(workspaceId),
      systemSkillRoot: deps.systemSkillRoot,
      enabledSkillPackages: [],
    };
  }

  function rootsOf(ctx: WorkspaceContext): readonly string[] {
    return [ctx.workspaceRoot, ctx.tempRoot, ctx.systemSkillRoot];
  }

  const fsOf = makeWorkspaceFs;

  function shellOf(ctx: WorkspaceContext): IsolatedShellExecutor {
    return new IsolatedShellExecutor({
      workspace: ctx,
      bwrapExecutable: deps.bwrapExecutable,
      mode: 'workspace-write',
    });
  }

  /** 统一错误出口：形状是 facade 那张封闭表的输入，绝不带物理路径。 */
  function fail(c: import('hono').Context, err: unknown, roots: readonly string[]): Response {
    if (err instanceof BridgeError) {
      return c.json({ detail: { code: err.code, message: err.message } }, err.status as never);
    }
    if (err instanceof ArtifactError) {
      return c.json(
        { detail: { code: err.code, message: redactPhysicalRoots(err.message, roots) } },
        err.status as never,
      );
    }
    const raw = err instanceof Error ? err.message : String(err);
    // 已知的路径类错误映射成 400 "Invalid request"，其余 500——与 Python
    // `_translate_error` 一致，不转发原始异常文本。
    const redacted = redactPhysicalRoots(raw, roots);
    const invalid = /path|escape|denied|invalid/i.test(redacted);
    if (!invalid) {
      // 500 是"我们这边坏了"。对外只给一句通用话，但**必须**留下脱敏后的
      // 原文——否则运维只看得到 "Sandbox operation failed"，无从下手。
      process.stderr.write(`exec mcp-bridge 500: ${redacted}\n`);
    }
    return c.json({ detail: invalid ? 'Invalid request' : 'Sandbox operation failed' }, (
      invalid ? 400 : 500
    ) as never);
  }

  async function body(c: import('hono').Context): Promise<Record<string, unknown>> {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BridgeError('PATH_INVALID', 'body must be an object', 400);
    }
    return parsed as Record<string, unknown>;
  }

  app.post('/internal/mcp/v1/context/ensure', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      return c.json({ sandbox_session_id: ctx.orgId, workspace_id: ctx.workspaceId });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/python/execute', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const code = requireString(payload['code'], 'code', limits.maxCodeLength);
      const timeoutSeconds = clampTimeout(payload['timeout_seconds'], limits.maxTimeoutSeconds);
      const executionId = `exec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const result = await shellOf(ctx).runPython({
        code,
        executionId,
        timeoutMs: timeoutSeconds * 1000,
      });
      return c.json({
        status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'succeeded' : 'failed',
        exit_code: result.exitCode,
        stdout_preview: result.stdout.text,
        stderr_preview: result.stderr.text,
        duration_ms: null,
        truncated: result.stdout.truncated || result.stderr.truncated,
        execution_id: executionId,
        python_version: null,
        python_mode: 'materialized',
      });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/shell/execute', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const command = requireString(payload['command'], 'command', limits.maxCommandLength);
      const timeoutSeconds = clampTimeout(payload['timeout_seconds'], limits.maxTimeoutSeconds);
      const executor = shellOf(ctx);
      const spec = executor.resolve({ command, timeoutMs: timeoutSeconds * 1000 });
      const result = await executor.run(spec);
      const executionId = `exec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      return c.json({
        status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'succeeded' : 'failed',
        exit_code: result.exitCode,
        stdout_preview: result.stdout.text,
        stderr_preview: result.stderr.text,
        duration_ms: null,
        truncated: result.stdout.truncated || result.stderr.truncated,
        execution_id: executionId,
      });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/files/write', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const logical = requireString(payload['path'], 'path');
      const content = payload['content'];
      if (typeof content !== 'string') throw new BridgeError('PATH_INVALID', 'invalid content', 400);
      if (Buffer.byteLength(content, 'utf8') > limits.maxFileSizeBytes) {
        throw new BridgeError('TOO_LARGE', 'content exceeds MCP file size limit', 413);
      }
      const mode = payload['mode'] === 'append' ? 'append' : 'overwrite';

      const fs = fsOf(ctx);
      const target = await fs.resolve(logical);
      const { mkdir, writeFile, appendFile } = await import('node:fs/promises');
      await mkdir(path.dirname(target.targetKey), { recursive: true });
      if (mode === 'append') await appendFile(target.targetKey, content, 'utf8');
      else await writeFile(target.targetKey, content, 'utf8');

      const { stat } = await import('node:fs/promises');
      const st = await stat(target.targetKey);
      return c.json({
        path: logical,
        content: '',
        size: st.size,
        truncated: false,
        mime_type: guessMime(logical),
      });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/files/read', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const logical = requireString(payload['path'], 'path');
      const offset = payload['offset'] == null ? null : Number(payload['offset']);
      const limit = payload['limit'] == null ? null : Number(payload['limit']);

      const fs = fsOf(ctx);
      const target = await fs.resolve(logical);
      const { readFile, stat } = await import('node:fs/promises');
      const st = await stat(target.targetKey);
      let content = await readFile(target.targetKey, 'utf8');
      let truncated = false;
      if (offset !== null && limit !== null) {
        const lines = content.split('\n');
        // Python 的 offset 是 1-based 行号。
        content = lines.slice(Math.max(0, offset - 1), Math.max(0, offset - 1) + limit).join('\n');
        truncated = lines.length > offset - 1 + limit;
      }
      return c.json({
        path: logical,
        content,
        size: st.size,
        truncated,
        mime_type: guessMime(logical),
      });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/files/list', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const logical = typeof payload['path'] === 'string' ? (payload['path'] as string) : '.';
      const depth = payload['depth'] == null ? 1 : Number(payload['depth']);
      if (!Number.isInteger(depth) || depth < 0 || depth > 5) {
        throw new BridgeError('PATH_INVALID', 'depth must be in 0..5', 400);
      }
      const fs = fsOf(ctx);
      const target = await fs.resolve(logical);
      const result = await fileSearchService.ls(
        { root: ctx.workspaceRoot, start: target.targetKey, publicPrefix: null },
        { depth },
      );
      return c.json(result);
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/artifacts/submit', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      // facade 自己生成 artifact_id（ULID），我们校验形状后原样用作记录 id
      // 的来源——facade 已经把它写进 Redis 元数据并签进下载 URL 了。
      const artifactId = requireFormalId(payload['artifact_id'], 'artifact_id');
      const sourcePath = requireString(payload['source_path'], 'source_path');
      const record = await deps.artifactService.submit({
        workspace: ctx,
        sessionId: ctx.workspaceId,
        sourcePath,
        name: path.basename(sourcePath),
        owner: { orgId: ctx.orgId, userId: ctx.userId },
        externalArtifactId: artifactId,
      });
      return c.json({
        artifact_id: record.artifactId,
        size: record.sizeBytes,
        sha256: record.sha256,
      });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.get('/internal/mcp/v1/artifacts/:artifactId/content', async (c) => {
    const roots: readonly string[] = [];
    try {
      const artifactId = requireFormalId(c.req.param('artifactId'), 'artifact_id');
      const orgId = c.req.query('sandbox_session_id') ?? '';
      const record = await deps.artifactService.get(artifactId, {
        orgId,
        userId: orgId,
      });
      if (record === null) {
        throw new BridgeError('FILE_NOT_FOUND', 'artifact not found', 404);
      }
      const stream = Readable.from(deps.artifactService.openSnapshot(record));
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(record.sizeBytes),
        },
      });
    } catch (err) {
      return fail(c, err, roots);
    }
  });
}
