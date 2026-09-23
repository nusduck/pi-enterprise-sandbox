/**
 * Physical table-name prefix required by UPspec (`tbl_<db abbr>_<name>`), applied by
 * migration `20260923000001_upspec_naming.js`. The lists below keep the **logical**
 * names that the earlier migrations created (the orphan gate checks those); use
 * `physicalTableName()` when talking to a fully migrated database.
 */
export const TABLE_PREFIX = 'tbl_agsvc_';

export function physicalTableName(logical: string): string {
  return `${TABLE_PREFIX}${logical}`;
}

/**
 * Ordered list of plan §8 core tables + Sandbox execution-domain tables
 * created by the initial Agent MySQL migration.
 * Used by tests and health checks.
 *
 * Create order respects FK parents. agent_sessions and sandbox_sessions do
 * **not** FK each other (logical indexed refs only — see migration header).
 */
export const CORE_TABLES_CREATE_ORDER = Object.freeze([
  'organizations',
  'users',
  'organization_memberships',
  'agent_definitions',
  'agent_versions',
  'conversations',
  'agent_sessions',
  'agent_session_snapshots',
  'messages',
  'runs',
  'run_events',
  'tool_executions',
  'sandbox_sessions',
  'process_executions',
  'sandbox_executions',
  'sandbox_audit_events',
  'datasets',
  'artifacts',
  'approvals',
  'domain_outbox',
  'idempotency_records',
]);

/** A2A protocol tables (PR-12 migration 20260718000009) — not part of core PR-02 set. */
export const A2A_TABLES = Object.freeze([
  'a2a_api_credentials',
  'a2a_tasks',
  'a2a_audit_events',
]);

/** Durable observability tables (created by the trace projection migration). */
export const TRACE_TABLES = Object.freeze(['trace_spans']);

/** Durable WAITING_INPUT interaction facts. */
export const INTERACTION_TABLES = Object.freeze(['run_interactions']);

/** Agent working memory: session todo list + owner-scoped note log. */
export const TASK_STATE_TABLES = Object.freeze([
  'task_todos',
  'task_memories',
]);

export const CORE_TABLES_DROP_ORDER = Object.freeze(
  [...CORE_TABLES_CREATE_ORDER].reverse(),
);

/** Sandbox-owned execution domain tables (present in the same migration). */
export const SANDBOX_EXECUTION_DOMAIN_TABLES = Object.freeze([
  'sandbox_sessions',
  'process_executions',
  'sandbox_executions',
  'sandbox_audit_events',
  'datasets',
  'artifacts',
]);
