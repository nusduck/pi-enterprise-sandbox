/**
 * task-state Extension.
 *
 * Gives the agent two pieces of durable working memory that survive a Run:
 *
 * - a todo list scoped to this AgentSession (`todo_write` / `todo_read`), so a
 *   multi-Run conversation keeps one plan instead of re-deriving it from the
 *   transcript after every compaction;
 * - an append-only note log scoped to the owner (`memory_write` /
 *   `memory_search`), so a fact learned in one conversation is retrievable in
 *   the next one.
 *
 * Both go through `deps.taskStateStore`, the same port pattern the rest of the
 * bundle uses. The extension never touches MySQL: the store is the boundary,
 * and it is owner-scoped by the container, so a tool argument can never widen
 * the scope of a read or a write.
 */

import { Type } from 'typebox';
import { toolErr, toolOk, toolResultJson } from '../sandbox-bridge/result.js';
import { TASK_STATE_TOOL_NAMES } from './constants.js';

export { TASK_STATE_TOOL_NAMES };

const MAX_TODO_ITEMS = 50;
const MAX_TODO_CONTENT = 1024;
const MAX_MEMORY_CONTENT = 8_000;
const MAX_MEMORY_KEY = 191;
const MAX_SEARCH_RESULTS = 50;

/**
 * @param {{
 *   runContext: { runId: string, orgId: string, userId: string, agentSessionId: string },
 *   deps?: {
 *     taskStateStore?: {
 *       replaceTodos?: Function,
 *       getTodos?: Function,
 *       appendMemory?: Function,
 *       searchMemory?: Function,
 *     } | null,
 *   },
 * }} options
 */
export function createTaskStateExtension(options) {
  const runContext = options?.runContext;
  const store = options?.deps?.taskStateStore ?? null;
  const scope = () => ({
    orgId: runContext.orgId,
    userId: runContext.userId,
    agentSessionId: runContext.agentSessionId,
    runId: runContext.runId,
  });

  /**
   * @param {'replaceTodos' | 'getTodos' | 'appendMemory' | 'searchMemory'} method
   */
  function storeFor(method) {
    return store && typeof store[method] === 'function' ? store[method] : null;
  }

  /**
   * @param {string} method
   */
  function storeUnavailable(method) {
    return toolErr(
      'TASK_STATE_STORE_UNAVAILABLE',
      `durable ${method} store is required for task state`,
    );
  }

  /**
   * @param {unknown} error
   * @param {string} fallbackCode
   */
  function storeError(error, fallbackCode) {
    const code = String(
      /** @type {{ code?: string }} */ (error)?.code || fallbackCode,
    );
    const message =
      error instanceof Error ? error.message : String(error ?? 'failed');
    return toolErr(code, message);
  }

  /**
   * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
   */
  function taskStateExtension(pi) {
    pi.registerTool({
      name: 'todo_write',
      label: 'Write todo list',
      description:
        'Replace this conversation’s todo list with the complete current plan. Always send every item, including the ones already completed.',
      promptSnippet:
        'Keep a durable todo list for multi-step work instead of replanning each turn',
      promptGuidelines: [
        'Send the whole list every time: this replaces the stored list rather than merging into it.',
        'Keep exactly one item in_progress while you work on it, and mark it completed before starting the next.',
      ],
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            content: Type.String({ minLength: 1, maxLength: MAX_TODO_CONTENT }),
            status: Type.Optional(
              Type.Union([
                Type.Literal('pending'),
                Type.Literal('in_progress'),
                Type.Literal('completed'),
              ]),
            ),
          }),
          { maxItems: MAX_TODO_ITEMS },
        ),
      }),
      async execute(_toolCallId, input) {
        const replaceTodos = storeFor('replaceTodos');
        if (!replaceTodos) return storeUnavailable('todo');
        try {
          const todos = await replaceTodos({ ...scope(), items: input.items });
          return toolOk(toolResultJson({ todos: projectTodos(todos) }), {
            count: Array.isArray(todos) ? todos.length : 0,
          });
        } catch (error) {
          return storeError(error, 'TODO_WRITE_FAILED');
        }
      },
    });

    pi.registerTool({
      name: 'todo_read',
      label: 'Read todo list',
      description:
        'Read this conversation’s stored todo list, including items written by earlier runs.',
      promptSnippet: 'Recover the current plan after a restart or compaction',
      parameters: Type.Object({}),
      async execute() {
        const getTodos = storeFor('getTodos');
        if (!getTodos) return storeUnavailable('todo');
        try {
          const todos = await getTodos(scope());
          return toolOk(toolResultJson({ todos: projectTodos(todos) }), {
            count: Array.isArray(todos) ? todos.length : 0,
          });
        } catch (error) {
          return storeError(error, 'TODO_READ_FAILED');
        }
      },
    });

    pi.registerTool({
      name: 'memory_write',
      label: 'Remember',
      description:
        'Append one durable note for this user. Notes outlive the conversation and are found again with memory_search.',
      promptSnippet:
        'Record a durable fact worth remembering in later conversations',
      promptGuidelines: [
        'Write facts that stay true (preferences, project conventions, stable decisions), not transient run state — the todo list is for that.',
        'Give a short key so the note can be found later by topic.',
      ],
      parameters: Type.Object({
        content: Type.String({ minLength: 1, maxLength: MAX_MEMORY_CONTENT }),
        key: Type.Optional(Type.String({ maxLength: MAX_MEMORY_KEY })),
      }),
      async execute(_toolCallId, input) {
        const appendMemory = storeFor('appendMemory');
        if (!appendMemory) return storeUnavailable('memory');
        try {
          const memory = await appendMemory({
            ...scope(),
            key: input.key ?? null,
            content: input.content,
          });
          return toolOk(
            toolResultJson({
              memoryId: memory?.memoryId ?? null,
              key: memory?.key ?? null,
              stored: true,
            }),
            { memoryId: memory?.memoryId ?? null },
          );
        } catch (error) {
          return storeError(error, 'MEMORY_WRITE_FAILED');
        }
      },
    });

    pi.registerTool({
      name: 'memory_search',
      label: 'Search memory',
      description:
        'Search this user’s durable notes by substring of the key or the content. An empty query returns the most recent notes.',
      promptSnippet: 'Look up durable notes recorded in earlier conversations',
      parameters: Type.Object({
        query: Type.Optional(Type.String({ maxLength: MAX_MEMORY_KEY })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS }),
        ),
      }),
      async execute(_toolCallId, input) {
        const searchMemory = storeFor('searchMemory');
        if (!searchMemory) return storeUnavailable('memory');
        try {
          const memories = await searchMemory({
            ...scope(),
            query: input.query ?? null,
            limit: input.limit ?? null,
          });
          const results = (Array.isArray(memories) ? memories : []).map(
            (memory) => ({
              memoryId: memory.memoryId,
              ...(memory.key ? { key: memory.key } : {}),
              content: memory.content,
              createdAt: memory.createdAt,
            }),
          );
          return toolOk(
            toolResultJson({ count: results.length, memories: results }),
            { count: results.length },
          );
        } catch (error) {
          return storeError(error, 'MEMORY_SEARCH_FAILED');
        }
      },
    });
  }

  taskStateExtension.extensionName = 'task-state';
  taskStateExtension.toolNames = TASK_STATE_TOOL_NAMES;
  return taskStateExtension;
}

/**
 * @param {unknown} todos
 */
function projectTodos(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.map((todo) => ({
    position: todo.position,
    content: todo.content,
    status: todo.status,
  }));
}
