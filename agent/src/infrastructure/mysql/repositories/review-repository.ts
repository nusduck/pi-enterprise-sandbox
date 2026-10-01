/**
 * 审核账本仓储（design `agent-output-review.md` §5.1、ADR 0016 D2）。
 *
 * 四张表都在这里：`tasks` / `items` / `materials` / `events`。表结构见迁移
 * `20261001000004_review_ledger.js`，本文件只做读写，不重复表语义。
 *
 * 几条贯穿全文件的纪律：
 *
 * - **org 作用域**：每一条读写都带 `org_id`。跨租户与不存在返回同一个 `null`
 *   （AGENTS.md §2「跨租户一律 404」），由调用方翻成 404，不在这里抛 403。
 * - **乐观并发**：`revision` 是任务级的版本号，领取/释放/决定都带
 *   `expectedRevision` 做 CAS；影响 0 行 = 有人先改了（409）。
 * - **状态机单向**：`PENDING -> IN_REVIEW -> APPROVED | REJECTED`，终态不可再变。
 *   条件更新里的 `WHERE status = ...` 就是这条规则的执行点，不是靠调用方自觉。
 */

import { toMysqlDateTime } from '../row-mappers.js';

type Loose = any;

/** 状态取值与迁移 `REVIEW_TASK_STATUSES` 一致；这里再钉一次，避免拼写漂移。 */
export const REVIEW_STATUS = Object.freeze({
  PENDING: 'PENDING',
  IN_REVIEW: 'IN_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export type ReviewTaskStatus = 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED';

export const REVIEW_TERMINAL_STATUSES: readonly ReviewTaskStatus[] = Object.freeze([
  'APPROVED',
  'REJECTED',
]);

export function isReviewTerminalStatus(status: string): boolean {
  return (REVIEW_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 审计事件类型（design §5.1）。只追加，不修改。 */
export const REVIEW_EVENT_TYPES = Object.freeze([
  'created',
  'claimed',
  'released_claim',
  'revised',
  'approved',
  'rejected',
]);

export const MATERIAL_SNAPSHOT_STATUS = Object.freeze({
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
});

export interface ReviewTaskRecord {
  reviewTaskId: string;
  orgId: string;
  requesterUserId: string;
  conversationId: string;
  agentSessionId: string;
  runId: string;
  agentId: string;
  agentVersionId: string;
  runStatus: string;
  status: ReviewTaskStatus;
  assigneeUserId: string | null;
  claimedAt: string | null;
  revision: number;
  feedback: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  contextInjectedRunId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReviewItemRecord {
  itemNo: number;
  originalArtifactId: string;
  currentArtifactId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ReviewMaterialRecord {
  materialId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  snapshotArtifactId: string | null;
  snapshotStatus: string;
}

export interface ReviewEventRecord {
  eventId: string;
  eventType: string;
  actorUserId: string | null;
  itemNo: number | null;
  fromArtifactId: string | null;
  toArtifactId: string | null;
  detail: string | null;
  createdAt: string | null;
}

export interface ReviewTaskDraft {
  readonly reviewTaskId: string;
  readonly orgId: string;
  readonly requesterUserId: string;
  readonly conversationId: string;
  readonly agentSessionId: string;
  readonly runId: string;
  readonly agentVersionId: string;
  readonly runStatus: string;
  readonly items: readonly {
    readonly originalArtifactId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }[];
  readonly materials: readonly {
    readonly materialId: string;
    readonly attachmentId: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }[];
}

function mapTask(row: Loose): ReviewTaskRecord {
  return {
    reviewTaskId: String(row.review_task_id),
    orgId: String(row.org_id),
    requesterUserId: String(row.requester_user_id),
    conversationId: String(row.conversation_id),
    agentSessionId: String(row.agent_session_id),
    runId: String(row.run_id),
    agentId: String(row.agent_id),
    agentVersionId: String(row.agent_version_id),
    runStatus: String(row.run_status ?? ''),
    status: String(row.status) as ReviewTaskStatus,
    assigneeUserId: row.assignee_user_id == null ? null : String(row.assignee_user_id),
    claimedAt: row.claimed_at == null ? null : toMysqlDateTime(row.claimed_at),
    revision: Number(row.revision ?? 0),
    feedback: row.feedback == null ? null : String(row.feedback),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    decidedAt: row.decided_at == null ? null : toMysqlDateTime(row.decided_at),
    contextInjectedRunId:
      row.context_injected_run_id == null ? null : String(row.context_injected_run_id),
    createdAt: row.created_at == null ? null : toMysqlDateTime(row.created_at),
    updatedAt: row.updated_at == null ? null : toMysqlDateTime(row.updated_at),
  };
}

function mapItem(row: Loose): ReviewItemRecord {
  return {
    itemNo: Number(row.item_no),
    originalArtifactId: String(row.original_artifact_id),
    currentArtifactId: String(row.current_artifact_id),
    name: String(row.name ?? ''),
    mimeType: String(row.mime_type ?? 'application/octet-stream'),
    sizeBytes: Number(row.size_bytes ?? 0),
    sha256: String(row.sha256 ?? ''),
  };
}

function mapMaterial(row: Loose): ReviewMaterialRecord {
  return {
    materialId: String(row.material_id),
    attachmentId: String(row.attachment_id),
    filename: String(row.filename ?? ''),
    mimeType: String(row.mime_type ?? 'application/octet-stream'),
    sizeBytes: Number(row.size_bytes ?? 0),
    snapshotArtifactId:
      row.snapshot_artifact_id == null ? null : String(row.snapshot_artifact_id),
    snapshotStatus: String(row.snapshot_status ?? MATERIAL_SNAPSHOT_STATUS.UNAVAILABLE),
  };
}

function mapEvent(row: Loose): ReviewEventRecord {
  return {
    eventId: String(row.event_id),
    eventType: String(row.event_type ?? ''),
    actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
    itemNo: row.item_no == null ? null : Number(row.item_no),
    fromArtifactId: row.from_artifact_id == null ? null : String(row.from_artifact_id),
    toArtifactId: row.to_artifact_id == null ? null : String(row.to_artifact_id),
    detail: row.detail == null ? null : String(row.detail),
    createdAt: row.created_at == null ? null : toMysqlDateTime(row.created_at),
  };
}

/**
 * 判定一条插入冲突是不是「这个 Run 已经有审核任务了」。
 *
 * 建任务与 Run 终态同事务，而终态由 CAS 保证只写一次；`UNIQUE(run_id)` 是第二道
 * 保险：恢复扫描重放同一终态时，第二次插入撞唯一键，语义是「已经建过」而不是错误。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null;
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062;
}

export class ReviewRepository {
  db: Loose;
  now: () => Date;

  constructor(db: Loose, { now = () => new Date() }: { now?: () => Date } = {}) {
    if (!db) throw new Error('ReviewRepository requires a knex executor');
    this.db = db;
    this.now = now;
  }

  /**
   * 同事务建任务 + items + materials + `created` 审计事件。
   *
   * @returns 新建的任务 id；`null` = 这个 Run 已经有一条任务（唯一键冲突），
   *          重放不是错误。
   */
  async createTask(draft: ReviewTaskDraft, itemIds: {
    readonly itemEventId: string;
  }): Promise<string | null> {
    const { reviewTaskId, orgId } = draft;
    // agent_id 不在 runs 行里（只有 agent_version_id），从版本行取——版本是
    // 「这个会话绑定了哪个智能体」的权威，读它比信调用方传进来的更稳。
    const versionRow = await this.db('tbl_agsvc_agent_versions')
      .where({ agent_version_id: draft.agentVersionId })
      .first('agent_id');
    const agentId = versionRow?.agent_id == null ? '' : String(versionRow.agent_id);
    if (!agentId) {
      throw new Error(`AgentVersion not found while creating review task: ${draft.agentVersionId}`);
    }

    const now = toMysqlDateTime(this.now());
    try {
      await this.db('tbl_agsvc_review_tasks').insert({
        review_task_id: reviewTaskId,
        org_id: orgId,
        requester_user_id: draft.requesterUserId,
        conversation_id: draft.conversationId,
        agent_session_id: draft.agentSessionId,
        run_id: draft.runId,
        agent_id: agentId,
        agent_version_id: draft.agentVersionId,
        run_status: draft.runStatus,
        status: REVIEW_STATUS.PENDING,
        assignee_user_id: null,
        claimed_at: null,
        revision: 0,
        feedback: null,
        decided_by: null,
        decided_at: null,
        context_injected_run_id: null,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }

    if (draft.items.length > 0) {
      await this.db('tbl_agsvc_review_items').insert(
        draft.items.map((item, index) => ({
          review_task_id: reviewTaskId,
          item_no: index + 1,
          original_artifact_id: item.originalArtifactId,
          current_artifact_id: item.originalArtifactId,
          name: item.name,
          mime_type: item.mimeType,
          size_bytes: item.sizeBytes,
          sha256: item.sha256,
        })),
      );
    }

    if (draft.materials.length > 0) {
      await this.db('tbl_agsvc_review_materials').insert(
        draft.materials.map((material) => ({
          review_task_id: reviewTaskId,
          material_id: material.materialId,
          attachment_id: material.attachmentId,
          filename: material.filename,
          mime_type: material.mimeType,
          size_bytes: material.sizeBytes,
          snapshot_artifact_id: null,
          // 初始就是「不可用」：快照要么由后台消费者补上，要么明确停在
          // 「不可用」让审核员界面如实提示（design §6.2 不静默缺失）。
          snapshot_status: MATERIAL_SNAPSHOT_STATUS.UNAVAILABLE,
        })),
      );
    }

    await this.appendEvent({
      eventId: itemIds.itemEventId,
      reviewTaskId,
      eventType: 'created',
      actorUserId: null,
      itemNo: null,
      fromArtifactId: null,
      toArtifactId: null,
      detail: JSON.stringify({ items: draft.items.length, materials: draft.materials.length }),
    });
    return reviewTaskId;
  }

  /** 所有 `artifact.ready` 事件的负载（本 Run），用于建 items。 */
  async listArtifactReadyEvents(
    runId: string,
    orgId: string,
  ): Promise<{ artifactId: string; name: string; mimeType: string; size: number; sha256: string }[]> {
    const rows = await this.db('tbl_agsvc_run_events')
      .where({ run_id: runId, org_id: orgId, event_type: 'artifact.ready' })
      .orderBy('sequence_no', 'asc')
      .select('payload_json');
    const out: { artifactId: string; name: string; mimeType: string; size: number; sha256: string }[] = [];
    for (const row of rows) {
      const data = parseEventData(row.payload_json);
      const artifactId = String(data.artifactId ?? '').trim();
      if (!artifactId) continue;
      // A1：只有 review 会话的产物才带 `review_status: "pending"`。direct 会话
      // 的交付物不进审核，所以这里就是「本轮有没有待审产物」的判据。
      if (data.review_status !== 'pending') continue;
      out.push({
        artifactId,
        name: String(data.name ?? artifactId),
        mimeType: String(data.mimeType ?? 'application/octet-stream'),
        size: Number(data.size ?? 0) || 0,
        sha256: String(data.sha256 ?? ''),
      });
    }
    return out;
  }

  /**
   * 审核员要看的**用户提问**（U5）：本会话截至该 Run 的 `role=user` 消息文字与附件。
   *
   * 只给文字与附件，不给智能体的回复——U5 没有要求，一期不给（design §6.1）。
   */
  async listUserQuestionsUpToRun(input: {
    readonly conversationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly triggeringMessageId: string;
    readonly limit: number;
  }): Promise<{
    messageId: string;
    sequenceNo: number;
    text: string;
    createdAt: string | null;
    attachments: { attachmentId: string; filename: string; mimeType: string; sizeBytes: number; sourcePath: string }[];
  }[]> {
    const bounded = await this.#boundedUserMessages(input);
    if (bounded === null) return [];
    const rows = await this.db('tbl_agsvc_messages')
      .where({ conversation_id: input.conversationId, role: 'user' })
      .andWhere('sequence_no', '<=', bounded.maxSequence)
      .orderBy('sequence_no', 'asc')
      .limit(input.limit)
      .select('message_id', 'sequence_no', 'content_json', 'created_at');
    return rows.map((row: Loose) => {
      const content = typeof row.content_json === 'string' ? safeParse(row.content_json) : row.content_json;
      const record = (content ?? {}) as Record<string, unknown>;
      return {
        messageId: String(row.message_id),
        sequenceNo: Number(row.sequence_no),
        text: typeof record['text'] === 'string' ? String(record['text']) : '',
        createdAt: row.created_at == null ? null : toMysqlDateTime(row.created_at),
        attachments: attachmentsOf(row.content_json),
      };
    });
  }

  /**
   * 会话作用域 + 该 Run 触发消息的序号。
   *
   * `tbl_agsvc_messages` 没有 org/user 列（归属在会话上），所以作用域通过会话行
   * 证明：读不到「这个 org+user 名下的这个会话」就返回 null，不去猜消息属于谁。
   */
  async #boundedUserMessages(input: {
    readonly conversationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly triggeringMessageId: string;
  }): Promise<{ maxSequence: number } | null> {
    const conversation = await this.db('tbl_agsvc_conversations')
      .where({
        conversation_id: input.conversationId,
        org_id: input.orgId,
        user_id: input.userId,
      })
      .first('conversation_id');
    if (!conversation) return null;
    const trigger = await this.db('tbl_agsvc_messages')
      .where({
        message_id: input.triggeringMessageId,
        conversation_id: input.conversationId,
      })
      .first('sequence_no');
    if (trigger?.sequence_no == null) return null;
    return { maxSequence: Number(trigger.sequence_no) };
  }

  /**
   * 本会话截至该 Run 的用户附件（U5 / §6.2）。
   *
   * 取 `role='user'` 且 `sequence_no <= 该 Run 触发消息` 的消息，从中抽
   * `attachments[].path`（`uploads/<name>`）。同一路径只快照一次：多轮重复上传同名
   * 文件时，后面那次的内容才是审核依据，取**最后一次**出现。
   */
  async listUserAttachmentsUpToRun(input: {
    readonly conversationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly triggeringMessageId: string;
  }): Promise<{ attachmentId: string; filename: string; mimeType: string; sizeBytes: number; sourcePath: string }[]> {
    const bounded = await this.#boundedUserMessages(input);
    if (bounded === null) return [];

    const query = this.db('tbl_agsvc_messages')
      .where({ conversation_id: input.conversationId, role: 'user' })
      .andWhere('sequence_no', '<=', bounded.maxSequence)
      .orderBy('sequence_no', 'asc')
      .select('content_json');

    const byPath = new Map<string, { attachmentId: string; filename: string; mimeType: string; sizeBytes: number; sourcePath: string }>();
    for (const row of await query) {
      for (const attachment of attachmentsOf(row.content_json)) byPath.set(attachment.sourcePath, attachment);
    }
    return [...byPath.values()];
  }

  /** org 作用域取任务；跨 org 与不存在都是 `null`。 */
  async getTask(reviewTaskId: string, orgId: string): Promise<ReviewTaskRecord | null> {
    const row = await this.db('tbl_agsvc_review_tasks')
      .where({ review_task_id: reviewTaskId, org_id: orgId })
      .first();
    return row ? mapTask(row) : null;
  }

  /** 供 outbox 消费者用：按任务 id 取（不带 org，调用方已有可信 org）。 */
  async getTaskById(reviewTaskId: string): Promise<ReviewTaskRecord | null> {
    const row = await this.db('tbl_agsvc_review_tasks')
      .where({ review_task_id: reviewTaskId })
      .first();
    return row ? mapTask(row) : null;
  }

  async getTaskByRunId(runId: string, orgId: string): Promise<ReviewTaskRecord | null> {
    const row = await this.db('tbl_agsvc_review_tasks')
      .where({ run_id: runId, org_id: orgId })
      .first();
    return row ? mapTask(row) : null;
  }

  /**
   * 审核池与历史。
   *
   * `statuses` / `assigneeUserId` 都是可选的收窄条件；游标是 keyset 式
   * （`created_at` + `review_task_id` 双键，避免同毫秒行被跳过）。
   *
   * `statuses` 是**列表**（T5）：历史页签要一次拿 APPROVED + REJECTED。空数组与
   * null 语义相同（不筛选）；调用方已把未知值挡在 422，这里不再校验。
   */
  async listTasks(input: {
    readonly orgId: string;
    readonly statuses?: readonly string[] | null;
    readonly assigneeUserId?: string | null;
    readonly cursor?: { createdAt: string; reviewTaskId: string } | null;
    readonly limit: number;
  }): Promise<ReviewTaskRecord[]> {
    const q = this.db('tbl_agsvc_review_tasks').where({ org_id: input.orgId });
    if (input.statuses && input.statuses.length > 0) q.whereIn('status', [...input.statuses]);
    if (input.assigneeUserId) q.andWhere({ assignee_user_id: input.assigneeUserId });
    if (input.cursor) {
      q.andWhere((qb: Loose) => {
        qb.where('created_at', '<', input.cursor!.createdAt).orWhere((inner: Loose) => {
          inner
            .where('created_at', '=', input.cursor!.createdAt)
            .andWhere('review_task_id', '<', input.cursor!.reviewTaskId);
        });
      });
    }
    const rows = await q
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'review_task_id', order: 'desc' }])
      .limit(input.limit);
    return rows.map(mapTask);
  }

  async listItems(reviewTaskId: string): Promise<ReviewItemRecord[]> {
    const rows = await this.db('tbl_agsvc_review_items')
      .where({ review_task_id: reviewTaskId })
      .orderBy('item_no', 'asc');
    return rows.map(mapItem);
  }

  async getItem(reviewTaskId: string, itemNo: number): Promise<ReviewItemRecord | null> {
    const row = await this.db('tbl_agsvc_review_items')
      .where({ review_task_id: reviewTaskId, item_no: itemNo })
      .first();
    return row ? mapItem(row) : null;
  }

  async listMaterials(reviewTaskId: string): Promise<ReviewMaterialRecord[]> {
    const rows = await this.db('tbl_agsvc_review_materials')
      .where({ review_task_id: reviewTaskId })
      .orderBy('material_id', 'asc');
    return rows.map(mapMaterial);
  }

  async getMaterial(reviewTaskId: string, materialId: string): Promise<ReviewMaterialRecord | null> {
    const row = await this.db('tbl_agsvc_review_materials')
      .where({ review_task_id: reviewTaskId, material_id: materialId })
      .first();
    return row ? mapMaterial(row) : null;
  }

  async listEvents(reviewTaskId: string): Promise<ReviewEventRecord[]> {
    const rows = await this.db('tbl_agsvc_review_events')
      .where({ review_task_id: reviewTaskId })
      .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'event_id', order: 'asc' }]);
    return rows.map(mapEvent);
  }

  async appendEvent(input: {
    readonly eventId: string;
    readonly reviewTaskId: string;
    readonly eventType: string;
    readonly actorUserId: string | null;
    readonly itemNo: number | null;
    readonly fromArtifactId: string | null;
    readonly toArtifactId: string | null;
    readonly detail: string | null;
  }): Promise<void> {
    await this.db('tbl_agsvc_review_events').insert({
      event_id: input.eventId,
      review_task_id: input.reviewTaskId,
      event_type: input.eventType,
      actor_user_id: input.actorUserId,
      item_no: input.itemNo,
      from_artifact_id: input.fromArtifactId,
      to_artifact_id: input.toArtifactId,
      detail: input.detail,
      created_at: toMysqlDateTime(this.now()),
    });
  }

  /**
   * 领取：条件更新 `WHERE status='PENDING' AND assignee IS NULL`。
   *
   * @returns 影响行数；0 = 已被别人领取（409 `REVIEW_ALREADY_CLAIMED`）。
   */
  async claim(input: {
    readonly reviewTaskId: string;
    readonly orgId: string;
    readonly actorUserId: string;
  }): Promise<number> {
    const now = toMysqlDateTime(this.now());
    return await this.db('tbl_agsvc_review_tasks')
      .where({ review_task_id: input.reviewTaskId, org_id: input.orgId, status: REVIEW_STATUS.PENDING })
      .whereNull('assignee_user_id')
      .update({
        status: REVIEW_STATUS.IN_REVIEW,
        assignee_user_id: input.actorUserId,
        claimed_at: now,
        revision: this.db.raw('revision + 1'),
        updated_at: now,
      });
  }

  /** 释放领取：回到 `PENDING`，清掉领取人。 */
  async releaseClaim(input: {
    readonly reviewTaskId: string;
    readonly orgId: string;
    readonly assigneeUserId: string;
  }): Promise<number> {
    const now = toMysqlDateTime(this.now());
    return await this.db('tbl_agsvc_review_tasks')
      .where({
        review_task_id: input.reviewTaskId,
        org_id: input.orgId,
        status: REVIEW_STATUS.IN_REVIEW,
        assignee_user_id: input.assigneeUserId,
      })
      .update({
        status: REVIEW_STATUS.PENDING,
        assignee_user_id: null,
        claimed_at: null,
        revision: this.db.raw('revision + 1'),
        updated_at: now,
      });
  }

  /**
   * 决定（通过/驳回）：带 `expectedRevision` 的 CAS。
   *
   * @returns 影响行数；0 = 版本不符或已经不是 IN_REVIEW（409）。
   */
  async decide(input: {
    readonly reviewTaskId: string;
    readonly orgId: string;
    readonly expectedRevision: number;
    readonly assigneeUserId: string;
    readonly status: 'APPROVED' | 'REJECTED';
    readonly feedback: string | null;
  }): Promise<number> {
    const now = toMysqlDateTime(this.now());
    return await this.db('tbl_agsvc_review_tasks')
      .where({
        review_task_id: input.reviewTaskId,
        org_id: input.orgId,
        status: REVIEW_STATUS.IN_REVIEW,
        assignee_user_id: input.assigneeUserId,
        revision: input.expectedRevision,
      })
      .update({
        status: input.status,
        feedback: input.feedback,
        decided_by: input.assigneeUserId,
        decided_at: now,
        revision: this.db.raw('revision + 1'),
        updated_at: now,
      });
  }

  /**
   * 修订：把 item 的当前版本指向新产物，`status` 保持 `IN_REVIEW`（design §5.2）。
   *
   * 带 `expectedRevision`（任务级）与 `expectedCurrentArtifactId`（item 级）双 CAS：
   * 前者挡「决定/领取已经改过任务」，后者挡「另一个修订已经换过这一件」。
   */
  async updateItemCurrentArtifact(input: {
    readonly reviewTaskId: string;
    readonly orgId: string;
    readonly itemNo: number;
    readonly expectedCurrentArtifactId: string;
    readonly newArtifactId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly expectedRevision: number;
  }): Promise<number> {
    const now = toMysqlDateTime(this.now());
    return await this.db.transaction(async (trx: Loose) => {
      const task = await trx('tbl_agsvc_review_tasks')
        .where({
          review_task_id: input.reviewTaskId,
          org_id: input.orgId,
          status: REVIEW_STATUS.IN_REVIEW,
          revision: input.expectedRevision,
        })
        .forUpdate()
        .first('review_task_id');
      if (!task) return 0;
      const changed = await trx('tbl_agsvc_review_items')
        .where({
          review_task_id: input.reviewTaskId,
          item_no: input.itemNo,
          current_artifact_id: input.expectedCurrentArtifactId,
        })
        .update({
          current_artifact_id: input.newArtifactId,
          name: input.name,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
          sha256: input.sha256,
        });
      if (changed === 0) return 0;
      await trx('tbl_agsvc_review_tasks')
        .where({ review_task_id: input.reviewTaskId, org_id: input.orgId })
        .update({ revision: trx.raw('revision + 1'), updated_at: now });
      return changed;
    });
  }

  /** 材料快照就绪（或失败）：只写一次，`snapshot_status='ready'` 后不再覆盖。 */
  async markMaterialSnapshot(input: {
    readonly reviewTaskId: string;
    readonly materialId: string;
    readonly snapshotArtifactId: string | null;
    readonly status: string;
  }): Promise<number> {
    return await this.db('tbl_agsvc_review_materials')
      .where({
        review_task_id: input.reviewTaskId,
        material_id: input.materialId,
      })
      .whereNot({ snapshot_status: MATERIAL_SNAPSHOT_STATUS.READY })
      .update({
        snapshot_artifact_id: input.snapshotArtifactId,
        snapshot_status: input.status,
      });
  }

  /**
   * §5.4：把「已决任务的注入文本已注入到哪一次 Run」记下来。
   *
   * 条件更新保证**每个任务只注入一次**：两个并发 Run 同时派生提示词时，只有一个
   * 能拿到 1 行的影响数，另一个不会再注入同样的文本。
   */
  async markContextInjected(reviewTaskId: string, runId: string): Promise<number> {
    return await this.db('tbl_agsvc_review_tasks')
      .where({ review_task_id: reviewTaskId })
      .whereNull('context_injected_run_id')
      .update({
        context_injected_run_id: runId,
        updated_at: toMysqlDateTime(this.now()),
      });
  }

  /**
   * 尚未注入的已决任务（同一会话、按决定时间升序）。
   *
   * `excludedRunId` 挡掉当前这次 Run：任务是在 Run 终态建的，那次 Run 自己不该
   * 收到「你的交付物已通过审核」的注入。
   */
  async listPendingContextInjection(input: {
    readonly conversationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly limit: number;
  }): Promise<ReviewTaskRecord[]> {
    const rows = await this.db('tbl_agsvc_review_tasks')
      .where({
        conversation_id: input.conversationId,
        org_id: input.orgId,
        requester_user_id: input.userId,
      })
      .whereIn('status', REVIEW_TERMINAL_STATUSES)
      .whereNull('context_injected_run_id')
      .orderBy('decided_at', 'asc')
      .limit(input.limit);
    return rows.map(mapTask);
  }
}

function parseEventData(payloadJson: unknown): Record<string, unknown> {
  const payload = typeof payloadJson === 'string' ? safeParse(payloadJson) : payloadJson;
  if (!payload || typeof payload !== 'object') return {};
  const data = (payload as Record<string, unknown>)['data'];
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 从消息 `content_json` 里抽附件清单（形状见 `dsh-run-input.attachmentsFromTriggeringMessage`）。 */
export function attachmentsOf(contentJson: unknown): {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string;
}[] {
  const content = typeof contentJson === 'string' ? safeParse(contentJson) : contentJson;
  if (!content || typeof content !== 'object') return [];
  const record = content as Record<string, unknown>;
  const messages = Array.isArray(record['messages']) ? (record['messages'] as unknown[]) : [];
  const collected: Record<string, unknown>[] = [];
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry['role'] !== 'user' && entry['role'] != null) continue;
    if (Array.isArray(entry['attachments'])) collected.push(...(entry['attachments'] as Record<string, unknown>[]));
  }
  if (Array.isArray(record['attachments'])) collected.push(...(record['attachments'] as Record<string, unknown>[]));

  const out: { attachmentId: string; filename: string; mimeType: string; sizeBytes: number; sourcePath: string }[] = [];
  for (const item of collected) {
    if (!item || typeof item !== 'object') continue;
    const attachmentId = String(item['attachment_id'] ?? item['attachmentId'] ?? '').trim();
    // 快照的输入是**工作区里的逻辑路径**。前端从上传响应里带回了 `path`
    // （`uploads/<name>`）；没有 path 的老数据只能记为不可用，不能猜。
    const sourcePath = String(item['path'] ?? item['workspace_path'] ?? '').trim();
    if (!attachmentId || !sourcePath) continue;
    const mimeType = String(item['mime_type'] ?? item['mimeType'] ?? '').trim().toLowerCase();
    out.push({
      attachmentId,
      filename: String(item['filename'] ?? item['name'] ?? sourcePath.split('/').pop() ?? 'attachment'),
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: Number(item['size'] ?? 0) || 0,
      sourcePath,
    });
  }
  return out;
}
