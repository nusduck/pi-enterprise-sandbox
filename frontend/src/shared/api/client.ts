/**
 * Typed HTTP + SSE stream client for the Sandbox API Server.
 * Typed client for API Server resources.
 */
import { isAllowedApiUrl, safeApiUrl } from '../security/url';
import {
  ApprovalDecisionSchema,
  ArtifactImportResponseSchema,
  ArtifactListSchema,
  AuthResponseSchema,
  ConversationDetailSchema,
  ConversationEventsResponseSchema,
  ConversationListSchema,
  EnsureSessionSchema,
  MeResponseSchema,
  parseApi,
  parseApiStrict,
  type AuthResponse,
  type AuthUser,
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

// ── Auth ────────────────────────────────────────

export async function register(body: {
  username: string;
  password: string;
  display_name?: string;
}): Promise<AuthResponse> {
  const resp = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    credentials: 'include',
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
    credentials: 'include',
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
  const resp = await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new Error(String(err.error || `Logout failed: ${resp.status}`));
  }
}

export async function me(): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/auth/me`, {
    credentials: 'include',
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new ApiError(
      String(err.error || err.detail || `Me failed: ${resp.status}`),
      { status: resp.status },
    );
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
