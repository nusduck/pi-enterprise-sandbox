/**
 * Typed HTTP + SSE stream client for the Sandbox API Server.
 * Typed client for API Server resources.
 */
import { isAllowedApiUrl } from '../security/url';
import {
  ApprovalDecisionSchema,
  ArtifactImportResponseSchema,
  ArtifactListSchema,
  ConversationDetailSchema,
  ConversationEventsResponseSchema,
  ConversationListSchema,
  EnsureSessionSchema,
  parseApi,
  parseApiStrict,
  type ArtifactImportResponse,
  type Conversation,
  type ConversationEventsResponse,
  type EnsureSession,
} from '../schemas/api';
import type { Artifact } from '../state/types';

const BASE = '/api';

/** Browser authentication is carried by the BFF-owned HttpOnly session cookie. */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra };
}

export class ApiError extends Error {
  status?: number;
  code?: string | null;
  traceId?: string | null;
  detail?: unknown;

  constructor(message: string, opts: Partial<ApiError> = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, opts);
  }
}

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

// ── Conversations ───────────────────────────────

/** `GET /api/conversations` 的一页：`next_cursor === null` 表示到底（§2.4）。 */
export type ConversationPage = {
  conversations: Conversation[];
  next_cursor: string | null;
};

/**
 * GET /api/conversations — cursor-paginated list (`q` filters titles server-side).
 * `limit` / `cursor` / `q` only go on the query string when the caller set them;
 * the server owns their defaults (limit 30). `URLSearchParams` escapes `q`.
 */
export async function listConversations(opts: {
  limit?: number;
  cursor?: string | null;
  q?: string | null;
} = {}): Promise<ConversationPage> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.q) q.set('q', opts.q);
  const qs = q.toString() ? `?${q}` : '';
  const resp = await fetch(`${BASE}/conversations${qs}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `List conversations failed: ${resp.status}`));
  }
  const page = parseApi(ConversationListSchema, await resp.json(), 'conversations');
  // parseApi 软失败时会把原始 body 原样放行（例如响应仍是旧版裸数组），这里再兜一层，
  // 不把 undefined 当列表、也不把「缺 cursor」读成「还有下一页」交给调用方。
  return {
    conversations: Array.isArray(page.conversations) ? page.conversations : [],
    next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null,
  };
}

export async function getConversation(id: string): Promise<Conversation> {
  const resp = await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `Get conversation failed: ${resp.status}`));
  }
  return parseApi(ConversationDetailSchema, await resp.json(), 'conversation');
}

export async function getConversationEvents(
  id: string,
): Promise<ConversationEventsResponse> {
  const resp = await fetch(
    `${BASE}/conversations/${encodeURIComponent(id)}/events`,
    { headers: authHeaders() },
  );
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new ApiError(
      String(err.error || err.detail || `Conversation events failed: ${resp.status}`),
      {
        status: resp.status,
        traceId: resp.headers.get('x-trace-id'),
      },
    );
  }
  return parseApiStrict(
    ConversationEventsResponseSchema,
    await resp.json(),
    'conversation events',
  );
}

export async function deleteConversation(id: string): Promise<boolean> {
  const resp = await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!resp.ok && resp.status !== 204) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `Delete conversation failed: ${resp.status}`));
  }
  return true;
}

// ── Artifacts ───────────────────────────────────

export async function listArtifacts(
  sessionId: string,
): Promise<{ artifacts: Artifact[]; total?: number }> {
  const q = new URLSearchParams({ session_id: sessionId });
  const resp = await fetch(`${BASE}/artifacts?${q}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `List artifacts failed: ${resp.status}`));
  }
  const data = parseApi(ArtifactListSchema, await resp.json(), 'artifacts');
  if (Array.isArray(data)) {
    return { artifacts: data as Artifact[] };
  }
  return {
    artifacts: (data.artifacts || []) as Artifact[],
    total: data.total,
  };
}

export async function importArtifact(input: {
  artifactId: string;
  targetConversationId: string;
  targetFilename?: string | null;
}): Promise<ArtifactImportResponse> {
  const resp = await fetch(
    `${BASE}/conversations/${encodeURIComponent(input.targetConversationId)}/artifact-imports`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        artifact_id: input.artifactId,
        ...(input.targetFilename
          ? { target_filename: input.targetFilename }
          : {}),
      }),
    },
  );
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new ApiError(
      String(err.error || err.detail || `Artifact import failed: ${resp.status}`),
      {
        status: resp.status,
        code: typeof err.code === 'string' ? err.code : null,
        traceId: resp.headers.get('x-trace-id'),
        detail: err,
      },
    );
  }
  return parseApiStrict(
    ArtifactImportResponseSchema,
    await resp.json(),
    'artifact import',
  );
}

export async function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `${BASE}/approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ decision }),
    },
  );
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `Approval failed: ${resp.status}`));
  }
  return parseApi(ApprovalDecisionSchema, await resp.json(), 'approval');
}

// ── Sessions ────────────────────────────────────

export async function ensureSession(
  conversationId: string | null = null,
): Promise<EnsureSession> {
  const resp = await fetch(`${BASE}/sessions/ensure`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(conversationId ? { conversation_id: conversationId } : {}),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    const msg = err.error || err.detail || `Ensure session failed: ${resp.status}`;
    throw new ApiError(typeof msg === 'string' ? msg : JSON.stringify(msg), {
      status: resp.status,
      traceId: (err.trace_id as string) || resp.headers.get('x-trace-id') || null,
    });
  }
  return parseApi(EnsureSessionSchema, await resp.json(), 'ensureSession');
}


/** Build a download URL for a registered artifact deliverable. */
export function getArtifactDownloadUrl(
  sessionId: string,
  artifactId: string,
): string | null {
  const url = `${BASE}/files/artifact-download?session_id=${encodeURIComponent(sessionId)}&artifact_id=${encodeURIComponent(artifactId)}`;
  return isAllowedApiUrl(url) ? url : null;
}

/** Build a URL for a workspace file (e.g. an uploaded attachment) of a session. */
export function getWorkspaceFileUrl(sessionId: string, path: string): string | null {
  const url = `${BASE}/files/download?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  return isAllowedApiUrl(url) ? url : null;
}

// 认证请求已按职责拆到 ./auth.ts；这里保留同名再导出，旧导入路径（含测试夹具）
// 继续可用，避免一次无谓的全仓改 import。
export { login, register, logout, me, getAuthConfig } from './auth';
