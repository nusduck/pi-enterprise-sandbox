import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEC_ARTIFACTS_TABLE,
  EXEC_DATASETS_TABLE,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20260904000001_exec_artifacts_datasets.js';

const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/infrastructure/mysql/migrations/20260904000001_exec_artifacts_datasets.js',
);

describe('exec_artifacts / exec_datasets migration', () => {
  it('ships the exec-owned artifact + dataset ledgers through Agent migrations', () => {
    assert.equal(EXEC_ARTIFACTS_TABLE, 'exec_artifacts');
    assert.equal(EXEC_DATASETS_TABLE, 'exec_datasets');
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');

    const source = readFileSync(MIGRATION, 'utf8');
    for (const column of [
      'artifact_id', 'session_id', 'workspace_id', 'org_id', 'user_id', 'name',
      'source_path', 'mime_type', 'sha256', 'size_bytes', 'identity', 'created_at',
    ]) {
      assert.match(source, new RegExp(`['"]${column}['"]`), `exec_artifacts.${column}`);
    }
    for (const column of [
      'dataset_id', 'conversation_id', 'original_filename', 'stored_relative_path',
      'status', 'idempotency_key', 'completed_at',
    ]) {
      assert.match(source, new RegExp(`['"]${column}['"]`), `exec_datasets.${column}`);
    }
    for (const index of [
      'idx_exec_artifacts_session', 'idx_exec_artifacts_workspace', 'idx_exec_artifacts_owner',
      'uniq_exec_datasets_idem', 'idx_exec_datasets_session',
      'idx_exec_datasets_workspace', 'idx_exec_datasets_owner',
    ]) {
      assert.match(source, new RegExp(index));
    }
  });

  it('gives created_at a server-side default because the writers omit it', () => {
    // `MySqlArtifactStore.insert` / `MySqlDatasetStore.insert` 的 INSERT 列表
    // 里没有 created_at；列上没有默认值的话第一次提交就会 1364 报错。
    const source = readFileSync(MIGRATION, 'utf8');
    const defaults = source.match(/CURRENT_TIMESTAMP\(3\)/g) ?? [];
    assert.equal(defaults.length, 2, 'both tables need a CURRENT_TIMESTAMP(3) default');
  });

  it('drops in reverse creation order', () => {
    const source = readFileSync(MIGRATION, 'utf8');
    const datasets = source.indexOf('dropTableIfExists(EXEC_DATASETS_TABLE)');
    const artifacts = source.indexOf('dropTableIfExists(EXEC_ARTIFACTS_TABLE)');
    assert.ok(datasets > 0 && artifacts > 0);
    assert.ok(datasets < artifacts, 'down() must drop datasets before artifacts');
  });
});
