/**
 * Durable task state: the agent's own todo list and long-term notes.
 *
 * Both are agent-authored working memory, but their lifetimes differ, which is
 * why they are two tables rather than one:
 *
 * - `task_todos` is the *current* plan for one AgentSession. It is replaced
 *   wholesale on every write (the model always sends the full list), so the
 *   session id plus a position is the natural identity and stale rows are
 *   deleted rather than accumulated.
 * - `task_memories` is an append-only note log scoped to the owner, not the
 *   session, so a fact learned in one conversation is still searchable in the
 *   next one. Nothing overwrites a note; search reads the newest matches.
 *
 * Both are ordinary owner-scoped tables: every read and write carries
 * org_id + user_id, so one tenant's plan or notes can never reach another.
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const TASK_TODOS_TABLE = 'task_todos';
export const TASK_MEMORIES_TABLE = 'task_memories';

const ID_TYPE = 'CHAR(26)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(TASK_TODOS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('todo_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('user_id', ID_TYPE).notNullable();
      t.specificType('agent_session_id', ID_TYPE).notNullable();
      // The Run that last wrote this item; nullable so a todo outlives it.
      t.specificType('run_id', ID_TYPE).nullable();
      t.integer('position').notNullable();
      t.string('content', 1024).notNullable();
      t.string('status', 16).notNullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable();
      t.specificType('updated_at', 'DATETIME(3)').notNullable();

      t.primary(['todo_id'], 'pk_task_todos');
      // One list per session: position is the list order, not a free column.
      t.unique(['agent_session_id', 'position'], 'uk_task_todos_position');
      t.index(
        ['org_id', 'user_id', 'agent_session_id', 'position'],
        'idx_task_todos_owner_session',
      );
      t.foreign('org_id').references('organizations.org_id');
      t.foreign('user_id').references('users.user_id');
      t.foreign('agent_session_id').references(
        'agent_sessions.agent_session_id',
      );
    });

    await tracker.createTable(TASK_MEMORIES_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('memory_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('user_id', ID_TYPE).notNullable();
      t.specificType('agent_session_id', ID_TYPE).nullable();
      t.specificType('run_id', ID_TYPE).nullable();
      // Optional caller-supplied topic. 191 keeps the index inside the utf8mb4
      // 767-byte prefix limit on older row formats.
      t.string('memory_key', 191).nullable();
      t.text('content').notNullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable();

      t.primary(['memory_id'], 'pk_task_memories');
      t.index(
        ['org_id', 'user_id', 'created_at'],
        'idx_task_memories_owner_recent',
      );
      t.index(
        ['org_id', 'user_id', 'memory_key'],
        'idx_task_memories_owner_key',
      );
      t.foreign('org_id').references('organizations.org_id');
      t.foreign('user_id').references('users.user_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(TASK_MEMORIES_TABLE);
  await knex.schema.dropTableIfExists(TASK_TODOS_TABLE);
}
