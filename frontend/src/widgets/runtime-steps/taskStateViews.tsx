/**
 * Shared bodies for the subagent-spawn / task-state tool cards.
 *
 * Two renderers show tool steps — `InlineRuntimeSteps` in the chat transcript
 * and `ToolExecutionCard` in the tool panel — so the list markup lives here
 * once instead of being written twice and drifting.
 */

import type { SubagentChild } from './subagentFields';
import { childStatusClass, summarizeChildren } from './subagentFields';
import type { MemoryFields, TodoItem } from './taskStateFields';
import { summarizeTodos, todoStatusClass, todoStatusIcon } from './taskStateFields';

export function SubagentChildList({ items }: { items: SubagentChild[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="sa-children">
      {items.map((child) => (
        <li key={child.runId} className="sa-child">
          <span className={`sa-pill ${childStatusClass(child.status)}`}>
            {child.status}
          </span>
          <span className="sa-child-body">
            <span className="sa-child-name">{child.label || child.runId}</span>
            {child.resultSummary ? (
              <span className="sa-child-summary">{child.resultSummary}</span>
            ) : child.statusReason ? (
              <span className="sa-child-summary sa-muted">{child.statusReason}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  return (
    <ol className="ts-list">
      {todos.map((todo) => (
        <li
          key={`${todo.position}:${todo.content}`}
          className={`ts-item ${todoStatusClass(todo.status)}`}
        >
          <span className="ts-mark" aria-hidden="true">
            {todoStatusIcon(todo.status)}
          </span>
          <span className="ts-text">{todo.content}</span>
        </li>
      ))}
    </ol>
  );
}

export function MemoryNotes({ fields }: { fields: MemoryFields }) {
  const { written, results } = fields;
  if (!written && results.length === 0) return null;
  return (
    <>
      {written ? <p className="ts-note">{written.content}</p> : null}
      {results.length ? (
        <ul className="ts-notes">
          {results.map((hit, index) => (
            <li key={hit.memoryId ?? `${index}`} className="ts-note-row">
              {hit.key ? <span className="ts-note-key">{hit.key}</span> : null}
              <span className="ts-note-text">{hit.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Collapsed-line summary for a memory step. */
export function summarizeMemory(fields: MemoryFields): string {
  if (fields.errorCode) return fields.errorCode;
  if (fields.written) return fields.written.key || 'Remembered';
  if (fields.query) return `“${fields.query}” · ${fields.results.length} found`;
  return `${fields.results.length} recent notes`;
}

export { summarizeChildren, summarizeTodos };
