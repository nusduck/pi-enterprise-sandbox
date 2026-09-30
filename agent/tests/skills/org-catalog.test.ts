/**
 * org 层对**能力页**的投影（ADR 0015 D5 / design §7.2）。
 *
 * 这条投影刻意与「某个 AgentVersion 绑了什么」分开：绑定清单是每 Run 算的，
 * 用它做能力页会让刚发布、还没被绑定的共享 Skill 从页面上消失——管理员发布完
 * 看不到自己刚发的东西。所以这里断言的是「本 org 的 active 版本」这条口径，
 * 以及挑版本的规则（`currentDigest` 优先、否则 newest active，`revoked` 等于不存在）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listActiveOrgSkillPackages } from '../../src/skills/org-catalog.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

/** 能力页只看账本 + 算物理包目录，不碰字节——所以这里读的东西就是全部输入。 */
function source(names: Array<{
  name: string;
  currentDigest: string;
  versions: Array<{ contentDigest: string; status: string; publishedAt?: string }>;
}>) {
  return { listForOrg: async ({ orgId }: { orgId: string }) => {
    assert.equal(orgId, ORG, 'capability listing is scoped to the caller org');
    return names;
  } };
}

test('每个名字出一条：current 指针指着的 active 版本优先', async () => {
  const packages = await listActiveOrgSkillPackages({
    orgId: ORG,
    publishedBase: '/published',
    orgSkills: source([
      {
        name: 'sales-weekly',
        currentDigest: DIGEST_B,
        // listForOrg 按 published_at 倒序：B 比 A 新，指针也指着 B。
        versions: [
          { contentDigest: DIGEST_B, status: 'active', publishedAt: '2026-09-30T00:00:00.000Z' },
          { contentDigest: DIGEST_A, status: 'active', publishedAt: '2026-09-01T00:00:00.000Z' },
        ],
      },
    ]),
  });
  assert.deepEqual(packages, [{
    name: 'sales-weekly',
    contentDigest: DIGEST_B,
    packageDir: `/published/${ORG}/_org/sales-weekly/.v/${DIGEST_B}/sales-weekly`,
  }]);
});

test('指针指着的版本被吊销 → 回退到 newest active，而不是整条消失', async () => {
  const packages = await listActiveOrgSkillPackages({
    orgId: ORG,
    publishedBase: '/published',
    orgSkills: source([
      {
        name: 'sales-weekly',
        // 指针还停在被吊销的 C 上：那是「推荐版本」指针，不是可用性判据。
        currentDigest: DIGEST_C,
        versions: [
          { contentDigest: DIGEST_C, status: 'revoked', publishedAt: '2026-10-01T00:00:00.000Z' },
          { contentDigest: DIGEST_B, status: 'deprecated', publishedAt: '2026-09-30T00:00:00.000Z' },
          { contentDigest: DIGEST_A, status: 'active', publishedAt: '2026-09-01T00:00:00.000Z' },
        ],
      },
    ]),
  });
  assert.deepEqual(packages.map((pkg) => pkg.contentDigest), [DIGEST_A]);
});

test('一个 active 版本都没有的名字不出现在能力页（revoked 等于不存在）', async () => {
  const packages = await listActiveOrgSkillPackages({
    orgId: ORG,
    publishedBase: '/published',
    orgSkills: source([
      { name: 'gone', currentDigest: DIGEST_A, versions: [{ contentDigest: DIGEST_A, status: 'revoked' }] },
      { name: 'live', currentDigest: DIGEST_B, versions: [{ contentDigest: DIGEST_B, status: 'active' }] },
    ]),
  });
  // 顺序也钉住：能力页按名字排序，否则列表每次刷新都可能换位置。
  assert.deepEqual(packages.map((pkg) => pkg.name), ['live']);
});

test('org 层为空时返回空数组，不是 null（调用方按「没有共享 Skill」展示）', async () => {
  const packages = await listActiveOrgSkillPackages({
    orgId: ORG,
    publishedBase: '/published',
    orgSkills: source([]),
  });
  assert.deepEqual(packages, []);
});
