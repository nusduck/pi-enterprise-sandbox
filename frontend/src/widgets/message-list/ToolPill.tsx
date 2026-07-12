import { useState } from 'react';
import type { ToolUsePart } from '../../shared/state';

export function ToolPill({ part }: { part: ToolUsePart }) {
  const [open, setOpen] = useState(false);
  const st =
    part.isError ? 'tp-e' : part.status === 'running' ? 'tp-r' : 'tp-d';
  const icon = part.isError ? '✕' : part.status === 'running' ? '' : '✓';
  const args = part.input ? JSON.stringify(part.input, null, 2) : '';
  const res = part.result
    ? typeof part.result === 'string'
      ? part.result
      : JSON.stringify(part.result, null, 2)
    : '';
  const popText = args || res || '(no data)';

  return (
    <span
      className={`tp ${st}`}
      role="button"
      tabIndex={0}
      aria-expanded={open ? 'true' : 'false'}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen((v) => !v);
        }
      }}
    >
      {part.status === 'running' ? (
        <span className="tpd" aria-hidden="true" />
      ) : null}
      <span className="tp-label">
        {`🔧 ${part.name || 'tool'}${icon ? ` ${icon}` : ''}`}
      </span>
      <span className={`tp-pop${open ? '' : ' hide'}`} role="tooltip">
        {popText}
      </span>
    </span>
  );
}
