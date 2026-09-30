/**
 * 管理端 Skill 路由的 BFF 面（ADR 0015 §7.2 管理员侧表）：
 *
 *   GET  /api/admin/skills/share-requests?status=         本 org 的共享申请队列
 *   GET  /api/admin/skills/share-requests/:id/manifest    被申请版本的文件清单
 *   POST /api/admin/skills/share-requests/:id/approve     body { setCurrent?, note? }
 *   POST /api/admin/skills/share-requests/:id/reject      body { note }（必填）
 *   GET  /api/admin/skills/org                            org 层列表
 *   POST /api/admin/skills/org                            管理员直传归档（流式）
 *   GET  /api/admin/skills/org/:name/versions/:digest/manifest
 *   POST /api/admin/skills/org/:name/current              body { contentDigest }
 *   POST /api/admin/skills/org/:name/versions/:digest/deprecate | revoke   body { reason }
 *
 * 身份由服务端解析后写入 `X-Acting-*`（含角色）：**浏览器声明不了自己的角色**。
 * 角色判定与 org 作用域在 agent/：非 admin 403、跨 org 404。这里只做形状与转发，
 * 所以前台看到的错误码与 agent 的语义一致，不是 BFF 另编的一套。
 */
import type { ServerResponse } from 'node:http';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';
import {
  decideAdminSkillShareRequest,
  getAdminOrgSkillManifest,
  getAdminSkillShareRequestManifest,
  listAdminOrgSkills,
  listAdminSkillShareRequests,
  setAdminOrgSkillCurrent,
  setAdminOrgSkillVersionStatus,
  uploadAdminOrgSkill,
} from '../services/agent-skill-admin-client.js';
import { sendError, sendJson as json } from '../http/response.js';
import { readJsonBody } from '../http/body.js';
import { config } from '../config.js';

const PREFIX = '/api/admin/skills';
const SHARE_PREFIX = `${PREFIX}/share-requests`;
const ORG_PREFIX = `${PREFIX}/org`;

type Deps = { req: ReqWithTrace | null; res: ServerResponse; parsedUrl: URL };

async function readBody(req: ReqWithTrace | null): Promise<Record<string, unknown>> {
  if (!req) return {};
  const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Returns true when the path belongs here (handled, whatever the outcome). */
export async function handleAdminSkillsRoute(
  method: string,
  path: string,
  parsedUrl: URL,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<boolean> {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  const deps: Deps = { req, res, parsedUrl };
  try {
    const auth = await resolveTrustedAuth(req);
    const opts = { auth, traceId: req?.traceId ?? null };

    if (path === SHARE_PREFIX && method === 'GET') {
      json(res, 200, await listAdminSkillShareRequests(parsedUrl.searchParams, opts));
      return true;
    }

    const share = path.slice(SHARE_PREFIX.length + 1).match(/^([^/]+)\/(manifest|approve|reject)$/);
    if (share) {
      const requestId = decodeURIComponent(share[1] as string);
      const action = share[2];
      if (action === 'manifest' && method === 'GET') {
        json(res, 200, await getAdminSkillShareRequestManifest(requestId, opts));
        return true;
      }
      if (action === 'approve' && method === 'POST') {
        const body = await readBody(req);
        json(res, 200, await decideAdminSkillShareRequest(requestId, 'approve', {
          ...(typeof body['setCurrent'] === 'boolean' ? { setCurrent: body['setCurrent'] } : {}),
          ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
        }, opts));
        return true;
      }
      if (action === 'reject' && method === 'POST') {
        const body = await readBody(req);
        const note = str(body['note']).trim();
        // 驳回必须带原因：没有原因的驳回在审计里等于没解释（design §7.1）。
        // 这一条在 agent 侧也判；BFF 早一步拒绝能省一次往返，但**不能**只在这里判。
        if (note === '') {
          json(res, 400, { error: 'note is required', code: 'SKILL_SHARE_NOTE_REQUIRED' });
          return true;
        }
        json(res, 200, await decideAdminSkillShareRequest(requestId, 'reject', { note }, opts));
        return true;
      }
      json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    if (path === ORG_PREFIX) {
      if (method === 'GET') {
        json(res, 200, await listAdminOrgSkills(opts));
        return true;
      }
      if (method === 'POST') {
        // 归档本体就是请求体，与草稿上传同一套流式转发（不在这里缓冲整包）。
        const rawFilename = req?.headers['x-filename'] ?? parsedUrl.searchParams.get('filename') ?? '';
        const filename = Array.isArray(rawFilename) ? rawFilename[0] : rawFilename;
        const lower = String(filename || '').toLowerCase();
        if (!lower.endsWith('.zip') && !lower.endsWith('.skill')) {
          json(res, 400, {
            error: 'Org Skill package must be a .zip or .skill file',
            code: 'SKILL_ARCHIVE_INVALID_EXTENSION',
          });
          return true;
        }
        // `req` 为 null 只出现在没有请求对象的单测装配里；那条路径没有流可转发。
        if (!req) {
          json(res, 400, { error: 'Request stream required', code: 'SKILL_ARCHIVE_REQUIRED' });
          return true;
        }
        const setCurrent = ['1', 'true'].includes(
          String(req.headers['x-set-current'] ?? parsedUrl.searchParams.get('set_current') ?? ''),
        );
        const contentLength = String(req.headers['content-length'] ?? '');
        const result = await uploadAdminOrgSkill(req, String(filename || 'skill.zip'), {
          setCurrent,
          ...opts,
          ...(contentLength === '' ? {} : { extraHeaders: { 'Content-Length': contentLength } }),
        });
        json(res, 201, result);
        return true;
      }
      json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    const org = path.slice(ORG_PREFIX.length + 1).match(
      /^([^/]+)\/(?:current|versions\/([^/]+)\/(manifest|deprecate|revoke))$/,
    );
    if (org) {
      const name = decodeURIComponent(org[1] as string);
      const digest = org[2] ? decodeURIComponent(org[2]) : '';
      const action = org[2] ? org[3] : 'current';
      if (action === 'manifest' && method === 'GET') {
        json(res, 200, await getAdminOrgSkillManifest(name, digest, opts));
        return true;
      }
      if (action === 'current' && method === 'POST') {
        const body = await readBody(req);
        const contentDigest = str(body['contentDigest']);
        if (contentDigest === '') {
          json(res, 400, { error: 'contentDigest is required', code: 'SKILL_ORG_DIGEST_REQUIRED' });
          return true;
        }
        json(res, 200, await setAdminOrgSkillCurrent(name, contentDigest, opts));
        return true;
      }
      if ((action === 'deprecate' || action === 'revoke') && method === 'POST') {
        const body = await readBody(req);
        json(res, 200, await setAdminOrgSkillVersionStatus(name, digest, action, body['reason'], opts));
        return true;
      }
      json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    return true;
  } catch (error) {
    sendError(res, error, req?.traceId);
    return true;
  }
}
