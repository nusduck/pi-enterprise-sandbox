import { useMemo } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  getRunApprovals,
  getRunArtifacts,
  getRunProcesses,
  getRunToolExecutions,
  getRunTraceSpans,
  listDatasetsForConversation,
} from '../../entities';
import {
  formatDuration,
  formatRunStatusLabel,
  getActiveRunEntity,
  summarizeToolInput,
  type InspectorTabId,
  type SelectedEntity,
} from '../runtime-timeline/buildTimeline';
import { ArtifactPanel } from '../artifact-panel/ArtifactPanel';
import { DatasetPanel } from '../dataset-panel/DatasetPanel';
import { TracePanel } from '../trace-panel/TracePanel';
import { ToolCallPanel } from '../tool-call-panel/ToolCallPanel';
import { ProcessPanel } from '../process-panel/ProcessPanel';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';

const TABS: { id: InspectorTabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'processes', label: 'Processes' },
  { id: 'tools', label: 'Tools' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'datasets', label: 'Datasets' },
  { id: 'trace', label: 'Trace' },
  { id: 'session', label: 'Session' },
];

export function ContextInspector({
  open,
  onClose,
  tab,
  onTabChange,
  selected,
}: {
  open: boolean;
  onClose: () => void;
  tab: InspectorTabId;
  onTabChange: (t: InspectorTabId) => void;
  selected: SelectedEntity;
}) {
  const { entityStore, activeRunId, activeSessionId, activeTraceId, state } = useChat();
  const { openProcessConsole } = useWorkbenchSelection();
  const runId = activeRunId;
  const run = getActiveRunEntity(entityStore, runId);

  const tools = useMemo(
    () => (runId ? getRunToolExecutions(entityStore, runId) : []),
    [entityStore, runId],
  );
  const processes = useMemo(
    () => (runId ? getRunProcesses(entityStore, runId) : []),
    [entityStore, runId],
  );
  const approvals = useMemo(
    () => (runId ? getRunApprovals(entityStore, runId) : []),
    [entityStore, runId],
  );
  const artifacts = useMemo(
    () => (runId ? getRunArtifacts(entityStore, runId) : []),
    [entityStore, runId],
  );
  const datasets = useMemo(
    () => listDatasetsForConversation(entityStore, state.conversationId),
    [entityStore, state.conversationId],
  );
  const traceSpans = useMemo(
    () => (runId ? getRunTraceSpans(entityStore, runId) : []),
    [entityStore, runId],
  );

  // Merge server-listed deliverables when entity artifacts empty
  const listedArtifacts = state.artifacts || [];

  const agentSession =
    (run?.agentSessionId &&
      entityStore.agentSessionsById[run.agentSessionId]) ||
    (state.conversationId &&
      Object.values(entityStore.agentSessionsById).find(
        (s) => s.conversationId === state.conversationId,
      )) ||
    null;

  const panelClass = [
    'context-inspector',
    open ? 'open' : 'closed',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <aside
        id="context-inspector"
        className={panelClass}
        aria-label="Context inspector"
        aria-hidden={!open}
      >
        <div className="inspector-head">
          <h2 className="inspector-title">Inspector</h2>
          <button
            type="button"
            className="btn-icon inspector-close"
            title="Close inspector"
            aria-label="Close inspector"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="inspector-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`inspector-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="inspector-body" role="tabpanel">
          {tab === 'overview' ? (
            <OverviewPanel
              run={run}
              agentSession={agentSession}
              toolsCount={tools.length}
              processesCount={processes.length}
              approvals={approvals}
              sessionId={activeSessionId}
              conversationId={state.conversationId}
              traceId={activeTraceId}
            />
          ) : null}

          {tab === 'files' ? (
            <FilesPanel
              artifacts={artifacts}
              listedArtifacts={listedArtifacts}
              sessionId={activeSessionId}
              tools={tools}
            />
          ) : null}

          {tab === 'processes' ? (
            <ProcessPanel
              processes={processes}
              selectedId={selected?.kind === 'process' ? selected.id : null}
              onOpenConsole={openProcessConsole}
            />
          ) : null}

          {tab === 'tools' ? (
            <ToolCallPanel
              tools={tools}
              selectedId={selected?.kind === 'tool' ? selected.id : null}
            />
          ) : null}

          {tab === 'artifacts' ? (
            <ArtifactPanel
              artifacts={artifacts}
              sessionId={activeSessionId}
              selectedId={selected?.kind === 'artifact' ? selected.id : null}
              submitOnly
            />
          ) : null}

          {tab === 'datasets' ? (
            <DatasetPanel datasets={datasets} />
          ) : null}

          {tab === 'trace' ? (
            <TracePanel spans={traceSpans} traceId={activeTraceId} />
          ) : null}

          {tab === 'session' ? (
            <SessionPanel
              run={run}
              agentSession={agentSession}
              sessionId={activeSessionId}
              conversationId={state.conversationId}
              traceId={activeTraceId}
            />
          ) : null}
        </div>
      </aside>
      <div
        className="inspector-backdrop"
        hidden={!open}
        onClick={onClose}
        aria-hidden="true"
      />
    </>
  );
}

function OverviewPanel({
  run,
  agentSession,
  toolsCount,
  processesCount,
  approvals,
  sessionId,
  conversationId,
  traceId,
}: {
  run: ReturnType<typeof getActiveRunEntity>;
  agentSession: { id: string; status: string; modelId: string | null; workspaceId: string | null } | null;
  toolsCount: number;
  processesCount: number;
  approvals: { id: string; status: string; reason: string }[];
  sessionId: string | null;
  conversationId: string | null;
  traceId: string | null;
}) {
  const pending = approvals.filter((a) => a.status === 'pending');
  return (
    <div className="inspector-section">
      <dl className="inspector-dl">
        <dt>Run status</dt>
        <dd>{run ? formatRunStatusLabel(run.status) : 'Idle'}</dd>
        <dt>Run ID</dt>
        <dd className="mono">{run?.id || '—'}</dd>
        <dt>Agent session</dt>
        <dd className="mono">
          {agentSession
            ? `${agentSession.id.slice(0, 12)}… (${agentSession.status})`
            : '—'}
        </dd>
        <dt>Model</dt>
        <dd>{agentSession?.modelId || '—'}</dd>
        <dt>Workspace</dt>
        <dd className="mono">{agentSession?.workspaceId || sessionId || '—'}</dd>
        <dt>Conversation</dt>
        <dd className="mono">{conversationId || '—'}</dd>
        <dt>Started</dt>
        <dd>{run?.startedAt || run?.createdAt || '—'}</dd>
        <dt>Duration</dt>
        <dd>
          {run
            ? formatDuration(run.startedAt || run.createdAt, run.finishedAt)
            : '—'}
        </dd>
        <dt>Tool calls</dt>
        <dd>{toolsCount}</dd>
        <dt>Processes</dt>
        <dd>{processesCount}</dd>
        <dt>Pending approvals</dt>
        <dd>{pending.length}</dd>
        <dt>Context usage</dt>
        <dd>
          {run?.contextUsage
            ? `${run.contextUsage.tokens ?? '—'} / ${run.contextUsage.contextWindow ?? '—'} (${run.contextUsage.percent ?? '—'}${typeof run.contextUsage.percent === 'number' && run.contextUsage.percent <= 1 ? '' : '%'})${run.contextUsage.warning ? ' ⚠' : ''}`
            : '—'}
        </dd>
        <dt>Compaction</dt>
        <dd className={run?.compactionStatus === 'failed' ? 'danger' : undefined}>
          {run?.compactionStatus || 'idle'}{run?.compactionError ? `: ${run.compactionError}` : ''}
        </dd>
        <dt>Task plan</dt>
        <dd>
          {run?.taskPlan.length
            ? run.taskPlan.map((task) => `${task.taskId}: ${task.status}`).join(', ')
            : '—'}
        </dd>
        <dt>Trace ID</dt>
        <dd className="mono">{traceId || '—'}</dd>
        {run?.error ? (
          <>
            <dt>Error</dt>
            <dd className="danger">{run.error}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function FilesPanel({
  artifacts,
  listedArtifacts,
  sessionId,
  tools,
}: {
  artifacts: { id: string; name: string; path: string | null; size: number | null }[];
  listedArtifacts: { artifact_id?: string; id?: string; name?: string; path?: string; size?: number }[];
  sessionId: string | null;
  tools: { id: string; name: string; input: unknown }[];
}) {
  // Paths referenced by tools (read/edit etc.) — lightweight file references
  const toolPaths = tools
    .map((t) => {
      const s = summarizeToolInput(t.input);
      return s && (s.includes('/') || s.includes('.')) ? s : null;
    })
    .filter((p): p is string => Boolean(p));

  const uniquePaths = [...new Set(toolPaths)];

  if (!artifacts.length && !listedArtifacts.length && !uniquePaths.length) {
    return <p className="inspector-empty">No files for this run yet.</p>;
  }

  return (
    <div className="inspector-section">
      {uniquePaths.length > 0 ? (
        <>
          <h3 className="inspector-subhead">Referenced paths</h3>
          <ul className="inspector-list">
            {uniquePaths.map((p) => (
              <li key={p} className="mono">
                {p}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {artifacts.length > 0 || listedArtifacts.length > 0 ? (
        <>
          <h3 className="inspector-subhead">Artifacts</h3>
          <ul className="inspector-list">
            {artifacts.map((a) => (
              <li key={a.id}>
                {a.name}
                {a.path ? (
                  <span className="muted mono"> · {a.path}</span>
                ) : null}
              </li>
            ))}
            {listedArtifacts.map((a) => {
              const id = a.artifact_id || a.id || a.path || a.name;
              return (
                <li key={String(id)}>
                  {a.name || a.path || id}
                  {sessionId ? (
                    <span className="muted"> · session</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <p className="inspector-hint">
        Full workspace tree / diff viewer ships with later phases.
      </p>
    </div>
  );
}

function SessionPanel({
  run,
  agentSession,
  sessionId,
  conversationId,
  traceId,
}: {
  run: ReturnType<typeof getActiveRunEntity>;
  agentSession: {
    id: string;
    status: string;
    modelId: string | null;
    workspaceId: string | null;
    sandboxSessionId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  } | null;
  sessionId: string | null;
  conversationId: string | null;
  traceId: string | null;
}) {
  return (
    <div className="inspector-section">
      <dl className="inspector-dl">
        <dt>SDK / Agent session</dt>
        <dd className="mono">{agentSession?.id || '—'}</dd>
        <dt>Sandbox session</dt>
        <dd className="mono">
          {agentSession?.sandboxSessionId || sessionId || '—'}
        </dd>
        <dt>Workspace</dt>
        <dd className="mono">{agentSession?.workspaceId || '—'}</dd>
        <dt>Conversation</dt>
        <dd className="mono">{conversationId || '—'}</dd>
        <dt>Session status</dt>
        <dd>{agentSession?.status || '—'}</dd>
        <dt>Created</dt>
        <dd>{agentSession?.createdAt || '—'}</dd>
        <dt>Updated</dt>
        <dd>{agentSession?.updatedAt || '—'}</dd>
        <dt>Active run</dt>
        <dd className="mono">{run?.id || '—'}</dd>
        <dt>Trace</dt>
        <dd className="mono">{traceId || '—'}</dd>
      </dl>
      <details className="inspector-details">
        <summary>Session entry timeline (technical)</summary>
        <p className="inspector-hint">
          Compaction, model history, and branch details appear here when the
          session API exposes them.
        </p>
      </details>
    </div>
  );
}
