/**
 * org 层共享 Skill 的账本读写（ADR 0015 D5/D6/D8，design §5.2/§5.3）。
 *
 * 这里钉的是**状态机与并发语义**，不是 SQL 文本：
 * - `revoked` 是终态，不允许复活、也不允许原样重新发布（否则吊销成了可逆的展示开关）；
 * - 首次发布必须先占位再锁名（否则两个并发首发布会各自插入，靠唯一键报错而不是排队）；
 * - 首次发布默认把 current 指到它，之后**不**自动跟随（ADR 0015 D3：绑定钉摘要，
 *   跟随最新会让同一个 AgentVersion 在不同时间行为不同）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeKnex, createFakeState } from './fake-knex.js';
import {
  OrgSkillRepository,
  OrgSkillError,
} from '../../src/infrastructure/mysql/repositories/org-skill-repository.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN51';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

let seq = 0;
function makeRepo(state = createFakeState()) {
  const db = createFakeKnex(state);
  const repo = new OrgSkillRepository(db, {
    now: () => new Date('2026-09-30T00:00:00.000Z'),
    generateId: () => `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + seq++).slice(-2)}`,
  });
  return { repo, state, db };
}

async function publish(repo, overrides = {}) {
  return repo.publishVersion({
    orgId: ORG,
    name: 'sales-weekly',
    contentDigest: DIGEST_A,
    fileCount: 3,
    totalBytes: 100,
    description: '周报技能',
    originKind: 'admin_upload',
    originUserId: USER,
    publishedByUserId: USER,
    ...overrides,
  });
}

describe('OrgSkillRepository.publishVersion', () => {
  it('首次发布写版本行，并把 current 指到它', async () => {
    const { repo } = makeRepo();
    const row = await publish(repo);
    assert.equal(row.name, 'sales-weekly');
    assert.equal(row.contentDigest, DIGEST_A);
    assert.equal(row.status, 'active');
    assert.equal(row.originKind, 'admin_upload');

    const [group] = await repo.listForOrg({ orgId: ORG });
    assert.equal(group.name, 'sales-weekly');
    assert.equal(group.currentDigest, DIGEST_A);
    assert.equal(group.versions.length, 1);
  });

  it('同一摘要重复发布不改状态，也不新增行', async () => {
    const { repo } = makeRepo();
    await publish(repo);
    await publish(repo);
    const [group] = await repo.listForOrg({ orgId: ORG });
    assert.equal(group.versions.length, 1);
  });

  it('第二个版本**不**自动改 current（升级是显式动作，ADR 0015 D3）', async () => {
    const { repo } = makeRepo();
    await publish(repo, { contentDigest: DIGEST_A });
    await publish(repo, { contentDigest: DIGEST_B });
    const [group] = await repo.listForOrg({ orgId: ORG });
    assert.equal(group.currentDigest, DIGEST_A, 'current must not follow the newest publish');
    assert.equal(group.versions.length, 2);
  });

  it('显式 setCurrent 才改指针', async () => {
    const { repo } = makeRepo();
    await publish(repo, { contentDigest: DIGEST_A });
    await publish(repo, { contentDigest: DIGEST_B, setCurrent: true });
    const [group] = await repo.listForOrg({ orgId: ORG });
    assert.equal(group.currentDigest, DIGEST_B);
  });

  it('撤销过的摘要不允许重新发布（防止原样回流）', async () => {
    const { repo } = makeRepo();
    await publish(repo);
    await repo.setStatus({
      orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A,
      status: 'revoked', reason: '误发布', changedByUserId: USER,
    });
    await assert.rejects(
      () => publish(repo),
      (err) => err instanceof OrgSkillError && err.code === 'SKILL_ORG_VERSION_REVOKED',
    );
  });

  it('空 orgId 一律拒绝（不能靠 where org_id = "" 静默命中零行）', async () => {
    const { repo } = makeRepo();
    await assert.rejects(() => publish(repo, { orgId: '' }), /non-empty orgId/);
  });

  it('带 expectedOriginUserId 时：名字已被别的作者占用 → 锁内拒绝 SKILL_ORG_NAME_TAKEN', async () => {
    // 两位作者同名申请被同时批准：先赢者在锁内写下版本，后到者在**同一事务、
    // 锁住名字行之后**再判来源，而不是靠锁外的一次先读。
    const { repo } = makeRepo();
    await publish(repo, { originUserId: USER });
    await assert.rejects(
      () => publish(repo, {
        contentDigest: DIGEST_B,
        originUserId: OTHER_USER,
        expectedOriginUserId: OTHER_USER,
      }),
      (err) => err instanceof OrgSkillError && err.code === 'SKILL_ORG_NAME_TAKEN',
    );
  });

  it('带 expectedOriginUserId 时：同一作者续版放行（继续迭代）', async () => {
    const { repo } = makeRepo();
    await publish(repo, { originUserId: USER });
    const row = await publish(repo, {
      contentDigest: DIGEST_B,
      originUserId: USER,
      expectedOriginUserId: USER,
    });
    assert.equal(row.contentDigest, DIGEST_B);
  });

  it('带 expectedOriginUserId 时：旧版本全被撤销后名字不再被占', async () => {
    const { repo } = makeRepo();
    await publish(repo, { originUserId: USER });
    await repo.setStatus({
      orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A,
      status: 'revoked', reason: '误发布', changedByUserId: USER,
    });
    const row = await publish(repo, {
      contentDigest: DIGEST_B,
      originUserId: OTHER_USER,
      expectedOriginUserId: OTHER_USER,
    });
    assert.equal(row.originUserId, OTHER_USER);
  });

  it('不带 expectedOriginUserId 时不判来源（管理员直传不受限）', async () => {
    const { repo } = makeRepo();
    await publish(repo, { originUserId: USER });
    const row = await publish(repo, { contentDigest: DIGEST_B, originUserId: OTHER_USER });
    assert.equal(row.contentDigest, DIGEST_B);
  });
});

describe('OrgSkillRepository.getVersion', () => {
  it('不存在返回 null —— 调用方据此写 missing 诊断，不能当成 active', async () => {
    const { repo } = makeRepo();
    assert.equal(await repo.getVersion({ orgId: ORG, name: 'nope', contentDigest: DIGEST_A }), null);
  });

  it('读到状态（Run 解析只关心这个）', async () => {
    const { repo } = makeRepo();
    await publish(repo);
    const row = await repo.getVersion({ orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A });
    assert.equal(row?.status, 'active');
  });

  it('不同 org 看不到对方的版本（跨租户）', async () => {
    const { repo } = makeRepo();
    await publish(repo);
    assert.equal(
      await repo.getVersion({ orgId: 'other-org', name: 'sales-weekly', contentDigest: DIGEST_A }),
      null,
    );
    assert.deepEqual(await repo.listForOrg({ orgId: 'other-org' }), []);
  });
});

describe('OrgSkillRepository.setStatus', () => {
  it('吊销带留痕，且之后 getVersion 反映 revoked', async () => {
    const { repo, state } = makeRepo();
    await publish(repo);
    const row = await repo.setStatus({
      orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A,
      status: 'revoked', reason: '含内部数据', changedByUserId: USER,
    });
    assert.equal(row.status, 'revoked');
    const stored = state.tables['tbl_agsvc_org_skill_versions'][0];
    assert.equal(stored.status, 'revoked');
    assert.equal(stored.status_reason, '含内部数据');
    assert.equal(stored.status_changed_by_user_id, USER);
  });

  it('revoked 是终态：不能改回 active（否则吊销成了可逆的展示开关）', async () => {
    const { repo } = makeRepo();
    await publish(repo);
    await repo.setStatus({
      orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A,
      status: 'revoked', reason: 'x', changedByUserId: USER,
    });
    await assert.rejects(
      () => repo.setStatus({
        orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A,
        status: 'active', reason: '算了', changedByUserId: USER,
      }),
      (err) => err instanceof OrgSkillError && err.code === 'SKILL_ORG_VERSION_REVOKED',
    );
  });

  it('deprecated 可以改回 active（只挡新绑定，不是安全动作）', async () => {
    const { repo } = makeRepo();
    await publish(repo);
    await repo.setStatus({
      orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A,
      status: 'deprecated', reason: '旧版', changedByUserId: USER,
    });
    const back = await repo.setStatus({
      orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_A,
      status: 'active', reason: '恢复', changedByUserId: USER,
    });
    assert.equal(back.status, 'active');
  });

  it('版本不存在报 SKILL_ORG_VERSION_UNKNOWN', async () => {
    const { repo } = makeRepo();
    await assert.rejects(
      () => repo.setStatus({
        orgId: ORG, name: 'nope', contentDigest: DIGEST_A,
        status: 'revoked', reason: 'x', changedByUserId: USER,
      }),
      (err) => err instanceof OrgSkillError && err.code === 'SKILL_ORG_VERSION_UNKNOWN',
    );
  });
});

describe('OrgSkillRepository.setCurrent', () => {
  it('改指针但不改任何版本状态', async () => {
    const { repo } = makeRepo();
    await publish(repo, { contentDigest: DIGEST_A });
    await publish(repo, { contentDigest: DIGEST_B });
    await repo.setCurrent({
      orgId: ORG, name: 'sales-weekly', contentDigest: DIGEST_B, updatedByUserId: USER,
    });
    const [group] = await repo.listForOrg({ orgId: ORG });
    assert.equal(group.currentDigest, DIGEST_B);
    assert.deepEqual(group.versions.map((v) => v.status), ['active', 'active']);
  });
});

describe('OrgSkillRepository 时间戳', () => {
  it('publishedAt 是带时区的 ISO（UTC），不是库里的无时区串', async () => {
    // 连接用 dateStrings：库里读回的是 `2026-09-30 00:00:00.000`，按本地时间解析会差出时区偏移。
    const { repo } = makeRepo();
    const row = await publish(repo);
    assert.equal(row.publishedAt, '2026-09-30T00:00:00.000Z');
  });
});
