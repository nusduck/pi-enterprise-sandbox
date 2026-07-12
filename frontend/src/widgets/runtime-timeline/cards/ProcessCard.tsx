import type { ProcessEntity } from '../../../entities';
import { formatDuration } from '../buildTimeline';

function statusDot(status: string): string {
  if (status === 'running' || status === 'waiting_input') return 'rtc-dot-active';
  if (status === 'failed' || status === 'timeout' || status === 'orphaned') {
    return 'rtc-dot-danger';
  }
  if (status === 'completed') return 'rtc-dot-ok';
  if (status === 'cancelled' || status === 'cancel_requested') return 'rtc-dot-muted';
  return 'rtc-dot-muted';
}

/**
 * Process card — opens Process Console when available (F4).
 */
export function ProcessCard({
  process,
  selected,
  onSelect,
  onOpenConsole,
}: {
  process: ProcessEntity;
  selected?: boolean;
  onSelect?: (processId: string) => void;
  onOpenConsole?: (processId: string) => void;
}) {
  const duration = formatDuration(process.startedAt, process.finishedAt);
  const cmd = process.command || process.id;

  return (
    <article
      className={`rtc-card rtc-process${selected ? ' selected' : ''}`}
      data-process-id={process.id}
      data-status={process.status}
      onClick={() => onSelect?.(process.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(process.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <header className="rtc-card-head">
        <span className={`rtc-dot ${statusDot(process.status)}`} aria-hidden="true" />
        <span className="rtc-title mono" title={cmd}>
          {cmd}
        </span>
        <span className="rtc-meta">{duration}</span>
      </header>
      <p className="rtc-status-line">
        {process.status}
        {process.exitCode != null ? ` · exit ${process.exitCode}` : ''}
      </p>
      <div className="rtc-actions">
        <button
          type="button"
          className="rtc-link-btn"
          title="Open process console"
          aria-label={`Open console for ${cmd}`}
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenConsole) onOpenConsole(process.id);
            else onSelect?.(process.id);
          }}
        >
          Open Console
        </button>
      </div>
    </article>
  );
}
