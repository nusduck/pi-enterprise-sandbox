/**
 * `data-sources.ts`：请求携带的数据源清单校验与环境变量命名。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContractError } from '../src/errors.js';
import {
  ENABLED_DATA_SOURCES_MAX,
  dataSourceEnvPrefix,
  parseEnabledDataSources,
} from '../src/data-sources.js';

function rejects(value: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseEnabledDataSources(value),
    (err: unknown) => err instanceof ContractError && err.code === 'ENVELOPE_INVALID' && pattern.test(err.message),
  );
}

describe('parseEnabledDataSources', () => {
  it('treats a missing list as empty', () => {
    assert.deepEqual(parseEnabledDataSources(undefined), []);
    assert.deepEqual(parseEnabledDataSources(null), []);
  });

  it('accepts ids and de-duplicates in first-seen order', () => {
    assert.deepEqual(parseEnabledDataSources(['employees', 'sales_2026', 'employees']), ['employees', 'sales_2026']);
  });

  it('rejects non-arrays and malformed ids instead of dropping them', () => {
    rejects('employees', /must be an array/);
    rejects([{ id: 'employees' }], /data source ids/);
    rejects(['Employees'], /data source ids/);
    rejects(['1st'], /data source ids/);
    rejects(['a-b'], /data source ids/);
    rejects(['x'.repeat(33)], /data source ids/);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: ENABLED_DATA_SOURCES_MAX + 1 }, (_, i) => `db${i}`);
    rejects(many, /at most/);
  });
});

describe('dataSourceEnvPrefix', () => {
  it('upper-cases the id under the reserved prefix', () => {
    assert.equal(dataSourceEnvPrefix('sales_2026'), 'DSH_DB_SALES_2026_');
  });
});
