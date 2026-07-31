import { useState } from 'react';
import type { ToolUsePart } from '../../shared/state';
import {
  formatToolInputDisplay,
  formatToolResultDisplay,
} from './formatToolDisplay';
import {
  isAskUserToolName,
  parseAskUserFields,
  summarizeInteractionResult,
} from '../runtime-steps/interactionFields';

export function ToolPill({ part }: { part: ToolUsePart }) {
  const [open, setOpen] = useState(false);
  const askUser = isAskUserToolName(part.name);
  const st =
    part.isError ? 'tp-e' : part.status === 'running' ? 'tp-r' : 'tp-d';
  const icon = part.isError ? '✕' : part.status === 'running' ? '' : '✓';

  let popText = '(no data)';
  let label = `🔧 ${part.name || 'tool'}${icon ? ` ${icon}` : ''}`;

  if (askUser) {
    const fields = parseAskUserFields(part.input);
    const answer = summarizeInteractionResult(part.result);
    label =
      part.status === 'running'
        ? `💬 ${fields.title}`
        : `💬 ${fields.title}${icon ? ` ${icon}` : ''}`;
    const sections = [
      fields.message || fields.title,
      answer ? `Reply: ${answer}` : part.status === 'running' ? '(waiting…)' : '',
    ].filter(Boolean);
    popText = sections.join('\n\n') || '(ask user)';
  } else {
    const args = formatToolInputDisplay(part.input);
    const res = formatToolResultDisplay(part.result);
    // Always prefer showing result when complete — previously `args || res`
    // hid successful stdout whenever input was present (every bash call).
    const sections: string[] = [];
    if (args) sections.push(args);
    if (res) sections.push(res);
    if (part.status === 'running' && !res) sections.push('(running…)');
    popText = sections.length ? sections.join('\n\n') : '(no data)';
  }

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
      <span className="tp-label">{label}</span>
      <span className={`tp-pop${open ? '' : ' hide'}`} role="tooltip">
        {popText}
      </span>
    </span>
  );
}
