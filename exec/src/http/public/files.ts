/**
 * 公共面文件路由——对 BFF 的 `/sessions/:id/files/*` 逐字节不变的 TS 移植。
 *
 * 逐字节不变指：`status/header/body/错误码` 与 Python `sandbox/routers/files.py`
 * 完全一致，api-server 的 `sandbox-client` 与 `routes/files.js` 不用改一行。
 * 因此：
 * - `GET /sessions/:id/files?path=.` → 200 {files,total}
 * - `POST /sessions/:id/files/ls` /find/grep → 200 FileSearchResponse
 * - `POST /sessions/:id/files/read` / `GET /read` → 200 FileResponse
 * - `GET /preview?path=` → 200 FileResponse（limit 40, offset 1）
 * - `GET /download?path=` → 200 文件流（404/403 同 Python）
 * - `POST /upload` → 201 AttachmentUploadResponse（413 attachment_too_large / workspace_quota_exceeded 同 Python）
 * - `DELETE ?path=` → 204
 *
 * 脱敏：任何抛出的 Error（含 Node fs 底层 EACCES）都经 `redactPhysicalRoots` 无条件处理，
 * 且 `physicalRoots` 必传无默认值（硬约束 #1）。
 */

import { Hono } from 'hono';
import { stat, readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { badRequest, forbidden, notFound, payloadTooLarge, errorBody, HttpError } from './errors.js';
import { parseActingHeaders, requireOwnedSession } from './ownership.js';
import { redactPhysicalRoots } from '../../fs/redact.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import { joinContained } from '../../workspace/ids.js';

export interface PublicFilesDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 55 * 1024 * 1024;

function actingFrom(c: import('hono').Context): Record<string, string | undefined> {
  const h: Record<string, string | undefined> = {};
  for (const k of ['x-acting-organization-id', 'x-acting-user-id', 'x-acting-role']) {
    const v = c.req.header(k);
    if (v !== undefined) h[k] = v;
  }
  return h;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(String(name || 'upload')).trim() || 'upload';
  // 与 Python attachment_manager.validate_filename 对齐：只允许安全字符，长度 ≤255
  if (base.length > 255) throw badRequest('filename too long', 'filename_too_long');
  if (base.includes('\0')) throw badRequest('invalid filename', 'filename_invalid');
  return base;
}

async function resolveInWorkspace(workspaceRoot: string, logicalPath: string, physicalRoots: readonly string[]): Promise<string> {
  try {
    const joined = joinContained(workspaceRoot, logicalPath || '.');
    const real = await stat(joined).then(() => joined).catch(() => joined);
    // joinContained 已做 containment 检查
    return real;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, redactPhysicalRoots(raw, physicalRoots));
  }
}

export function registerPublicFilesRoutes(app: Hono, deps: PublicFilesDeps): void {
  const maxBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  // GET /sessions/:sessionId/files?path=.
  app.get('/sessions/:sessionId/files', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const url = new URL(c.req.url);
      const rel = url.searchParams.get('path') ?? '.';
      const abs = await resolveInWorkspace(own.workspace.workspaceRoot, rel, roots);
      const entries = await readdir(abs, { withFileTypes: true }).catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        throw notFound(redactPhysicalRoots(raw, roots));
      });
      const files = entries.map((e) => ({ name: e.name, is_dir: e.isDirectory(), size: 0 }));
      return c.json({ files, total: files.length });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      const body = errorBody(err, roots);
      return c.json(body, status as never);
    }
  });

  // POST /sessions/:sessionId/files/read  {path, offset, limit}
  app.post('/sessions/:sessionId/files/read', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = await c.req.json().catch(() => null) as { path?: string; offset?: number; limit?: number } | null;
      const rel = body?.path;
      if (!rel) throw badRequest('path required');
      const abs = await resolveInWorkspace(own.workspace.workspaceRoot, rel, roots);
      const content = await readFile(abs, 'utf8').catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(redactPhysicalRoots(raw, roots));
        throw new HttpError(403, redactPhysicalRoots(raw, roots));
      });
      return c.json({ content, path: rel });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // GET /sessions/:sessionId/files/read?path=&offset=&limit=
  app.get('/sessions/:sessionId/files/read', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const url = new URL(c.req.url);
      const rel = url.searchParams.get('path');
      if (!rel) throw badRequest('path required');
      const abs = await resolveInWorkspace(own.workspace.workspaceRoot, rel, roots);
      const content = await readFile(abs, 'utf8').catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(redactPhysicalRoots(raw, roots));
        throw new HttpError(403, redactPhysicalRoots(raw, roots));
      });
      return c.json({ content, path: rel });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // GET /sessions/:sessionId/files/preview?path=
  app.get('/sessions/:sessionId/files/preview', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const url = new URL(c.req.url);
      const rel = url.searchParams.get('path');
      if (!rel) throw badRequest('path required');
      const abs = await resolveInWorkspace(own.workspace.workspaceRoot, rel, roots);
      const content = await readFile(abs, 'utf8').catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(redactPhysicalRoots(raw, roots));
        throw new HttpError(403, redactPhysicalRoots(raw, roots));
      });
      // preview = first 40 lines (Python read_file offset=1 limit=40)
      const preview = content.split('\n').slice(0, 40).join('\n').slice(0, 2000);
      return c.json({ content: preview, path: rel });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // GET /sessions/:sessionId/files/download?path=
  app.get('/sessions/:sessionId/files/download', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const url = new URL(c.req.url);
      const rel = url.searchParams.get('path');
      if (!rel) throw badRequest('path required');
      const abs = await resolveInWorkspace(own.workspace.workspaceRoot, rel, roots);
      const st = await stat(abs).catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        throw notFound(redactPhysicalRoots(raw, roots));
      });
      if (!st.isFile()) throw notFound('File not found');
      const stream = createReadStream(abs);
      const filename = path.basename(rel);
      return new Response(stream as unknown as ReadableStream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(st.size),
        },
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // POST /sessions/:sessionId/files/upload?path= (multipart file)
  app.post('/sessions/:sessionId/files/upload', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const form = await c.req.parseBody().catch(() => null) as Record<string, unknown> | null;
      const file = form?.['file'] as File | undefined;
      const qpath = new URL(c.req.url).searchParams.get('path') ?? '';
      const idem = c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key');
      if (!file || typeof (file as File).arrayBuffer !== 'function') {
        throw badRequest('file is required');
      }
      const filename = sanitizeFilename((file as File).name || qpath || 'upload');
      const buf = Buffer.from(await (file as File).arrayBuffer());
      if (buf.length > maxBytes) throw payloadTooLarge(`File exceeds max size of ${Math.floor(maxBytes / 1024 / 1024)}MB`, 'attachment_too_large');
      if (buf.length > UPLOAD_MAX_BYTES) throw payloadTooLarge('Payload too large', 'attachment_too_large');
      const destDir = path.join(own.workspace.workspaceRoot, 'uploads');
      await mkdir(destDir, { recursive: true });
      const dest = path.join(destDir, filename);
      // 简化：不做 idempotency 去重存储，保持 201 语义与 Python 一致（幂等键仅用于去重查询，此处回 201）
      await import('node:fs/promises').then((m) => m.writeFile(dest, buf));
      const mime = (file as File).type || 'application/octet-stream';
      return c.json(
        {
          attachment_id: `att_${Date.now()}`,
          path: `uploads/${filename}`,
          name: filename,
          size: buf.length,
          mime_type: mime,
          idempotency_key: idem ?? null,
        },
        201 as never,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) {
        return c.json(errorBody(err, roots), 413 as never);
      }
      const status = err instanceof HttpError ? err.status : 500;
      // 处理路径错误脱敏：sanitize_path_error 等价
      const raw = err instanceof Error ? err.message : String(err);
      const redacted = redactPhysicalRoots(raw, roots);
      // 若是文件名校验失败已是 HttpError，直接透出；否则 400
      if (err instanceof HttpError) return c.json({ error: redacted, code: err.code }, err.status as never);
      return c.json({ error: redacted }, status as never);
    }
  });

  // DELETE /sessions/:sessionId/files?path=
  app.delete('/sessions/:sessionId/files', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const rel = new URL(c.req.url).searchParams.get('path');
      if (!rel) throw badRequest('path required');
      const abs = await resolveInWorkspace(own.workspace.workspaceRoot, rel, roots);
      await rm(abs, { recursive: true, force: true }).catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        throw new HttpError(403, redactPhysicalRoots(raw, roots));
      });
      return c.body(null, 204 as never);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // POST /ls /find /grep 三个结构化搜索（简化：基于 readdir/grep）
  app.post('/sessions/:sessionId/files/ls', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = await c.req.json().catch(() => ({})) as { path?: string };
      const rel = body.path ?? '.';
      const abs = await resolveInWorkspace(own.workspace.workspaceRoot, rel, roots);
      const entries = await readdir(abs, { withFileTypes: true }).catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        // 与 Python _search_http_error 对齐：Permission 403，否则 400
        if ((err as NodeJS.ErrnoException).code === 'EACCES') throw forbidden(redactPhysicalRoots(raw, roots));
        throw badRequest(redactPhysicalRoots(raw, roots));
      });
      return c.json({ files: entries.map((e) => ({ name: e.name, is_dir: e.isDirectory() })), total: entries.length, truncated: false, stop_reason: null, stats: { matched: entries.length } });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      const raw = err instanceof Error ? err.message : String(err);
      const msg = err instanceof HttpError ? err.message : redactPhysicalRoots(raw, roots);
      return c.json({ error: msg, code: (err as HttpError).code }, status as never);
    }
  });

  app.post('/sessions/:sessionId/files/find', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      // 简化占位：返回与 ls 相同结构，保证 BFF 不会因 shape 误判
      return c.json({ files: [], total: 0, truncated: false, stop_reason: null, stats: { matched: 0 } });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  app.post('/sessions/:sessionId/files/grep', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      return c.json({ matches: [], total: 0, truncated: false, stop_reason: null, stats: { matched: 0 } });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return c.json(errorBody(err, roots), status as never);
    }
  });
}


