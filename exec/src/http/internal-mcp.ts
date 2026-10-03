/**
 * MCP facade 专用的**窄桥**：`/internal/mcp/v1/*` 十一条路由。
 * 移植自已退役的 Python 执行面（旧 `sandbox/routers/mcp_internal.py` + `sandbox/mcp/runtime.py`，现为本模块）。
 *
 * **这条桥为什么单独存在**：facade（`exec/src/mcp/`）是整个系统里唯一对外
 * 暴露的进程。它持有的 `SANDBOX_MCP_INTERNAL_TOKEN` 只够走这十一条路由，
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
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, open, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import { FsError } from '@deepseek-ai/dsh-fs';
import { makeWorkspaceFs } from '../fs/make-workspace-fs.js';
import type { ShellRunResult } from '@deepseek-ai/dsh-shell';
import { deniedRunResult, type IsolatedShellExecutor } from '../shell/executor.js';
import {
  effectiveResourceLimits,
  makeLimitedExecutor,
  quotaGateFor,
  runGuardedForeground,
  type GuardedExecutionDeps,
} from '../shell/guarded-execution.js';
import { fileSearchService, isBinaryBytes, SearchQueryError } from '../search/index.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import { ArtifactError } from '../artifact/service.js';
import type { ArtifactService } from '../artifact/service.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { WorkspaceContext } from '../types.js';

/**
 * 执行相关的限额/配额（`GuardedExecutionDeps`）与内部 Shell 路由**同一份**
 * 装配值：外部 MCP 命令走这条桥，不能比 Agent 的工具调用更宽松（复核 F1）。
 */
export interface InternalMcpDeps extends GuardedExecutionDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly artifactService: ArtifactService;
  /** 空串表示未配置——那时整条桥回 503，而不是用空 token 比对。 */
  readonly internalToken: string;
  readonly maxCodeLength?: number;
  readonly maxCommandLength?: number;
  readonly maxFileSizeBytes?: number;
  /** 单次读取返回正文的字节上限（只计完整行）。与 facade 的同名配置同值。 */
  readonly maxReadBytes?: number;
  readonly maxTimeoutSeconds?: number;
  /** 记录 MCP 工作区活动，供闲置回收使用（`workspace/mcp-workspace-gc.ts`）。 */
  readonly workspaceActivity?: { touch(workspaceId: string): Promise<void> };
}

/** facade（`SANDBOX_MCP_MAX_READ_BYTES` 默认）与桥侧必须一致，见 settings.ts。 */
export const DEFAULT_MCP_MAX_READ_BYTES = 256 * 1024;

const DEFAULTS = {
  maxCodeLength: 200_000,
  maxCommandLength: 20_000,
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxReadBytes: DEFAULT_MCP_MAX_READ_BYTES,
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
  // NUL 字节走执行/写入会一路变成 500（spawn、bwrap、fs 都在不同层炸）。
  // 在这里拦成 400 INVALID_INPUT，facade 有对应的精确文案。
  if (value.includes('\0')) {
    throw new BridgeError('INVALID_INPUT', `${field} contains NUL bytes`, 400);
  }
  return value;
}

function clampTimeout(value: unknown, max: number): number {
  // 缺省 120 秒，但不超过服务端上限——上限被配得更小时，缺省值不能自己越界。
  const n = value === undefined || value === null ? Math.min(120, max) : Number(value);
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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 文本类路由缺省 text/plain；上传是任意字节，缺省 application/octet-stream。 */
function guessMime(p: string, fallback = 'text/plain'): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? fallback;
}

/**
 * 探针内容是否是合法 UTF-8。探针读满时末尾可能切在一个多字节字符中间，
 * 最多去掉 3 个尾字节再判一次，不把这种切口误判成二进制。
 */
function isValidUtf8Probe(sample: Buffer, probeFull: boolean): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const tries = probeFull ? 4 : 1;
  for (let cut = 0; cut < tries && cut < sample.length; cut += 1) {
    try {
      decoder.decode(sample.subarray(0, sample.length - cut));
      return true;
    } catch {
      // 换一个切口再试
    }
  }
  return sample.length === 0;
}

/** 二进制探针宽度，与搜索面的 GREP_BINARY_PROBE 同量级。 */
const BINARY_PROBE_BYTES = 8192;

/** 头部采样判二进制：含 NUL 或控制字节超 30% 即二进制（复用搜索面的判定）。 */
async function assertTextFile(targetKey: string): Promise<void> {
  let handle;
  try {
    handle = await open(targetKey, 'r');
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_PROBE_BYTES, 0);
    const sample = buf.subarray(0, bytesRead);
    if (isBinaryBytes(sample) || !isValidUtf8Probe(sample, bytesRead === BINARY_PROBE_BYTES)) {
      throw new BridgeError(
        'BINARY_FILE',
        'file is binary; deliver it with sandbox_artifact_submit or process it with Python',
        400,
      );
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface BoundedRead {
  readonly content: string;
  readonly truncated: boolean;
  /** 1-based：继续翻页时的 offset。读完则为 null。 */
  readonly nextOffset: number | null;
  readonly totalLines: number;
}

/**
 * 有界行读取：流式扫描，只保留窗口内的完整行。
 *
 * - 输出字节决不超过 `maxBytes`；超了就停，`truncated: true`。
 * - 单行自身超过上限时整行丢弃（只计数），否则内存会被一行超长文本撑爆。
 * - `totalLines` 必须全文件扫描才知道——逐行计数，内存仍有界（只攒窗口内的行）。
 * - `offset` 是 1-based 行号（与旧 Python 版一致），`limit: null` = 到文件尾。
 * - 文件尾换行会被保留（整文件读回时与原文逐字节一致）：调用方按 `st.size`
 *   预读最后 1 字节，把 1 字节尾换行预算预留出来。
 */
async function readTextBounded(
  targetKey: string,
  opts: { offset: number; limit: number | null; maxBytes: number; endsWithNewline: boolean },
): Promise<BoundedRead> {
  const { offset, limit, maxBytes, endsWithNewline } = opts;
  const lineBudget = endsWithNewline ? maxBytes - 1 : maxBytes;
  const taken: string[] = [];
  let takenBytes = 0;
  let lineNo = 0;
  let overBudget = false;
  let beyondWindow = false;
  // 当前行已确定装不下（自身超预算），直接丢弃、换行时只计数。
  let dropping = false;

  /** 即将完成的行号（1-based）是否在请求窗口内。 */
  const upcomingInWindow = (): boolean =>
    lineNo + 1 >= offset && (limit === null || lineNo + 1 < offset + limit);

  const pushLine = (line: string): void => {
    lineNo += 1;
    if (lineNo < offset) return;
    if (limit !== null && lineNo >= offset + limit) {
      beyondWindow = true;
      return;
    }
    if (overBudget) return;
    const cost = Buffer.byteLength(line, 'utf8') + (taken.length === 0 ? 0 : 1);
    if (takenBytes + cost > lineBudget) {
      overBudget = true;
      return;
    }
    taken.push(line);
    takenBytes += cost;
  };

  const stream = createReadStream(targetKey);
  const decoder = new StringDecoder('utf8');
  let buf = '';
  await new Promise<void>((resolve, reject) => {
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
    stream.on('data', (chunk: Buffer) => {
      if (dropping) {
        // 丢弃中的超长行：找到换行就计数一行，剩下的回到正常流程。
        const text = decoder.write(chunk);
        const idx = text.indexOf('\n');
        if (idx < 0) return;
        lineNo += 1;
        dropping = false;
        buf = text.slice(idx + 1);
      } else {
        buf += decoder.write(chunk);
      }
      let idx: number;
      while (!dropping && (idx = buf.indexOf('\n')) >= 0) {
        pushLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
      // buf 里是没有换行的"当前行前半"：单个行超预算就整体丢弃，保证内存有界。
      if (!dropping && Buffer.byteLength(buf, 'utf8') > lineBudget) {
        if (upcomingInWindow()) overBudget = true;
        dropping = true;
        buf = '';
      }
    });
    stream.on('end', () => {
      buf += decoder.end();
      if (dropping) {
        lineNo += 1;
      } else if (buf !== '') {
        pushLine(buf);
      }
      resolve();
    });
  });
  const truncated = overBudget || beyondWindow;
  // 读到文件尾且窗口覆盖最后一行时，补回原文的尾换行（整文件读回逐字节一致）。
  const reachedEnd =
    !overBudget &&
    endsWithNewline &&
    lineNo >= offset &&
    (limit === null || lineNo < offset + limit);
  const content = taken.join('\n') + (reachedEnd ? '\n' : '');
  return {
    content,
    truncated,
    nextOffset: truncated ? offset + taken.length : null,
    totalLines: lineNo,
  };
}

/** 最后一字节是不是换行（O(1) 预读，供读取的尾换行保留逻辑用）。 */
async function endsWithNewline(targetKey: string, size: number): Promise<boolean> {
  if (size <= 0) return false;
  let handle;
  try {
    handle = await open(targetKey, 'r');
    const buf = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buf, 0, 1, size - 1);
    return bytesRead === 1 && buf[0] === 0x0a;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** 严格 base64：Buffer.from 本身不抛，非法字符必须自己拦。 */
function decodeBase64Strict(value: string): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new BridgeError('INVALID_BASE64', 'invalid content_base64', 400);
  }
  return Buffer.from(compact, 'base64');
}

export function registerInternalMcpRoutes(app: Hono, deps: InternalMcpDeps): void {
  const limits = { ...DEFAULTS, ...deps };
  // 桥自己的秒级上限与执行面前台预算取小：`SANDBOX_EXECUTION_TIMEOUT_SECONDS`
  // 调小之后，超出的请求在这里 400，而不是被执行器悄悄夹短。
  const maxTimeoutSeconds = Math.max(
    1,
    Math.min(limits.maxTimeoutSeconds, Math.floor(effectiveResourceLimits(deps).executionTimeoutMs / 1000)),
  );

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
    await deps.workspaceActivity?.touch(workspaceId);
    return {
      // MCP facade 是单租户外部客户端，用 session 身份当归属维度。
      orgId: sandboxSessionId,
      userId: sandboxSessionId,
      workspaceId,
      workspaceRoot: deps.workspaceManager.physicalWorkspacePath(workspaceId),
      tempRoot: deps.workspaceManager.physicalTempPath(workspaceId),
      systemSkillRoot: deps.systemSkillRoot,
      enabledSkillPackages: [],
      // 产品 2026-10-03 决定：外部 MCP 不读取平台系统 Skill（外部平台有自己的
      // Skill 体系，且避免内部内容外泄）。空数组 = 一个不挂（undefined 才是整树）。
      systemSkillPackages: [],
    };
  }

  function rootsOf(ctx: WorkspaceContext): readonly string[] {
    return [ctx.workspaceRoot, ctx.tempRoot, ctx.systemSkillRoot];
  }

  const fsOf = makeWorkspaceFs;

  function shellOf(ctx: WorkspaceContext): IsolatedShellExecutor {
    return makeLimitedExecutor(deps, ctx, 'workspace-write');
  }

  /**
   * 前台执行 + 配额准入/采样 + 请求断开取消，与内部 Shell 路由同一份编排。
   * 被配额拒绝时回一个 `sandbox.denied` 的结果（exit 126，原因进 stderr），
   * 响应形状不变，facade 照常翻译成 `failed`。
   */
  async function guarded(
    c: import('hono').Context,
    ctx: WorkspaceContext,
    executor: IsolatedShellExecutor,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<ShellRunResult>,
  ): Promise<ShellRunResult> {
    const outcome = await runGuardedForeground({
      gate: quotaGateFor(deps, ctx),
      clientSignal: c.req.raw.signal,
      run,
    });
    if (outcome.kind === 'ran') return outcome.result;
    return deniedRunResult(ctx, executor.mode, outcome.message, timeoutMs);
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
    if (err instanceof SearchQueryError) {
      return c.json({ detail: { code: 'PATH_INVALID', message: err.message } }, 400 as never);
    }
    if (err instanceof FsError && err.code === 'FS_NOT_FOUND') {
      return c.json({ detail: { code: 'PATH_NOT_FOUND', message: 'path not found' } }, 404 as never);
    }
    // 直调 node:fs 的那几条路由（read 探针、delete、upload）：ENOENT/ENOTDIR
    // 是"路径不存在"，固定文案不带物理路径；EISDIR 是"是个目录"。
    const errno = (err as { code?: unknown }).code;
    if (errno === 'ENOENT' || errno === 'ENOTDIR') {
      return c.json({ detail: { code: 'PATH_NOT_FOUND', message: 'path not found' } }, 404 as never);
    }
    if (errno === 'EISDIR') {
      return c.json({ detail: { code: 'IS_DIRECTORY', message: 'path is a directory' } }, 400 as never);
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
      const timeoutSeconds = clampTimeout(payload['timeout_seconds'], maxTimeoutSeconds);
      const executionId = `exec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const executor = shellOf(ctx);
      const timeoutMs = timeoutSeconds * 1000;
      const startedAt = Date.now();
      const result = await guarded(c, ctx, executor, timeoutMs, (signal) =>
        executor.runPython({ code, executionId, timeoutMs, signal }),
      );
      return c.json({
        status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'succeeded' : 'failed',
        exit_code: result.exitCode,
        stdout_preview: result.stdout.text,
        stderr_preview: result.stderr.text,
        duration_ms: Date.now() - startedAt,
        truncated: result.stdout.truncated || result.stderr.truncated,
        execution_id: executionId,
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
      const timeoutSeconds = clampTimeout(payload['timeout_seconds'], maxTimeoutSeconds);
      const executor = shellOf(ctx);
      const spec = executor.resolve({ command, timeoutMs: timeoutSeconds * 1000 });
      const startedAt = Date.now();
      const result = await guarded(c, ctx, executor, spec.timeoutMs, (signal) =>
        executor.run({ ...spec, signal }),
      );
      const executionId = `exec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      return c.json({
        status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'succeeded' : 'failed',
        exit_code: result.exitCode,
        stdout_preview: result.stdout.text,
        stderr_preview: result.stderr.text,
        duration_ms: Date.now() - startedAt,
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
      if (content.includes('\0')) throw new BridgeError('INVALID_INPUT', 'content contains NUL bytes', 400);
      if (Buffer.byteLength(content, 'utf8') > limits.maxFileSizeBytes) {
        throw new BridgeError('TOO_LARGE', 'content exceeds MCP file size limit', 413);
      }
      const mode = payload['mode'] === 'append' ? 'append' : 'overwrite';

      const fs = fsOf(ctx);
      const target = await fs.resolve(logical);
      await mkdir(path.dirname(target.targetKey), { recursive: true });
      if (mode === 'append') await appendFile(target.targetKey, content, 'utf8');
      else await writeFile(target.targetKey, content, 'utf8');

      const st = await stat(target.targetKey);
      return c.json({
        path: logical,
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
      const rawOffset = payload['offset'];
      const rawLimit = payload['limit'];
      const offset = rawOffset === undefined || rawOffset === null ? 1 : Number(rawOffset);
      const limit = rawLimit === undefined || rawLimit === null ? null : Number(rawLimit);
      if (!Number.isInteger(offset) || offset < 1) {
        throw new BridgeError('PATH_INVALID', 'invalid offset', 400);
      }
      if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
        throw new BridgeError('PATH_INVALID', 'invalid limit', 400);
      }

      const fs = fsOf(ctx);
      const target = await fs.resolve(logical);
      const st = await stat(target.targetKey);
      if (!st.isFile()) {
        if (st.isDirectory()) throw new BridgeError('IS_DIRECTORY', 'path is a directory', 400);
        throw new BridgeError('PATH_INVALID', 'not a readable file', 400);
      }
      await assertTextFile(target.targetKey);
      // 大文件不整段进内存：流式逐行扫描，内存只保留窗口内的完整行。
      const out = await readTextBounded(target.targetKey, {
        offset,
        limit,
        maxBytes: limits.maxReadBytes,
        endsWithNewline: await endsWithNewline(target.targetKey, st.size),
      });
      return c.json({
        path: logical,
        content: out.content,
        size: st.size,
        truncated: out.truncated,
        mime_type: guessMime(logical),
        total_lines: out.totalLines,
        next_offset: out.nextOffset,
        ...(out.truncated
          ? {
              hint:
                `File exceeds the ${limits.maxReadBytes}-byte read limit. ` +
                'Read it in pages with offset/limit (1-based line numbers); ' +
                'total_lines shows the full line count.',
            }
          : {}),
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
      if (result.stop_reason === 'not_found') {
        throw new BridgeError('PATH_NOT_FOUND', 'path not found', 404);
      }
      return c.json(result);
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/files/delete', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const logical = requireString(payload['path'], 'path');
      const rawRecursive = payload['recursive'];
      const recursive =
        rawRecursive === undefined || rawRecursive === null ? false : rawRecursive;
      if (typeof recursive !== 'boolean') {
        throw new BridgeError('PATH_INVALID', 'invalid recursive', 400);
      }
      const normalized = path.posix.normalize(logical);
      if (
        normalized === '' ||
        normalized === '.' ||
        normalized === '/' ||
        normalized === '..' ||
        normalized.startsWith('../')
      ) {
        throw new BridgeError('PATH_INVALID', 'refusing to delete workspace root', 400);
      }
      const fs = fsOf(ctx);
      // 先过围栏（防穿越与符号链接逃逸），再在父目录下定位链接本身。
      await fs.resolve(logical);
      const parentLogical = path.posix.dirname(normalized);
      const parent = await fs.resolve(parentLogical === '' ? '.' : parentLogical);
      const linkPath = path.join(parent.targetKey, path.posix.basename(normalized));
      const contained = [ctx.workspaceRoot, ctx.tempRoot].some(
        (root) => linkPath === root || linkPath.startsWith(root + path.sep),
      );
      if (!contained) throw new BridgeError('PATH_INVALID', 'path escapes workspace', 400);
      let entry;
      try {
        // lstat 不跟随最后一段：删符号链接时删的是链接本身，不断目标。
        entry = await lstat(linkPath);
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ENOENT') {
          throw new BridgeError('PATH_NOT_FOUND', 'path not found', 404);
        }
        throw err;
      }
      if (entry.isSymbolicLink() || entry.isFile()) {
        await unlink(linkPath);
      } else if (entry.isDirectory()) {
        if (!recursive) {
          throw new BridgeError('IS_DIRECTORY', 'directory requires recursive=true', 400);
        }
        await rm(linkPath, { recursive: true });
      } else {
        await unlink(linkPath);
      }
      return c.json({ path: logical, deleted: true });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/files/upload', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const logical = requireString(payload['path'], 'path');
      if (typeof payload['content_base64'] !== 'string') {
        throw new BridgeError('INVALID_BASE64', 'invalid content_base64', 400);
      }
      const rawOverwrite = payload['overwrite'];
      const overwrite =
        rawOverwrite === undefined || rawOverwrite === null ? true : rawOverwrite;
      if (typeof overwrite !== 'boolean') {
        throw new BridgeError('PATH_INVALID', 'invalid overwrite', 400);
      }
      // 桥侧精判：解码后的字节数（facade 只按 base64 长度粗判）。
      const bytes = decodeBase64Strict(payload['content_base64']);
      if (bytes.length > limits.maxFileSizeBytes) {
        throw new BridgeError('TOO_LARGE', 'content exceeds MCP file size limit', 413);
      }
      const fs = fsOf(ctx);
      const target = await fs.resolve(logical);
      let existing = null;
      try {
        existing = await lstat(target.targetKey);
      } catch (err) {
        if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
      }
      if (existing !== null) {
        if (existing.isDirectory()) {
          throw new BridgeError('IS_DIRECTORY', 'path is a directory', 400);
        }
        if (!overwrite) {
          throw new BridgeError('FILE_EXISTS', 'file exists and overwrite is false', 409);
        }
      }
      await mkdir(path.dirname(target.targetKey), { recursive: true });
      await writeFile(target.targetKey, bytes);
      const st = await stat(target.targetKey);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return c.json({
        path: logical,
        size: st.size,
        sha256,
        mime_type: guessMime(logical, 'application/octet-stream'),
      });
    } catch (err) {
      return fail(c, err, roots);
    }
  });

  app.post('/internal/mcp/v1/files/search', async (c) => {
    let roots: readonly string[] = [];
    try {
      const payload = await body(c);
      const ctx = await contextOf(payload);
      roots = rootsOf(ctx);
      const logical =
        payload['path'] === undefined || payload['path'] === null
          ? '.'
          : requireString(payload['path'], 'path');
      const pattern =
        payload['pattern'] === undefined || payload['pattern'] === null
          ? null
          : requireString(payload['pattern'], 'pattern', 256);
      const query =
        payload['query'] === undefined || payload['query'] === null
          ? null
          : requireString(payload['query'], 'query', 512);
      if (pattern === null && query === null) {
        throw new BridgeError('PATH_INVALID', 'at least one of pattern or query is required', 400);
      }
      const rawMax = payload['max_results'];
      const maxResults = rawMax === undefined || rawMax === null ? 100 : Number(rawMax);
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
        throw new BridgeError('PATH_INVALID', 'max_results must be in 1..500', 400);
      }
      const fs = fsOf(ctx);
      const target = await fs.resolve(logical);
      // 公共前缀 null：返回逻辑相对路径，物理根不出桥（与 files/list 同做法）。
      const where = { root: ctx.workspaceRoot, start: target.targetKey, publicPrefix: null };
      if (query !== null) {
        const result = await fileSearchService.grep(where, {
          query,
          glob: pattern,
          limit: maxResults,
        });
        if (result.stop_reason === 'not_found') {
          throw new BridgeError('PATH_NOT_FOUND', 'path not found', 404);
        }
        return c.json({ path: logical, mode: 'grep', ...result });
      }
      const result = await fileSearchService.find(where, {
        pattern: pattern ?? '*',
        limit: maxResults,
      });
      if (result.stop_reason === 'not_found') {
        throw new BridgeError('PATH_NOT_FOUND', 'path not found', 404);
      }
      return c.json({ path: logical, mode: 'find', ...result });
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
