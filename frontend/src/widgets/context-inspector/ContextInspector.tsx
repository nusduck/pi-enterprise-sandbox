import { useMemo, type ReactNode } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  getRunApprovals,
  getRunArtifacts,
  getRunProcesses,
  getRunToolExecutions,
  getRunTraceSpans,
  listDatasetsForConversation,
  type ArtifactEntity,
} from '../../entities';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import {
  formatDuration,
  formatRunStatusLabel,
  getActiveRunEntity,
  runStatusTone,
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

type TabDef = {
  id: InspectorTabId;
  label: string;
  count?: number;
};

function shortId(id: string | null | undefined, keep = 10): string {
  if (!id) return '—';
  if (id.length <= keep + 1) return id;
  return `${id.slice(0, keep)}…`;
}

function MetaRow({
  label,
  value,
  mono,
  danger,
  copyable,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  danger?: boolean;
  copyable?: string | null;
}) {
  return (
    <div className="insp-meta-row">
      <span className="insp-meta-label">{label}</span>
      <span
        className={`insp-meta-value${mono ? ' mono' : ''}${danger ? ' danger' : ''}`}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
        {copyable ? (
          <button
            type="button"
            className="insp-copy"
            title="Copy"
            aria-label={`Copy ${label}`}
            onClick={() => {
              void navigator.clipboard?.writeText(copyable);
            }}
          >
            copy
          </button>
        ) : null}
      </span>
    </div>
  );
}

function StatPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'active' | 'warn' | 'danger' | 'success';
}) {
  return (
    <div className={`insp-stat tone-${tone || 'default'}`}>
      <span className="insp-stat-value">{value}</span>
      <span className="insp-stat-label">{label}</span>
    </div>
  );
}

function EmptyState({
  title,
  body,
}: {
  title: string;
  body?: string;
}) {
  return (
    <div className="insp-empty">
      <p className="insp-empty-title">{title}</p>
      {body ? <p className="insp-empty-body">{body}</p> : null}
    </div>
  );
}

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
  const {
    entityStore,
    activeRunId,
    activeSessionId,
    activeTraceId,
    state,
    importArtifactToConversation,
  } = useChat();
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

  const listedArtifacts = state.artifacts || [];

  const importableArtifacts = useMemo((): ArtifactEntity[] => {
    const convId = state.conversationId;
    const runIds = new Set<string>();
    if (runId) runIds.add(runId);
    if (convId) {
      for (const r of Object.values(entityStore.runsById)) {
        if (r.conversationId === convId) runIds.add(r.id);
      }
    }

    const seen = new Set<string>();
    const out: ArtifactEntity[] = [];

    for (const art of Object.values(entityStore.artifactsById)) {
      if (art.source !== 'submit_artifact') continue;
      if (!isDurableArtifactId(art.id, art.runId || '')) continue;
      if (art.runId && runIds.size > 0 && !runIds.has(art.runId)) continue;
      if (seen.has(art.id)) continue;
      seen.add(art.id);
      out.push(art);
    }

    for (const art of artifacts) {
      if (art.source !== 'submit_artifact') continue;
      if (!isDurableArtifactId(art.id, art.runId || '')) continue;
      if (seen.has(art.id)) continue;
      seen.add(art.id);
      out.push(art);
    }

    for (const listed of listedArtifacts) {
      const id = String(listed.artifact_id || listed.id || '').trim();
      if (!id || seen.has(id)) continue;
      if (!isDurableArtifactId(id, runId || '')) continue;
      seen.add(id);
      out.push({
        id,
        runId: runId,
        sessionId: activeSessionId,
        name: String(listed.name || listed.path || id),
        path: listed.path != null ? String(listed.path) : null,
        mimeType:
          listed.mime_type != null
            ? String(listed.mime_type)
            : listed.mimeType != null
              ? String(listed.mimeType)
              : null,
        size:
          typeof listed.size === 'number' && Number.isFinite(listed.size)
            ? listed.size
            : null,
        sha256:
          listed.sha256 != null
            ? String(listed.sha256)
            : listed.sha_256 != null
              ? String(listed.sha_256)
              : null,
        description: null,
        source: 'submit_artifact',
        createdAt:
          listed.created_at != null
            ? String(listed.created_at)
            : listed.createdAt != null
              ? String(listed.createdAt)
              : null,
      });
    }

    return out;
  }, [
    entityStore,
    runId,
    state.conversationId,
    artifacts,
    listedArtifacts,
    activeSessionId,
  ]);

  const agentSession =
    (run?.agentSessionId &&
      entityStore.agentSessionsById[run.agentSessionId]) ||
    (state.conversationId &&
      Object.values(entityStore.agentSessionsById).find(
        (s) => s.conversationId === state.conversationId,
      )) ||
    null;

  const pendingCount = approvals.filter((a) => a.status === 'pending').length;

  const tabs: TabDef[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'tools', label: 'Tools', count: tools.length || undefined },
    { id: 'processes', label: 'Processes', count: processes.length || undefined },
    { id: 'files', label: 'Files' },
    {
      id: 'artifacts',
      label: 'Artifacts',
      count: importableArtifacts.length || undefined,
    },
    { id: 'datasets', label: 'Datasets', count: datasets.length || undefined },
    { id: 'trace', label: 'Trace', count: traceSpans.length || undefined },
    { id: 'session', label: 'Session' },
  ];

  const panelClass = [
    'context-inspector',
    open ? 'open' : 'closed',
  ]
    .filter(Boolean)
    .join(' ');

  const tone = run ? runStatusTone(run.status) : 'idle';
  const statusLabel = run ? formatRunStatusLabel(run.status) : 'Idle';

  return (
    <>
      <aside
        id="context-inspector"
        className={panelClass}
        aria-label="Details"
        aria-hidden={!open}
      >
        <div className="inspector-head">
          <div className="inspector-head-text">
            <h2 className="inspector-title">Details</h2>
            <p className="inspector-subtitle">
              {run
                ? `Run · ${statusLabel}`
                : state.conversationId
                  ? 'Conversation context'
                  : 'No active run'}
            </p>
          </div>
          <button
            type="button"
            className="btn-icon inspector-close-desktop"
            title="Close details"
            aria-label="Close details"
            onClick={onClose}
          >
            ✕
          </button>
          <button
            type="button"
            className="btn-icon inspector-close"
            title="Close details"
            aria-label="Close details"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {run || tools.length || processes.length ? (
          <div className={`inspector-status-bar tone-${tone}`}>
            <span className="inspector-status-dot" aria-hidden="true" />
            <span className="inspector-status-label">{statusLabel}</span>
            {run ? (
              <span className="inspector-status-meta mono">
                {formatDuration(run.startedAt || run.createdAt, run.finishedAt)}
              </span>
            ) : null}
            {pendingCount > 0 ? (
              <span className="inspector-status-chip warn">
                {pendingCount} approval{pendingCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="inspector-tabs" role="tablist" aria-label="Detail sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`inspector-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              <span>{t.label}</span>
              {t.count != null && t.count > 0 ? (
                <span className="inspector-tab-count">{t.count}</span>
              ) : null}
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
              artifactsCount={artifacts.length}
              pendingApprovals={pendingCount}
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
              artifacts={importableArtifacts}
              sessionId={activeSessionId}
              selectedId={selected?.kind === 'artifact' ? selected.id : null}
              submitOnly
              conversations={state.conversations}
              currentConversationId={state.conversationId}
              onImport={importArtifactToConversation}
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
  artifactsCount,
  pendingApprovals,
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
  } | null;
  toolsCount: number;
  processesCount: number;
  artifactsCount: number;
  pendingApprovals: number;
  sessionId: string | null;
  conversationId: string | null;
  traceId: string | null;
}) {
  if (!run && !agentSession && !conversationId) {
    return (
      <EmptyState
        title="Nothing selected"
        body="Start a chat or open a run to inspect runtime context."
      />
    );
  }

  const ctx = run?.contextUsage;
  const ctxLabel = ctx
    ? `${ctx.tokens ?? '—'} / ${ctx.contextWindow ?? '—'}${
        ctx.percent != null
          ? ` · ${typeof ctx.percent === 'number' && ctx.percent <= 1 ? Math.round(ctx.percent * 100) : ctx.percent}%`
          : ''
      }`
    : '—';

  return (
    <div className="insp-stack">
      <section className="insp-card">
        <div className="insp-card-head">
          <h3 className="insp-card-title">Snapshot</h3>
        </div>
        <div className="insp-stat-grid">
          <StatPill
            label="Tools"
            value={toolsCount}
            tone={toolsCount ? 'active' : 'default'}
          />
          <StatPill
            label="Processes"
            value={processesCount}
            tone={processesCount ? 'active' : 'default'}
          />
          <StatPill
            label="Artifacts"
            value={artifactsCount}
            tone={artifactsCount ? 'success' : 'default'}
          />
          <StatPill
            label="Approvals"
            value={pendingApprovals}
            tone={pendingApprovals ? 'warn' : 'default'}
          />
        </div>
      </section>

      <section className="insp-card">
        <div className="insp-card-head">
          <h3 className="insp-card-title">Run</h3>
        </div>
        <div className="insp-meta-list">
          <MetaRow
            label="Status"
            value={run ? formatRunStatusLabel(run.status) : 'Idle'}
          />
          <MetaRow
            label="Run ID"
            value={shortId(run?.id, 14)}
            mono
            copyable={run?.id || null}
          />
          <MetaRow
            label="Started"
            value={run?.startedAt || run?.createdAt || '—'}
            mono
          />
          <MetaRow
            label="Duration"
            value={
              run
                ? formatDuration(run.startedAt || run.createdAt, run.finishedAt)
                : '—'
            }
            mono
          />
          <MetaRow label="Context" value={ctxLabel} mono />
          <MetaRow
            label="Compaction"
            value={
              run?.compactionStatus
                ? `${run.compactionStatus}${run.compactionError ? `: ${run.compactionError}` : ''}`
                : 'idle'
            }
            danger={run?.compactionStatus === 'failed'}
          />
          {run?.error ? (
            <MetaRow label="Error" value={run.error} danger />
          ) : null}
        </div>
      </section>

      <section className="insp-card">
        <div className="insp-card-head">
          <h3 className="insp-card-title">Identity</h3>
        </div>
        <div className="insp-meta-list">
          <MetaRow
            label="Model"
            value={agentSession?.modelId || '—'}
          />
          <MetaRow
            label="Agent session"
            value={
              agentSession
                ? `${shortId(agentSession.id, 12)} · ${agentSession.status}`
                : '—'
            }
            mono
            copyable={agentSession?.id || null}
          />
          <MetaRow
            label="Workspace"
            value={shortId(agentSession?.workspaceId || sessionId, 14)}
            mono
            copyable={agentSession?.workspaceId || sessionId}
          />
          <MetaRow
            label="Conversation"
            value={shortId(conversationId, 14)}
            mono
            copyable={conversationId}
          />
          <MetaRow
            label="Trace"
            value={shortId(traceId, 14)}
            mono
            copyable={traceId}
          />
        </div>
      </section>

      {run?.taskPlan?.length ? (
        <section className="insp-card">
          <div className="insp-card-head">
            <h3 className="insp-card-title">Task plan</h3>
            <span className="insp-card-count">{run.taskPlan.length}</span>
          </div>
          <ul className="insp-task-list">
            {run.taskPlan.map((task) => (
              <li key={task.taskId} className="insp-task-item">
                <span className={`insp-task-status status-${task.status}`}>
                  {task.status}
                </span>
                <span className="insp-task-id mono">{task.taskId}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
  listedArtifacts: {
    artifact_id?: string;
    id?: string;
    name?: string;
    path?: string;
    size?: number;
  }[];
  sessionId: string | null;
  tools: { id: string; name: string; input: unknown }[];
}) {
  const toolPaths = tools
    .map((t) => {
      const s = summarizeToolInput(t.input);
      return s && (s.includes('/') || s.includes('.')) ? s : null;
    })
    .filter((p): p is string => Boolean(p));

  const uniquePaths = [...new Set(toolPaths)];

  if (!artifacts.length && !listedArtifacts.length && !uniquePaths.length) {
    return (
      <EmptyState
        title="No files yet"
        body="Paths and artifacts from this run will appear here."
      />
    );
  }

  return (
    <div className="insp-stack">
      {uniquePaths.length > 0 ? (
        <section className="insp-card">
          <div className="insp-card-head">
            <h3 className="insp-card-title">Referenced paths</h3>
            <span className="insp-card-count">{uniquePaths.length}</span>
          </div>
          <ul className="insp-chip-list">
            {uniquePaths.map((p) => (
              <li key={p} className="insp-path-chip mono" title={p}>
                {p}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {artifacts.length > 0 || listedArtifacts.length > 0 ? (
        <section className="insp-card">
          <div className="insp-card-head">
            <h3 className="insp-card-title">Artifacts</h3>
          </div>
          <ul className="insp-file-list">
            {artifacts.map((a) => (
              <li key={a.id} className="insp-file-row">
                <span className="insp-file-name">{a.name}</span>
                {a.path ? (
                  <span className="insp-file-path mono">{a.path}</span>
                ) : null}
              </li>
            ))}
            {listedArtifacts.map((a) => {
              const id = a.artifact_id || a.id || a.path || a.name;
              return (
                <li key={String(id)} className="insp-file-row">
                  <span className="insp-file-name">
                    {a.name || a.path || id}
                  </span>
                  {sessionId ? (
                    <span className="insp-file-path">session-linked</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
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
  if (!run && !agentSession && !sessionId && !conversationId) {
    return (
      <EmptyState
        title="No session"
        body="Session identity appears after the first run starts."
      />
    );
  }

  return (
    <div className="insp-stack">
      <section className="insp-card">
        <div className="insp-card-head">
          <h3 className="insp-card-title">Agent session</h3>
          {agentSession?.status ? (
            <span className="insp-pill">{agentSession.status}</span>
          ) : null}
        </div>
        <div className="insp-meta-list">
          <MetaRow
            label="Session ID"
            value={shortId(agentSession?.id, 16)}
            mono
            copyable={agentSession?.id || null}
          />
          <MetaRow label="Model" value={agentSession?.modelId || '—'} />
          <MetaRow
            label="Created"
            value={agentSession?.createdAt || '—'}
            mono
          />
          <MetaRow
            label="Updated"
            value={agentSession?.updatedAt || '—'}
            mono
          />
        </div>
      </section>

      <section className="insp-card">
        <div className="insp-card-head">
          <h3 className="insp-card-title">Sandbox</h3>
        </div>
        <div className="insp-meta-list">
          <MetaRow
            label="Sandbox session"
            value={shortId(
              agentSession?.sandboxSessionId || sessionId,
              16,
            )}
            mono
            copyable={agentSession?.sandboxSessionId || sessionId}
          />
          <MetaRow
            label="Workspace"
            value={shortId(agentSession?.workspaceId, 16)}
            mono
            copyable={agentSession?.workspaceId}
          />
          <MetaRow
            label="Conversation"
            value={shortId(conversationId, 16)}
            mono
            copyable={conversationId}
          />
          <MetaRow
            label="Active run"
            value={shortId(run?.id, 16)}
            mono
            copyable={run?.id || null}
          />
          <MetaRow
            label="Trace"
            value={shortId(traceId, 16)}
            mono
            copyable={traceId}
          />
        </div>
      </section>
    </div>
  );
}
