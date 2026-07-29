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

/**
 * GET /api/approvals — list approvals, optional status filter.
 * Returns [] when endpoint is not available (404/501).
 */
export async function listApprovals(opts: {
  status?: string;
} = {}): Promise<ApprovalListItem[]> {
  try {
    const q = new URLSearchParams();
    if (opts.status && opts.status !== 'all') q.set('status', opts.status);
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(`${BASE}/approvals${qs}`, {
      headers: authHeaders(),
    });
    if (resp.status === 404 || resp.status === 501 || resp.status === 405) {
      return [];
    }
    if (!resp.ok) return [];
    const raw = await resp.json();
    parseApi(ApprovalListSchema, raw, 'listApprovals');
    return unwrapList(raw).map((item) =>
      parseApi(ApprovalListItemSchema, item, 'listApprovals.item'),
    );
  } catch {
    return [];
  }
}

