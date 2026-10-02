/**
 * 通知场景扩展迁移（design `notification-scenarios.md` §3.1）的静态形状检查：
 * 新列、新唯一键、外键承接顺序与完整回滚。真实 up → down → up 在有历史投递行
 * 的库上走部署前验证，这里只钉住语句形状（与 `exec-jobs-migration` 同一做法）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20261003000002_notification_scenarios.js';

const SOURCE = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/infrastructure/mysql/migrations/20261003000002_notification_scenarios.js',
  ),
  'utf8',
);

describe('notification scenarios migration', () => {
  it('exports reversible up/down', () => {
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
  });

  it('adds the dedupe key with backfill and swaps the uniqueness guard', () => {
    for (const token of [
      'dedupe_key',
      "CONCAT(`kind`, ':', `run_id`)",
      'ind_agsvc_nd_a2',
      'ind_agsvc_nd_i2',
      'ind_agsvc_nd_a1',
    ]) {
      assert.ok(SOURCE.includes(token), `migration mentions ${token}`);
    }
    // 外键承接顺序：先建 run_id 普通索引，再删旧唯一键。
    assert.ok(
      SOURCE.indexOf('ind_agsvc_nd_i2') < SOURCE.lastIndexOf('ind_agsvc_nd_a1'),
      'the run_id index lands before the old unique key is dropped',
    );
  });

  it('adds the three user preferences and backfills the decided one', () => {
    for (const column of ['notify_review_result', 'notify_review_pending', 'notify_run_waiting']) {
      assert.ok(SOURCE.includes(column), `migration mentions ${column}`);
    }
    assert.ok(
      SOURCE.includes('SET `notify_review_result` = `notify_run_complete`'),
      'review-result preference inherits the legacy switch',
    );
  });

  it('adds the cron notify policy with a failure default and rolls everything back', () => {
    assert.ok(SOURCE.includes('notify_policy'));
    assert.ok(SOURCE.includes("'failure'"));
    const downBody = SOURCE.slice(SOURCE.indexOf('export async function down'));
    for (const token of [
      'dedupe_key', 'notify_review_result', 'notify_review_pending', 'notify_run_waiting', 'notify_policy',
    ]) {
      assert.ok(downBody.includes(token), `down rolls back ${token}`);
    }
  });
});
