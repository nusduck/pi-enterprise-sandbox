/**
 * 审核账本的时间映射（返工单 R1）。
 *
 * **根因**：仓储在**读**路径上用了 `toMysqlDateTime`——那是写库用的 UTC 字面量
 * （`"YYYY-MM-DD HH:mm:ss.sss"`，没有时区）。前端 `new Date("2026-10-01 07:16:16.221")`
 * 会把它当**本地时间**解析，于是在 +08:00 的机器上，列表的提交时间、详情的「提交于」、
 * 审计时间线全都比实际早 8 小时。同一页的版本表是对的，因为那条时间来自 exec 的 ISO 串。
 *
 * 仓库约定（`infrastructure/mysql/row-mappers.ts`）：**读用 `formatDateTime`**（带 `Z` 的
 * ISO），**写用 `toMysqlDateTime`**。#68 修过同一类问题，这里是第二次。
 *
 * 游标也跟着受影响：`encodeCursor` 用的是映射后的 `createdAt`，而 SQL 比较的是库里的
 * DATETIME 列，所以解码时必须转回 MySQL 字面量（见 `review-service` 的 `#decodeCursor`）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  mapEvent,
  mapTask,
} from '../../src/infrastructure/mysql/repositories/review-repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_SRC = join(
  HERE,
  '..',
  '..',
  'src',
  'infrastructure',
  'mysql',
  'repositories',
  'review-repository.ts',
);

/** MySQL 里存的 UTC 挂钟值（无时区）。 */
const MYSQL_UTC = '2026-10-01 07:15:21.581';
const ISO_UTC = '2026-10-01T07:15:21.581Z';

describe('审核账本的时间映射：读路径必须是带时区的 ISO（R1）', () => {
  it('mapTask：created/updated/claimed/decided 都转成 UTC ISO', () => {
    const task = mapTask({
      review_task_id: '01K0G2PAV8FPMVC9QHJG7JPN70',
      org_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
      requester_user_id: '01K0G2PAV8FPMVC9QHJG7JPN50',
      conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN51',
      agent_session_id: '01K0G2PAV8FPMVC9QHJG7JPN52',
      run_id: '01K0G2PAV8FPMVC9QHJG7JPN5H',
      agent_id: '01K0G2PAV8FPMVC9QHJG7JPN5A',
      agent_version_id: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      run_status: 'SUCCEEDED',
      status: 'IN_REVIEW',
      claimed_at: MYSQL_UTC,
      decided_at: MYSQL_UTC,
      created_at: MYSQL_UTC,
      updated_at: MYSQL_UTC,
    });
    assert.equal(task.createdAt, ISO_UTC);
    assert.equal(task.updatedAt, ISO_UTC);
    assert.equal(task.claimedAt, ISO_UTC);
    assert.equal(task.decidedAt, ISO_UTC);
  });

  it('mapEvent：审计时间线的时间同样带时区', () => {
    const event = mapEvent({
      event_id: '01K0G2PAV8FPMVC9QHJG7JPN80',
      event_type: 'created',
      created_at: MYSQL_UTC,
    });
    assert.equal(event.createdAt, ISO_UTC);
  });

  it('空值仍然是 null，不会被伪造成时间', () => {
    const task = mapTask({
      review_task_id: '01K0G2PAV8FPMVC9QHJG7JPN70',
      org_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
      requester_user_id: '01K0G2PAV8FPMVC9QHJG7JPN50',
      conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN51',
      agent_session_id: '01K0G2PAV8FPMVC9QHJG7JPN52',
      run_id: '01K0G2PAV8FPMVC9QHJG7JPN5H',
      agent_id: '01K0G2PAV8FPMVC9QHJG7JPN5A',
      agent_version_id: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      status: 'PENDING',
      created_at: MYSQL_UTC,
    });
    assert.equal(task.claimedAt, null);
    assert.equal(task.decidedAt, null);
  });

  it('仓储的读路径不再用写库用的 toMysqlDateTime（防再次漂移）', () => {
    const src = readFileSync(REPO_SRC, 'utf8');
    assert.doesNotMatch(src, /toMysqlDateTime\(row\./, '读路径必须用 formatDateTime');
    assert.match(src, /formatDateTime\(row\./, '读路径要有 formatDateTime');
    // 写路径仍然是 toMysqlDateTime（不能把这条也改掉）。
    assert.match(src, /toMysqlDateTime\(this\.now\(\)\)/);
  });
});
