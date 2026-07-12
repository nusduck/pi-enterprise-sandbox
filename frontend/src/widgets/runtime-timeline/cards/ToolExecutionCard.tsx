import { useState } from 'react';
import type { ToolExecutionEntity } from '../../../entities';
import {
  formatDuration,
  formatPayload,
  summarizeToolInput,
} from '../buildTimeline';

function statusIcon(tool: ToolExecutionEntity): string {
  if (tool.isError || tool.status === 'failed') return '✗';
  if (tool.status === 'running' || tool.status === 'prepared') return '●';
  if (tool.status === 'waiting_approval') return '⏸';
  if (tool.status === 'cancelled') return '○';
  return '✓';
}

function statusClass(tool: ToolExecutionEntity): string {
  if (tool.isError || tool.status === 'failed') return 'rtc-tool-error';
  if (tool.status === 'running' || tool.status === 'prepared') return 'rtc-tool-running';
  if (tool.status === 'waiting_approval') return 'rtc-tool-wait';
  if (tool.status === 'cancelled') return 'rtc-tool-cancel';
  return 'rtc-tool-done';
}

export function ToolExecutionCard({
  tool,
  selected,
  onSelect,
}: {
  tool: ToolExecutionEntity;
  selected?: boolean;
  onSelect?: (toolId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const subtitle = tool.summary || summarizeToolInput(tool.input);
  const duration = formatDuration(tool.createdAt, tool.updatedAt);
  const args = formatPayload(tool.input);
  const result = formatPayload(tool.result);

  return (
    <article
      className={`rtc-card rtc-tool ${statusClass(tool)}${selected ? ' selected' : ''}`}
      data-tool-id={tool.id}
      data-status={tool.status}
      onClick={() => onSelect?.(tool.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(tool.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={open}
    >
      <header className="rtc-card-head">
        <span className="rtc-icon" aria-hidden="true">
          {statusIcon(tool)}
        </span>
        <span className="rtc-title">{tool.name || 'tool'}</span>
        <span className="rtc-meta">{duration}</span>
        <button
          type="button"
          className="rtc-expand"
          aria-label={open ? 'Collapse tool details' : 'Expand tool details'}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? '▾' : '▸'}
        </button>
      </header>
      {subtitle ? <p className="rtc-subtitle">{subtitle}</p> : null}
      <p className="rtc-status-line">
        {tool.status}
        {tool.isError ? ' · error' : ''}
      </p>
      {open ? (
        <div className="rtc-expand-body">
          {args ? (
            <section>
              <h4>Arguments</h4>
              <pre>{args}</pre>
            </section>
          ) : null}
          {result ? (
            <section>
              <h4>Result</h4>
              <pre>{result}</pre>
            </section>
          ) : (
            <section>
              <h4>Result</h4>
              <p className="rtc-muted">
                {tool.status === 'running' || tool.status === 'prepared'
                  ? 'Running…'
                  : '(no result)'}
              </p>
            </section>
          )}
          <section className="rtc-ids">
            <span>id: {tool.id}</span>
            {tool.approvalId ? <span>approval: {tool.approvalId}</span> : null}
            {tool.processId ? <span>process: {tool.processId}</span> : null}
          </section>
        </div>
      ) : null}
    </article>
  );
}
