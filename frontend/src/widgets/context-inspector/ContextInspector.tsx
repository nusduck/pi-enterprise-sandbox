import { useMemo } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  getRunApprovals,
  getRunArtifacts,
  getRunProcesses,
  getRunToolExecutions,
} from '../../entities';
import {
  formatDuration,
  formatPayload,
  formatRunStatusLabel,
  getActiveRunEntity,
  summarizeToolInput,
  type InspectorTabId,
  type SelectedEntity,
} from '../runtime-timeline/buildTimeline';
import { safeApiUrl } from '../../shared/security/url';
import {
  getArtifactDownloadUrl,
  getDownloadUrl,
} from '../../shared/api';

const TABS: { id: InspectorTabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'processes', label: 'Processes' },
  { id: 'tools', label: 'Tools' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'session', label: 'Session' },
];

function formatSize(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
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
  const { entityStore, activeRunId, activeSessionId, activeTraceId, state } = useChat();
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

  // Merge legacy deliverables when entity artifacts empty
  const legacyArtifacts = state.artifacts || [];

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
              legacyArtifacts={legacyArtifacts}
              sessionId={activeSessionId}
              tools={tools}
            />
          ) : null}

          {tab === 'processes' ? (
            <ProcessesPanel
              processes={processes}
              selectedId={selected?.kind === 'process' ? selected.id : null}
            />
          ) : null}

          {tab === 'tools' ? (
            <ToolsPanel
              tools={tools}
              selectedId={selected?.kind === 'tool' ? selected.id : null}
            />
          ) : null}

          {tab === 'artifacts' ? (
            <ArtifactsPanel
              artifacts={artifacts}
              legacyArtifacts={legacyArtifacts}
              sessionId={activeSessionId}
              selectedId={selected?.kind === 'artifact' ? selected.id : null}
            />
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
  legacyArtifacts,
  sessionId,
  tools,
}: {
  artifacts: { id: string; name: string; path: string | null; size: number | null }[];
  legacyArtifacts: { artifact_id?: string; id?: string; name?: string; path?: string; size?: number }[];
  sessionId: string | null;
  tools: { id: string; name: string; input: unknown }[];
}) {
  // Paths referenced by tools (read/edit etc.) — lightweight file browser stub
  const toolPaths = tools
    .map((t) => {
      const s = summarizeToolInput(t.input);
      return s && (s.includes('/') || s.includes('.')) ? s : null;
    })
    .filter((p): p is string => Boolean(p));

  const uniquePaths = [...new Set(toolPaths)];

  if (!artifacts.length && !legacyArtifacts.length && !uniquePaths.length) {
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
      {artifacts.length > 0 || legacyArtifacts.length > 0 ? (
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
            {legacyArtifacts.map((a) => {
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

function ProcessesPanel({
  processes,
  selectedId,
}: {
  processes: {
    id: string;
    status: string;
    command: string | null;
    exitCode: number | null;
    startedAt: string | null;
    finishedAt: string | null;
  }[];
  selectedId: string | null;
}) {
  if (!processes.length) {
    return (
      <p className="inspector-empty">
        No managed processes. Console live logs land in F4.
      </p>
    );
  }
  return (
    <ul className="inspector-list cards">
      {processes.map((p) => (
        <li
          key={p.id}
          className={`inspector-row${selectedId === p.id ? ' selected' : ''}`}
        >
          <div className="row-title mono">{p.command || p.id}</div>
          <div className="row-meta">
            {p.status}
            {p.exitCode != null ? ` · exit ${p.exitCode}` : ''}
            {' · '}
            {formatDuration(p.startedAt, p.finishedAt)}
          </div>
          <button type="button" className="rtc-link-btn" disabled title="F4">
            Open Console (soon)
          </button>
        </li>
      ))}
    </ul>
  );
}

function ToolsPanel({
  tools,
  selectedId,
}: {
  tools: {
    id: string;
    name: string;
    status: string;
    input: unknown;
    result: unknown;
    isError: boolean;
    summary: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }[];
  selectedId: string | null;
}) {
  if (!tools.length) {
    return <p className="inspector-empty">No tool executions for this run.</p>;
  }
  return (
    <ul className="inspector-list cards">
      {tools.map((t, idx) => (
        <li
          key={t.id}
          className={`inspector-row${selectedId === t.id ? ' selected' : ''}${t.isError ? ' error' : ''}`}
          data-tool-id={t.id}
        >
          <div className="row-title">
            <span className="step">#{idx + 1}</span> {t.name}
          </div>
          <div className="row-meta">
            {t.status} · {formatDuration(t.createdAt, t.updatedAt)}
          </div>
          {summarizeToolInput(t.input) ? (
            <div className="row-sub mono">{summarizeToolInput(t.input)}</div>
          ) : null}
          {selectedId === t.id && t.result != null ? (
            <pre className="row-pre">{formatPayload(t.result, 1200)}</pre>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ArtifactsPanel({
  artifacts,
  legacyArtifacts,
  sessionId,
  selectedId,
}: {
  artifacts: {
    id: string;
    name: string;
    path: string | null;
    size: number | null;
    runId: string | null;
    mimeType: string | null;
  }[];
  legacyArtifacts: {
    artifact_id?: string;
    id?: string;
    name?: string;
    path?: string;
    size?: number;
  }[];
  sessionId: string | null;
  selectedId: string | null;
}) {
  if (!artifacts.length && !legacyArtifacts.length) {
    return <p className="inspector-empty">No artifacts yet.</p>;
  }

  return (
    <ul className="inspector-list cards">
      {artifacts.map((a) => {
        let url: string | null = null;
        if (sessionId) {
          url = getArtifactDownloadUrl(sessionId, a.id);
        }
        const safe = safeApiUrl(url);
        return (
          <li
            key={a.id}
            className={`inspector-row${selectedId === a.id ? ' selected' : ''}`}
          >
            <div className="row-title">{a.name}</div>
            <div className="row-meta">
              {a.runId ? `run ${a.runId}` : 'artifact'}
              {formatSize(a.size) ? ` · ${formatSize(a.size)}` : ''}
            </div>
            {safe ? (
              <a className="rtc-link-btn" href={safe} download="">
                Download
              </a>
            ) : null}
          </li>
        );
      })}
      {legacyArtifacts.map((a) => {
        const id = a.artifact_id || a.id;
        const name = a.name || a.path || id || 'file';
        let url: string | null = null;
        if (id && sessionId) url = getArtifactDownloadUrl(sessionId, id);
        else if (a.path && sessionId) url = getDownloadUrl(sessionId, a.path);
        const safe = safeApiUrl(url);
        return (
          <li key={String(id || a.path)} className="inspector-row">
            <div className="row-title">{String(name)}</div>
            <div className="row-meta">
              deliverable
              {formatSize(a.size as number | undefined)
                ? ` · ${formatSize(a.size as number | undefined)}`
                : ''}
            </div>
            {safe ? (
              <a className="rtc-link-btn" href={safe} download="">
                Download
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
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
