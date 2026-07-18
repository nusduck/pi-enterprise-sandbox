/**
 * Dataset list API (plan §17 / §19.7). Soft-fails when BFF is unavailable.
 */
import { authHeaders, ApiError } from './client';

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
  conversation_id?: string | null;
  sandbox_session_id?: string | null;
  [key: string]: unknown;
};

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * GET /api/datasets?session_id=… or conversation-scoped list.
 */
export async function listDatasets(opts: {
  sessionId?: string | null;
  conversationId?: string | null;
} = {}): Promise<DatasetRow[]> {
  try {
    const q = new URLSearchParams();
    if (opts.sessionId) q.set('session_id', opts.sessionId);
    let url = `${BASE}/datasets`;
    if (opts.conversationId) {
      url = `${BASE}/conversations/${encodeURIComponent(opts.conversationId)}/datasets`;
    }
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(`${url}${qs}`, { headers: authHeaders() });
    if (resp.status === 404 || resp.status === 501) return [];
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
