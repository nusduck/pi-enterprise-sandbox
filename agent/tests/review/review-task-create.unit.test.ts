/**
 * P3：Run 终态建审核任务（design `agent-output-review.md` §5.2 / §6.2）。
 *
 * 用 fake 审核仓储把「判据 → 建任务 → items → 材料占位 → outbox 快照」整条接线
 * 跑一遍，并逐条钉住三条容易退化的性质：
 *
 * 1. **判据是 A1 的 `review_status`**：direct 会话（事件上没有这个字段）不建任务；
 * 2. **一个 Run 至多一条任务**：已有任务时不重复建（恢复扫描重放的语义）；
 * 3. **审核 outbox 行不会被 Run 的两个消费者抢走**：payload 里没有 `runId` 键，
 *    聚合类型也不重叠。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyRunTransitionInTxn } from '../../src/application/run-transition.js';
import {
  NOTIFICATION_DISPATCH_CLAIM_ELIGIBILITY,
  REVIEW_JOB_CLAIM_ELIGIBILITY,
  REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY,
  RUN_NOTIFICATION_CLAIM_ELIGIBILITY,
  RUN_STREAM_CLAIM_ELIGIBILITY,
  rowMatchesEligibility,
} from '../../src/infrastructure/outbox/eligibility.js';
import { AGGREGATE_TYPE_REVIEW, AGGREGATE_TYPE_REVIEW_NOTIFICATION, EVENT_TYPE_REVIEW_PENDING_NOTIFICATION, EVENT_TYPE_REVIEW_SNAPSHOT } from '../../src/infrastructure/outbox/outbox-status.js';

const RUN = {
  runId: '01M1RUN00000000000000000000',
  orgId: '01M1ORG00000000000000000000',
  userId: '01M1USER0000000000000000000',
  conversationId: '01M1CONV0000000000000000000',
  agentSessionId: '01M1SESS0000000000000000000',
  agentVersionId: '01M1VER00000000000000000000',
  triggeringMessageId: '01M1MSG00000000000000000000',
};

/** 极简 fake 审核仓储：只实现 `review-task-create` 用到的四个方法。 */
function fakeReviewRepo(options: {
  artifacts?: Array<{ artifactId: string; name: string; mimeType: string; size: number; sha256: string }>;
  materials?: Array<{ attachmentId: string; filename: string; mimeType: string; sizeBytes: number }>;
  existingTaskId?: string | null;
}) {
  const created: any[] = [];
  const events: any[] = [];
  return {
    created,
    events,
    async listArtifactReadyEvents() {
      return options.artifacts ?? [];
    },
    async listUserAttachmentsUpToRun() {
      return options.materials ?? [];
    },
    async getTaskByRunId() {
      return options.existingTaskId ? { reviewTaskId: options.existingTaskId } : null;
    },
    async createTask(draft: any, ids: any) {
      created.push({ draft, ids });
      events.push(ids.itemEventId);
      return draft.reviewTaskId;
    },
  };
}

function makeIds() {
  let n = 0;
  // ULID 形状：26 个 Crockford base32 字符（不含 I/L/O/U）。
  return () => `01M1AA${String(n++).padStart(20, '0')}`;
}

function baseRepos(reviews: unknown) {
  const inserted: any[] = [];
  return {
    inserted,
    repos: {
      runs: {
        async updateStatusIf() {
          return { ...RUN, status: 'SUCCEEDED' };
        },
        async getById() {
          return null;
        },
      },
      runEvents: { async append(e: any) { return { eventId: e.eventId, sequenceNo: 7 }; } },
      outbox: { async insert(row: any) { inserted.push(row); return row; } },
      reviews,
    },
  };
}

describe('Run 终态建审核任务', () => {
  it('review 会话里本轮有 held 产物 → 同事务建任务、items 与材料占位', async () => {
    const reviews = fakeReviewRepo({
      artifacts: [
        { artifactId: 'art_a', name: '报告.md', mimeType: 'text/markdown', size: 12, sha256: 'a'.repeat(64) },
        { artifactId: 'art_b', name: '数据.csv', mimeType: 'text/csv', size: 34, sha256: 'b'.repeat(64) },
      ],
      materials: [
        { attachmentId: 'att_1', filename: '材料.pdf', mimeType: 'application/pdf', sizeBytes: 99 },
      ],
    });
    const { repos, inserted } = baseRepos(reviews);

    await applyRunTransitionInTxn({
      repos,
      runId: RUN.runId,
      scope: { orgId: RUN.orgId, userId: RUN.userId },
      from: 'RUNNING',
      to: 'SUCCEEDED',
      traceId: 't',
      generateId: makeIds(),
    });

    assert.equal(reviews.created.length, 1);
    const { draft } = reviews.created[0];
    assert.equal(draft.runId, RUN.runId);
    assert.equal(draft.orgId, RUN.orgId);
    assert.equal(draft.requesterUserId, RUN.userId);
    assert.equal(draft.agentVersionId, RUN.agentVersionId);
    assert.equal(draft.runStatus, 'SUCCEEDED');
    assert.deepEqual(
      draft.items.map((item: any) => [item.originalArtifactId, item.name, item.sizeBytes]),
      [['art_a', '报告.md', 12], ['art_b', '数据.csv', 34]],
    );
    assert.deepEqual(
      draft.materials.map((material: any) => [material.attachmentId, material.filename]),
      [['att_1', '材料.pdf']],
    );
    // 材料行在**事务内**只落元数据；快照产物 id 由 outbox 消费者补齐
    // （design §6.2：跨服务调用不能放进数据库事务）。
    assert.ok(draft.materials[0].materialId);
    assert.equal(draft.materials[0].materialId.length, 26);

    // 终态本身仍然写 run 事件与 run_notification，审核快照是第三行，待我审核通知是第四行。
    assert.equal(inserted.length, 4);
    assert.equal(inserted[2].aggregateType, AGGREGATE_TYPE_REVIEW);
    assert.equal(inserted[2].eventType, EVENT_TYPE_REVIEW_SNAPSHOT);
    assert.equal(inserted[2].aggregateId, draft.reviewTaskId);
    assert.equal(inserted[3].aggregateType, AGGREGATE_TYPE_REVIEW_NOTIFICATION);
    assert.equal(inserted[3].eventType, EVENT_TYPE_REVIEW_PENDING_NOTIFICATION);
    assert.equal(inserted[3].aggregateId, draft.reviewTaskId);
    assert.deepEqual(inserted[3].payloadJson, {
      reviewTaskId: draft.reviewTaskId,
      orgId: RUN.orgId,
      requesterUserId: RUN.userId,
    });
    assert.ok(!('runId' in inserted[3].payloadJson) && !('run_id' in inserted[3].payloadJson));
  });

  it('没有 review_status 的 artifact.ready（direct 会话）不建任务', async () => {
    // fake 仓储只回「没有待审产物」，与 direct 会话的事件过滤结果同形。
    const reviews = fakeReviewRepo({ artifacts: [] });
    const { repos, inserted } = baseRepos(reviews);

    await applyRunTransitionInTxn({
      repos,
      runId: RUN.runId,
      scope: { orgId: RUN.orgId, userId: RUN.userId },
      from: 'RUNNING',
      to: 'SUCCEEDED',
      traceId: 't',
      generateId: makeIds(),
    });

    assert.equal(reviews.created.length, 0);
    // 只有 run 事件与终态通知两行，没有审核行。
    assert.deepEqual(inserted.map((row) => row.aggregateType), ['run', 'run_notification']);
  });

  it('一个 Run 至多一条任务：已有任务时不再建', async () => {
    const reviews = fakeReviewRepo({
      artifacts: [{ artifactId: 'art_a', name: 'r.md', mimeType: 'text/markdown', size: 1, sha256: 'c'.repeat(64) }],
      existingTaskId: '01M1EXISTING000000000000000',
    });
    const { repos, inserted } = baseRepos(reviews);

    await applyRunTransitionInTxn({
      repos,
      runId: RUN.runId,
      scope: { orgId: RUN.orgId, userId: RUN.userId },
      from: 'RUNNING',
      to: 'CANCELLED',
      traceId: 't',
      generateId: makeIds(),
    });

    assert.equal(reviews.created.length, 0);
    assert.equal(inserted.some((row) => row.aggregateType === AGGREGATE_TYPE_REVIEW), false);
  });

  it('提交产物后被取消的 Run 照样建任务，并记录 run_status=CANCELLED', async () => {
    const reviews = fakeReviewRepo({
      artifacts: [{ artifactId: 'art_a', name: 'r.md', mimeType: 'text/markdown', size: 1, sha256: 'd'.repeat(64) }],
    });
    const { repos } = baseRepos(reviews);

    await applyRunTransitionInTxn({
      repos,
      runId: RUN.runId,
      scope: { orgId: RUN.orgId, userId: RUN.userId },
      from: 'CANCELLING',
      to: 'CANCELLED',
      traceId: 't',
      generateId: makeIds(),
    });

    assert.equal(reviews.created.length, 1);
    assert.equal(reviews.created[0].draft.runStatus, 'CANCELLED');
  });

  it('缺少审核仓储的调用路径（测试替身）不受影响', async () => {
    const inserted: any[] = [];
    await applyRunTransitionInTxn({
      repos: {
        runs: { async updateStatusIf() { return { ...RUN, status: 'SUCCEEDED' }; }, async getById() { return null; } },
        runEvents: { async append(e: any) { return { eventId: e.eventId, sequenceNo: 1 }; } },
        outbox: { async insert(row: any) { inserted.push(row); return row; } },
      },
      runId: RUN.runId,
      scope: { orgId: RUN.orgId, userId: RUN.userId },
      from: 'RUNNING',
      to: 'SUCCEEDED',
      traceId: 't',
      generateId: makeIds(),
    });
    assert.equal(inserted.length, 2);
  });

  it('审核 outbox 行只被审核消费者认领，且不会被 Run 的两个消费者抢走', () => {
    const row = {
      aggregate_type: AGGREGATE_TYPE_REVIEW,
      event_type: EVENT_TYPE_REVIEW_SNAPSHOT,
      payload_json: { reviewTaskId: 'rt1', orgId: RUN.orgId, requesterUserId: RUN.userId },
    };
    assert.equal(rowMatchesEligibility(row, REVIEW_JOB_CLAIM_ELIGIBILITY), true);
    assert.equal(rowMatchesEligibility(row, RUN_STREAM_CLAIM_ELIGIBILITY), false);
    assert.equal(rowMatchesEligibility(row, RUN_NOTIFICATION_CLAIM_ELIGIBILITY), false);
    // 审核结果通知也必须与 Run 终态通知互不认领。
    assert.equal(
      rowMatchesEligibility({ aggregate_type: 'review_notification' }, REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY),
      true,
    );
    assert.equal(
      rowMatchesEligibility({ aggregate_type: 'review_notification' }, RUN_NOTIFICATION_CLAIM_ELIGIBILITY),
      false,
    );
    assert.equal(
      rowMatchesEligibility({ aggregate_type: 'run_notification' }, REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY),
      false,
    );
    // 待我审核行（review_notification 聚合）只被分发器认领，不会被工作队列抢走。
    assert.equal(
      rowMatchesEligibility(
        { aggregate_type: 'review_notification', event_type: 'review.pending.notification' },
        NOTIFICATION_DISPATCH_CLAIM_ELIGIBILITY,
      ),
      true,
    );
    assert.equal(
      rowMatchesEligibility(
        { aggregate_type: 'review_notification', event_type: 'review.pending.notification' },
        REVIEW_JOB_CLAIM_ELIGIBILITY,
      ),
      false,
    );
  });
});
