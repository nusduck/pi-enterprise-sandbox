import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEC_JOBS_TABLE,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20260901000001_exec_jobs.js';

describe('exec_jobs migration', () => {
  it('ships the exec-owned process ledger through Agent migrations', () => {
    assert.equal(EXEC_JOBS_TABLE, 'exec_jobs');
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../src/infrastructure/mysql/migrations/20260901000001_exec_jobs.js',
      ),
      'utf8',
    );
    for (const column of [
      'process_id', 'org_id', 'user_id', 'workspace_id', 'run_id', 'status',
      'output_limit_bytes', 'pid', 'pgid', 'start_identity', 'exit_code',
      'reported', 'started_at', 'finished_at', 'created_at',
    ]) {
      assert.match(source, new RegExp(`['\"]${column}['\"]`));
    }
    for (const index of [
      'idx_exec_jobs_owner', 'idx_exec_jobs_run',
      'idx_exec_jobs_status', 'idx_exec_jobs_created',
    ]) {
      assert.match(source, new RegExp(index));
    }
  });
});
