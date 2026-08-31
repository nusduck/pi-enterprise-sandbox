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

/**
 * memory 工具（ADR 0009 D10：**本阶段不做**）。
 *
 * 名字留着是为了历史会话：2026-08-31 之前的 Run 里有 `memory_write` /
 * `memory_search` 的调用记录，卡片要能继续渲染它们。新的 Run 不会再产生这两个
 * 工具——它们在风险表里被映射成退役（理由码 `TOOL_RETIRED`），根本调不动。
 */
export function isMemoryToolName(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  return n === 'memory_write' || n === 'memory_search';
}

export function isTaskStateToolName(name: string | null | undefined): boolean {
  return isTodoToolName(name) || isMemoryToolName(name);
}

/**
 * Todo items.
 *
 * ## 2026-08-31（ADR 0009 / 计划 H9.1）：清单在 **arguments** 里，不在 result 里
 *
 * 出厂 `dsh-tool-todo` 的 tool result 只有一句
 * `Updated todo list: <n> pending, <m> in progress, <k> completed.`，
 * canonical value 是 `{ counts: {...} }` —— **不含 todos 数组**。清单在
 * `arguments.todos` 与 `todo/write` 这个 session event 里
 * （证据：`docs/evidence/2026-08-31-dsh-tool-registry.md` 附录 H0.5）。
 *
 * 所以取值顺序改成 **arguments 优先**。旧的「result 优先」在换到出厂工具之后
 * 会取到 `undefined`，卡片静默退化成一行文本——没有报错，只是清单没了。
 *
 * 三个来源都留着，因为历史会话里三种形状都存在：
 * - `arguments.todos`  出厂 `tool-todo`（当前）
 * - `arguments.items`  旧 Pi `task-state` extension
 * - `result.todos`     旧 Pi 的结果形状
 *
 * @param input `todo_write` arguments
 * @param result the tool result, when it has arrived
 */
export function parseTodoFields(input: unknown, result?: unknown): TodoFields {
  const payload = parseToolResultJson(result);
  const stored = payload && Array.isArray(payload.todos) ? payload.todos : null;
  const args = isPlainObject(input)
    ? Array.isArray(input.todos)
      ? input.todos
      : Array.isArray(input.items)
        ? input.items
        : null
    : null;
  const source = args ?? stored ?? [];

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
