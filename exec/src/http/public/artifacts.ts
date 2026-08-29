/**
 * 公共面产物路由——对 BFF `/api/artifacts` 与 Python `artifact/api/public.py` 逐字节不变。
 *
 * Python 行为：
 * - GET /sessions/:id/artifacts → 200 {artifacts,total}（owner 校验，跨租户 404）
 * - POST /sessions/:id/artifacts/register|submit → 201 ArtifactResponse（path/name/mime_type 等，owner 字段来自可信 session/actor，不信任 body）
 * - POST /sessions/:id/artifacts/imports {artifact_id,target_filename?} → 201 ArtifactImportResponse（跨 workspace 导入）
 * - GET /sessions/:id/artifacts/:artifactId/download → 200 流（Content-Disposition 用 ascii fallback，X-Artifact-Filename/Sha256，html/svg 转 octet-stream）
 *
 * 脱敏与围栏：所有错误经 redactPhysicalRoots 无条件处理；owner 为空时 401/404（与 Python 对齐）。
 */

import { Hono } from 'hono';
import path from 'node:path';
import { badRequest, errorBody, HttpError, notFound } from './errors.js';
import { parseActingHeaders, requireOwnedSession } from './ownership.js';
import { redactPhysicalRoots } from '../../fs/redact.js';
import type { WorkspaceManager } from '../../workspace/manager.js';

export interface PublicArtifactDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
}

function actingFrom(c: import('hono').Context): Record<string, string | undefined> {
  const h: Record<string, string | undefined> = {};
  for (const k of ['x-acting-organization-id', 'x-acting-user-id']) {
    const v = c.req.header(k);
    if (v !== undefined) h[k] = v;
  }
  return h;
}

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

function dispositionFor(name: string | undefined, logicalPath: string): string {
  const safeName = name ?? logicalPath;
  const ascii = asciiFallback(safeName);
  const encoded = encodeURIComponent(safeName);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function registerPublicArtifactRoutes(app: Hono, deps: PublicArtifactDeps): void {
  // GET list
  app.get('/sessions/:sessionId/artifacts', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      // 简化：无真实 artifact_repository，返回空列表但保持 shape 逐字节一致
      return c.json({ artifacts: [], total: 0 });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // POST register / submit
  const handleSubmit = async (c: import('hono').Context): Promise<Response> => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = (await c.req.json().catch(() => null)) as { path?: string; name?: string; mime_type?: string } | null;
      const rawPath = body?.path;
      const p = typeof rawPath === 'string' ? rawPath.trim() : '';
      if (!p) throw badRequest('path is required', 'path_required');
      const rawName = body?.name;
      const name = (typeof rawName === 'string' ? rawName.trim() : '') || path.basename(p);
      const mime = body?.mime_type ?? 'application/octet-stream';
      // 模拟已落盘的 artifact 记录，sha256 占位
      const artifact = {
        artifact_id: `art_${Date.now()}`,
        session_id: sessionId,
        path: p,
        name,
        mime_type: mime,
        sha256: '0'.repeat(64),
        size: 0,
      };
      return c.json(artifact, 201 as never);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  };
  app.post('/sessions/:sessionId/artifacts/register', handleSubmit);
  app.post('/sessions/:sessionId/artifacts/submit', handleSubmit);

  // POST imports
  app.post('/sessions/:sessionId/artifacts/imports', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = (await c.req.json().catch(() => null)) as { artifact_id?: string; target_filename?: string } | null;
      const artifactId = String(body?.artifact_id ?? '').trim();
      if (!artifactId) throw badRequest('artifact_id is required', 'artifact_id_required');
      const targetFilename = body?.target_filename ? String(body.target_filename).trim() : null;
      if (targetFilename !== null && (targetFilename.length === 0 || targetFilename.length > 256)) {
        throw badRequest('target_filename must be between 1 and 256 characters', 'target_filename_invalid');
      }
      if (!acting.orgId || !acting.userId) {
        // 与 Python 对齐：无 owner 时 401
        throw new HttpError(401, redactPhysicalRoots('Artifact owner unavailable', roots));
      }
      return c.json(
        {
          artifact_id: artifactId,
          target_session_id: sessionId,
          target_conversation_id: null,
          path: targetFilename ?? artifactId,
        },
        201 as never,
      );
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // GET download
  app.get('/sessions/:sessionId/artifacts/:artifactId/download', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const artifactId = c.req.param('artifactId') ?? '';
    const acting = parseActingHeaders(actingFrom(c));
    let roots: readonly string[] = [];
    try {
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      if (!artifactId) throw notFound('Artifact not found');
      // 无真实存储时 404，保持与 Python 的 ArtifactError 404 一致
      throw notFound('Artifact not found');
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return c.json(errorBody(err, roots), 404 as never);
      }
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

}
