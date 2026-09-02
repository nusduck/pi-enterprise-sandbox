/**
 * 公共面产物路由——对 BFF `/api/artifacts` 与 Python `artifact/api/public.py` 对齐。
 *
 * - GET  /sessions/:id/artifacts → 200 {artifacts,total}（owner 作用域，跨租户当作空）
 * - POST /sessions/:id/artifacts/register|submit → 201 ArtifactResponse
 * - POST /sessions/:id/artifacts/imports {artifact_id,target_filename?} → 201
 * - GET  /sessions/:id/artifacts/:artifactId/download → 200 流
 *
 * **归属只认可信来源。** org/user 一律取自已校验的 acting 头（api-server 从
 * JWT/cookie 解析后转发，浏览器直传的会被剥掉），**绝不读 body 里的
 * org_id/user_id**——Python 版的注释写得很清楚：伪造这些字段曾经能把正式记录
 * 和控制面快照写到别的租户路径下。
 *
 * 这四条路由在 2026-08-29 之前是占位：list 恒空、submit 编造
 * `sha256: '0'.repeat(64)` 并回 201、imports 只回显、download 恒 404。
 * 见 docs/design/waves/gap-audit.md。
 */

import { Hono } from 'hono';
import path from 'node:path';
import { Readable } from 'node:stream';
import { badRequest, errorBody, HttpError, notFound } from './errors.js';
import { parseActingHeaders, requireOwnedSession } from './ownership.js';
import { redactPhysicalRoots } from '../../fs/redact.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import type { ArtifactService } from '../../artifact/service.js';
import { ArtifactError, downloadMimeType } from '../../artifact/service.js';
import type { ExecArtifactRecord } from '../../db/repositories/artifacts.js';
import { newUlid } from '../../mcp/ulid.js';

export interface PublicArtifactDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (
    orgId: string,
    userId: string,
  ) => readonly { name: string; sourcePath: string }[];
  readonly artifactService: ArtifactService;
}

function actingFrom(c: import('hono').Context): Record<string, string | undefined> {
  const h: Record<string, string | undefined> = {};
  for (const k of ['x-acting-organization-id', 'x-acting-user-id']) {
    const v = c.req.header(k);
    if (v !== undefined) h[k] = v;
  }
  return h;
}

const ASCII_EXT_RE = /\.([A-Za-z0-9]{1,8})$/;

/**
 * 显示名 + 从存储路径借来的扩展名。
 *
 * `submit` 的 name 是用户可见标题（`随机 Markdown 文档`），扩展名常常只存在于
 * 工作区路径里。原样下载标题会存出一个没有应用打得开的文件。
 */
function displayFilename(record: ExecArtifactRecord): string {
  const base = path.basename(record.name || 'artifact');
  if (ASCII_EXT_RE.test(base)) return base;
  const matched = ASCII_EXT_RE.exec(path.basename(record.sourcePath || ''));
  return matched ? `${base}${matched[0]}` : base;
}

/** latin-1 安全的 `filename=` 兜底值，保留扩展名。 */
function asciiFallback(name: string): string {
  const base = path.basename(String(name || 'download'));
  const ext = path.extname(base);
  const body = ext ? base.slice(0, -ext.length) : base;
  let ascii = '';
  for (const ch of body) {
    const code = ch.codePointAt(0) ?? 0;
    ascii += code >= 0x20 && code <= 0x7e ? ch : '_';
  }
  ascii = ascii.replace(/[_\s.]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'download';
  return `${ascii}${ext}`.slice(0, 200);
}

/** Python `quote(safe='')`：比 encodeURIComponent 多编码 `!'()*`。 */
function quoteAll(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 对外的产物 JSON。字段名与 Python `ArtifactResponse` 一致。 */
function toResponse(record: ExecArtifactRecord): Record<string, unknown> {
  return {
    artifact_id: record.artifactId,
    session_id: record.sessionId,
    org_id: record.orgId,
    user_id: record.userId,
    path: record.sourcePath,
    name: record.name,
    mime_type: record.mimeType,
    sha256: record.sha256,
    size: record.sizeBytes,
    created_at: record.createdAt.toISOString(),
  };
}

function mapError(err: unknown, roots: readonly string[]): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ArtifactError) {
    return new HttpError(err.status, redactPhysicalRoots(err.message, roots), err.code);
  }
  const raw = err instanceof Error ? err.message : String(err);
  return new HttpError(500, redactPhysicalRoots(raw, roots));
}

export function registerPublicArtifactRoutes(app: Hono, deps: PublicArtifactDeps): void {
  app.get('/sessions/:sessionId/artifacts', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const artifacts = await deps.artifactService.list(sessionId, {
        orgId: own.workspace.orgId,
        userId: own.workspace.userId,
      });
      return c.json({ artifacts: artifacts.map(toResponse), total: artifacts.length });
    } catch (err) {
      const mapped = mapError(err, roots);
      return c.json(errorBody(mapped, roots), mapped.status as never);
    }
  });

  const handleSubmit = async (c: import('hono').Context): Promise<Response> => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = (await c.req.json().catch(() => null)) as {
        path?: string;
        name?: string;
        mime_type?: string;
        expected_sha256?: string;
      } | null;
      const sourcePath = typeof body?.path === 'string' ? body.path.trim() : '';
      if (!sourcePath) throw badRequest('path is required', 'path_required');

      const record = await deps.artifactService.submit({
        workspace: own.workspace,
        sessionId,
        sourcePath,
        name: body?.name ?? null,
        mimeType: body?.mime_type ?? null,
        expectedSha256: body?.expected_sha256 ?? null,
        // 归属只来自可信 session/actor，绝不取 body。
        owner: { orgId: own.workspace.orgId, userId: own.workspace.userId },
      });
      return c.json(toResponse(record), 201 as never);
    } catch (err) {
      const mapped = mapError(err, roots);
      return c.json(errorBody(mapped, roots), mapped.status as never);
    }
  };
  app.post('/sessions/:sessionId/artifacts/register', handleSubmit);
  app.post('/sessions/:sessionId/artifacts/submit', handleSubmit);

  app.post('/sessions/:sessionId/artifacts/imports', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = (await c.req.json().catch(() => null)) as {
        artifact_id?: string;
        target_filename?: string;
      } | null;
      const artifactId = String(body?.artifact_id ?? '').trim();
      if (!artifactId) throw badRequest('artifact_id is required', 'artifact_id_required');
      const targetFilename = body?.target_filename ? String(body.target_filename).trim() : null;
      if (targetFilename !== null && (targetFilename.length === 0 || targetFilename.length > 256)) {
        throw badRequest(
          'target_filename must be between 1 and 256 characters',
          'target_filename_invalid',
        );
      }
      if (!acting.orgId || !acting.userId) {
        throw new HttpError(401, redactPhysicalRoots('Artifact owner unavailable', roots));
      }

      const { record, path: written } = await deps.artifactService.importToWorkspace({
        artifactId,
        workspace: own.workspace,
        owner: { orgId: own.workspace.orgId, userId: own.workspace.userId },
        targetFilename,
      });
      return c.json(
        {
          import_id: newUlid(),
          artifact_id: artifactId,
          target_session_id: sessionId,
          target_conversation_id: null,
          workspace_file: {
            name: path.basename(written),
            path: written,
            mime_type: record.mimeType,
            size: record.sizeBytes,
            sha256: record.sha256,
          },
          path: written,
        },
        201 as never,
      );
    } catch (err) {
      const mapped = mapError(err, roots);
      return c.json(errorBody(mapped, roots), mapped.status as never);
    }
  });

  app.get('/sessions/:sessionId/artifacts/:artifactId/download', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const artifactId = c.req.param('artifactId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      if (!artifactId) throw notFound('Artifact not found');

      const record = await deps.artifactService.get(artifactId, {
        orgId: own.workspace.orgId,
        userId: own.workspace.userId,
      });
      // 归属不符与不存在给同一个 404：存在性本身不能泄漏。
      if (record === null || record.sessionId !== sessionId) throw notFound('Artifact not found');

      const filename = displayFilename(record);
      const stream = Readable.from(deps.artifactService.openSnapshot(record));
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          'content-type': downloadMimeType(record.mimeType),
          'content-length': String(record.sizeBytes),
          'content-disposition': `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${quoteAll(filename)}`,
          'x-artifact-filename': quoteAll(filename),
          'x-artifact-sha256': record.sha256,
          // 即使 content-type 已降级，也要挡住浏览器的类型嗅探。
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (err) {
      const mapped = mapError(err, roots);
      return c.json(errorBody(mapped, roots), mapped.status as never);
    }
  });
}
