/**
 * Parse `todo_write` / `todo_read` / `memory_write` / `memory_search` payloads.
 *
 * The todo list is the agent's plan for the whole conversation, so it is worth
 * a real checklist rather than a JSON blob — it is the one tool result a user
 * reads to answer "what is it actually doing, and how far along is it".
 */

import { parseToolResultJson, toolErrorCode } from './subagentFields';

export type TodoItem = {
  position: number;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
};

export type TodoFields = {
  todos: TodoItem[];
  errorCode: string | null;
};

export type MemoryHit = {
  memoryId: string | null;
  key: string | null;
  content: string;
  createdAt: string | null;
};

export type MemoryFields = {
  /** memory_write: what was stored. memory_search: what was found. */
  written: MemoryHit | null;
  results: MemoryHit[];
  query: string | null;
  errorCode: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

export function isTodoToolName(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  return n === 'todo_write' || n === 'todo_read';
}

export function isMemoryToolName(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  return n === 'memory_write' || n === 'memory_search';
}

export function isTaskStateToolName(name: string | null | undefined): boolean {
  return isTodoToolName(name) || isMemoryToolName(name);
}

/**
 * Todo items, preferring the stored result (authoritative, carries positions)
 * and falling back to the arguments so a still-running write still renders.
 *
 * @param input `todo_write` arguments
 * @param result the tool result, when it has arrived
 */
export function parseTodoFields(input: unknown, result?: unknown): TodoFields {
  const payload = parseToolResultJson(result);
  const stored = payload && Array.isArray(payload.todos) ? payload.todos : null;
  const args = isPlainObject(input) && Array.isArray(input.items) ? input.items : null;
  const source = stored ?? args ?? [];

  const todos: TodoItem[] = source.flatMap((raw, index) => {
    if (!isPlainObject(raw)) return [];
    const content = trimmedString(raw.content);
    if (!content) return [];
    const position = Number(raw.position);
    return [
      {
        position: Number.isFinite(position) && position > 0 ? position : index + 1,
        content,
        status: trimmedString(raw.status) ?? 'pending',
      },
    ];
  });
  todos.sort((a, b) => a.position - b.position);
  return { todos, errorCode: toolErrorCode(result) };
}

function parseMemoryHit(raw: unknown): MemoryHit | null {
  if (!isPlainObject(raw)) return null;
  const content = trimmedString(raw.content);
  if (!content) return null;
  return {
    memoryId: trimmedString(raw.memoryId),
    key: trimmedString(raw.key),
    content,
    createdAt: trimmedString(raw.createdAt),
  };
}

/**
 * @param name tool name (`memory_write` or `memory_search`)
 * @param input tool arguments
 * @param result the tool result, when it has arrived
 */
export function parseMemoryFields(
  name: string,
  input: unknown,
  result?: unknown,
): MemoryFields {
  const args = isPlainObject(input) ? input : {};
  const payload = parseToolResultJson(result) ?? {};
  const rawResults = Array.isArray(payload.memories) ? payload.memories : [];
  const results = rawResults.flatMap((raw) => {
    const hit = parseMemoryHit(raw);
    return hit ? [hit] : [];
  });

  let written: MemoryHit | null = null;
  if (String(name).trim() === 'memory_write') {
    const content = trimmedString(args.content);
    if (content) {
      written = {
        memoryId: trimmedString(payload.memoryId),
        key: trimmedString(args.key) ?? trimmedString(payload.key),
        content,
        createdAt: null,
      };
    }
  }

  return {
    written,
    results,
    query: trimmedString(args.query),
    errorCode: toolErrorCode(result),
  };
}

/** Checklist glyph for one todo status. */
export function todoStatusIcon(status: string): string {
  const s = status.toLowerCase();
  if (s === 'completed') return '✓';
  if (s === 'in_progress') return '●';
  return '○';
}

export function todoStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'completed') return 'ts-done';
  if (s === 'in_progress') return 'ts-active';
  return 'ts-todo';
}

/** "2/5 done" progress line. */
export function summarizeTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'empty plan';
  const done = todos.filter((t) => t.status.toLowerCase() === 'completed').length;
  return `${done}/${todos.length} done`;
}
