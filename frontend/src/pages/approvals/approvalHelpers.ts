/**
 * Pure helpers for Approval Center (F5 / ADR 0003 §9).
 */
import type { ApprovalEntity, EntityStore, RunEntity } from '../../entities';
import type { ApprovalListItem } from '../../shared/schemas/management';

export const APPROVAL_STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'expired', label: 'Expired' },
  { id: 'cancelled', label: 'Cancelled' },
] as const;

export type ApprovalStatusFilterId =
  (typeof APPROVAL_STATUS_FILTERS)[number]['id'];

export type ApprovalRow = {
  id: string;
  runId: string | null;
  conversationId: string | null;
  tool: string | null;
  status: string;
  riskLevel: string | null;
  reason: string;
  command: string | null;
  arguments: unknown;
  workspaceId: string | null;
  username: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  source: 'api' | 'store' | 'merged';
};

/** Normalize backend status variants onto UI filter ids. */
export function normalizeApprovalStatus(status: string | null | undefined): string {
  if (!status) return 'pending';
  const s = status.toLowerCase();
  if (s === 'pending_approval' || s === 'waiting_approval') return 'pending';
  if (s === 'approve' || s === 'approved') return 'approved';
  if (s === 'reject' || s === 'rejected') return 'rejected';
  if (s === 'expire' || s === 'expired') return 'expired';
  if (s === 'cancel' || s === 'cancelled' || s === 'canceled') return 'cancelled';
  return s;
}

export function filterApprovalsByStatus(
  rows: ApprovalRow[],
  filter: ApprovalStatusFilterId,
): ApprovalRow[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => normalizeApprovalStatus(r.status) === filter);
}

export function approvalRowFromApi(item: ApprovalListItem): ApprovalRow | null {
  const id = item.approval_id || item.id || '';
  if (!id) return null;
  const payload = (item.payload || {}) as Record<string, unknown>;
  return {
    id,
    runId:
      item.run_id ||
      (payload.run_id as string | undefined) ||
      null,
    conversationId:
      item.conversation_id ||
      (payload.conversation_id as string | undefined) ||
      null,
    tool: item.tool_name || item.tool || null,
    status: normalizeApprovalStatus(item.status),
    riskLevel: item.risk_level || null,
    reason: item.reason || '',
    command:
      item.command ||
      (payload.command as string | undefined) ||
      null,
    arguments: item.arguments ?? payload.arguments ?? payload.args ?? null,
    workspaceId: item.workspace_id || null,
    username:
      item.username ||
      (item.user_id != null ? String(item.user_id) : null),
    createdAt: item.created_at || null,
    decidedAt: item.decided_at || null,
    source: 'api',
  };
}

export function approvalRowFromEntity(
  a: ApprovalEntity,
  run: RunEntity | null,
): ApprovalRow {
  return {
    id: a.id,
    runId: a.runId,
    conversationId: run?.conversationId ?? null,
    tool: a.toolExecutionId,
    status: normalizeApprovalStatus(a.status),
    riskLevel: null,
    reason: a.reason || '',
    command: a.command,
    arguments: null,
    workspaceId: null,
    username: null,
    createdAt: a.createdAt,
    decidedAt: a.decidedAt,
    source: 'store',
  };
}

export function mergeApprovalRows(
  apiItems: ApprovalListItem[],
  store: EntityStore,
): ApprovalRow[] {
  const byId = new Map<string, ApprovalRow>();

  for (const item of apiItems) {
    const row = approvalRowFromApi(item);
    if (row) byId.set(row.id, row);
  }

  for (const a of Object.values(store.approvalsById)) {
    const run = store.runsById[a.runId] || null;
    const fromStore = approvalRowFromEntity(a, run);
    const existing = byId.get(a.id);
    if (!existing) {
      byId.set(a.id, fromStore);
    } else {
      byId.set(a.id, {
        ...fromStore,
        ...Object.fromEntries(
          Object.entries(existing).filter(([, v]) => v != null && v !== ''),
        ),
        id: a.id,
        status: normalizeApprovalStatus(existing.status || fromStore.status),
        source: 'merged',
      } as ApprovalRow);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    return tb - ta;
  });
}

export function canDecideApproval(status: string): boolean {
  return normalizeApprovalStatus(status) === 'pending';
}

export function formatArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
