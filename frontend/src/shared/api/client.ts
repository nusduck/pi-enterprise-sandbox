/**
 * Typed HTTP + SSE stream client for the Sandbox API Server.
 * Typed client for API Server resources.
 */
import { isAllowedApiUrl, safeApiUrl } from '../security/url';
import {
  ApprovalDecisionSchema,
  ArtifactListSchema,
  AuthResponseSchema,
  ConversationDetailSchema,
  ConversationEventsResponseSchema,
  ConversationListSchema,
  EnsureSessionSchema,
  MeResponseSchema,
  StatusSchema,
  UploadResponseSchema,
  parseApi,
  parseApiStrict,
  type AuthResponse,
  type AuthUser,
  type Conversation,
  type ConversationEventsResponse,
  type EnsureSession,
  type UploadResponse,
} from '../schemas/api';
import type { Artifact } from '../state/types';

export { readSSEStream } from '../sse/parser';
export { isAllowedApiUrl, safeApiUrl } from '../security/url';

const BASE = '/api';
const MAX_RETRIES = 3;

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

/** Get API Server status. */
export async function getStatus(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${BASE}/status`);
  if (!resp.ok) throw new Error(`Status check failed: ${resp.status}`);
  return parseApi(StatusSchema, await resp.json(), 'status');
}

// ── Auth ────────────────────────────────────────

export async function register(body: {
  username: string;
  password: string;
  display_name?: string;
}): Promise<AuthResponse> {
  const resp = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(
      String(err.error || err.detail || `Register failed: ${resp.status}`),
    );
  }
  const data = parseApi(AuthResponseSchema, await resp.json(), 'register');
  return data;
}

export async function login(body: {
  username: string;
  password: string;
}): Promise<AuthResponse> {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || err.detail || `Login failed: ${resp.status}`));
  }
  const data = parseApi(AuthResponseSchema, await resp.json(), 'login');
  return data;
}

export async function logout(): Promise<void> {
  const resp = await fetch(`${BASE}/auth/logout`, { method: 'POST' });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `Logout failed: ${resp.status}`));
  }
}

export async function me(): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/auth/me`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || err.detail || `Me failed: ${resp.status}`));
  }
  return parseApi(MeResponseSchema, await resp.json(), 'me');
}

// ── Conversations ───────────────────────────────

export async function listConversations(): Promise<Conversation[]> {
  const resp = await fetch(`${BASE}/conversations`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `List conversations failed: ${resp.status}`));
  }
  return parseApi(ConversationListSchema, await resp.json(), 'conversations');
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

export async function createConversation(title = 'New chat'): Promise<Conversation> {
  const resp = await fetch(`${BASE}/conversations`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `Create conversation failed: ${resp.status}`));
  }
  return parseApi(ConversationDetailSchema, await resp.json(), 'createConversation');
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

// ── Files ───────────────────────────────────────

async function uploadErrorFromResponse(resp: Response): Promise<ApiError> {
  const err = await errorBody(resp);
  const detail = err.detail;
  let code: string | null = (err.code as string) || null;
  let message: string | null = (err.error as string) || null;
  if (detail && typeof detail === 'object') {
    const d = detail as { code?: string; message?: string };
    code = d.code || code;
    message = d.message || message;
  } else if (typeof detail === 'string') {
    message = message || detail;
  }
  if (!message) message = `Upload failed (HTTP ${resp.status})`;
  return new ApiError(message, {
    status: resp.status,
    code,
    traceId: (err.trace_id as string) || resp.headers.get('x-trace-id') || null,
    detail,
  });
}

export async function uploadFile(
  sessionId: string,
  file: File | Blob,
  signal?: AbortSignal | null,
  opts: { idempotencyKey?: string; traceId?: string } = {},
): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', file);

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const headers = authHeaders();
      if (opts.idempotencyKey) {
        headers['Idempotency-Key'] = opts.idempotencyKey;
      }
      if (opts.traceId) {
        headers['X-Trace-Id'] = opts.traceId;
      }

      const resp = await fetch(
        `${BASE}/files/upload?session_id=${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers,
          body: fd,
          signal: signal ?? undefined,
        },
      );

      if (!resp.ok) {
        const e = await uploadErrorFromResponse(resp);
        throw e;
      }
      const data = parseApi(UploadResponseSchema, await resp.json(), 'upload');
      data.trace_id = data.trace_id || resp.headers.get('x-trace-id') || null;
      return data;
    } catch (err) {
      const error = err as ApiError & { name?: string };
      if (error.name === 'AbortError') throw err;
      if (
        error.code === 'attachment_too_large' ||
        error.code === 'attachment_type_denied' ||
        error.code === 'workspace_quota_exceeded' ||
        error.code === 'turn_attachment_limit'
      ) {
        throw err;
      }
      if (attempt === MAX_RETRIES - 1) throw err;
      lastErr = error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Upload failed after retries');
}

/**
 * Build a download URL for a raw workspace file.
 * Agent deliverables should use getArtifactDownloadUrl instead.
 */
export function getDownloadUrl(sessionId: string, path: string): string | null {
  const url = `${BASE}/files/download?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  return isAllowedApiUrl(url) ? url : null;
}

/** Build a download URL for a registered artifact deliverable. */
export function getArtifactDownloadUrl(
  sessionId: string,
  artifactId: string,
): string | null {
  const url = `${BASE}/files/artifact-download?session_id=${encodeURIComponent(sessionId)}&artifact_id=${encodeURIComponent(artifactId)}`;
  return isAllowedApiUrl(url) ? url : null;
}
