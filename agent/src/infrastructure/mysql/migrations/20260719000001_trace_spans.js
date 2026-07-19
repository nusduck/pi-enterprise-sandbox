/**
 * Durable distributed-trace projection (plan §6.2 / §19.10).
 *
 * This is deliberately a small formal MySQL projection rather than a
 * process-local OpenTelemetry exporter.  Run/event, tool, Sandbox and
 * artifact facts can therefore be re-projected after an Agent restart while
 * ownership remains enforced by the same org/user key used by the domain
 * repositories.
 *
 * @param {import('knex').Knex} knex
 */

export const TRACE_SPANS_TABLE = 'trace_spans';

const TRACE_ID_TYPE = 'CHAR(32) CHARACTER SET ascii COLLATE ascii_bin';
const SPAN_ID_TYPE = 'CHAR(16) CHARACTER SET ascii COLLATE ascii_bin';

export async function up(knex) {
  await knex.schema.createTable(TRACE_SPANS_TABLE, (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    // W3C ids are binary-stable and lowercase at the repository boundary.
    t.specificType('trace_id', TRACE_ID_TYPE).notNullable();
    t.specificType('span_id', SPAN_ID_TYPE).notNullable();
    t.specificType('parent_span_id', SPAN_ID_TYPE).nullable();

    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('conversation_id', 'CHAR(26)').nullable();
    t.specificType('agent_session_id', 'CHAR(26)').nullable();
    t.specificType('run_id', 'CHAR(26)').nullable();
    t.specificType('sandbox_session_id', 'CHAR(26)').nullable();
    t.specificType('execution_id', 'CHAR(26)').nullable();
    t.specificType('tool_execution_id', 'CHAR(26)').nullable();
    t.specificType('artifact_id', 'CHAR(26)').nullable();

    t.string('kind', 32).notNullable();
    t.string('name', 255).notNullable();
    t.string('status', 32).notNullable();
    t.specificType('started_at', 'DATETIME(3)').notNullable();
    t.specificType('finished_at', 'DATETIME(3)').nullable();
    t.bigInteger('duration_ms').nullable();
    t.bigInteger('token_count').nullable();
    t.decimal('cost', 20, 8).nullable();
    t.json('attributes_json').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.specificType('updated_at', 'DATETIME(3)').notNullable();

    t.primary(['trace_id', 'span_id'], 'pk_trace_spans');
    t.index(['org_id', 'user_id', 'trace_id', 'started_at'], 'idx_trace_spans_owner');
    t.index(['org_id', 'user_id', 'run_id', 'started_at'], 'idx_trace_spans_run');
    t.index(['trace_id', 'parent_span_id'], 'idx_trace_spans_parent');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('run_id').references('runs.run_id');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(TRACE_SPANS_TABLE);
}

