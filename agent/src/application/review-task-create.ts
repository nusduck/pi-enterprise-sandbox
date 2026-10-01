/**
 * Run 终态建审核任务（design `agent-output-review.md` §5.2 / §6.2、ADR 0016 D2）。
 *
 * 从 `run-transition.ts` 拆出：那个函数是九个终态入口共用的收口点（正常完成、失败、
 * 取消、恢复扫描、挂起取消……），而「这一轮要不要建审核任务、建什么」是一件事，
 * 值得单独一个文件说清楚，也避免 `run-transition.ts` 越写越长。
 *
 * ## 判据是 A1 写进事件的 `review_status`
 *
 * `held` 的权威在 exec（产物可见性），agent 侧唯一的内聚事实是 `artifact.ready`
 * 事件上的 `review_status: "pending"`——它由**绑定版本**的 deliveryPolicy 决定
 * （见 `FencedToolGovernanceRecorder`）。**不去查 exec 的表**：那会让 agent 依赖
 * exec 的 schema，而且 `session_id + visibility='held'` 会把别的 Run 的产物混进来。
 *
 * ## 同一事务建任务 + items + 材料占位，快照交给 outbox
 *
 * 建任务、items、材料行都与 Run 终态同事务（design §5.2「同一事务建任务、items、
 * 材料快照记录」）。但**材料快照本身是跨服务调用**，不能放进事务：材料行先以
 * `snapshot_status='unavailable'` 落库，再由 agent-worker 的审核循环补齐。
 * 这样「快照失败」是一个看得见的状态，而不是静默缺失（design §6.2）。
 *
 * ## 幂等
 *
 * 终态由 CAS 保证只写一次，`UNIQUE(run_id)` 是第二道保险：恢复扫描重放时第二次
 * 插入撞唯一键，`createTask` 返回 `null`，这里不当作错误。
 */

import {
  AGGREGATE_TYPE_REVIEW,
  EVENT_TYPE_REVIEW_SNAPSHOT,
} from '../infrastructure/outbox/outbox-status.js';
import { assertUlid } from '../domain/shared/ulid.js';

type Loose = any;

export interface TerminalReviewInput {
  readonly repos: Loose;
  readonly run: {
    readonly runId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly agentSessionId: string;
    readonly agentVersionId: string;
    readonly triggeringMessageId: string;
  };
  readonly to: string;
  readonly generateId: () => string;
}

export interface TerminalReviewOutcome {
  /** 新建的任务 id；`null` = 这一轮没有待审产物，或任务已经建过。 */
  readonly reviewTaskId: string | null;
  readonly itemCount: number;
  readonly materialCount: number;
}

/**
 * 终态建任务。**在调用方已开的 MySQL 事务里执行**。
 *
 * 没有 `review_status:"pending"` 的 `artifact.ready` 事件 = 这一轮没有交付物
 * （或不是 review 会话）→ 不建任务。这就是 U4「追问的回答不审核」。
 */
export async function ensureReviewTaskForTerminalRun(
  input: TerminalReviewInput,
): Promise<TerminalReviewOutcome> {
  const { repos, run, to } = input;
  const empty: TerminalReviewOutcome = { reviewTaskId: null, itemCount: 0, materialCount: 0 };
  // 守卫：`applyRunTransitionInTxn` 的调用方里有只注入三件套（runs/runEvents/outbox）
  // 的测试替身与历史调用路径。没有审核仓储时什么都不做，而不是抛 undefined。
  if (!repos.reviews || typeof repos.reviews.createTask !== 'function') return empty;

  const artifacts = await repos.reviews.listArtifactReadyEvents(run.runId, run.orgId);
  if (artifacts.length === 0) return empty;

  // 已建过就直接返回（恢复扫描重放同一终态）。
  const existing = await repos.reviews.getTaskByRunId(run.runId, run.orgId);
  if (existing) {
    return { reviewTaskId: existing.reviewTaskId, itemCount: 0, materialCount: 0 };
  }

  const materials = await repos.reviews.listUserAttachmentsUpToRun({
    conversationId: run.conversationId,
    orgId: run.orgId,
    userId: run.userId,
    triggeringMessageId: run.triggeringMessageId,
  });

  const reviewTaskId = assertUlid(input.generateId(), 'reviewTaskId');
  const created = await repos.reviews.createTask(
    {
      reviewTaskId,
      orgId: run.orgId,
      requesterUserId: run.userId,
      conversationId: run.conversationId,
      agentSessionId: run.agentSessionId,
      runId: run.runId,
      agentVersionId: run.agentVersionId,
      runStatus: to,
      items: artifacts.map((artifact: { artifactId: string; name: string; mimeType: string; size: number; sha256: string }) => ({
        originalArtifactId: artifact.artifactId,
        name: artifact.name,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.size,
        sha256: artifact.sha256,
      })),
      materials: materials.map((material: {
        attachmentId: string; filename: string; mimeType: string; sizeBytes: number;
      }) => ({
        materialId: assertUlid(input.generateId(), 'materialId'),
        attachmentId: material.attachmentId,
        filename: material.filename,
        mimeType: material.mimeType,
        sizeBytes: material.sizeBytes,
      })),
    },
    { itemEventId: assertUlid(input.generateId(), 'reviewEventId') },
  );
  if (created === null) {
    // 唯一键撞了：另一个入口（或重放）已经建过这个 Run 的任务。
    const row = await repos.reviews.getTaskByRunId(run.runId, run.orgId);
    return { reviewTaskId: row?.reviewTaskId ?? null, itemCount: 0, materialCount: 0 };
  }

  if (materials.length > 0) {
    await repos.outbox.insert({
      outboxId: assertUlid(input.generateId(), 'reviewOutboxId'),
      aggregateType: AGGREGATE_TYPE_REVIEW,
      aggregateId: reviewTaskId,
      eventType: EVENT_TYPE_REVIEW_SNAPSHOT,
      payloadJson: { reviewTaskId, orgId: run.orgId, requesterUserId: run.userId },
    });
  }

  return { reviewTaskId, itemCount: artifacts.length, materialCount: materials.length };
}
