import { resolveTrustedAuth } from '../application/run-access-service.js';
import {
  getAgentExtensionDiagnostics,
  mutateAgentSkill,
  uploadAgentSkillDraft,
} from '../services/agent-client.js';
import { sendError } from '../http/response.js';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function handleExtensionDiagnostics(parsedUrl, res, req) {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    json(res, 200, await getAgentExtensionDiagnostics(profileId, { auth, traceId }));
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleCapabilityRegistry(kind, parsedUrl, res, req) {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    const diagnostics = await getAgentExtensionDiagnostics(profileId, { auth, traceId });
    if (kind === 'skills') {
      json(res, 200, {
        skills: [
          ...(diagnostics.skills || []),
          ...(diagnostics.skill_drafts || []),
        ],
      });
    }
    else if (kind === 'mcp') json(res, 200, { servers: diagnostics.mcp_servers || [] });
    else if (kind === 'tools') json(res, 200, { tools: diagnostics.tools || [] });
    else if (kind === 'models') json(res, 200, { models: diagnostics.models || [] });
    else json(res, 404, { error: 'unknown capability registry' });
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleSkillMutation(encodedName, action, res, req) {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    let name;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      json(res, 400, { error: 'Invalid Skill name', code: 'SKILL_INVALID' });
      return;
    }
    json(res, 200, await mutateAgentSkill(name, action, { auth, traceId }));
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleSkillDraftUpload(parsedUrl, res, req) {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const rawFilename = req.headers['x-filename'] || parsedUrl.searchParams.get('filename') || '';
    let filename = Array.isArray(rawFilename) ? rawFilename[0] : rawFilename;
    filename = filename ? decodeURIComponent(filename).trim() : 'skill.zip';
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.zip') && !lower.endsWith('.skill')) {
      json(res, 400, {
        error: 'Skill draft package must be a .zip or .skill file',
        code: 'SKILL_ARCHIVE_INVALID_EXTENSION',
      });
      return;
    }
    const maxBytes = 55 * 1024 * 1024;
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > maxBytes) {
      json(res, 413, {
        error: 'Skill archive exceeds 50MB limit',
        code: 'SKILL_ARCHIVE_TOO_LARGE',
      });
      return;
    }
    const result = await uploadAgentSkillDraft(req, filename, { auth, traceId });
    json(res, 201, result);
  } catch (error) {
    sendError(res, error, traceId);
  }
}
