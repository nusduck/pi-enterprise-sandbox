import type { IncomingMessage, ServerResponse } from 'node:http';
import { authSubjectsFromRequest, json } from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';

type Loose = any;

function readBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        const err = new Error('Skill archive exceeds size limit');
        (err as any).statusCode = 413;
        (err as any).code = 'SKILL_ARCHIVE_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks, bytes));
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

export async function handleSkillRoute(input: {
  req: IncomingMessage;
  res: ServerResponse;
  parsedUrl: URL;
  path: string;
  getExtensionDiagnostics?: Loose;
  mutateSkill?: Loose;
  uploadSkillDraft?: Loose;
}): Promise<boolean> {
  const { req, res, parsedUrl, path } = input;
  if (req.method === 'GET' && path === '/internal/extensions/diagnostics') {
    if (typeof input.getExtensionDiagnostics !== 'function') {
      json(res, 501, { error: 'Extension diagnostics not configured', code: 'NOT_IMPLEMENTED' });
      return true;
    }
    try {
      json(res, 200, await input.getExtensionDiagnostics({
        profileId: parsedUrl.searchParams.get('profile_id') || 'coding-agent',
        auth: authSubjectsFromRequest(req),
      }));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
    }
    return true;
  }

  if (req.method === 'POST' && path === '/internal/skills/drafts') {
    if (typeof input.uploadSkillDraft !== 'function') {
      json(res, 501, { error: 'Skill draft upload not configured', code: 'NOT_IMPLEMENTED' });
      return true;
    }
    const auth = authSubjectsFromRequest(req);
    if (!auth) {
      json(res, 400, { error: 'Trusted acting identity required', code: 'AUTH_CONTEXT_REQUIRED' });
      return true;
    }
    const rawFilename = req.headers['x-filename'] || parsedUrl.searchParams.get('filename') || 'skill.zip';
    const filename = Array.isArray(rawFilename) ? rawFilename[0] : rawFilename;
    try {
      const archiveBytes = await readBuffer(req, 50 * 1024 * 1024);
      const result = await input.uploadSkillDraft({
        auth,
        filename,
        archiveBytes,
      });
      json(res, 201, result);
    } catch (error) {
      console.error('[agent-http] Skill draft upload failed:', error);
      const status = (error as any)?.statusCode || 400;
      json(res, status, {
        error: (error as Error)?.message || 'Failed to upload Skill draft',
        code: (error as any)?.code || 'SKILL_DRAFT_UPLOAD_FAILED',
      });
    }
    return true;
  }

  const match = path.match(/^\/internal\/skills\/([^/]+)\/(enable|disable)$/);
  if (req.method !== 'POST' || !match) return false;
  if (typeof input.mutateSkill !== 'function') {
    json(res, 501, { error: 'Skill enablement not configured', code: 'NOT_IMPLEMENTED' });
    return true;
  }
  const auth = authSubjectsFromRequest(req);
  if (!auth) {
    json(res, 400, { error: 'Trusted acting identity required', code: 'AUTH_CONTEXT_REQUIRED' });
    return true;
  }
  try {
    const name = decodeURIComponent(match[1] as string);
    json(res, 200, await input.mutateSkill({ action: match[2], name, auth }));
  } catch (error) {
    console.error('[agent-http] Skill mutation failed:', error);
    const mapped = (error as { code?: string })?.code === 'MYSQL_DEPENDENCY_ERROR'
      ? mapErrorToHttp(error)
      : { status: 400, body: { error: 'Invalid Skill package', code: 'SKILL_INVALID' } };
    json(res, mapped.status, mapped.body);
  }
  return true;
}
