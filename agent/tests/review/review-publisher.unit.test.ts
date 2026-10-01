/**
 * 审核工作队列的 outbox 消费者（design `agent-output-review.md` §5.3 / §6.2）。
 *
 * 三条要钉住的性质：
 *
 * 1. **材料快照逐个补齐**，源文件缺失停在 `unavailable`（看得见的状态，不是静默缺失）；
 * 2. **放行 = 状态变更 + 修订导入**，且都是幂等调用（至少一次投递下重复执行安全）；
 * 3. **失败分类**：4xx 结清（输入不可满足，重试没有意义），5xx/网络交给退避重试。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReviewPublisher } from '../../src/infrastructure/review/review-publisher.js';
import { InternalReviewError } from '../../src/infrastructure/sandbox/internal-review-http.js';

const TASK = '01K0G2PAV8FPMVC9QHJG7JPN70';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const REQUESTER = '01K0G2PAV8FPMVC9QHJG7JPN50';

function task() {
  return {
    reviewTaskId: TASK,
    orgId: ORG,
    requesterUserId: REQUESTER,
    conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
    agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
    runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
    status: 'APPROVED',
    feedback: null,
  };
}

function harness(options: {
  materials?: any[];
  attachments?: any[];
  snapshot?: (input: any) => Promise<any>;
  applyVisibilities?: (input: any) => Promise<any>;
  importRevision?: (input: any) => Promise<any>;
} = {}) {
  const state = {
    materials: options.materials ?? [],
    snapshotCalls: [] as any[],
    visibilityCalls: [] as any[],
    importCalls: [] as any[],
    materialUpdates: [] as any[],
    published: [] as string[],
    retried: [] as string[],
    failed: [] as string[],
  };
  const repos = {
    reviews: {
      async getTaskById() { return task(); },
      async listMaterials() { return state.materials; },
      async listUserAttachmentsUpToRun() { return options.attachments ?? []; },
      async markMaterialSnapshot(input: any) { state.materialUpdates.push(input); return 1; },
    },
    runs: { async getById() { return { traceId: 'd'.repeat(32), triggeringMessageId: '01K0G2PAV8FPMVC9QHJG7JPN5J' }; } },
    sessions: { async getById() { return { workspaceId: 'ws-1', sandboxSessionId: 'ss-1' }; } },
  };
  const transport = {
    async snapshot(input: any) {
      state.snapshotCalls.push(input);
      if (options.snapshot) return await options.snapshot(input);
      return { artifactId: `snap_${state.snapshotCalls.length}` };
    },
    async applyVisibilities(input: any) {
      state.visibilityCalls.push(input);
      if (options.applyVisibilities) return await options.applyVisibilities(input);
      return { changed: input.updates.length };
    },
    async importRevision(input: any) {
      state.importCalls.push(input);
      if (options.importRevision) return await options.importRevision(input);
      return { artifactId: input.artifactId, path: input.targetPath };
    },
  } as any;
  const outbox = {
    async claimBatch() { return claimedRows; },
    async markPublished(outboxId: string) { state.published.push(outboxId); },
    async markFailed(outboxId: string) { state.failed.push(outboxId); },
    async markPendingForRetry(outboxId: string) { state.retried.push(outboxId); return 'pending'; },
  };
  let claimedRows: any[] = [];
  const publisher = new ReviewPublisher({
    outbox,
    createRepositories: (db: unknown) => {
      assert.ok(db, '仓储工厂必须拿到显式执行器');
      return repos;
    },
    db: { isTransaction: false },
    transport,
  });
  return {
    publisher,
    state,
    setClaimed(rows: any[]) { claimedRows = rows; },
  };
}

function row(eventType: string, payload: Record<string, unknown> = {}) {
  return {
    outboxId: 'ob_1',
    claimToken: 'ct_1',
    aggregateId: TASK,
    eventType,
    attempts: 0,
    payloadJson: { reviewTaskId: TASK, orgId: ORG, requesterUserId: REQUESTER, ...payload },
  };
}

describe('审核消费者：材料快照', () => {
  it('源文件在 → 快照 ready，并把 exec 返回的产物 id 记进材料行', async () => {
    const { publisher, state, setClaimed } = harness({
      materials: [{
        materialId: 'm1', attachmentId: 'att_1', filename: '材料.pdf',
        mimeType: 'application/pdf', snapshotStatus: 'unavailable', snapshotArtifactId: null,
      }],
      attachments: [{ attachmentId: 'att_1', filename: '材料.pdf', mimeType: 'application/pdf', sizeBytes: 3, sourcePath: 'uploads/材料.pdf' }],
    });
    setClaimed([row('review.snapshot')]);
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['snapshot_ready']);
    assert.equal(state.snapshotCalls[0].sourcePath, 'uploads/材料.pdf');
    assert.equal(state.materialUpdates[0].snapshotArtifactId, 'snap_1');
    assert.equal(state.materialUpdates[0].status, 'ready');
    assert.deepEqual(state.published, ['ob_1']);
  });

  it('源文件不在（发起人删了）→ 停在 unavailable，并结清而不是无限重试', async () => {
    const { publisher, state, setClaimed } = harness({
      materials: [{
        materialId: 'm1', attachmentId: 'att_1', filename: '材料.pdf',
        mimeType: 'application/pdf', snapshotStatus: 'unavailable', snapshotArtifactId: null,
      }],
      attachments: [],
    });
    setClaimed([row('review.snapshot')]);
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['snapshot_unavailable']);
    assert.equal(state.snapshotCalls.length, 0);
    assert.equal(state.materialUpdates[0].status, 'unavailable');
    assert.deepEqual(state.published, ['ob_1']);
    assert.deepEqual(state.retried, []);
  });

  it('exec 说源文件不存在（404）→ 终态，不重试', async () => {
    const { publisher, state, setClaimed } = harness({
      materials: [{
        materialId: 'm1', attachmentId: 'att_1', filename: '材料.pdf',
        mimeType: 'application/pdf', snapshotStatus: 'unavailable', snapshotArtifactId: null,
      }],
      attachments: [{ attachmentId: 'att_1', filename: '材料.pdf', mimeType: 'application/pdf', sizeBytes: 3, sourcePath: 'uploads/材料.pdf' }],
      snapshot: async () => {
        throw new InternalReviewError('artifact_path_required', 'path not found', { httpStatus: 400 });
      },
    });
    setClaimed([row('review.snapshot')]);
    const { outcomes } = await publisher.publishOnce();
    // 4xx 是这一件材料的终态：记成 unavailable 后继续，整行不重试。
    assert.deepEqual(outcomes, ['snapshot_unavailable']);
    assert.deepEqual(state.retried, []);
    assert.deepEqual(state.published, ['ob_1']);
    assert.equal(state.materialUpdates[0].status, 'unavailable');
  });

  it('exec 5xx → 交给退避重试，不结清', async () => {
    const { publisher, state, setClaimed } = harness({
      materials: [{
        materialId: 'm1', attachmentId: 'att_1', filename: '材料.pdf',
        mimeType: 'application/pdf', snapshotStatus: 'unavailable', snapshotArtifactId: null,
      }],
      attachments: [{ attachmentId: 'att_1', filename: '材料.pdf', mimeType: 'application/pdf', sizeBytes: 3, sourcePath: 'uploads/材料.pdf' }],
      snapshot: async () => {
        throw new InternalReviewError('SANDBOX_REVIEW_UNAVAILABLE', 'down', { httpStatus: 503, retryable: true });
      },
    });
    setClaimed([row('review.snapshot')]);
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['retry']);
    assert.deepEqual(state.retried, ['ob_1']);
    assert.deepEqual(state.published, []);
  });
});

describe('审核消费者：放行与导入', () => {
  it('通过：先状态变更再导入，两者都带正确的目标', async () => {
    const { publisher, state, setClaimed } = harness();
    setClaimed([row('review.decided', {
      decision: 'APPROVED',
      updates: [
        { artifactId: 'art_rev', visibility: 'released' },
        { artifactId: 'art_orig', visibility: 'withdrawn' },
      ],
      imports: [{ artifactId: 'art_rev', targetPath: '审核版/报告.md' }],
    })]);
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['released']);
    assert.deepEqual(state.visibilityCalls[0].updates, [
      { artifactId: 'art_rev', visibility: 'released' },
      { artifactId: 'art_orig', visibility: 'withdrawn' },
    ]);
    assert.deepEqual(state.importCalls, [{ artifactId: 'art_rev', targetPath: '审核版/报告.md' }]);
    assert.deepEqual(state.published, ['ob_1']);
  });

  it('驳回：只撤回，不导入', async () => {
    const { publisher, state, setClaimed } = harness();
    setClaimed([row('review.decided', {
      decision: 'REJECTED',
      updates: [{ artifactId: 'art_orig', visibility: 'withdrawn' }],
      imports: [],
    })]);
    await publisher.publishOnce();
    assert.equal(state.visibilityCalls.length, 1);
    assert.equal(state.importCalls.length, 0);
  });

  it('空 updates/imports（脏 payload）不炸，直接结清', async () => {
    const { publisher, state, setClaimed } = harness();
    setClaimed([row('review.decided', { updates: 'nope', imports: null })]);
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['released']);
    assert.equal(state.visibilityCalls.length, 0);
    assert.deepEqual(state.published, ['ob_1']);
  });

  it('任务已不存在 → 结清（不永远重试）', async () => {
    const { publisher, setClaimed, state } = harness();
    const repos = { reviews: { async getTaskById() { return null; } } };
    const isolated = new ReviewPublisher({
      outbox: {
        async claimBatch() { return [row('review.decided')]; },
        async markPublished(id: string) { state.published.push(id); },
        async markFailed(id: string) { state.failed.push(id); },
        async markPendingForRetry(id: string) { state.retried.push(id); return 'pending'; },
      },
      createRepositories: () => repos,
      db: {},
      transport: { async applyVisibilities() { throw new Error('must not be called'); } } as any,
    });
    void publisher;
    const { outcomes } = await isolated.publishOnce();
    assert.deepEqual(outcomes, ['not_found']);
    assert.deepEqual(state.published, ['ob_1']);
  });
});
