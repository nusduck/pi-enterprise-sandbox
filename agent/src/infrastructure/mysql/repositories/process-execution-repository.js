/** Owner-scoped access to durable managed-process metadata. */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { formatDateTime, parseJsonColumn } from '../row-mappers.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

/** @param {Record<string, unknown>} row */
export function mapProcessExecution(row) {
  const commandJson = parseJsonColumn(row.command_json) || {};
  return {
    processId: String(row.process_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    sandboxSessionId: String(row.sandbox_session_id),
    runId: String(row.run_id),
    executionId: String(row.execution_id),
    commandJson,
    command: String(commandJson.command || ''),
    status: String(row.status).toLowerCase(),
    pid: row.pid == null ? null : Number(row.pid),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    stdoutPath: row.stdout_path == null ? null : String(row.stdout_path),
    stderrPath: row.stderr_path == null ? null : String(row.stderr_path),
    startedAt: formatDateTime(row.started_at),
    endedAt: formatDateTime(row.ended_at),
    createdAt: formatDateTime(row.created_at),
  };
}

export class ProcessExecutionRepository {
  /** @param {import('knex').Knex | import('knex').Knex.Transaction} db */
  constructor(db) {
    if (!db) throw new Error('ProcessExecutionRepository requires a knex executor');
    this.db = db;
  }

  async getById(processId, scope) {
    const id = assertUlid(processId, 'processId');
    const owner = requireOwnerScope(scope);
    const row = await applyOwnerScope(
      this.db('process_executions').where({ process_id: id }),
      owner,
    ).first();
    return row ? mapProcessExecution(row) : null;
  }

  async list(scope, filters = {}) {
    const owner = requireOwnerScope(scope);
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    let query = applyOwnerScope(this.db('process_executions'), owner);
    if (filters.runId) query = query.where('run_id', assertUlid(filters.runId, 'runId'));
    if (filters.sandboxSessionId) {
      query = query.where(
        'sandbox_session_id',
        assertUlid(filters.sandboxSessionId, 'sandboxSessionId'),
      );
    }
    if (filters.status) query = query.where('status', String(filters.status));
    const rows = await query.orderBy('created_at', 'desc').limit(limit);
    return rows.map(mapProcessExecution);
  }
}
