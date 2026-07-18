/**
 * Dataset Panel (plan §19.7) — upload status, path, agent visibility.
 * Keeps existing visual tokens (rtc-card / inspector-list).
 */
import type { DatasetEntity } from '../../entities';

function formatSize(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: DatasetEntity['status']): string {
  switch (status) {
    case 'uploading':
      return 'Uploading';
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Failed';
    case 'removed':
      return 'Removed';
    default:
      return status;
  }
}

export function DatasetPanel({
  datasets,
  selectedId,
  onSelect,
  emptyHint = 'No datasets uploaded for this conversation.',
}: {
  datasets: DatasetEntity[];
  selectedId?: string | null;
  onSelect?: (datasetId: string) => void;
  emptyHint?: string;
}) {
  if (!datasets.length) {
    return <p className="inspector-empty">{emptyHint}</p>;
  }

  return (
    <ul className="inspector-list cards dataset-panel" aria-label="Datasets">
      {datasets.map((d) => {
        const size = formatSize(d.size);
        const progress =
          d.status === 'uploading' && d.progress != null
            ? ` · ${Math.round(d.progress)}%`
            : '';
        return (
          <li
            key={d.id}
            className={`inspector-row rtc-card rtc-dataset status-${d.status}${selectedId === d.id ? ' selected' : ''}`}
            data-dataset-id={d.id}
            data-status={d.status}
            onClick={() => onSelect?.(d.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect?.(d.id);
              }
            }}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
          >
            <div className="row-title" title={d.path || d.name}>
              {d.name}
            </div>
            <div className="row-meta">
              {statusLabel(d.status)}
              {progress}
              {size ? ` · ${size}` : ''}
              {d.agentVisible ? ' · agent visible' : ' · hidden from agent'}
            </div>
            {d.path ? (
              <div className="row-sub mono">{d.path}</div>
            ) : null}
            {d.sha256 ? (
              <div className="row-sub mono muted">sha256 {d.sha256.slice(0, 16)}…</div>
            ) : null}
            {d.createdAt ? (
              <div className="row-meta muted">{d.createdAt}</div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
