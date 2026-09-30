/**
 * skill-usage 的**分层归并**（ADR 0015 D1/D7 / design §7.4）。
 *
 * 层归属由那次 Run 的 AgentVersion 引用账本决定：账本只记 system / org 两层，
 * 「不在账本里」就是用户层（它随调用者启用集变化，不进账本）。这里钉的是三条
 * 容易写错的规则：
 * 1. 结果按 **(名字, 层)** 出——同名在不同版本下属于不同层时不能合成一个数字；
 * 2. 层优先级 system > org > user 与 Run 解析同序（ADR 0015 D7）；
 * 3. 名字里带 NUL 的键不会把两个 (版本, 层) 组合拼到一起（拼接分隔符的选择）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeSkillUsageTiers } from '../../src/infrastructure/mysql/repositories/admin-run-read-repository.js';

const V1 = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const V2 = '01K0G2PAV8FPMVC9QHJG7JPN50';

test('账本里的名字按 system / org 记层，账本外的记 user', () => {
  const out = mergeSkillUsageTiers(
    [
      { agentVersionId: V1, name: 'pdf', calls: 5 },
      { agentVersionId: V1, name: 'sales-weekly', calls: 2 },
      { agentVersionId: V1, name: 'mine', calls: 7 },
    ],
    [
      { agentVersionId: V1, scope: 'system', name: 'pdf' },
      { agentVersionId: V1, scope: 'org', name: 'sales-weekly' },
    ],
  );
  assert.deepEqual(out, [
    { name: 'mine', scope: 'user', calls: 7 },
    { name: 'pdf', scope: 'system', calls: 5 },
    { name: 'sales-weekly', scope: 'org', calls: 2 },
  ]);
});

test('同一个名字在不同版本下属于不同层 → 出两行，不合并成一行', () => {
  const out = mergeSkillUsageTiers(
    [
      { agentVersionId: V1, name: 'pdf', calls: 4 },
      { agentVersionId: V2, name: 'pdf', calls: 3 },
    ],
    // V1 把它当系统层；V2 没绑定它，那次 Run 用的是用户自己装的同名包。
    [{ agentVersionId: V1, scope: 'system', name: 'pdf' }],
  );
  assert.deepEqual(
    out.map((row) => [row.name, row.scope, row.calls]),
    [['pdf', 'system', 4], ['pdf', 'user', 3]],
  );
});

test('同一层跨版本累加；被两层引用的名字记 system（Run 解析同序）', () => {
  const out = mergeSkillUsageTiers(
    [
      { agentVersionId: V1, name: 'pdf', calls: 4 },
      { agentVersionId: V2, name: 'pdf', calls: 6 },
    ],
    [
      { agentVersionId: V1, scope: 'system', name: 'pdf' },
      { agentVersionId: V2, scope: 'org', name: 'pdf' },
    ],
  );
  // V2 那次 Run 里生效的是 org 版本——账本说它绑的是 org 层。
  assert.deepEqual(out, [
    { name: 'pdf', scope: 'org', calls: 6 },
    { name: 'pdf', scope: 'system', calls: 4 },
  ]);
});

test('没有任何引用账本（旧版本 / 纯用户层）时全部记 user', () => {
  const out = mergeSkillUsageTiers(
    [{ agentVersionId: V1, name: 'mine', calls: 1 }],
    [],
  );
  assert.deepEqual(out, [{ name: 'mine', scope: 'user', calls: 1 }]);
});

test('空输入返回空数组，排序与层无关地按调用次数降序', () => {
  assert.deepEqual(mergeSkillUsageTiers([], []), []);
  const out = mergeSkillUsageTiers(
    [
      { agentVersionId: V1, name: 'b', calls: 1 },
      { agentVersionId: V1, name: 'a', calls: 9 },
    ],
    [],
  );
  assert.deepEqual(out.map((row) => row.name), ['a', 'b']);
});
