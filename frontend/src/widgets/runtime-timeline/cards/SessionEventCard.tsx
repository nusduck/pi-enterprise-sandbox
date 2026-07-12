import { useState } from 'react';

/**
 * Session / system event — collapsed by default (ADR §6.2).
 */
export function SessionEventCard({
  id,
  label,
  detail,
  defaultOpen = false,
}: {
  id: string;
  label: string;
  detail?: string | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <article
      className="rtc-card rtc-session"
      data-session-event-id={id}
    >
      <header
        className="rtc-card-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="rtc-icon" aria-hidden="true">
          ℹ
        </span>
        <span className="rtc-title muted">{label}</span>
        <button
          type="button"
          className="rtc-expand"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? '▾' : '▸'}
        </button>
      </header>
      {open && detail ? (
        <div className="rtc-expand-body">
          <pre>{detail}</pre>
        </div>
      ) : null}
    </article>
  );
}
