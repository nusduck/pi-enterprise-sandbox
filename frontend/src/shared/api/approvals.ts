/**
 * Approval Center API adapters (F5 / ADR 0003 §9).
 * Soft-fail when list endpoints are missing so UI can use entity-store fallback.
 */
import {
  ApprovalListItemSchema,
  ApprovalListSchema,
  type ApprovalListItem,
} from '../schemas/management';
import { parseApi } from '../schemas/api';
import { authHeaders } from './client';

export type { ApprovalListItem };

const BASE = '/api';

function unwrapList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as { approvals?: unknown[] };
    if (Array.isArray(obj.approvals)) return obj.approvals;
  }
  return [];
}

/** `null` 表示到底；只有字符串游标才算「还有下一页」。 */
function unwrapNextCursor(data: unknown): string | null {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const { next_cursor: cursor } = data as { next_cursor?: unknown };
    if (typeof cursor === 'string') return cursor;
  }
  return null;
}

export type ApprovalPage = {
  approvals: ApprovalListItem[];
  next_cursor: string | null;
};

/**
 * GET /api/approvals — cursor-paginated page (`limit` 1..100, server default 50).
 * Soft-fails to an empty page when the endpoint is unavailable (404/501/405) or on
 * any failure, so callers can fall back to the entity store instead of erroring out.
 */
export async function listApprovalsPage(opts: {
  status?: string;
  limit?: number;
  cursor?: string | null;
} = {}): Promise<ApprovalPage> {
  try {
    const q = new URLSearchParams();
    if (opts.status && opts.status !== 'all') q.set('status', opts.status);
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.cursor) q.set('cursor', opts.cursor);
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(`${BASE}/approvals${qs}`, {
      headers: authHeaders(),
    });
    if (resp.status === 404 || resp.status === 501 || resp.status === 405) {
      return { approvals: [], next_cursor: null };
    }
    if (!resp.ok) return { approvals: [], next_cursor: null };
    const raw = await resp.json();
    parseApi(ApprovalListSchema, raw, 'listApprovals');
    return {
      approvals: unwrapList(raw).map((item) =>
        parseApi(ApprovalListItemSchema, item, 'listApprovals.item'),
      ),
      next_cursor: unwrapNextCursor(raw),
    };
  } catch {
    return { approvals: [], next_cursor: null };
  }
}

/**
 * GET /api/approvals — first page as a plain array.
 * Kept for call sites that predate pagination (`entityBridge.ts`); delegates to
 * `listApprovalsPage` so both share exactly the same soft-fail behaviour.
 */
export async function listApprovals(opts: {
  status?: string;
} = {}): Promise<ApprovalListItem[]> {
  const { approvals } = await listApprovalsPage(opts);
  return approvals;
}

