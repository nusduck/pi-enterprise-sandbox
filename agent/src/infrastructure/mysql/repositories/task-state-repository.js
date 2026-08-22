/**
 * Task-state repository — the agent's durable todo list and note log.
 *
 * Owner-scoped like every other repository: org_id + user_id are part of every
 * predicate, never a filter the caller may omit. Two shapes:
 *
 * - todos: one list per AgentSession, replaced wholesale (`replaceTodos`) and
 *   read back in list order (`getTodos`).
 * - memories: append-only per owner (`appendMemory`), searched newest-first
 *   with a bounded LIKE (`searchMemory`).
 *
 * `replaceTodos` deletes then inserts, so it must run inside the caller's
 * transaction to be atomic — the store port in the container hands it one.
 */

import { assertUlid } from '../../../domain/shared/ulid.js';
import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';

/** Statuses a todo item may hold. */
export const TODO_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed',
]);

export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_CONTENT_CHARS = 1024;
export const MAX_MEMORY_CONTENT_CHARS = 8_000;
export const MAX_MEMORY_KEY_CHARS = 191;
export const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
export const MEMORY_SEARCH_MAX_LIMIT = 50;

/**
 * @param {Record<string, unknown>} row
 */
export function mapTodo(row) {
  return {
    todoId: String(row.todo_id),
    agentSessionId: String(row.agent_session_id),
    runId: row.run_id == null ? null : String(row.run_id),
    position: Number(row.position),
    content: String(row.content),
    status: String(row.status),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapMemory(row) {
  return {
    memoryId: String(row.memory_id),
    agentSessionId:
      row.agent_session_id == null ? null : String(row.agent_session_id),
    runId: row.run_id == null ? null : String(row.run_id),
    key: row.memory_key == null ? null : String(row.memory_key),
    content: String(row.content),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * Bound a model-authored string: strip C0 controls (keep newlines in notes),
 * collapse runs of whitespace for todos, and cut to the column width.
 *
 * @param {unknown} value
 * @param {number} maxChars
 * @param {{ keepNewlines?: boolean }} [opts]
 * @returns {string}
 */
export function boundText(value, maxChars, opts = {}) {
  const raw = String(value ?? '');
  const stripped = opts.keepNewlines
    ? // Keep \n and \t so a multi-line note stays readable.
      raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    : raw
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ');
  return stripped.trim().slice(0, maxChars);
}

/**
 * @param {unknown} status
 * @returns {string}
 */
export function assertTodoStatus(status) {
  const s = String(status ?? '').trim().toLowerCase();
  if (!TODO_STATUSES.includes(s)) {
    throw new Error(
      `todo status must be one of ${TODO_STATUSES.join(', ')}`,
    );
  }
  return s;
}

export class TaskStateRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date, generateId?: () => string }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('TaskStateRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.generateId = opts.generateId ?? null;
  }

  #newId(field) {
    if (typeof this.generateId !== 'function') {
      throw new Error('TaskStateRepository requires generateId() for writes');
    }
    return assertUlid(this.generateId(), field);
  }

  /**
   * Replace this session's whole todo list.
   *
   * Wholesale replacement is the contract, not an optimisation: the model
   * always restates the full plan, so a partial merge would resurrect items it
   * deliberately dropped.
   *
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   agentSessionId: string,
   *   runId?: string | null,
   *   items: Array<{ content: string, status?: string }>,
   * }} input
   */
  async replaceTodos(input) {
    const scope = requireOwnerScope(input);
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const runId = input.runId ? assertUlid(input.runId, 'runId') : null;
    if (!Array.isArray(input.items)) {
      throw new Error('replaceTodos requires an items array');
    }
    if (input.items.length > MAX_TODO_ITEMS) {
      throw new Error(`todo list is capped at ${MAX_TODO_ITEMS} items`);
    }

    await applyOwnerScope(
      this.db('task_todos').where({ agent_session_id: agentSessionId }),
      scope,
    ).delete();

    const now = toMysqlDateTime(this.now());
    let position = 0;
    for (const item of input.items) {
      const content = boundText(item?.content, MAX_TODO_CONTENT_CHARS);
      if (!content) continue;
      position += 1;
      await this.db('task_todos').insert({
        todo_id: this.#newId('todoId'),
        org_id: scope.orgId,
        user_id: scope.userId,
        agent_session_id: agentSessionId,
        run_id: runId,
        position,
        content,
        status: assertTodoStatus(item?.status ?? 'pending'),
        created_at: now,
        updated_at: now,
      });
    }
    return this.getTodos({ ...scope, agentSessionId });
  }

  /**
   * @param {{ orgId: string, userId: string, agentSessionId: string }} input
   */
  async getTodos(input) {
    const scope = requireOwnerScope(input);
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const rows = await applyOwnerScope(
      this.db('task_todos').where({ agent_session_id: agentSessionId }),
      scope,
    )
      .orderBy('position', 'asc')
      .limit(MAX_TODO_ITEMS);
    return rows.map(mapTodo);
  }

  /**
   * Append one owner-scoped note.
   *
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   agentSessionId?: string | null,
   *   runId?: string | null,
   *   key?: string | null,
   *   content: string,
   * }} input
   */
  async appendMemory(input) {
    const scope = requireOwnerScope(input);
    const content = boundText(input.content, MAX_MEMORY_CONTENT_CHARS, {
      keepNewlines: true,
    });
    if (!content) {
      throw new Error('appendMemory requires non-empty content');
    }
    const key = input.key == null ? null : boundText(input.key, MAX_MEMORY_KEY_CHARS);
    const memoryId = this.#newId('memoryId');
    await this.db('task_memories').insert({
      memory_id: memoryId,
      org_id: scope.orgId,
      user_id: scope.userId,
      agent_session_id: input.agentSessionId
        ? assertUlid(input.agentSessionId, 'agentSessionId')
        : null,
      run_id: input.runId ? assertUlid(input.runId, 'runId') : null,
      memory_key: key || null,
      content,
      created_at: toMysqlDateTime(this.now()),
    });
    const row = await applyOwnerScope(
      this.db('task_memories').where({ memory_id: memoryId }),
      scope,
    ).first();
    return row ? mapMemory(row) : null;
  }

  /**
   * Newest owner-scoped notes matching a substring of the key or the content.
   *
   * An empty query returns the most recent notes rather than everything, so a
   * model asking "what do I know" gets a bounded, useful answer.
   *
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   query?: string | null,
   *   limit?: number,
   * }} input
   */
  async searchMemory(input) {
    const scope = requireOwnerScope(input);
    const limit = boundLimit(input.limit);
    const query = boundText(input.query, MAX_MEMORY_KEY_CHARS);
    let q = applyOwnerScope(this.db('task_memories'), scope);
    if (query) {
      // Escape LIKE wildcards so a literal % or _ in the query cannot widen it.
      const needle = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((builder) =>
        builder
          .where('content', 'like', needle)
          .orWhere('memory_key', 'like', needle),
      );
    }
    const rows = await q.orderBy('created_at', 'desc').limit(limit);
    return rows.map(mapMemory);
  }
}

/**
 * @param {unknown} limit
 */
function boundLimit(limit) {
  if (limit == null || limit === '') return MEMORY_SEARCH_DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isSafeInteger(n) || n < 1) return MEMORY_SEARCH_DEFAULT_LIMIT;
  return Math.min(n, MEMORY_SEARCH_MAX_LIMIT);
}

Object.freeze(TaskStateRepository.prototype);
