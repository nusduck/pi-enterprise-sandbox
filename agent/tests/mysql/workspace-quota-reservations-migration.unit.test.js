import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_QUOTA_RESERVATIONS_TABLE,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20260904000002_workspace_quota_reservations.js';

const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/infrastructure/mysql/migrations/20260904000002_workspace_quota_reservations.js',
);

describe('workspace_quota_reservations migration', () => {
  it('ships the exec-owned quota ledger through Agent migrations', () => {
    assert.equal(WORKSPACE_QUOTA_RESERVATIONS_TABLE, 'workspace_quota_reservations');
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
    const source = readFileSync(MIGRATION, 'utf8');
    for (const column of ['workspace_id', 'reservation_id', 'bytes', 'created_at', 'updated_at']) {
      assert.match(source, new RegExp(`['"]${column}['"]`), column);
    }
  });

  it('keys on (workspace_id, reservation_id) so sumReserved() has a covering prefix', () => {
    const source = readFileSync(MIGRATION, 'utf8');
    assert.match(source, /primary\(\['workspace_id', 'reservation_id'\]/);
  });

  it('gives both timestamps server-side defaults because the writer omits them', () => {
    // `MySqlQuotaStore.putReservation` 的 INSERT 只写 workspace_id/reservation_id/bytes。
    const source = readFileSync(MIGRATION, 'utf8');
    assert.match(source, /knex\.raw\('CURRENT_TIMESTAMP\(3\)'\)/);
    assert.match(source, /ON UPDATE CURRENT_TIMESTAMP\(3\)/);
  });
});
