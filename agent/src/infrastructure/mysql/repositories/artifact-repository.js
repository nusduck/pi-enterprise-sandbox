/**
 * Minimal owner-scoped Artifact repository for A2A GetTask / download authority.
 * MySQL artifacts table is the durable authority (plan §8.15).
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { formatDateTime } from '../row-mappers.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

/**
 * @param {Record<string, unknown>} row
 */
export function mapArtifact(row) {
  return {
    artifactId: String(row.artifact_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    agentSessionId: String(row.agent_session_id),
    runId: String(row.run_id),
    /** Internal relative path — never expose on A2A wire. */
    relativePath: String(row.relative_path),
    displayName: String(row.display_name),
    mimeType: row.mime_type == null ? null : String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    status: String(row.status),
    createdAt: formatDateTime(row.created_at),
  };
}

export class ArtifactRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   */
  constructor(db) {
    if (!db) throw new Error('ArtifactRepository requires a knex executor');
    this.db = db;
  }

  /**
   * @param {string} artifactId
   * @param {{ orgId: string, userId: string }} scope
   */
  async getById(artifactId, scope) {
    const id = assertUlid(artifactId, 'artifactId');
    const s = requireOwnerScope(scope);
    const row = await applyOwnerScope(
      this.db('artifacts').where({ artifact_id: id }),
      s,
    ).first();
    return row ? mapArtifact(row) : null;
  }

  /**
   * List artifacts for a run under owner scope (complete, bounded).
   *
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ limit?: number }} [opts]
   */
  async listByRunId(runId, scope, opts = {}) {
    const rid = assertUlid(runId, 'runId');
    const s = requireOwnerScope(scope);
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
    const rows = await applyOwnerScope(
      this.db('artifacts').where({ run_id: rid }),
      s,
    )
      .orderBy('created_at', 'asc')
      .limit(limit + 1);
    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;
    return {
      artifacts: page.map(mapArtifact),
      truncated,
      limit,
    };
  }
}
