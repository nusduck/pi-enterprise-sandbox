/**
 * Approval Center API adapters (F5 / ADR 0003 §9).
 * Soft-fail when list endpoints are missing so UI can use entity-store fallback.
 */
import {
  ApprovalListItemSchema,
  ApprovalListSchema,
  type ApprovalListItem,
} from '../schemas/management';
import { parseApi, ApprovalDecisionSchema } from '../schemas/api';
import { authHeaders, ApiError } from './client';

export type { ApprovalListItem };

const BASE = '/api';

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

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

/**
 * GET /api/approvals/:id — single approval detail.
 * Returns null when missing.
 */
export async function getApproval(
  approvalId: string,
): Promise<ApprovalListItem | null> {
  try {
    const resp = await fetch(
      `${BASE}/approvals/${encodeURIComponent(approvalId)}`,
      { headers: authHeaders() },
    );
    if (resp.status === 404 || resp.status === 501) return null;
    if (!resp.ok) return null;
    return parseApi(
      ApprovalListItemSchema,
      await resp.json(),
      'getApproval',
    );
  } catch {
    return null;
  }
}

/**
 * POST /api/approvals/:id/decide — approve or reject.
 * Same path as client.decideApproval; re-exported shape for management pages.
 */
export async function decideApprovalDecision(
  approvalId: string,
  decision: 'approve' | 'reject',
  opts: { run_id?: string | null; reason?: string | null } = {},
): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `${BASE}/approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        decision,
        run_id: opts.run_id || undefined,
        reason: opts.reason || undefined,
      }),
    },
  );
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new ApiError(
      String(err.error || err.detail || `Approval failed: ${resp.status}`),
      { status: resp.status },
    );
  }
  return parseApi(ApprovalDecisionSchema, await resp.json(), 'approvalDecide');
}
