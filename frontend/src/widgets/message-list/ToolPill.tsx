import { useState } from 'react';
import type { ToolUsePart } from '../../shared/state';
import {
  formatToolInputDisplay,
  formatToolResultDisplay,
} from './formatToolDisplay';

export function ToolPill({ part }: { part: ToolUsePart }) {
  const [open, setOpen] = useState(false);
  const st =
    part.isError ? 'tp-e' : part.status === 'running' ? 'tp-r' : 'tp-d';
  const icon = part.isError ? '✕' : part.status === 'running' ? '' : '✓';
  const args = formatToolInputDisplay(part.input);
  const res = formatToolResultDisplay(part.result);
  // Always prefer showing result when complete — previously `args || res`
  // hid successful stdout whenever input was present (every bash call).
  const sections: string[] = [];
  if (args) sections.push(args);
  if (res) sections.push(res);
  if (part.status === 'running' && !res) sections.push('(running…)');
  const popText = sections.length ? sections.join('\n\n') : '(no data)';

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
