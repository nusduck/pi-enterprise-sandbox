/**
 * 共享申请账本（ADR 0015 D6，design §7.1）。
 *
 * 这条流程记录的是**信任等级的提升**（从「只进作者自己的上下文」到「进他人的 prompt
 * 与执行环境」），所以状态机与作用域都必须严格：
 * - 只有 `pending` 能迁出；终态不能被改回（否则「被拒过」这个事实会消失）；
 * - 跨用户撤回一律 404（不泄漏存在性）；
 * - 同名再次申请把旧 `pending` 置为 `superseded`，**同一个事务内**——两条 pending
 *   会让「管理员该批哪一条」没有答案。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeKnex, createFakeState } from './fake-knex.js';
import {
  ShareRequestError,
  SkillShareRequestRepository,
} from '../../src/infrastructure/mysql/repositories/skill-share-request-repository.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const OTHER_ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Y';
const ALICE = '01K0G2PAV8FPMVC9QHJG7JPN50';
const BOB = '01K0G2PAV8FPMVC9QHJG7JPN51';
const ADMIN = '01K0G2PAV8FPMVC9QHJG7JPN52';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

let seq = 0;
function makeRepo() {
  const state = createFakeState();
  const repo = new SkillShareRequestRepository(createFakeKnex(state), {
    now: () => new Date('2026-09-30T00:00:00.000Z'),
    generateId: () => `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + seq++).slice(-2)}`,
  });
  return { repo, state };
}

async function request(repo, overrides = {}) {
  return repo.create({
    orgId: ORG,
    requesterUserId: ALICE,
    name: 'sales-weekly',
    contentDigest: DIGEST,
    ...overrides,
  });
}

describe('SkillShareRequestRepository.create', () => {
  it('新建是 pending，带申请人、摘要与备注', async () => {
    const { repo } = makeRepo();
    const row = await request(repo, { note: '希望大家都能用' });
    assert.equal(row.status, 'pending');
    assert.equal(row.requesterUserId, ALICE);
    assert.equal(row.contentDigest, DIGEST);
    assert.equal(row.note, '希望大家都能用');
    assert.equal(row.decidedByUserId, '');
    assert.equal(row.decidedAt, null);
  });

  it('同名再次申请把旧 pending 置为 superseded（一个事务内）', async () => {
    const { repo } = makeRepo();
    const first = await request(repo);
    const second = await request(repo, { contentDigest: OTHER_DIGEST });
    const all = await repo.listForRequester({ orgId: ORG, requesterUserId: ALICE });
    const byId = new Map(all.map((row) => [row.requestId, row]));
    assert.equal(byId.get(first.requestId)?.status, 'superseded');
    assert.equal(byId.get(second.requestId)?.status, 'pending');
    // 同一时刻至多一条 pending。
    assert.equal(all.filter((row) => row.status === 'pending').length, 1);
  });

  it('别人同名的 pending 不受影响（supersede 只作用于同一申请人）', async () => {
    const { repo } = makeRepo();
    const alice = await request(repo);
    const bob = await request(repo, { requesterUserId: BOB });
    assert.equal((await repo.get(alice.requestId))?.status, 'pending');
    assert.equal((await repo.get(bob.requestId))?.status, 'pending');
  });

  it('已被批准的申请不会被后续同名申请改写（只有 pending 会被 supersede）', async () => {
    const { repo } = makeRepo();
    const first = await request(repo);
    await repo.decide({ requestId: first.requestId, status: 'approved', decidedByUserId: ADMIN });
    await request(repo, { contentDigest: OTHER_DIGEST });
    assert.equal((await repo.get(first.requestId))?.status, 'approved');
  });
});

describe('SkillShareRequestRepository.decide', () => {
  it('批准 / 驳回都记下决定人与备注', async () => {
    const { repo } = makeRepo();
    const a = await request(repo);
    const approved = await repo.decide({
      requestId: a.requestId, status: 'approved', decidedByUserId: ADMIN, note: '内容合规',
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedByUserId, ADMIN);
    assert.equal(approved.decisionNote, '内容合规');
    assert.ok(approved.decidedAt);

    const b = await request(repo, { requesterUserId: BOB });
    const rejected = await repo.decide({
      requestId: b.requestId, status: 'rejected', decidedByUserId: ADMIN, note: '含客户名单',
    });
    assert.equal(rejected.status, 'rejected');
  });

  it('终态不能被再次决定——「被拒过」不能消失', async () => {
    const { repo } = makeRepo();
    const a = await request(repo);
    await repo.decide({ requestId: a.requestId, status: 'rejected', decidedByUserId: ADMIN });
    await assert.rejects(
      () => repo.decide({ requestId: a.requestId, status: 'approved', decidedByUserId: ADMIN }),
      (err) => err instanceof ShareRequestError && err.code === 'SKILL_SHARE_REQUEST_DECIDED',
    );
    assert.equal((await repo.get(a.requestId))?.status, 'rejected');
  });

  it('申请不存在报 SKILL_SHARE_REQUEST_UNKNOWN（HTTP 层给 404）', async () => {
    const { repo } = makeRepo();
    await assert.rejects(
      () => repo.decide({
        requestId: '01K0G2PAV8FPMVC9QHJG7JPN99', status: 'approved', decidedByUserId: ADMIN,
      }),
      (err) => err instanceof ShareRequestError && err.code === 'SKILL_SHARE_REQUEST_UNKNOWN',
    );
  });

  it('cross-org：别的 org 看不到这条申请', async () => {
    const { repo } = makeRepo();
    const a = await request(repo);
    assert.deepEqual(await repo.listForOrg({ orgId: OTHER_ORG }), []);
    // decide 本身不按 org 过滤（它按 request_id + 锁），所以调用方必须先按 org 取到它
    // ——这一条由管理员服务负责；这里只钉住「列表不跨 org」。
    assert.equal((await repo.get(a.requestId))?.orgId, ORG);
  });
});

describe('SkillShareRequestRepository.withdraw', () => {
  it('本人可以撤回 pending', async () => {
    const { repo } = makeRepo();
    const a = await request(repo);
    const withdrawn = await repo.withdraw({ requestId: a.requestId, requesterUserId: ALICE });
    assert.equal(withdrawn.status, 'withdrawn');
  });

  it('别人不能撤回：一律 404，不泄漏存在性', async () => {
    const { repo } = makeRepo();
    const a = await request(repo);
    await assert.rejects(
      () => repo.withdraw({ requestId: a.requestId, requesterUserId: BOB }),
      (err) => err instanceof ShareRequestError && err.code === 'SKILL_SHARE_REQUEST_UNKNOWN',
    );
    assert.equal((await repo.get(a.requestId))?.status, 'pending');
  });

  it('终态不能撤回', async () => {
    const { repo } = makeRepo();
    const a = await request(repo);
    await repo.decide({ requestId: a.requestId, status: 'approved', decidedByUserId: ADMIN });
    await assert.rejects(
      () => repo.withdraw({ requestId: a.requestId, requesterUserId: ALICE }),
      (err) => err instanceof ShareRequestError && err.code === 'SKILL_SHARE_REQUEST_DECIDED',
    );
  });
});

describe('SkillShareRequestRepository.withdrawAllForRequester', () => {
  it('成员离开组织时其 pending 全部作废，但**不删行**（轨迹是审计材料）', async () => {
    const { repo } = makeRepo();
    const a = await request(repo);
    const b = await request(repo, { name: 'other-skill' });
    // 一条已决定的不能被这条操作碰到。
    const c = await request(repo, { name: 'decided-skill' });
    await repo.decide({ requestId: c.requestId, status: 'approved', decidedByUserId: ADMIN });

    const affected = await repo.withdrawAllForRequester({ orgId: ORG, requesterUserId: ALICE });
    assert.equal(affected, 2);
    assert.equal((await repo.get(a.requestId))?.status, 'withdrawn');
    assert.equal((await repo.get(b.requestId))?.status, 'withdrawn');
    assert.equal((await repo.get(c.requestId))?.status, 'approved');
    // 行还在。
    assert.equal((await repo.listForRequester({ orgId: ORG, requesterUserId: ALICE })).length, 3);
  });
});

describe('SkillShareRequestRepository.listForOrg', () => {
  it('可按状态过滤，按创建时间升序（最早的先处理）', async () => {
    const { repo } = makeRepo();
    const a = await request(repo, { name: 'first' });
    await request(repo, { name: 'second' });
    await repo.decide({ requestId: a.requestId, status: 'rejected', decidedByUserId: ADMIN });

    assert.equal((await repo.listForOrg({ orgId: ORG })).length, 2);
    const pending = await repo.listForOrg({ orgId: ORG, status: 'pending' });
    assert.deepEqual(pending.map((row) => row.name), ['second']);
    const rejected = await repo.listForOrg({ orgId: ORG, status: 'rejected' });
    assert.deepEqual(rejected.map((row) => row.name), ['first']);
  });
});
