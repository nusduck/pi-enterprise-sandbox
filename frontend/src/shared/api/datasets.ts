/**
 * Dataset API (plan §17 / §19.7). Listing soft-fails when BFF is unavailable;
 * creation uses a strict formal-row contract.
 */
import { authHeaders, ApiError } from './client';
import {
  DatasetUploadResponseSchema,
  parseApiStrict,
  type DatasetUploadResponse,
} from '../schemas/api';

const BASE = '/api';

export type DatasetRow = {
  dataset_id?: string;
  id?: string;
  name?: string;
  original_filename?: string;
  path?: string;
  stored_relative_path?: string;
  size?: number;
  size_bytes?: number;
  mime_type?: string;
  sha256?: string | null;
  status?: string;
  created_at?: string | null;
  completed_at?: string | null;
  conversation_id?: string | null;
  sandbox_session_id?: string | null;
  [key: string]: unknown;
};

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

async function datasetUploadError(resp: Response): Promise<ApiError> {
  const body = await errorBody(resp);
  const detail = body.detail;
  const structured =
    detail && typeof detail === 'object'
      ? (detail as { code?: unknown; message?: unknown })
      : null;
  const message =
    body.error ||
    structured?.message ||
    (typeof detail === 'string' ? detail : null) ||
    `Dataset upload failed: ${resp.status}`;
  return new ApiError(String(message), {
    status: resp.status,
    code: String(body.code || structured?.code || '') || null,
    traceId:
      (typeof body.trace_id === 'string' ? body.trace_id : null) ||
      resp.headers.get('x-trace-id'),
    detail,
  });
}

/**
 * Create a Dataset in the conversation's active Sandbox session.
 *
 * The caller owns a stable key for the upload attempt. The backend persists
 * that key and replays the same Dataset response across retries/restarts.
 */
export async function uploadDataset(opts: {
  conversationId: string;
  sessionId: string;
  file: File | Blob;
  signal?: AbortSignal | null;
  idempotencyKey: string;
  traceId?: string;
}): Promise<DatasetUploadResponse> {
  const conversationId = String(opts.conversationId || '').trim();
  const sessionId = String(opts.sessionId || '').trim();
  if (!conversationId) throw new Error('conversationId is required');
  if (!sessionId) throw new Error('sessionId is required');
  const idempotencyKey = String(opts.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('idempotencyKey is required');

  const form = new FormData();
  const filename = (opts.file as File).name || 'dataset';
  form.append('file', opts.file, filename);
  const headers = authHeaders();
  headers['Idempotency-Key'] = idempotencyKey;
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const query = new URLSearchParams({ session_id: sessionId });
  const response = await fetch(
    `${BASE}/conversations/${encodeURIComponent(conversationId)}/datasets?${query}`,
    {
      method: 'POST',
      headers,
      body: form,
      signal: opts.signal ?? undefined,
    },
  );
  if (!response.ok) throw await datasetUploadError(response);

  const parsed = parseApiStrict(
    DatasetUploadResponseSchema,
    await response.json(),
    'dataset upload',
  );
  if (parsed.conversation_id !== conversationId) {
    throw new Error('dataset upload contract mismatch: conversation_id');
  }
  if (parsed.sandbox_session_id !== sessionId) {
    throw new Error('dataset upload contract mismatch: sandbox_session_id');
  }
  if (parsed.path !== parsed.stored_relative_path) {
    throw new Error('dataset upload contract mismatch: path');
  }
  if (parsed.size !== parsed.size_bytes) {
    throw new Error('dataset upload contract mismatch: size');
  }
  return {
    ...parsed,
    trace_id: parsed.trace_id || response.headers.get('x-trace-id'),
  };
}

/**
 * GET /api/datasets?session_id=… or conversation-scoped list.
 */
export async function listDatasets(opts: {
  sessionId?: string | null;
  conversationId?: string | null;
} = {}): Promise<DatasetRow[]> {
  try {
    const sessionId = String(opts.sessionId || '').trim();
    // BFF requires session_id for both /api/datasets and conversation-scoped
    // list. Calling without it returns 400 (session_id required) which used to
    // surface as a hard "not found" in the browser network panel.
    if (!sessionId) return [];
    const q = new URLSearchParams({ session_id: sessionId });
    let url = `${BASE}/datasets`;
    if (opts.conversationId) {
      url = `${BASE}/conversations/${encodeURIComponent(opts.conversationId)}/datasets`;
    }
    const resp = await fetch(`${url}?${q}`, { headers: authHeaders() });
    if (resp.status === 404 || resp.status === 501) return [];
    if (resp.status === 400) {
      // Missing/invalid session is not a fatal UI error for the datasets panel.
      return [];
    }
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || err.detail || `List datasets failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    const data = (await resp.json()) as unknown;
    if (Array.isArray(data)) return data as DatasetRow[];
    if (data && typeof data === 'object') {
      const rows = (data as { datasets?: DatasetRow[] }).datasets;
      if (Array.isArray(rows)) return rows;
    }
    return [];
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.warn('[datasets] list unavailable:', (err as Error).message);
    return [];
  }
}
