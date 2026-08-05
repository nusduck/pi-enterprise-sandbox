/**
 * Sandbox horizontal scale-out: node registry + workspace placement.
 *
 * The Sandbox service is node-affine by physical necessity — a workspace lives
 * on one pod's local volume, and a managed child process can only be read or
 * signalled from the pod that spawned it. Multi-pod operation therefore needs a
 * durable `workspace -> node` binding plus a node registry to resolve it.
 *
 * Additive nullable columns only (EXPAND). No backfill, no NOT NULL, no status
 * ENUM/CHECK — consistent with 20260718000008. `node_id` values are Kubernetes
 * StatefulSet pod names (`sandbox-0`), or `sandbox-0` under Compose.
 *
 * Deliberately no FK from placement columns to `sandbox_nodes`: a node row is
 * removed on scale-down while its sessions/processes rows must survive as
 * history. Placement columns are logical refs, same convention as
 * `sandbox_sessions.agent_session_id` in the core schema.
 */

export const IDX_SANDBOX_NODES_LIVENESS = 'idx_sandbox_nodes_liveness';
export const IDX_SANDBOX_SESSIONS_NODE = 'idx_sandbox_sessions_node';
export const IDX_PROCESS_EXECUTIONS_NODE = 'idx_process_executions_node';
export const IDX_TOOL_EXECUTIONS_LEASE = 'idx_tool_executions_lease';

/** Width of every placement node identifier column. */
export const NODE_ID_LENGTH = 64;

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  // Node registry. One row per Sandbox replica; `generation` increments on every
  // process start so orphan recovery can tell "rows my previous incarnation left
  // behind" from "rows I am currently serving".
  await knex.schema.createTable('sandbox_nodes', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.string('node_id', NODE_ID_LENGTH).primary();
    // Routable base URL authority for the internal plane, e.g.
    // "sandbox-0.sandbox-headless.pi.svc.cluster.local:8081".
    t.string('address', 255).notNullable();
    // ACTIVE | DRAINING | GONE. VARCHAR, not ENUM — status vocabularies stay in
    // application code so they can grow without DDL.
    t.string('status', 32).notNullable();
    t.bigInteger('generation').unsigned().notNullable();
    t.specificType('started_at', 'DATETIME(3)').notNullable();
    t.specificType('heartbeat_at', 'DATETIME(3)').notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.specificType('updated_at', 'DATETIME(3)').notNullable();
    // Placement candidate scan: WHERE status = 'ACTIVE' AND heartbeat_at > ?
    t.index(['status', 'heartbeat_at'], IDX_SANDBOX_NODES_LIVENESS);
  });

  // Workspace placement. NULL means "not yet placed" — assigned exactly once by
  // sessions/ensure and never rewritten while the session is open.
  await knex.schema.alterTable('sandbox_sessions', (t) => {
    t.string('node_id', NODE_ID_LENGTH).nullable();
  });
  await knex.schema.alterTable('sandbox_sessions', (t) => {
    // Least-loaded placement counts open sessions per node.
    t.index(['node_id', 'status'], IDX_SANDBOX_SESSIONS_NODE);
  });

  // Process ownership. Without these columns a starting pod reaps every other
  // pod's live processes, because recovery scans all globally active rows.
  await knex.schema.alterTable('process_executions', (t) => {
    t.string('node_id', NODE_ID_LENGTH).nullable();
    t.bigInteger('node_generation').unsigned().nullable();
  });
  await knex.schema.alterTable('process_executions', (t) => {
    t.index(['node_id', 'status'], IDX_PROCESS_EXECUTIONS_NODE);
  });

  // Artifact blobs stay on the producing node's local volume this round, so a
  // download must be routed there. Becomes unused once artifacts move to object
  // storage.
  await knex.schema.alterTable('artifacts', (t) => {
    t.string('storage_node_id', NODE_ID_LENGTH).nullable();
  });

  // Execution-owner lease. A SIGKILLed pod cannot run its own in-flight
  // reconciliation, so claims carry an owner + expiry that a sweeper reaps.
  await knex.schema.alterTable('tool_executions', (t) => {
    t.string('owner_node_id', NODE_ID_LENGTH).nullable();
    t.specificType('lease_expires_at', 'DATETIME(3)').nullable();
  });
  await knex.schema.alterTable('tool_executions', (t) => {
    // Sweeper scan: WHERE status = ? AND lease_expires_at < ?
    t.index(['status', 'lease_expires_at'], IDX_TOOL_EXECUTIONS_LEASE);
  });
}

/**
 * Down order: drop indexes before their columns, table last.
 *
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('tool_executions', (t) => {
    t.dropIndex(['status', 'lease_expires_at'], IDX_TOOL_EXECUTIONS_LEASE);
  });
  await knex.schema.alterTable('tool_executions', (t) => {
    t.dropColumn('lease_expires_at');
    t.dropColumn('owner_node_id');
  });

  await knex.schema.alterTable('artifacts', (t) => {
    t.dropColumn('storage_node_id');
  });

  await knex.schema.alterTable('process_executions', (t) => {
    t.dropIndex(['node_id', 'status'], IDX_PROCESS_EXECUTIONS_NODE);
  });
  await knex.schema.alterTable('process_executions', (t) => {
    t.dropColumn('node_generation');
    t.dropColumn('node_id');
  });

  await knex.schema.alterTable('sandbox_sessions', (t) => {
    t.dropIndex(['node_id', 'status'], IDX_SANDBOX_SESSIONS_NODE);
  });
  await knex.schema.alterTable('sandbox_sessions', (t) => {
    t.dropColumn('node_id');
  });

  await knex.schema.dropTableIfExists('sandbox_nodes');
}
