import { useState, type KeyboardEvent } from 'react';
import type { ToolExecutionEntity } from '../../../entities';
import {
  formatDuration,
  formatPayload,
  summarizeToolInput,
} from '../buildTimeline';
import {
  isAskUserToolName,
  parseAskUserFields,
  summarizeInteractionResult,
} from '../../runtime-steps/interactionFields';
import {
  isCheckSubagentToolName,
  isSpawnSubagentToolName,
  parseCheckSubagentFields,
  parseSpawnSubagentFields,
} from '../../runtime-steps/subagentFields';
import {
  isMemoryToolName,
  isTodoToolName,
  parseMemoryFields,
  parseTodoFields,
} from '../../runtime-steps/taskStateFields';
import {
  MemoryNotes,
  SubagentChildList,
  TodoChecklist,
  summarizeChildren,
  summarizeMemory,
  summarizeTodos,
} from '../../runtime-steps/taskStateViews';

/** Enter/Space activates a card, matching the generic tool card. */
function cardKeyDown(
  toolId: string,
  onSelect?: (toolId: string) => void,
): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect?.(toolId);
    }
  };
}

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

  // ask_user: human-readable card instead of raw JSON dump.
  if (isAskUserToolName(tool.name)) {
    const fields = parseAskUserFields(tool.input);
    const waiting =
      tool.status === 'running' || tool.status === 'prepared';
    const answer = summarizeInteractionResult(tool.result);
    return (
      <article
        className={`ix-card${waiting ? ' ix-waiting' : ''}${selected ? ' selected' : ''}`}
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
      >
        <header className="ix-head">
          <span className="ix-icon" aria-hidden="true">
            {waiting ? '💬' : '✓'}
          </span>
          <div className="ix-head-text">
            <span className="ix-kicker">
              {waiting ? 'Waiting for you' : 'Ask user'}
            </span>
            <h3 className="ix-title">{fields.title}</h3>
          </div>
        </header>
        {fields.message ? <p className="ix-message">{fields.message}</p> : null}
        {answer ? (
          <p className="ix-answer">
            <span className="ix-answer-label">Reply</span>
            {answer}
          </p>
        ) : waiting ? (
          <p className="ix-message ix-muted">Respond in the chat composer below.</p>
        ) : null}
      </article>
    );
  }

  // spawn_subagent: one child, identified by run id.
  if (isSpawnSubagentToolName(tool.name)) {
    const fields = parseSpawnSubagentFields(tool.input, tool.result);
    const pending = tool.status === 'running' || tool.status === 'prepared';
    return (
      <article
        className={`sa-card${selected ? ' selected' : ''}${fields.errorCode ? ' sa-card-error' : ''}`}
        data-tool-id={tool.id}
        data-status={tool.status}
        onClick={() => onSelect?.(tool.id)}
        onKeyDown={cardKeyDown(tool.id, onSelect)}
        role="button"
        tabIndex={0}
      >
        <header className="sa-head">
          <span className="sa-icon" aria-hidden="true">
            {fields.errorCode ? '✗' : pending ? '◐' : '⑂'}
          </span>
          <div className="sa-head-text">
            <span className="sa-kicker">Sub-agent</span>
            <h3 className="sa-title">{fields.label || 'Delegated task'}</h3>
          </div>
        </header>
        {fields.task ? <p className="sa-task">{fields.task}</p> : null}
        {fields.errorCode ? (
          <p className="sa-error">{fields.errorCode}</p>
        ) : fields.childRunId ? (
          <p className="sa-runid">
            <span className="sa-runid-label">run</span>
            <code>{fields.childRunId}</code>
          </p>
        ) : pending ? (
          <p className="sa-muted">Starting…</p>
        ) : null}
      </article>
    );
  }

  // check_subagent: the fan-out status board.
  if (isCheckSubagentToolName(tool.name)) {
    const fields = parseCheckSubagentFields(tool.result);
    const pending = tool.status === 'running' || tool.status === 'prepared';
    return (
      <article
        className={`sa-card${selected ? ' selected' : ''}${fields.errorCode ? ' sa-card-error' : ''}`}
        data-tool-id={tool.id}
        data-status={tool.status}
        onClick={() => onSelect?.(tool.id)}
        onKeyDown={cardKeyDown(tool.id, onSelect)}
        role="button"
        tabIndex={0}
      >
        <header className="sa-head">
          <span className="sa-icon" aria-hidden="true">
            {fields.allTerminal ? '✓' : '◐'}
          </span>
          <div className="sa-head-text">
            <span className="sa-kicker">Sub-agents</span>
            <h3 className="sa-title">
              {fields.errorCode
                ? fields.errorCode
                : pending && fields.children.length === 0
                  ? 'Checking…'
                  : summarizeChildren(fields.children)}
            </h3>
          </div>
        </header>
        <SubagentChildList items={fields.children} />
      </article>
    );
  }

  // todo_write / todo_read: the agent's plan, as a checklist.
  if (isTodoToolName(tool.name)) {
    const fields = parseTodoFields(tool.input, tool.result);
    return (
      <article
        className={`ts-card${selected ? ' selected' : ''}${fields.errorCode ? ' ts-card-error' : ''}`}
        data-tool-id={tool.id}
        data-status={tool.status}
        onClick={() => onSelect?.(tool.id)}
        onKeyDown={cardKeyDown(tool.id, onSelect)}
        role="button"
        tabIndex={0}
      >
        <header className="ts-head">
          <span className="ts-icon" aria-hidden="true">
            ☑
          </span>
          <div className="ts-head-text">
            <span className="ts-kicker">Plan</span>
            <h3 className="ts-title">
              {fields.errorCode ?? summarizeTodos(fields.todos)}
            </h3>
          </div>
        </header>
        <TodoChecklist todos={fields.todos} />
      </article>
    );
  }

  // memory_write / memory_search: durable notes.
  if (isMemoryToolName(tool.name)) {
    const fields = parseMemoryFields(tool.name, tool.input, tool.result);
    const stored = fields.written;
    return (
      <article
        className={`ts-card${selected ? ' selected' : ''}${fields.errorCode ? ' ts-card-error' : ''}`}
        data-tool-id={tool.id}
        data-status={tool.status}
        onClick={() => onSelect?.(tool.id)}
        onKeyDown={cardKeyDown(tool.id, onSelect)}
        role="button"
        tabIndex={0}
      >
        <header className="ts-head">
          <span className="ts-icon" aria-hidden="true">
            {stored ? '✎' : '⌕'}
          </span>
          <div className="ts-head-text">
            <span className="ts-kicker">Memory</span>
            <h3 className="ts-title">{summarizeMemory(fields)}</h3>
          </div>
        </header>
        <MemoryNotes fields={fields} />
      </article>
    );
  }

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
        {tool.source && tool.source !== 'unknown' ? ` · ${tool.source}` : ''}
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
