/**
 * Pure helpers for Runtime Activity Timeline (F3 / ADR 0003 §6.2).
 * No React — unit-testable.
 */
import type {
  ApprovalEntity,
  ArtifactEntity,
  EntityStore,
  ProcessEntity,
  RunEntity,
  ToolExecutionEntity,
} from '../../entities';
import {
  getRunApprovals,
  getRunArtifacts,
  getRunProcesses,
  getRunToolExecutions,
  isTerminalRunStatus,
  listActiveRuns,
} from '../../entities';

export type TimelineKind =
  | 'tool'
  | 'process'
  | 'approval'
  | 'artifact'
  | 'session';

export type TimelineItem =
  | {
      kind: 'tool';
      id: string;
      sortAt: number;
      tool: ToolExecutionEntity;
    }
  | {
      kind: 'process';
      id: string;
      sortAt: number;
      process: ProcessEntity;
    }
  | {
      kind: 'approval';
      id: string;
      sortAt: number;
      approval: ApprovalEntity;
    }
  | {
      kind: 'artifact';
      id: string;
      sortAt: number;
      artifact: ArtifactEntity;
    }
  | {
      kind: 'session';
      id: string;
      sortAt: number;
      label: string;
      detail?: string | null;
    };

export type InspectorTabId =
  | 'overview'
  | 'files'
  | 'processes'
  | 'tools'
  | 'artifacts'
  | 'session';

/** Parse ISO timestamp → ms; missing/invalid → 0. */
export function parseTime(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Format duration between two ISO timestamps (or "now" if finished missing). */
export function formatDuration(
  startedAt: string | null | undefined,
  finishedAt?: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const start = parseTime(startedAt);
  if (!start) return '—';
  const end = finishedAt ? parseTime(finishedAt) || nowMs : nowMs;
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${String(rem).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${String(min % 60).padStart(2, '0')}m`;
}

/** Compact status label for run status bar. */
export function formatRunStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Idle';
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'restoring_session':
      return 'Restoring session';
    case 'running':
      return 'Running';
    case 'waiting_approval':
      return 'Waiting approval';
    case 'waiting_input':
      return 'Waiting input';
    case 'cancel_requested':
      return 'Cancelling…';
    case 'cancelled':
      return 'Cancelled';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    case 'budget_exceeded':
      return 'Budget exceeded';
    case 'orphaned':
      return 'Orphaned';
    default:
      return status;
  }
}

export function runStatusTone(
  status: string | null | undefined,
): 'idle' | 'active' | 'warning' | 'danger' | 'success' {
  if (!status) return 'idle';
  if (status === 'running' || status === 'queued' || status === 'restoring_session') {
    return 'active';
  }
  if (
    status === 'waiting_approval' ||
    status === 'waiting_input' ||
    status === 'cancel_requested' ||
    status === 'interrupted' ||
    status === 'budget_exceeded'
  ) {
    return 'warning';
  }
  if (status === 'failed' || status === 'cancelled' || status === 'orphaned') {
    return 'danger';
  }
  if (status === 'succeeded') return 'success';
  return 'idle';
}

/** Summarize tool input for card subtitle (file path, command, etc.). */
export function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') {
    return input.length > 80 ? `${input.slice(0, 77)}…` : input;
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    for (const key of ['path', 'file', 'file_path', 'command', 'cmd', 'query', 'url']) {
      if (typeof o[key] === 'string' && o[key]) {
        const v = o[key] as string;
        return v.length > 80 ? `${v.slice(0, 77)}…` : v;
      }
    }
    try {
      const s = JSON.stringify(input);
      return s.length > 80 ? `${s.slice(0, 77)}…` : s;
    } catch {
      return '';
    }
  }
  try {
    const s = String(input);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return '';
  }
}

/** Pretty-print unknown payload for expanded card body. */
export function formatPayload(value: unknown, maxLen = 4000): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return String(value);
  }
}

/**
 * Build ordered runtime timeline items for a run from the entity store.
 * Session events are included but consumers collapse them by default.
 */
export function buildRunTimeline(
  store: EntityStore,
  runId: string | null | undefined,
): TimelineItem[] {
  if (!runId) return [];
  const run = store.runsById[runId];
  if (!run) return [];

  const items: TimelineItem[] = [];

  for (const tool of getRunToolExecutions(store, runId)) {
    items.push({
      kind: 'tool',
      id: `tool:${tool.id}`,
      sortAt: parseTime(tool.createdAt) || parseTime(tool.updatedAt),
      tool,
    });
  }

  for (const proc of getRunProcesses(store, runId)) {
    items.push({
      kind: 'process',
      id: `process:${proc.id}`,
      sortAt: parseTime(proc.startedAt) || parseTime(proc.createdAt),
      process: proc,
    });
  }

  for (const approval of getRunApprovals(store, runId)) {
    items.push({
      kind: 'approval',
      id: `approval:${approval.id}`,
      sortAt: parseTime(approval.createdAt),
      approval,
    });
  }

  for (const artifact of getRunArtifacts(store, runId)) {
    items.push({
      kind: 'artifact',
      id: `artifact:${artifact.id}`,
      sortAt: parseTime(artifact.createdAt),
      artifact,
    });
  }

  // Session-level events derived from run lifecycle (collapsed by default in UI)
  if (run.startedAt) {
    items.push({
      kind: 'session',
      id: `session:started:${run.id}`,
      sortAt: parseTime(run.startedAt) - 1,
      label: 'Run started',
      detail: run.id,
    });
  }
  if (run.finishedAt && isTerminalRunStatus(run.status)) {
    items.push({
      kind: 'session',
      id: `session:finished:${run.id}`,
      sortAt: parseTime(run.finishedAt) + 1,
      label: `Run ${formatRunStatusLabel(run.status).toLowerCase()}`,
      detail: run.error || run.id,
    });
  }

  items.sort((a, b) => {
    if (a.sortAt !== b.sortAt) return a.sortAt - b.sortAt;
    return a.id.localeCompare(b.id);
  });

  return items;
}

/** Pending approvals across all runs (persist across conversation navigation). */
export function listPendingApprovals(store: EntityStore): ApprovalEntity[] {
  return Object.values(store.approvalsById).filter((a) => a.status === 'pending');
}

/** Pending approvals for a specific conversation (via its runs). */
export function listPendingApprovalsForConversation(
  store: EntityStore,
  conversationId: string | null | undefined,
): ApprovalEntity[] {
  if (!conversationId) return listPendingApprovals(store);
  return listPendingApprovals(store).filter((a) => {
    const run = store.runsById[a.runId];
    return run?.conversationId === conversationId;
  });
}

/** Map conversation id → latest non-terminal run status (for nav markers). */
export function conversationRunMarkers(
  store: EntityStore,
): Record<
  string,
  {
    runStatus: string | null;
    hasPendingApproval: boolean;
    activeRunId: string | null;
  }
> {
  const out: Record<
    string,
    {
      runStatus: string | null;
      hasPendingApproval: boolean;
      activeRunId: string | null;
    }
  > = {};

  const active = listActiveRuns(store);
  for (const run of active) {
    const cid = run.conversationId;
    if (!cid) continue;
    const prev = out[cid];
    // Prefer waiting_approval / running over other active statuses
    if (
      !prev ||
      run.status === 'waiting_approval' ||
      (run.status === 'running' && prev.runStatus !== 'waiting_approval')
    ) {
      out[cid] = {
        runStatus: run.status,
        hasPendingApproval:
          prev?.hasPendingApproval ||
          getRunApprovals(store, run.id).some((a) => a.status === 'pending'),
        activeRunId: run.id,
      };
    } else if (prev) {
      out[cid] = {
        ...prev,
        hasPendingApproval:
          prev.hasPendingApproval ||
          getRunApprovals(store, run.id).some((a) => a.status === 'pending'),
      };
    }
  }

  // Also flag conversations that only have pending approvals on terminal-ish runs
  for (const a of listPendingApprovals(store)) {
    const run = store.runsById[a.runId];
    const cid = run?.conversationId;
    if (!cid) continue;
    if (!out[cid]) {
      out[cid] = {
        runStatus: run?.status || null,
        hasPendingApproval: true,
        activeRunId: run?.id || null,
      };
    } else {
      out[cid] = { ...out[cid], hasPendingApproval: true };
    }
  }

  return out;
}

/** Inspector selection target when a timeline card is clicked. */
export function selectionToInspectorTab(
  kind: TimelineKind | null,
): InspectorTabId {
  switch (kind) {
    case 'tool':
      return 'tools';
    case 'process':
      return 'processes';
    case 'artifact':
      return 'artifacts';
    case 'approval':
      return 'overview';
    case 'session':
      return 'session';
    default:
      return 'overview';
  }
}

export type SelectedEntity =
  | { kind: 'tool'; id: string }
  | { kind: 'process'; id: string }
  | { kind: 'approval'; id: string }
  | { kind: 'artifact'; id: string }
  | { kind: 'session'; id: string }
  | null;

export function getActiveRunEntity(
  store: EntityStore,
  activeRunId: string | null | undefined,
): RunEntity | null {
  if (!activeRunId) return null;
  return store.runsById[activeRunId] || null;
}

export function countRunTools(store: EntityStore, runId: string): number {
  return getRunToolExecutions(store, runId).length;
}
