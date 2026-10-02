/**
 * `GET /internal/identity/owner` → `{ org_id, user_id }`：调用者的正式归属。
 * 未映射的身份按 `OwnerScopedNotFoundError` 映射成 404。返回 `true` 表示已处理。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuthSubjects, json, type AuthSubjects } from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';

export interface OwnerIdentityServiceLike {
  resolve(auth: AuthSubjects): Promise<{ org_id: string; user_id: string }>;
}

export async function handleIdentityRoute(input: {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  ownerIdentityService?: OwnerIdentityServiceLike | null;
}): Promise<boolean> {
  const { req, res, path, ownerIdentityService } = input;
  if (path !== '/internal/identity/owner') return false;
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  if (!ownerIdentityService) {
    json(res, 503, { error: 'Identity resolution unavailable', code: 'DEPENDENCY' });
    return true;
  }
  const auth = requireAuthSubjects(req, res);
  if (!auth) return true;
  try {
    json(res, 200, await ownerIdentityService.resolve(auth));
  } catch (error) {
    const mapped = mapErrorToHttp(error);
    json(res, mapped.status, mapped.body);
  }
  return true;
}
