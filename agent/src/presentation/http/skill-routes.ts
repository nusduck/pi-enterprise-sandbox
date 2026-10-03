import type { IncomingMessage, ServerResponse } from 'node:http';
import { authSubjectsFromRequest, requireAuthSubjects, json } from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';
import type {
  OrgSkillAdminRequest,
  OrgSkillAdminResponse,
} from '../../application/org-skill-admin-service.js';
import type {
  ShareHttpRequest,
  ShareHttpResponse,
} from '../../application/skill-share-service.js';

interface SkillRouteErrorMeta {
  readonly statusCode?: unknown;
  readonly code?: unknown;
}
export interface ExtensionDiagnosticsHandler {
  (options?: { auth?: object | null; [key: string]: unknown }): Promise<unknown>;
}
export interface MutateSkillHandler {
  (input: { action: string; name: string; auth: unknown }): Promise<unknown>;
}
export interface UploadSkillDraftHandler {
  (input: { auth: unknown; filename: string; archiveBytes: Buffer }): Promise<unknown>;
}
export interface SkillShareResult {
  readonly status: number;
  readonly body: unknown;
}
export interface SkillShareHandler {
  (input: ShareHttpRequest): Promise<ShareHttpResponse | null>;
}
export interface OrgSkillAdminHandler {
  (input: OrgSkillAdminRequest): Promise<OrgSkillAdminResponse>;
}

/**
 * 把 org 层操作的错误映射成 HTTP。
 *
 * 这一份是**给人看的兜底**：`orgSkillAdmin` 注入的实现自己也会映射（它知道
 * `OrgSkillError` 的语义）。这里只保证「没有映射器时也不是 500 或静默成功」。
 */
/**
 * 共享申请流程的兜底错误映射。
 *
 * 与 `mapOrgSkillError` 分开：两个域的错误码集合不同，合并会让一个域的新码悄悄落到
 * 另一个域的默认分支上。注入的实现自己也会映射；这里只保证不会 500 或静默成功。
 */
function mapShareError(error: unknown): { status: number; body: { error: string; code: string } } {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  const message = (error as Error)?.message || 'Share operation failed';
  if (code === 'ADMIN_REQUIRED') return { status: 403, body: { error: message, code } };
  if (code === 'SKILL_SHARE_REQUEST_UNKNOWN') return { status: 404, body: { error: message, code } };
  if (code === 'SKILL_NOT_ENABLED') return { status: 409, body: { error: message, code } };
  if (code === 'SKILL_ORG_NAME_TAKEN') return { status: 409, body: { error: message, code } };
  if (code === 'SKILL_SHARE_REQUEST_DECIDED') return { status: 409, body: { error: message, code } };
  if (code.startsWith('SKILL_')) return { status: 400, body: { error: message, code } };
  return {
    status: 400,
    body: { error: message, code: code || 'SKILL_SHARE_OPERATION_FAILED' },
  };
}

function mapOrgSkillError(error: unknown): { status: number; body: { error: string; code: string } } {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  const message = (error as Error)?.message || 'Org skill operation failed';
  if (code === 'ADMIN_REQUIRED') return { status: 403, body: { error: message, code } };
  if (code === 'SKILL_ORG_VERSION_UNKNOWN') return { status: 404, body: { error: message, code } };
  if (code.startsWith('SKILL_ORG_') || code.startsWith('SKILL_SHARE_')) {
    return { status: 400, body: { error: message, code } };
  }
  return { status: 400, body: { error: message, code: code || 'SKILL_ORG_OPERATION_FAILED' } };
}

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
        const err = new Error('Skill archive exceeds size limit') as Error & { statusCode?: number; code?: string }; // reason: 413 与业务码是错误契约的一部分，随错误一起传递
        err.statusCode = 413;
        err.code = 'SKILL_ARCHIVE_TOO_LARGE';
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
  getExtensionDiagnostics?: ExtensionDiagnosticsHandler;
  mutateSkill?: MutateSkillHandler;
  uploadSkillDraft?: UploadSkillDraftHandler;
  /** org 层管理员操作面（ADR 0015 §7.2）。省略时这些路由返回 501。 */
  orgSkillAdmin?: OrgSkillAdminHandler;
  /** 共享申请与审批流程（ADR 0015 §7.2/§7.3）。省略时这些路由返回 501。 */
  skillShare?: SkillShareHandler;
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
    const auth = requireAuthSubjects(req, res);
    if (!auth) return true;
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
      const meta = error as SkillRouteErrorMeta | null; // reason: 上传失败的 HTTP 状态与业务码由调用方约定在错误对象上
      const statusCode = typeof meta?.statusCode === 'number' ? meta.statusCode : 400;
      const status = statusCode;
      json(res, status, {
        error: error instanceof Error ? error.message : 'Failed to upload Skill draft',
        code: typeof meta?.code === 'string' && meta.code ? meta.code : 'SKILL_DRAFT_UPLOAD_FAILED',
      });
    }
    return true;
  }

  // ── 共享申请与审批（ADR 0015 §7.2/§7.3）─────────────────────────────────
  //
  // 用户侧与管理员共用 `/internal/skills/share-requests`，靠 `scope=org` 区分列表；
  // **权限判定不靠这个参数**——`scope=org` 仍要过 admin 检查（在流程服务里）。
  if (path.startsWith('/internal/skills/share-requests')) {
    if (typeof input.skillShare !== 'function') {
      json(res, 501, { error: 'Skill sharing is not configured', code: 'NOT_IMPLEMENTED' });
      return true;
    }
    const auth = requireAuthSubjects(req, res);
    if (!auth) return true;
    try {
      const result = await input.skillShare({
        method: req.method,
        path,
        auth,
        query: parsedUrl.searchParams,
        readBody: () => readBuffer(req, 64 * 1024),
      });
      if (result === null) return false;
      json(res, result.status, result.body);
    } catch (error) {
      const mapped = mapShareError(error);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  // ── org 层管理员操作面（ADR 0015 §7.2）───────────────────────────────────
  //
  // 鉴权（`hasRole(actor, 'admin')`）与 org 作用域都在 `orgSkillAdmin` 里判，这里只做
  // HTTP 形状与错误映射。跨 org 的资源由服务返回「不存在」→ 404，不是 403。
  if (path.startsWith('/internal/skills/org')) {
    if (typeof input.orgSkillAdmin !== 'function') {
      json(res, 501, { error: 'Org skill administration not configured', code: 'NOT_IMPLEMENTED' });
      return true;
    }
    const auth = requireAuthSubjects(req, res);
    if (!auth) return true;
    try {
      const result = await input.orgSkillAdmin({
        method: req.method,
        path,
        auth,
        query: parsedUrl.searchParams,
        readBody: () => readBuffer(req, 50 * 1024 * 1024),
        headers: req.headers,
      });
      if (result === null) return false;
      json(res, result.status, result.body);
    } catch (error) {
      const mapped = mapOrgSkillError(error);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  const match = path.match(/^\/internal\/skills\/([^/]+)\/(enable|disable)$/);
  if (req.method !== 'POST' || !match) return false;
  if (typeof input.mutateSkill !== 'function') {
    json(res, 501, { error: 'Skill enablement not configured', code: 'NOT_IMPLEMENTED' });
    return true;
  }
  const auth = requireAuthSubjects(req, res);
  if (!auth) return true;
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
