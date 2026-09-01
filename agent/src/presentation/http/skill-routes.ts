import type { IncomingMessage, ServerResponse } from 'node:http';
import { authSubjectsFromRequest, json } from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';

type Loose = any;

export async function handleSkillRoute(input: {
  req: IncomingMessage;
  res: ServerResponse;
  parsedUrl: URL;
  path: string;
  getExtensionDiagnostics?: Loose;
  mutateSkill?: Loose;
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
