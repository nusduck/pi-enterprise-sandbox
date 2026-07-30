import { useMemo, useState, type ReactNode } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';
import { getArtifactDownloadUrl } from '../../shared/api';
import { safeApiUrl } from '../../shared/security/url';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import {
  buildRunTimeline,
  formatDuration,
  formatPayload,
  summarizeToolInput,
  type TimelineItem,
} from '../runtime-timeline/buildTimeline';
import {
  formatToolInputDisplay,
  formatToolResultDisplay,
} from '../message-list/formatToolDisplay';

function isActiveStatus(status: string | null | undefined): boolean {
  return (
    status === 'running' ||
    status === 'prepared' ||
    status === 'waiting_approval' ||
    status === 'waiting_input' ||
    status === 'queued'
  );
}

/** Prefer MCP-aware display names: `mcp__server__tool` → `server / tool`. */
function formatToolName(name: string | null | undefined, source?: string | null): string {
  const raw = (name || 'tool').trim();
  if (!raw) return 'tool';
  if (raw.startsWith('mcp__')) {
    const parts = raw.slice(5).split('__').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]} / ${parts.slice(1).join(' / ')}`;
    if (parts.length === 1) return parts[0];
  }
  if (source === 'mcp') return `mcp · ${raw}`;
  return raw;
}

function toolTone(status: string, isError: boolean): string {
  if (isError || status === 'failed') return 'error';
  if (status === 'waiting_approval') return 'wait';
  if (isActiveStatus(status)) return 'running';
  if (status === 'cancelled') return 'muted';
  return 'done';
}

function processTone(status: string): string {
  if (status === 'failed' || status === 'timeout' || status === 'orphaned') return 'error';
  if (status === 'running' || status === 'waiting_input') return 'running';
  if (status === 'completed') return 'done';
  return 'muted';
}

function statusGlyph(tone: string): ReactNode {
  if (tone === 'running') return <span className="rs-dot rs-dot-live" aria-hidden="true" />;
  if (tone === 'error') return <span className="rs-glyph" aria-hidden="true">✕</span>;
  if (tone === 'wait') return <span className="rs-glyph" aria-hidden="true">⏸</span>;
  if (tone === 'done') return <span className="rs-glyph" aria-hidden="true">✓</span>;
  return <span className="rs-glyph muted" aria-hidden="true">○</span>;
}

function StepShell({
  tone,
  title,
  subtitle,
  meta,
  defaultOpen,
  selected,
  onSelect,
  actions,
  children,
}: {
  tone: string;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  defaultOpen?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const expandable = Boolean(children);

  return (
    <div
      className={`rs-step tone-${tone}${selected ? ' selected' : ''}${open ? ' open' : ''}`}
      data-tone={tone}
    >
      <button
        type="button"
        className="rs-step-head"
        onClick={() => {
          if (expandable) setOpen((v) => !v);
          onSelect?.();
        }}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="rs-step-status">{statusGlyph(tone)}</span>
        <span className="rs-step-title" title={title}>
          {title}
        </span>
        {subtitle ? (
          <span className="rs-step-sub" title={subtitle}>
            {subtitle}
          </span>
        ) : null}
        {meta ? <span className="rs-step-meta">{meta}</span> : null}
        {expandable ? (
          <span className="rs-step-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        ) : null}
      </button>
      {actions ? <div className="rs-step-actions">{actions}</div> : null}
      {open && children ? <div className="rs-step-body">{children}</div> : null}
    </div>
  );
}

function ToolStep({
  item,
  selected,
  onSelect,
  onOpenConsole,
}: {
  item: Extract<TimelineItem, { kind: 'tool' }>;
  selected?: boolean;
  onSelect?: () => void;
  onOpenConsole?: (processId: string) => void;
}) {
  const tool = item.tool;
  const tone = toolTone(tool.status, tool.isError);
  const title = formatToolName(tool.name, tool.source);
  const subtitle = tool.summary || summarizeToolInput(tool.input);
  const duration = formatDuration(tool.createdAt, tool.updatedAt);
  const args =
    formatToolInputDisplay(tool.input) || formatPayload(tool.input) || '';
  const result =
    formatToolResultDisplay(tool.result) || formatPayload(tool.result) || '';
  const running = isActiveStatus(tool.status);

  return (
    <StepShell
      tone={tone}
      title={title}
      subtitle={subtitle}
      meta={duration !== '—' ? duration : running ? 'live' : null}
      defaultOpen={running || tool.isError}
      selected={selected}
      onSelect={onSelect}
      actions={
        tool.processId && onOpenConsole ? (
          <button
            type="button"
            className="rs-link"
            onClick={(e) => {
              e.stopPropagation();
              onOpenConsole(tool.processId!);
            }}
          >
            Console
          </button>
        ) : null
      }
    >
      {args ? (
        <section>
          <h4>Input</h4>
          <pre>{args}</pre>
        </section>
      ) : null}
      <section>
        <h4>Output</h4>
        {result ? (
          <pre>{result}</pre>
        ) : (
          <p className="rs-muted">
            {running ? 'Running…' : '(no output)'}
          </p>
        )}
      </section>
      {tool.source && tool.source !== 'unknown' ? (
        <p className="rs-muted">source · {tool.source}</p>
      ) : null}
    </StepShell>
  );
}

function ProcessStep({
  item,
  selected,
  onSelect,
  onOpenConsole,
}: {
  item: Extract<TimelineItem, { kind: 'process' }>;
  selected?: boolean;
  onSelect?: () => void;
  onOpenConsole?: (processId: string) => void;
}) {
  const process = item.process;
  const tone = processTone(process.status);
  const cmd = process.command || process.id;
  const duration = formatDuration(process.startedAt, process.finishedAt);
  const running = isActiveStatus(process.status);
  const preview = [process.stdout, process.stderr].filter(Boolean).join('\n').trim();

  return (
    <StepShell
      tone={tone}
      title="process"
      subtitle={cmd}
      meta={duration !== '—' ? duration : running ? 'live' : process.status}
      defaultOpen={running}
      selected={selected}
      onSelect={onSelect}
      actions={
        onOpenConsole ? (
          <button
            type="button"
            className="rs-link"
            onClick={(e) => {
              e.stopPropagation();
              onOpenConsole(process.id);
            }}
          >
            Console
          </button>
        ) : null
      }
    >
      <section>
        <h4>Command</h4>
        <pre>{cmd}</pre>
      </section>
      {preview ? (
        <section>
          <h4>Output</h4>
          <pre>{preview.length > 4000 ? `${preview.slice(0, 4000)}…` : preview}</pre>
        </section>
      ) : (
        <p className="rs-muted">
          {running ? 'Running…' : 'No buffered output'}
          {process.exitCode != null ? ` · exit ${process.exitCode}` : ''}
        </p>
      )}
    </StepShell>
  );
}

function ApprovalStep({
  item,
  selected,
  onSelect,
  onApprove,
  onReject,
  busy,
}: {
  item: Extract<TimelineItem, { kind: 'approval' }>;
  selected?: boolean;
  onSelect?: () => void;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  busy?: boolean;
}) {
  const approval = item.approval;
  const pending = approval.status === 'pending';
  const tone = pending
    ? 'wait'
    : approval.status === 'rejected'
      ? 'error'
      : approval.status === 'approved'
        ? 'done'
        : 'muted';

  return (
    <StepShell
      tone={tone}
      title={pending ? 'Approval required' : `Approval ${approval.status}`}
      subtitle={approval.reason || approval.command || null}
      meta={approval.risk || approval.status}
      defaultOpen={pending}
      selected={selected}
      onSelect={onSelect}
      actions={
        pending ? (
          <>
            <button
              type="button"
              className="rs-btn approve"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onApprove?.(approval.id);
              }}
            >
              Approve
            </button>
            <button
              type="button"
              className="rs-btn reject"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onReject?.(approval.id);
              }}
            >
              Reject
            </button>
          </>
        ) : null
      }
    >
      {approval.command ? (
        <section>
          <h4>Command</h4>
          <pre>{approval.command}</pre>
        </section>
      ) : null}
      {approval.reason ? (
        <section>
          <h4>Reason</h4>
          <p>{approval.reason}</p>
        </section>
      ) : null}
      {approval.risk ? <p className="rs-muted">Risk · {approval.risk}</p> : null}
    </StepShell>
  );
}

function ArtifactStep({
  item,
  selected,
  onSelect,
  sessionId,
}: {
  item: Extract<TimelineItem, { kind: 'artifact' }>;
  selected?: boolean;
  onSelect?: () => void;
  sessionId?: string | null;
}) {
  const artifact = item.artifact;
  const sid = sessionId || artifact.sessionId;
  const durable =
    Boolean(artifact.id) &&
    isDurableArtifactId(artifact.id, artifact.runId || '');
  const url =
    sid && durable ? getArtifactDownloadUrl(sid, artifact.id) : null;
  const safe = safeApiUrl(url);
  const size =
    artifact.size == null
      ? ''
      : artifact.size < 1024
        ? `${artifact.size} B`
        : artifact.size < 1024 * 1024
          ? `${(artifact.size / 1024).toFixed(1)} KB`
          : `${(artifact.size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <StepShell
      tone="done"
      title={artifact.name || artifact.path || 'artifact'}
      subtitle={artifact.mimeType || artifact.path || null}
      meta={size || null}
      selected={selected}
      onSelect={onSelect}
      actions={
        safe ? (
          <a
            className="rs-link"
            href={safe}
            download=""
            onClick={(e) => e.stopPropagation()}
          >
            Download
          </a>
        ) : null
      }
    />
  );
}

/**
 * Codex / Claude Code style runtime steps embedded in the chat stream.
 * Session lifecycle noise is omitted; process rows linked to a tool are folded
 * into the tool step (Console action) to avoid double-listing.
 */
export function InlineRuntimeSteps({ runId }: { runId: string }) {
  const { entityStore, resolveApproval, activeSessionId } = useChat();
  const { selected, setSelected, openProcessConsole } = useWorkbenchSelection();
  const [busyApproval, setBusyApproval] = useState<string | null>(null);

  const items = useMemo(() => {
    const all = buildRunTimeline(entityStore, runId);
    const toolIds = new Set(
      all.filter((i) => i.kind === 'tool').map((i) => i.tool.id),
    );
    return all.filter((item) => {
      if (item.kind === 'session') return false;
      if (
        item.kind === 'process' &&
        item.process.toolExecutionId &&
        toolIds.has(item.process.toolExecutionId)
      ) {
        return false;
      }
      return true;
    });
  }, [entityStore, runId]);

  if (!items.length) return null;

  function isSelected(item: TimelineItem): boolean {
    if (!selected) return false;
    if (item.kind === 'tool' && selected.kind === 'tool') {
      return item.tool.id === selected.id;
    }
    if (item.kind === 'process' && selected.kind === 'process') {
      return item.process.id === selected.id;
    }
    if (item.kind === 'approval' && selected.kind === 'approval') {
      return item.approval.id === selected.id;
    }
    if (item.kind === 'artifact' && selected.kind === 'artifact') {
      return item.artifact.id === selected.id;
    }
    return false;
  }

  async function handleApprove(id: string) {
    setBusyApproval(id);
    try {
      await resolveApproval(id, 'approve');
    } finally {
      setBusyApproval(null);
    }
  }

  async function handleReject(id: string) {
    setBusyApproval(id);
    try {
      await resolveApproval(id, 'reject');
    } finally {
      setBusyApproval(null);
    }
  }

  return (
    <div className="runtime-steps" role="list" aria-label="Runtime steps">
      {items.map((item) => {
        const selectedRow = isSelected(item);
        if (item.kind === 'tool') {
          return (
            <div key={item.id} role="listitem">
              <ToolStep
                item={item}
                selected={selectedRow}
                onSelect={() => setSelected({ kind: 'tool', id: item.tool.id })}
                onOpenConsole={openProcessConsole}
              />
            </div>
          );
        }
        if (item.kind === 'process') {
          return (
            <div key={item.id} role="listitem">
              <ProcessStep
                item={item}
                selected={selectedRow}
                onSelect={() =>
                  setSelected({ kind: 'process', id: item.process.id })
                }
                onOpenConsole={openProcessConsole}
              />
            </div>
          );
        }
        if (item.kind === 'approval') {
          return (
            <div key={item.id} role="listitem">
              <ApprovalStep
                item={item}
                selected={selectedRow}
                onSelect={() =>
                  setSelected({ kind: 'approval', id: item.approval.id })
                }
                onApprove={(id) => void handleApprove(id)}
                onReject={(id) => void handleReject(id)}
                busy={busyApproval === item.approval.id}
              />
            </div>
          );
        }
        if (item.kind === 'artifact') {
          return (
            <div key={item.id} role="listitem">
              <ArtifactStep
                item={item}
                selected={selectedRow}
                onSelect={() =>
                  setSelected({ kind: 'artifact', id: item.artifact.id })
                }
                sessionId={activeSessionId}
              />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

/** True when the entity store already owns rich tool rows for this run. */
export function runHasEntitySteps(
  // loose typing so MessageBubble can pass the store without importing EntityStore deep
  store: { toolExecutionsById: Record<string, unknown>; runsById: Record<string, { toolExecutionIds?: string[]; processIds?: string[]; approvalIds?: string[]; artifactIds?: string[] } | undefined> },
  runId: string | null | undefined,
): boolean {
  if (!runId) return false;
  const run = store.runsById[runId];
  if (!run) return false;
  return Boolean(
    run.toolExecutionIds?.length ||
      run.processIds?.length ||
      run.approvalIds?.length ||
      run.artifactIds?.length,
  );
}
