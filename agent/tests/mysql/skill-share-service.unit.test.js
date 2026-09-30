/**
 * 共享申请流程（ADR 0015 D6，design §7.1/§7.2）。
 *
 * 钉的是**流程的不可逆方向**与作用域：
 * - 批准先在行锁里迁到 approved（与撤回互斥），字节失败时**退回 pending**（作者可以
 *   重新发布再申请），不会留下「已批准但 org 层没有这个版本」；
 * - 摘要不一致**不是** rejected：那是管理员的判断，不该由一次竞态代劳；
 * - 只有自己**已启用**的版本能申请（申请的是发布副本的摘要，不是草稿）；
 * - 跨 org 一律 404；非 admin 403；
 * - 一个名字只能有一个来源（`SKILL_ORG_NAME_TAKEN`）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ShareAdminRequiredError,
  ShareFlowError,
  SkillShareService,
  statusForShareError,
} from '../../src/application/skill-share-service.js';
import { OrgSkillPublishError } from '../../src/skills/org-publish.js';
import { SkillShareRequestRepository } from '../../src/infrastructure/mysql/repositories/skill-share-request-repository.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const OTHER_ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Y';
const ALICE = '01K0G2PAV8FPMVC9QHJG7JPN50';
const BOB = '01K0G2PAV8FPMVC9QHJG7JPN51';
const ADMIN = '01K0G2PAV8FPMVC9QHJG7JPN52';
const DIGEST = 'a'.repeat(64);

const ALICE_ACTOR = { externalOrgId: ORG, externalUserId: ALICE };
const ADMIN_ACTOR = { externalOrgId: ORG, externalUserId: ADMIN, role: 'admin' };
const MEMBER_ACTOR = { externalOrgId: ORG, externalUserId: BOB, role: 'user' };

let seq = 0;
function makeService(overrides = {}) {
  const requests = new SkillShareRequestRepository(createFakeKnex(createFakeState()), {
    generateId: () => `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + seq++).slice(-2)}`,
  });
  const audits = [];
  const service = new SkillShareService({
    // 单测里外部主体就是内部 ULID：账本 id 的解析在 http-main 一处完成；
    // 服务只要求「进来的 actor 已经是内部 id」。
    resolveOwner: async (auth) => ({ orgId: auth.externalOrgId, userId: auth.externalUserId }),
    requests,
    orgSkills: {},
    enabledVersionOf: async () => ({ contentDigest: DIGEST }),
    orgSkillOwnerOf: async () => null,
    publishFromPublished: async () => ({ contentDigest: DIGEST }),
    audit: (event) => audits.push(event),
    ...overrides,
  });
  return { service, requests, audits };
}

async function pendingRequest(service) {
  return service.requestShare({ actor: ALICE_ACTOR, name: 'sales-weekly' });
}

describe('SkillShareService.requestShare', () => {
  it('对已启用的版本发起申请，钉住该摘要', async () => {
    const { service } = makeService();
    const row = await service.requestShare({ actor: ALICE_ACTOR, name: 'sales-weekly', note: '共享' });
    assert.equal(row.status, 'pending');
    assert.equal(row.contentDigest, DIGEST);
    assert.equal(row.requesterUserId, ALICE);
  });

  it('未启用 → 409 SKILL_NOT_ENABLED（可以先启用再来，不是你请求写错了）', async () => {
    const { service } = makeService({ enabledVersionOf: async () => null });
    await assert.rejects(
      () => service.requestShare({ actor: ALICE_ACTOR, name: 'nope' }),
      (err) => {
        assert.ok(err instanceof ShareFlowError);
        assert.equal(err.code, 'SKILL_NOT_ENABLED');
        assert.equal(statusForShareError(err).status, 409);
        return true;
      },
    );
  });

  it('申请记录审计', async () => {
    const { service, audits } = makeService();
    await pendingRequest(service);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'share_request');
    assert.equal(audits[0].result, 'success');
    assert.equal(audits[0].contentDigest, DIGEST);
  });
});

describe('SkillShareService 权限与作用域', () => {
  it('非 admin 不能列表 / 批准 / 驳回（403，有 admin 成功对照）', async () => {
    const { service } = makeService();
    const row = await pendingRequest(service);
    await assert.rejects(() => service.listForAdmin({ actor: MEMBER_ACTOR }), ShareAdminRequiredError);
    await assert.rejects(
      () => service.approve({ actor: MEMBER_ACTOR, requestId: row.requestId }),
      ShareAdminRequiredError,
    );
    await assert.rejects(
      () => service.reject({ actor: MEMBER_ACTOR, requestId: row.requestId, note: 'x' }),
      ShareAdminRequiredError,
    );
    assert.equal((await service.listForAdmin({ actor: ADMIN_ACTOR })).length, 1);
  });

  it('role 为 null 也按非 admin 拒——fail-closed', async () => {
    const { service } = makeService();
    await assert.rejects(
      () => service.listForAdmin({ actor: { ...ADMIN_ACTOR, role: null } }),
      ShareAdminRequiredError,
    );
  });

  it('跨 org 的申请一律 404（不泄漏存在性），且申请不被改动', async () => {
    const { service } = makeService();
    const row = await pendingRequest(service);
    const otherAdmin = { externalOrgId: OTHER_ORG, externalUserId: ADMIN, role: 'admin' };
    await assert.rejects(
      () => service.approve({ actor: otherAdmin, requestId: row.requestId }),
      (err) => {
        assert.ok(err instanceof ShareFlowError);
        assert.equal(err.code, 'SKILL_SHARE_REQUEST_UNKNOWN');
        assert.equal(statusForShareError(err).status, 404);
        return true;
      },
    );
    assert.equal((await service.listMine({ actor: ALICE_ACTOR }))[0].status, 'pending');
  });

  it('非本人的申请不出现在「我的申请」里', async () => {
    const { service } = makeService();
    await pendingRequest(service);
    assert.deepEqual(await service.listMine({ actor: { externalOrgId: ORG, externalUserId: BOB } }), []);
  });
});

describe('SkillShareService.approve', () => {
  it('批准把字节发到 org 层并迁到 approved', async () => {
    const { service, audits } = makeService();
    const row = await pendingRequest(service);
    const result = await service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId, note: '合规' });
    assert.equal(result.request.status, 'approved');
    assert.equal(result.request.decidedByUserId, ADMIN);
    assert.equal(result.contentDigest, DIGEST);
    assert.equal(audits.at(-1).action, 'share_approve');
  });

  it('摘要不一致 → 申请**保持 pending**（不是 rejected：那是管理员的判断）', async () => {
    const { service, requests } = makeService({
      publishFromPublished: async () => {
        throw new OrgSkillPublishError(
          `digest mismatch: the request pinned ${DIGEST} but the published copy hashes to ${'b'.repeat(64)}`,
          'SKILL_SHARE_DIGEST_MISMATCH',
        );
      },
    });
    const row = await pendingRequest(service);
    await assert.rejects(
      () => service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId }),
      (err) => statusForShareError(err).code === 'SKILL_SHARE_DIGEST_MISMATCH',
    );
    // 还能重新发布再申请：申请没被判定。
    assert.equal((await requests.get(row.requestId))?.status, 'pending');
  });

  it('名字已被别的作者占用 → 409 SKILL_ORG_NAME_TAKEN，且不发布', async () => {
    let published = 0;
    const { service } = makeService({
      orgSkillOwnerOf: async () => ({ originUserId: BOB }),
      publishFromPublished: async () => {
        published += 1;
        return { contentDigest: DIGEST };
      },
    });
    const row = await pendingRequest(service);
    await assert.rejects(
      () => service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId }),
      (err) => {
        assert.ok(err instanceof ShareFlowError);
        assert.equal(err.code, 'SKILL_ORG_NAME_TAKEN');
        assert.equal(statusForShareError(err).status, 409);
        return true;
      },
    );
    assert.equal(published, 0, 'must not publish when the name belongs to another author');
  });

  it('同一个作者再次申请同名新版本是允许的（继续迭代）', async () => {
    const { service } = makeService({ orgSkillOwnerOf: async () => ({ originUserId: ALICE }) });
    const row = await pendingRequest(service);
    const result = await service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId });
    assert.equal(result.request.status, 'approved');
  });

  it('已决定的申请不能再次批准（409），且不重复发布', async () => {
    let published = 0;
    const { service } = makeService({
      publishFromPublished: async () => {
        published += 1;
        return { contentDigest: DIGEST };
      },
    });
    const row = await pendingRequest(service);
    await service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId });
    await assert.rejects(
      () => service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId }),
      (err) => statusForShareError(err).code === 'SKILL_SHARE_REQUEST_DECIDED',
    );
    assert.equal(published, 1, 'the second approve must not republish');
  });
});

describe('SkillShareService.approve 与撤回的竞态（2026-09-30 复审）', () => {
  // 旧顺序是「先发字节、后改状态」：发布过程中作者撤回会成功，随后 decide 失败，
  // 而 org 层已经多了一个 active（setCurrent 时还是 current）版本——作者撤回了
  // 同意，他的 Skill 却进了别人的上下文。现在先在行锁里迁到 approved，撤回与批准互斥。
  it('发布过程中作者撤回 → 撤回被拒（已批准），申请为 approved', async () => {
    const holder = {};
    let withdrawOutcome = null;
    const { service, requests } = makeService({
      publishFromPublished: async () => {
        try {
          await holder.service.withdraw({ actor: ALICE_ACTOR, requestId: holder.requestId });
          withdrawOutcome = 'withdrawn';
        } catch (err) {
          const mapped = statusForShareError(err);
          withdrawOutcome = mapped.code;
          // api.md：DECIDED 是 409。仓储层抛出的同码错误曾被映射成 400。
          assert.equal(mapped.status, 409);
        }
        return { contentDigest: DIGEST };
      },
    });
    holder.service = service;
    const row = await pendingRequest(service);
    holder.requestId = row.requestId;
    const result = await service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId });
    assert.equal(withdrawOutcome, 'SKILL_SHARE_REQUEST_DECIDED');
    assert.equal(result.request.status, 'approved');
    assert.equal((await requests.get(row.requestId))?.status, 'approved');
  });

  it('先撤回再批准 → 409 且不发布（合法对照）', async () => {
    let published = 0;
    const { service } = makeService({
      publishFromPublished: async () => {
        published += 1;
        return { contentDigest: DIGEST };
      },
    });
    const row = await pendingRequest(service);
    await service.withdraw({ actor: ALICE_ACTOR, requestId: row.requestId });
    await assert.rejects(
      () => service.approve({ actor: ADMIN_ACTOR, requestId: row.requestId }),
      (err) => statusForShareError(err).code === 'SKILL_SHARE_REQUEST_DECIDED',
    );
    assert.equal(published, 0);
  });
});

describe('SkillShareService.reject 与 withdraw', () => {
  it('驳回只改状态、不碰 org 层', async () => {
    let published = 0;
    const { service } = makeService({
      publishFromPublished: async () => {
        published += 1;
        return { contentDigest: DIGEST };
      },
    });
    const row = await pendingRequest(service);
    const rejected = await service.reject({
      actor: ADMIN_ACTOR, requestId: row.requestId, note: '含客户名单',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decisionNote, '含客户名单');
    assert.equal(published, 0);
  });

  it('本人撤回 pending；别人撤不了（404）', async () => {
    const { service } = makeService();
    const row = await pendingRequest(service);
    await assert.rejects(
      () => service.withdraw({ actor: { externalOrgId: ORG, externalUserId: BOB }, requestId: row.requestId }),
      (err) => statusForShareError(err).status === 404,
    );
    const withdrawn = await service.withdraw({ actor: ALICE_ACTOR, requestId: row.requestId });
    assert.equal(withdrawn.status, 'withdrawn');
  });
});

describe('statusForShareError', () => {
  it('未知错误不当成成功，也不伪装成 404', () => {
    const mapped = statusForShareError(new Error('boom'));
    assert.equal(mapped.status, 400);
    assert.equal(mapped.code, 'SKILL_SHARE_OPERATION_FAILED');
  });
});

describe('org 层保留名与作者豁免（ADR 0015 D7 / design §7.3）', () => {
  /**
   * 这两条钉的是**豁免的边界**：作者豁免只给原作者，别人仍被挡。
   *
   * 没有豁免，被提升过的 Skill 的原作者只能换名字才能迭代自己的草稿；
   * 豁免给得太宽（任何人不分作者），两个同名 Skill 就会撞在一条发现路径上——
   * 模型看到两个同名，而 Run 解析只保留 org 版本，作者会以为自己的新版本生效了。
   */
  it('别人的同名 org Skill → 保留名集合包含它（启用会被闸门拒）', async () => {
    const { repo } = await makeReservationFixture();
    const reserved = await repo.reservedNamesForOrg({ orgId: ORG, excludeAuthorUserId: BOB });
    assert.equal(reserved.has('sales-weekly'), true);
  });

  it('原作者自己 → 保留名集合不含它（可以继续迭代草稿）', async () => {
    const { repo } = await makeReservationFixture();
    const reserved = await repo.reservedNamesForOrg({ orgId: ORG, excludeAuthorUserId: ALICE });
    assert.equal(reserved.has('sales-weekly'), false);
  });

  it('全部版本都 revoked 之后，名字不再是保留名', async () => {
    const { repo } = await makeReservationFixture({ status: 'revoked' });
    const reserved = await repo.reservedNamesForOrg({ orgId: ORG, excludeAuthorUserId: BOB });
    assert.equal(reserved.has('sales-weekly'), false);
  });

  it('deprecated 仍然是保留名（只挡新绑定，不释放名字）', async () => {
    const { repo } = await makeReservationFixture({ status: 'deprecated' });
    const reserved = await repo.reservedNamesForOrg({ orgId: ORG, excludeAuthorUserId: BOB });
    assert.equal(reserved.has('sales-weekly'), true);
  });

  it('跨 org 的名字不影响本 org', async () => {
    const { repo } = await makeReservationFixture();
    const reserved = await repo.reservedNamesForOrg({ orgId: OTHER_ORG, excludeAuthorUserId: BOB });
    assert.equal(reserved.size, 0);
  });

  async function makeReservationFixture({ status = 'active' } = {}) {
    const { OrgSkillRepository } = await import(
      '../../src/infrastructure/mysql/repositories/org-skill-repository.js'
    );
    const state = createFakeState();
    state.tables['tbl_agsvc_org_skill_versions'] = [{
      version_id: '01K0G2PAV8FPMVC9QHJG7JPN90',
      org_id: ORG,
      skill_name: 'sales-weekly',
      content_digest: DIGEST,
      status,
      origin_user_id: ALICE,
    }];
    state.tables['tbl_agsvc_org_skills'] = [];
    return { repo: new OrgSkillRepository(createFakeKnex(state)) };
  }
});
