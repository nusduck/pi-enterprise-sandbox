import { useMemo, useState, type ReactNode } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  getRunApprovals,
  getRunArtifacts,
  getRunToolExecutions,
  getRunTraceSpans,
  listDatasetsForConversation,
  listProcessesForSession,
  type ArtifactEntity,
} from '../../entities';
import { fileTypeLabel } from '../../shared/state';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import {
  formatDuration,
  formatRunStatusLabel,
  getActiveRunEntity,
  runStatusTone,
  type InspectorTabId,
  type SelectedEntity,
} from '../runtime-timeline/buildTimeline';
import { ArtifactPanel } from '../artifact-panel/ArtifactPanel';
import { DatasetPanel } from '../dataset-panel/DatasetPanel';
import { TracePanel } from '../trace-panel/TracePanel';
import { ToolCallPanel } from '../tool-call-panel/ToolCallPanel';
import { ProcessPanel } from '../process-panel/ProcessPanel';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';
import { IconClose, IconCopy, IconCheck, IconLayers } from '../../shared/ui/Icons';

type TabDef = {
  id: InspectorTabId;
  label: string;
  count?: number;
};

type ReferencedFile = {
  path: string;
  name: string;
  toolName: string;
};

const FILE_INPUT_KEYS = new Set([
  'path',
  'file',
  'file_path',
  'filepath',
  'source_path',
  'target_path',
  'destination_path',
  'paths',
  'files',
]);

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

function pathLike(value: string): boolean {
  const clean = value.trim();
  return (
    clean.startsWith('/') ||
    clean.startsWith('./') ||
    clean.startsWith('../') ||
    clean.includes('/workspace/') ||
    /^[^/\s]+\.[a-z0-9]{1,8}$/i.test(clean)
  );
}

function pathsFromInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const found: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (FILE_INPUT_KEYS.has(key.toLowerCase()) && pathLike(value)) {
        found.push(value.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      if (FILE_INPUT_KEYS.has(key.toLowerCase())) {
        for (const item of value) {
          if (typeof item === 'string' && pathLike(item)) found.push(item.trim());
        }
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, childKey);
      }
    }
  };
  visit(input);
  return found;
}

export function collectReferencedFiles(
  tools: Array<{ name: string; input: unknown }>,
  excludedPaths: Array<string | null | undefined> = [],
): ReferencedFile[] {
  const excluded = new Set(
    excludedPaths
      .filter((path): path is string => Boolean(path))
      .map((path) => path.replace(/\\/g, '/')),
  );
  const seen = new Set<string>();
  const files: ReferencedFile[] = [];
  for (const tool of tools) {
    for (const rawPath of pathsFromInput(tool.input)) {
      const path = rawPath.replace(/\\/g, '/');
      if (excluded.has(path) || seen.has(path)) continue;
      seen.add(path);
      files.push({ path, name: basename(path), toolName: tool.name });
    }
  }
  return files;
}

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
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!copyable) return;
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(copyable);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="insp-meta-row">
      <span className="insp-meta-label">{label}</span>
      <span
        className={`insp-meta-value${mono ? ' mono' : ''}${danger ? ' danger' : ''}`}
        title={typeof value === 'string' ? value : undefined}
      >
        <span className="insp-meta-text">{value}</span>
        {copyable ? (
          <button
            type="button"
            className="insp-copy"
            title="Copy"
            aria-label={`Copy ${label}`}
            onClick={handleCopy}
          >
            {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
            <span>{copied ? 'copied' : 'copy'}</span>
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
    () => listProcessesForSession(entityStore, activeSessionId),
    [entityStore, activeSessionId],
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
    if (runId) {
      runIds.add(runId);
    } else if (convId) {
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

    for (const listed of listedArtifacts) {
      const id = String(listed.artifact_id || listed.id || '').trim();
      if (!id || seen.has(id)) continue;
      const listedRunId = String(
        listed.run_id || listed.runId || '',
      ).trim();
      if (runId && listedRunId !== runId) continue;
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
  const referencedFiles = useMemo(
    () =>
      collectReferencedFiles(tools, [
        ...artifacts.map((artifact) => artifact.path),
        ...listedArtifacts.map((artifact) =>
          artifact.path == null ? null : String(artifact.path),
        ),
      ]),
    [tools, artifacts, listedArtifacts],
  );

  const tabs: TabDef[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'tools', label: 'Tools', count: tools.length || undefined },
    { id: 'processes', label: 'Processes', count: processes.length || undefined },
    {
      id: 'files',
      label: 'Files',
      count: referencedFiles.length || undefined,
    },
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
            <div className="inspector-title-row">
              <IconLayers size={16} className="inspector-title-icon" />
              <h2 className="inspector-title">Details</h2>
            </div>
            <p className="inspector-subtitle">
              {run
                ? `Run · ${statusLabel}`
                : state.conversationId
                  ? 'Conversation Context'
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
            <IconClose size={16} />
          </button>
          <button
            type="button"
            className="btn-icon inspector-close"
            title="Close details"
            aria-label="Close details"
            onClick={onClose}
          >
            <IconClose size={16} />
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
            <FilesPanel files={referencedFiles} />
          ) : null}

          {tab === 'processes' ? (
            <ProcessPanel
              processes={processes}
              selectedId={selected?.kind === 'process' ? selected.id : null}
              onOpenConsole={openProcessConsole}
              emptyHint="No managed processes in this session."
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
        title="Nothing Selected"
        body="Start a chat or select an execution step to inspect context."
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
          <h3 className="insp-card-title">Execution Snapshot</h3>
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
          <h3 className="insp-card-title">Run Details</h3>
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
          <MetaRow label="Context Usage" value={ctxLabel} mono />
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
          <h3 className="insp-card-title">Identity & Tracing</h3>
        </div>
        <div className="insp-meta-list">
          <MetaRow
            label="Model"
            value={run?.modelId || agentSession?.modelId || '—'}
          />
          <MetaRow
            label="Agent Session"
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
            label="Trace ID"
            value={shortId(traceId, 14)}
            mono
            copyable={traceId}
          />
        </div>
      </section>

      {run?.taskPlan?.length ? (
        <section className="insp-card">
          <div className="insp-card-head">
            <h3 className="insp-card-title">Task Plan</h3>
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
  files,
}: {
  files: ReferencedFile[];
}) {
  if (!files.length) {
    return (
      <EmptyState
        title="No Referenced Files"
        body="Files read or written by tools in this run will appear here. Final deliverables stay in Artifacts."
      />
    );
  }

  return (
    <div className="insp-stack">
      <div className="insp-section-intro">
        <span>Workspace References</span>
        <span>{files.length}</span>
      </div>
      <ul className="insp-file-list">
        {files.map((file) => (
          <li key={file.path} className="insp-file-row">
            <span className="file-type-tile" aria-hidden="true">
              {fileTypeLabel(file.name)}
            </span>
            <span className="insp-file-copy">
              <span className="insp-file-name">{file.name}</span>
              <span className="insp-file-path mono" title={file.path}>
                {file.path}
              </span>
            </span>
            <span className="insp-file-source" title={`Referenced by ${file.toolName}`}>
              {file.toolName}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionPanel({
  run,
  agentSession,
  sessionId,
  conversationId,
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
}) {
  if (!run && !agentSession && !sessionId && !conversationId) {
    return (
      <EmptyState
        title="No Active Session"
        body="Session identity appears after the first run starts."
      />
    );
  }

  return (
    <div className="insp-stack">
      <section className="insp-card">
        <div className="insp-card-head">
          <h3 className="insp-card-title">Agent Session</h3>
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
          <MetaRow
            label="Model"
            value={run?.modelId || agentSession?.modelId || '—'}
          />
          <MetaRow
            label="Workspace ID"
            value={shortId(agentSession?.workspaceId || sessionId, 16)}
            mono
            copyable={agentSession?.workspaceId || sessionId}
          />
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
    </div>
  );
}
