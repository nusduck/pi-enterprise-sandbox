/**
 * 审核工作队列的 outbox 消费者（design `agent-output-review.md` §5.3 / §6.2）。
 *
 * 认领 `aggregate_type='review'` 的行，做两件 agent 事务里做不了的事（跨服务调用）：
 *
 * | event_type | 做什么 |
 * |---|---|
 * | `review.snapshot` | 把建任务时落下的材料占位行补齐成 exec 里的不可变快照 |
 * | `review.decided`  | 放行/撤回一组产物，并把修订版导入工作区 `审核版/` |
 *
 * ## 失败分类决定"要不要重试"
 *
 * - **4xx / 404**：输入本身不可满足（源文件已被删、产物不存在）→ 这是终态，
 *   结清 outbox 行。材料停在 `unavailable`——design §6.2 要的就是「快照失败是
 *   看得见的状态」，而不是无限重试。
 * - **5xx / 网络**：exec 暂时不可用 → 交给 outbox 的退避重试。
 *
 * ## 幂等
 *
 * exec 侧状态变更是单事务 + `WHERE visibility='held'`；导入是覆盖同名文件。所以
 * 至少一次投递下重复执行是安全的（这正是选 outbox 而不是在 agent 事务里直连的理由）。
 */

import { AGGREGATE_TYPE_REVIEW, EVENT_TYPE_REVIEW_DECIDED, EVENT_TYPE_REVIEW_SNAPSHOT } from '../outbox/outbox-status.js';
import { REVIEW_JOB_CLAIM_ELIGIBILITY } from '../outbox/eligibility.js';
import { MATERIAL_SNAPSHOT_STATUS } from '../mysql/repositories/review-repository.js';
import type { ReviewMaterialRecord, ReviewRepository, ReviewTaskRecord } from '../mysql/repositories/review-repository.js';
import type { OutboxRepository } from '../outbox/outbox-repository.js';
import type { createRepositoryBundle } from '../../bootstrap/container-env.js';
import type { Knex } from 'knex';
import { InternalReviewError, type InternalReviewTransport } from '../sandbox/internal-review-http.js';

/** 仓储容器：复用 ServiceContainer 实际返回的 bundle 类型。 */
type Repositories = ReturnType<typeof createRepositoryBundle>;
/** outbox 认领行的形状：与 OutboxRepository.claimBatch 返回元素一致。 */
type ClaimedRow = Awaited<ReturnType<OutboxRepository['claimBatch']>>[number];
/** 用户附件行：与 ReviewRepository.listUserAttachmentsUpToRun 返回元素一致。 */
type ReviewAttachment = Awaited<ReturnType<ReviewRepository['listUserAttachmentsUpToRun']>>[number];

export type ReviewJobOutcome =
  | 'snapshot_ready'
  | 'snapshot_unavailable'
  | 'released'
  | 'unknown_event'
  | 'not_found'
  | 'retry'
  | 'failed';

export interface ReviewPublisherDeps {
  readonly outbox: OutboxRepository;
  /**
   * 仓储工厂。**必须同时给 `db`**：`ServiceContainer.createRepositories(db?)` 在
   * `db` 为 undefined 时回落到容器自己的 knex，而 worker 进程里那条路径会抛
   * `ServiceContainer MySQL not started`（2026-10-01 真机验收踩到过：放行行被认领后
   * 卡在 PUBLISHING，产物永远不放行）。显式传执行器让这条依赖看得见。
   */
  readonly createRepositories: (db: Knex) => Repositories;
  readonly db: Knex;
  readonly transport: InternalReviewTransport;
  readonly log?: (message: string) => void;
  readonly batchSize?: number;
}

export class ReviewPublisher {
  readonly #outbox: OutboxRepository;
  readonly #createRepositories: (db: Knex) => Repositories;
  readonly #db: Knex;
  readonly #transport: InternalReviewTransport;
  readonly #log: (message: string) => void;
  readonly #batchSize: number;

  constructor(deps: ReviewPublisherDeps) {
    if (!deps?.outbox || typeof deps.createRepositories !== 'function' || !deps.transport) {
      throw new Error('ReviewPublisher requires outbox, createRepositories and transport');
    }
    if (!deps.db) throw new Error('ReviewPublisher requires the knex executor');
    this.#outbox = deps.outbox;
    this.#createRepositories = deps.createRepositories;
    this.#db = deps.db;
    this.#transport = deps.transport;
    this.#log = deps.log ?? (() => {});
    this.#batchSize = deps.batchSize ?? 10;
  }

  async publishOnce(): Promise<{ claimed: number; outcomes: ReviewJobOutcome[] }> {
    const claimed: ClaimedRow[] = await this.#outbox.claimBatch({
      limit: this.#batchSize,
      eligibility: REVIEW_JOB_CLAIM_ELIGIBILITY,
    });
    const outcomes: ReviewJobOutcome[] = [];
    for (const row of claimed) {
      if (!row?.outboxId || !row?.claimToken) continue;
      outcomes.push(await this.#handle(row));
    }
    return { claimed: claimed.length, outcomes };
  }

  async #handle(row: ClaimedRow): Promise<ReviewJobOutcome> {
    const repos = this.#createRepositories(this.#db);
    const payload = (row.payloadJson ?? {}) as Record<string, unknown>;
    const reviewTaskId = typeof payload['reviewTaskId'] === 'string' ? payload['reviewTaskId'] : row.aggregateId;
    const task = await repos.reviews.getTaskById(reviewTaskId);
    if (!task) {
      // 任务不存在（数据被清过）：结清而不是永远重试。
      await this.#outbox.markPublished(row.outboxId, row.claimToken);
      return 'not_found';
    }
    try {
      if (row.eventType === EVENT_TYPE_REVIEW_SNAPSHOT) {
        return await this.#snapshot(repos, task, row);
      }
      if (row.eventType === EVENT_TYPE_REVIEW_DECIDED) {
        return await this.#decided(repos, task, payload, row);
      }
      await this.#outbox.markPublished(row.outboxId, row.claimToken);
      return 'unknown_event';
    } catch (err) {
      if (isTerminalError(err)) {
        // 输入不可满足：结清并留痕（材料停在 unavailable，界面如实提示）。
        this.#log(`review job ${row.eventType} for ${reviewTaskId} settled as terminal: ${describe(err)}`);
        await this.#outbox.markPublished(row.outboxId, row.claimToken);
        return 'failed';
      }
      const outcome = await this.#outbox.markPendingForRetry(row.outboxId, row.claimToken, err, {
        attempts: row.attempts,
      });
      if (outcome === 'failed') {
        this.#log(`review job ${row.eventType} for ${reviewTaskId} gave up after retries`);
        return 'failed';
      }
      return 'retry';
    }
  }

  /** 材料快照：逐个补齐；单个失败不影响其余（每个材料是独立的一行状态）。 */
  async #snapshot(repos: Repositories, task: ReviewTaskRecord, row: ClaimedRow): Promise<ReviewJobOutcome> {
    const materials = await repos.reviews.listMaterials(task.reviewTaskId);
    const pending = materials.filter((material: ReviewMaterialRecord) =>
      material.snapshotStatus !== MATERIAL_SNAPSHOT_STATUS.READY && !material.snapshotArtifactId);
    if (pending.length === 0) {
      await this.#outbox.markPublished(row.outboxId, row.claimToken);
      return 'snapshot_ready';
    }

    // 源路径不在材料行上（账本只记附件身份）：按 attachment_id 从消息里重新解析。
    // 这样「发起人删了工作区文件」会表现为快照失败——正是要的状态，而不是猜路径。
    const attachments = await repos.reviews.listUserAttachmentsUpToRun({
      conversationId: task.conversationId,
      orgId: task.orgId,
      userId: task.requesterUserId,
      triggeringMessageId: (await this.#runFor(repos, task))?.triggeringMessageId ?? '',
    });
    const byAttachment = new Map<string, ReviewAttachment>(
      attachments.map((attachment: ReviewAttachment) => [String(attachment.attachmentId), attachment]),
    );
    const identity = await this.#identityFor(repos, task);

    let ready = 0;
    let unavailable = 0;
    let retryable: unknown = null;
    for (const material of pending) {
      const source = byAttachment.get(material.attachmentId);
      if (!source?.sourcePath) {
        await repos.reviews.markMaterialSnapshot({
          reviewTaskId: task.reviewTaskId,
          materialId: material.materialId,
          snapshotArtifactId: null,
          status: MATERIAL_SNAPSHOT_STATUS.UNAVAILABLE,
        });
        unavailable += 1;
        continue;
      }
      try {
        const snapshot = await this.#transport.snapshot(
          { sourcePath: source.sourcePath, name: material.filename, mimeType: material.mimeType },
          identity,
        );
        await repos.reviews.markMaterialSnapshot({
          reviewTaskId: task.reviewTaskId,
          materialId: material.materialId,
          snapshotArtifactId: snapshot.artifactId,
          status: MATERIAL_SNAPSHOT_STATUS.READY,
        });
        ready += 1;
      } catch (err) {
        if (isTerminalError(err)) {
          await repos.reviews.markMaterialSnapshot({
            reviewTaskId: task.reviewTaskId,
            materialId: material.materialId,
            snapshotArtifactId: null,
            status: MATERIAL_SNAPSHOT_STATUS.UNAVAILABLE,
          });
          unavailable += 1;
          continue;
        }
        retryable = err;
      }
    }

    if (retryable) {
      // 还有材料没结论：整行重试（已 ready 的不会被再改一次，markMaterialSnapshot
      // 在 ready 之后不再覆盖）。
      throw retryable;
    }
    await this.#outbox.markPublished(row.outboxId, row.claimToken);
    this.#log(`review snapshot ${task.reviewTaskId}: ready=${ready} unavailable=${unavailable}`);
    return unavailable > 0 && ready === 0 ? 'snapshot_unavailable' : 'snapshot_ready';
  }

  /** 放行/驳回：状态变更 + （有修订时的）导入工作区。两者都幂等。 */
  async #decided(repos: Repositories, task: ReviewTaskRecord, payload: Record<string, unknown>, row: ClaimedRow): Promise<ReviewJobOutcome> {
    const updates = Array.isArray(payload['updates'])
      ? (payload['updates'] as { artifactId?: unknown; visibility?: unknown }[])
          .map((update) => ({
            artifactId: String(update?.artifactId ?? ''),
            visibility: String(update?.visibility ?? '') as 'released' | 'withdrawn',
          }))
          .filter((update) => update.artifactId && (update.visibility === 'released' || update.visibility === 'withdrawn'))
      : [];
    const imports = Array.isArray(payload['imports'])
      ? (payload['imports'] as { artifactId?: unknown; targetPath?: unknown }[])
          .map((entry) => ({
            artifactId: String(entry?.artifactId ?? ''),
            targetPath: String(entry?.targetPath ?? ''),
          }))
          .filter((entry) => entry.artifactId && entry.targetPath)
      : [];
    if (updates.length === 0 && imports.length === 0) {
      await this.#outbox.markPublished(row.outboxId, row.claimToken);
      return 'released';
    }

    const identity = await this.#identityFor(repos, task);
    if (updates.length > 0) {
      await this.#transport.applyVisibilities({ updates }, identity);
    }
    for (const entry of imports) {
      await this.#transport.importRevision(entry, identity);
    }
    await this.#outbox.markPublished(row.outboxId, row.claimToken);
    this.#log(`review decision ${task.reviewTaskId} applied: updates=${updates.length} imports=${imports.length}`);
    return 'released';
  }

  async #runFor(repos: Repositories, task: ReviewTaskRecord) {
    return await repos.runs.getById(task.runId, { orgId: task.orgId, userId: task.requesterUserId });
  }

  /** exec 侧签名信封需要的身份（工作区与会话来自 AgentSession）。 */
  async #identityFor(repos: Repositories, task: ReviewTaskRecord) {
    const scope = { orgId: task.orgId, userId: task.requesterUserId };
    const session = await repos.sessions.getById(task.agentSessionId, scope);
    const run = await this.#runFor(repos, task);
    return {
      orgId: task.orgId,
      userId: task.requesterUserId,
      workspaceId: String(session?.workspaceId ?? ''),
      conversationId: task.conversationId,
      agentSessionId: task.agentSessionId,
      sandboxSessionId: String(session?.sandboxSessionId ?? ''),
      traceId: String(run?.traceId ?? '').padEnd(32, '0').slice(0, 32),
    };
  }
}

/** 4xx / 404 = 输入不可满足（终态）；5xx 与网络 = 可重试。 */
function isTerminalError(err: unknown): boolean {
  if (err instanceof InternalReviewError) return err.httpStatus >= 400 && err.httpStatus < 500;
  return false;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
