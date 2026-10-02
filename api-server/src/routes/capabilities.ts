import type { ServerResponse } from 'node:http';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';
import {
  getAgentExtensionDiagnostics,
  mutateAgentSkill,
  uploadAgentSkillDraft,
} from '../services/agent-client.js';
import {
  createAgentSkillShareRequest,
  listAgentSkillShareRequests,
  withdrawAgentSkillShareRequest,
} from '../services/agent-skill-admin-client.js';
import { sendError, sendJson } from '../http/response.js';
import { readJsonBody } from '../http/body.js';
import { config, UPLOAD_MAX_BYTES } from '../config.js';

/** 本人的申请列表；创建与撤回的形状见 `handleSkillShareRequests`。 */
const LIST_PATH = '/api/capabilities/skills/share-requests';

export async function handleExtensionDiagnostics(parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    sendJson(res, 200, await getAgentExtensionDiagnostics(profileId, { auth, traceId }));
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleCapabilityRegistry(kind: string, parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    const diagnostics = await getAgentExtensionDiagnostics(profileId, { auth, traceId });
    if (kind === 'skills') {
      sendJson(res, 200, {
        skills: [
          ...(diagnostics.skills || []),
          ...(diagnostics.skill_drafts || []),
        ],
      });
    }
    else if (kind === 'mcp') sendJson(res, 200, { servers: diagnostics.mcp_servers || [] });
    else if (kind === 'tools') sendJson(res, 200, { tools: diagnostics.tools || [] });
    else if (kind === 'models') sendJson(res, 200, { models: diagnostics.models || [] });
    else sendJson(res, 404, { error: 'unknown capability registry' });
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleSkillMutation(encodedName: string, action: string, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    let name: string;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      sendJson(res, 400, { error: 'Invalid Skill name', code: 'SKILL_INVALID' });
      return;
    }
    sendJson(res, 200, await mutateAgentSkill(name, action, { auth, traceId }));
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleSkillDraftUpload(parsedUrl: URL, res: ServerResponse, req: ReqWithTrace): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const rawFilename = req.headers['x-filename'] || parsedUrl.searchParams.get('filename') || '';
    let filename = Array.isArray(rawFilename) ? rawFilename[0] : rawFilename;
    filename = filename ? decodeURIComponent(filename).trim() : 'skill.zip';
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.zip') && !lower.endsWith('.skill')) {
      sendJson(res, 400, {
        error: 'Skill draft package must be a .zip or .skill file',
        code: 'SKILL_ARCHIVE_INVALID_EXTENSION',
      });
      return;
    }
    const maxBytes = UPLOAD_MAX_BYTES;
    const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
    if (declared > maxBytes) {
      sendJson(res, 413, {
        error: 'Skill archive exceeds 50MB limit',
        code: 'SKILL_ARCHIVE_TOO_LARGE',
      });
      return;
    }
    const result = await uploadAgentSkillDraft(req, filename, { auth, traceId });
    sendJson(res, 201, result);
  } catch (error) {
    sendError(res, error, traceId);
  }
}

/**
 * 用户侧共享申请（ADR 0015 §7.2 用户侧表）：
 *
 *   POST /api/capabilities/skills/:name/share-requests   body { note? }
 *   GET  /api/capabilities/skills/share-requests         本人申请列表
 *   POST /api/capabilities/skills/share-requests/:id/withdraw
 *
 * 申请钉住的是「本人**已启用**的那一版」——未启用 → 409 `SKILL_NOT_ENABLED`，
 * 由 agent 判定（它才读得到启用账本）。BFF 不查账本，也不接受客户端指定摘要：
 * 让调用方自报摘要等于让人给自己背书。
 */
export async function handleSkillShareRequests(
  method: string,
  path: string,
  res: ServerResponse,
  req: ReqWithTrace,
): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const opts = { auth, traceId };
    if (method === 'GET' && path === LIST_PATH) {
      sendJson(res, 200, await listAgentSkillShareRequests(opts));
      return;
    }
    const withdraw = path.match(/^\/api\/capabilities\/skills\/share-requests\/([^/]+)\/withdraw$/);
    if (method === 'POST' && withdraw) {
      sendJson(res, 200, await withdrawAgentSkillShareRequest(
        decodeURIComponent(withdraw[1] as string),
        opts,
      ));
      return;
    }
    const create = method === 'POST'
      ? path.match(/^\/api\/capabilities\/skills\/([^/]+)\/share-requests$/)
      : null;
    if (create) {
      const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
      const note = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>)['note']
        : undefined;
      sendJson(res, 201, await createAgentSkillShareRequest(
        decodeURIComponent(create[1] as string),
        note,
        opts,
      ));
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    sendError(res, error, traceId);
  }
}

