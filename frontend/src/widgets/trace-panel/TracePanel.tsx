/**
 * Trace Panel (plan §19.10) — tree of run / model / tool / sandbox spans.
 */
import { useMemo } from 'react';
import type { TraceSpanEntity } from '../../entities';
import { formatDuration } from '../runtime-timeline/buildTimeline';

export type TraceTreeNode = {
  span: TraceSpanEntity;
  children: TraceTreeNode[];
};

/** Build a parent→children tree from flat span entities. */
export function buildTraceTree(spans: TraceSpanEntity[]): TraceTreeNode[] {
  const byId = new Map<string, TraceTreeNode>();
  for (const span of spans) {
    byId.set(span.id, { span, children: [] });
  }
  const roots: TraceTreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parentId;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: TraceTreeNode[]) => {
    nodes.sort((a, b) => {
      const ta = a.span.startedAt || '';
      const tb = b.span.startedAt || '';
      return ta.localeCompare(tb) || a.span.id.localeCompare(b.span.id);
    });
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

function statusGlyph(status: TraceSpanEntity['status']): string {
  switch (status) {
    case 'running':
      return '●';
    case 'ok':
      return '✓';
    case 'error':
      return '✗';
    case 'cancelled':
      return '○';
    default:
      return '·';
  }
}

function TraceNodeView({
  node,
  depth,
  traceId,
}: {
  node: TraceTreeNode;
  depth: number;
  traceId: string | null;
}) {
  const { span } = node;
  const duration =
    span.durationMs != null
      ? span.durationMs < 1000
        ? `${span.durationMs} ms`
        : `${(span.durationMs / 1000).toFixed(1)}s`
      : formatDuration(span.startedAt, span.finishedAt);

  return (
    <li
      className={`trace-node status-${span.status}`}
      data-span-id={span.id}
      data-kind={span.kind}
      style={{ marginLeft: depth * 12 }}
    >
      <div className="trace-node-head">
        <span className="rtc-icon" aria-hidden="true">
          {statusGlyph(span.status)}
        </span>
        <span className="trace-kind">{span.kind}</span>
        <span className="trace-name">{span.name}</span>
        <span className="rtc-meta">{duration}</span>
      </div>
      <div className="row-meta mono">
        {span.spanId ? `span ${span.spanId.slice(0, 12)}` : span.id}
        {span.tokens != null ? ` · ${span.tokens} tok` : ''}
        {span.cost != null ? ` · $${Number(span.cost).toFixed(4)}` : ''}
        {depth === 0 && traceId ? ` · trace ${traceId.slice(0, 12)}…` : ''}
      </div>
      {span.error ? <div className="row-sub danger">{span.error}</div> : null}
      {node.children.length > 0 ? (
        <ul className="trace-children">
          {node.children.map((child) => (
            <TraceNodeView
              key={child.span.id}
              node={child}
              depth={depth + 1}
              traceId={traceId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TracePanel({
  spans,
  traceId,
  emptyHint = 'No trace spans for this run yet.',
}: {
  spans: TraceSpanEntity[];
  traceId?: string | null;
  emptyHint?: string;
}) {
  const tree = useMemo(() => buildTraceTree(spans), [spans]);

  if (!spans.length) {
    return <p className="inspector-empty">{emptyHint}</p>;
  }

  return (
    <div className="trace-panel inspector-section" aria-label="Trace">
      {traceId ? (
        <dl className="inspector-dl">
          <dt>Trace ID</dt>
          <dd className="mono">{traceId}</dd>
        </dl>
      ) : null}
      <ul className="trace-tree inspector-list">
        {tree.map((node) => (
          <TraceNodeView
            key={node.span.id}
            node={node}
            depth={0}
            traceId={traceId || null}
          />
        ))}
      </ul>
    </div>
  );
}
