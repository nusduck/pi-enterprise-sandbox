/**
 * 审核员应用服务（design `agent-output-review.md` §6 / §7，ADR 0016 D2/D5）。
 *
 * 一次请求的形状：路由层只做路径/参数解析与错误映射，**鉴权、org 作用域、状态机、
 * 事务边界都在这里**。这是 RBAC 一期 `member-role-service` 的同一套写法：
 * 先判角色（`hasRole`），再解析内部身份（`ExternalIdentityResolver`）——顺序是
 * 刻意的信息保护，未授权者不该知道「这个 org 存不存在」。
 *
 * 几条关键纪律：
 *
 * - **跨租户与不存在同一个 404**：所有读写都带解析出来的 `orgId`，查不到就是
 *   `NOT_FOUND`（AGENTS.md §2）。
 * - **职责分离（U8）**：发起人本人即使持有 `reviewer`，领取自己的任务 → 403
 *   `REVIEW_SELF_FORBIDDEN`。
 * - **跨服务调用不进数据库事务**：材料快照、修订上传、放行/撤回都走 outbox 或
 *   事务外调用，exec 侧幂等（design §5.3 的原话）。
 * - **产物只能经 exec 读写**：审核员下载任一版本、上传修订都经
 *   `internal-review-http` 的内部面，agent 不碰工作区字节。
 */

import { ROLE_ADMIN, ROLE_REVIEWER, hasRole } from '../domain/identity/roles.js';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { assertUlid } from '../domain/shared/ulid.js';
import { ValidationError } from './errors.js';
import {
  AGGREGATE_TYPE_REVIEW,
  AGGREGATE_TYPE_REVIEW_NOTIFICATION,
  AGGREGATE_TYPE_RUN,
  EVENT_TYPE_REVIEW_DECIDED,
  EVENT_TYPE_REVIEW_DECIDED_NOTIFICATION,
} from '../infrastructure/outbox/outbox-status.js';
import { isReviewTerminalStatus, MATERIAL_SNAPSHOT_STATUS, REVIEW_STATUS } from '../infrastructure/mysql/repositories/review-repository.js';
import type { InternalReviewTransport, ReviewIdentity } from '../infrastructure/sandbox/internal-review-http.js';
import { InternalReviewError } from '../infrastructure/sandbox/internal-review-http.js';
import {
  applyArtifactMeta,
  buildVersionChains,
  collectArtifactIds,
} from './review-version-chain.js';
import { REVIEW_TRANSFER_MAX_BYTES } from '@dsh/contract/delivery-policy.js';

type Loose = any;

/** 审核面错误码（design §7）。状态码与码一起定义，路由层原样映射。 */
export class ReviewError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const reviewerRequired = () => new ReviewError(403, 'REVIEWER_REQUIRED', 'Reviewer role is required');
const selfForbidden = () => new ReviewError(403, 'REVIEW_SELF_FORBIDDEN', 'You cannot review your own run');
const notAssignee = () => new ReviewError(403, 'REVIEW_NOT_ASSIGNEE', 'Only the current assignee can do this');
const notFound = () => new ReviewError(404, 'NOT_FOUND', 'Review task not found');
const alreadyClaimed = () => new ReviewError(409, 'REVIEW_ALREADY_CLAIMED', 'This task is already claimed');
const versionConflict = (currentRevision?: number) =>
  new ReviewError(
    409,
    'REVIEW_VERSION_CONFLICT',
    'This task was updated by someone else',
    currentRevision == null ? null : { current_revision: currentRevision },
  );
const alreadyDecided = () => new ReviewError(409, 'REVIEW_ALREADY_DECIDED', 'This task is already decided');
const feedbackRequired = () => new ReviewError(422, 'REVIEW_FEEDBACK_REQUIRED', 'Rejection feedback is required');
const fileInvalid = (message: string) => new ReviewError(422, 'REVIEW_FILE_INVALID', message);

const MAX_LIST_LIMIT = 100;const DEFAULT_LIST_LIMIT = 20;
const MAX_FEEDBACK_LEN = 4_000;
const MAX_NOTE_LEN = 1_000;
const MAX_QUESTIONS = 200;

/**
 * `status` 接受**逗号分隔的多值**（T5：历史页签 = `APPROVED,REJECTED`）。
 *
 * 空值/空白 = 不筛选；大小写、首尾空白与重复值都规范化。**任何一个未知值都 422**，
 * 不静默忽略——静默忽略会让人以为「筛过了」，看到的却是全部。单值调用与以前完全等价。
 */
function parseTaskStatuses(raw: unknown): string[] | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  const allowed = new Set<string>(Object.values(REVIEW_STATUS));
  const out: string[] = [];
  for (const part of text.split(',')) {
    const value = part.trim().toUpperCase();
    if (!value) continue;
    if (!allowed.has(value)) {
      throw new ReviewError(
        422,
        'REVIEW_INPUT_INVALID',
        'status must be a comma-separated subset of PENDING|IN_REVIEW|APPROVED|REJECTED',
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : null;
}
const MAX_REVISION_BYTES = REVIEW_TRANSFER_MAX_BYTES;

/**
 * exec 拒绝超过审核传输上限的读取时（`review_transfer_too_large`），给审核员一个明确的 413，
 * 而不是让 `InternalReviewError` 落到路由兜底变成 500。
 */
async function withTransferLimit<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof InternalReviewError && err.code === 'review_transfer_too_large') {
      throw new ReviewError(413, 'REVIEW_FILE_TOO_LARGE', 'File exceeds the review transfer limit (100 MiB)');
    }
    throw err;
  }
}

/** 修订版在工作区里的落点目录（design §5.3 第 3 步 / §5.4）。 */
export const REVIEW_REVISION_DIR = '审核版';

function resolveListLimit(raw: unknown): number {
  if (raw == null || String(raw).trim() === '') return DEFAULT_LIST_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw new ReviewError(422, 'REVIEW_INPUT_INVALID', `limit must be 1..${MAX_LIST_LIMIT}`);
  }
  return parsed;
}

function sanitizeText(raw: unknown, max: number, field: string, required: boolean): string | null {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim() : '';
  if (!text) {
    if (required) throw feedbackRequired();
    return null;
  }
  if (text.length > max) throw new ValidationError(`${field} is too long`);
  return text;
}

function parseBaseRevision(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReviewError(422, 'REVIEW_INPUT_INVALID', 'base_revision must be a non-negative integer');
  }
  return parsed;
}

/**
 * keyset 游标：`<created_at>|<review_task_id>` 的 base64url。
 *
 * 双键而不是只用时间：同一毫秒建的两条任务用单键游标会漏行。编码成 base64url 只是
 * 为了让它看起来像一个不透明游标（客户端不该解析它），不是加密。
 */
function encodeCursor(task: { createdAt: string | null; reviewTaskId: string }): string {
  return Buffer.from(`${task.createdAt}|${task.reviewTaskId}`, 'utf8').toString('base64url');
}

export interface ReviewServiceDeps {
  readonly db: Loose;
  readonly createRepositories: (db?: Loose) => Loose;
  readonly transactionManager: { run: <T>(work: (trx: Loose) => Promise<T>) => Promise<T> };
  readonly generateId: () => string;
  readonly now?: () => Date;
  /** exec 内部审核面客户端；缺省时审核面拒绝启动（fail-closed）。 */
  readonly reviewTransport: InternalReviewTransport | null;
  /** 解析内部身份用。 */
  readonly resolveOwner?: (actor: Loose) => Promise<{ orgId: string; userId: string }>;
}

export class ReviewService {
  readonly #db: Loose;
  readonly #createRepositories: (db?: Loose) => Loose;
  readonly #tx: { run: <T>(work: (trx: Loose) => Promise<T>) => Promise<T> };
  readonly #generateId: () => string;
  readonly #now: () => Date;
  readonly #transport: InternalReviewTransport | null;
  readonly #resolveOwner: ((actor: Loose) => Promise<{ orgId: string; userId: string }>) | null;

  constructor(deps: ReviewServiceDeps) {
    if (!deps?.db) throw new Error('ReviewService requires db');
    if (typeof deps.createRepositories !== 'function') throw new Error('ReviewService requires createRepositories');
    if (!deps.transactionManager?.run) throw new Error('ReviewService requires transactionManager');
    if (typeof deps.generateId !== 'function') throw new Error('ReviewService requires generateId');
    this.#db = deps.db;
    this.#createRepositories = deps.createRepositories;
    this.#tx = deps.transactionManager;
    this.#generateId = deps.generateId;
    this.#now = deps.now ?? (() => new Date());
    this.#transport = deps.reviewTransport ?? null;
    this.#resolveOwner = deps.resolveOwner ?? null;
  }

  /** exec 面未装配时一律 503：审核面不能"读得到但读不了文件"地半可用。 */
  #requireTransport(): InternalReviewTransport {
    if (!this.#transport) {
      throw new ReviewError(503, 'DEPENDENCY', 'Review plane is unavailable');
    }
    return this.#transport;
  }

  #repos(): Loose {
    return this.#createRepositories(this.#db);
  }

  /**
   * 鉴权 + 身份解析。**先角色、再解析**（与 `member-role-service` 同一顺序）。
   */
  async #reviewer(actor: Loose): Promise<{ orgId: string; userId: string }> {
    if (!actor || !hasRole(actor, ROLE_REVIEWER)) throw reviewerRequired();
    if (!String(actor.externalOrgId ?? '').trim()) throw reviewerRequired();
    if (this.#resolveOwner) return await this.#resolveOwner(actor);
    const repos = this.#repos();
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    const owner = await resolver.resolveOwner({
      externalOrgId: actor.externalOrgId,
      externalUserId: actor.externalUserId,
      role: actor.role,
    });
    return { orgId: owner.orgId, userId: owner.userId };
  }

  async #isAdmin(actor: Loose): Promise<boolean> {
    return hasRole(actor, ROLE_ADMIN);
  }

  /**
   * 任务 + org 作用域。**跨租户与不存在同一个 404**，不给「这个 id 存在但属于别人」
   * 任何可区分的信号。
   */
  async #taskOr404(reviewTaskId: string, orgId: string, repos: Loose = this.#repos()) {
    const task = await repos.reviews.getTask(reviewTaskId, orgId);
    if (!task) throw notFound();
    return task;
  }

  /** 任务所属的工作区与会话身份（exec 侧要它来定位工作区与签名信封）。 */
  async #identityFor(task: Loose): Promise<ReviewIdentity & { workspaceId: string }> {
    const scope = { orgId: task.orgId, userId: task.requesterUserId };
    const session = await this.#repos().sessions.getById(task.agentSessionId, scope);
    if (!session) throw notFound();
    const run = await this.#repos().runs.getById(task.runId, scope);
    return {
      orgId: task.orgId,
      userId: task.requesterUserId,
      workspaceId: String(session.workspaceId),
      conversationId: task.conversationId,
      agentSessionId: task.agentSessionId,
      sandboxSessionId: String(session.sandboxSessionId ?? ''),
      traceId: String(run?.traceId ?? '').padEnd(32, '0').slice(0, 32),
    };
  }

  // ── 列表与详情 ────────────────────────────────────────────────────────

  async listTasks(actor: Loose, query: { status?: string | null; mine?: boolean; cursor?: string | null; limit?: unknown }) {
    const { orgId, userId } = await this.#reviewer(actor);
    const limit = resolveListLimit(query?.limit);
    const statuses = parseTaskStatuses(query?.status);
    const cursor = await this.#decodeCursor(query?.cursor, orgId);
    const rows = await this.#repos().reviews.listTasks({
      orgId,
      statuses,
      assigneeUserId: query?.mine === true ? userId : null,
      cursor,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      tasks: await this.#presentTasks(page),
      next_cursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async #decodeCursor(raw: unknown, orgId: string) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return null;
    // 游标是 `<created_at>|<review_task_id>` 的 base64url。解不出来就当成无效游标
    // 而不是"从头发一页"——静默从头开始会让分页无限循环。
    let decoded = '';
    try {
      decoded = Buffer.from(text, 'base64url').toString('utf8');
    } catch {
      throw new ReviewError(422, 'REVIEW_INPUT_INVALID', 'cursor is invalid');
    }
    const [createdAt, reviewTaskId] = decoded.split('|');
    if (!createdAt || !reviewTaskId) {
      throw new ReviewError(422, 'REVIEW_INPUT_INVALID', 'cursor is invalid');
    }
    const task = await this.#repos().reviews.getTask(reviewTaskId, orgId);
    if (!task) throw new ReviewError(422, 'REVIEW_INPUT_INVALID', 'cursor is invalid');
    return { createdAt: String(task.createdAt), reviewTaskId };
  }

  async #presentTasks(tasks: Loose[]) {
    if (tasks.length === 0) return [];
    const repos = this.#repos();
    const nameOf = await this.#displayNames(repos, tasks.flatMap((task: Loose) =>
      [task.requesterUserId, task.assigneeUserId].filter(Boolean)));
    const items = await Promise.all(tasks.map((task) => repos.reviews.listItems(task.reviewTaskId)));
    const agentNames = await this.#agentNames(repos, tasks.map((task: Loose) => task.agentId));
    return tasks.map((task, index) => ({
      review_task_id: task.reviewTaskId,
      status: task.status,
      run_status: task.runStatus,
      revision: task.revision,
      requester: { user_id: task.requesterUserId, display_name: nameOf(task.requesterUserId) },
      assignee: task.assigneeUserId
        ? { user_id: task.assigneeUserId, display_name: nameOf(task.assigneeUserId) }
        : null,
      item_count: items[index].length,
      // §3.2.1：同一发起人的十几行要能区分开——给出首件交付物名与智能体名，
      // 前端不必逐条请求详情。
      first_item_name: items[index].length > 0 ? String(items[index][0].name || '') || null : null,
      agent_name: agentNames(task.agentId),
      created_at: task.createdAt,
      claimed_at: task.claimedAt,
      decided_at: task.decidedAt,
      feedback: task.feedback,
    }));
  }

  /** 智能体名称：按需取并缓存（列表投影要用，不能每条任务一次查询）。 */
  async #agentNames(repos: Loose, agentIds: readonly string[]) {
    const cache = new Map<string, string | null>();
    const lookup = typeof repos?.catalog?.getDefinitionById === 'function'
      ? repos.catalog.getDefinitionById.bind(repos.catalog)
      : null;
    for (const agentId of new Set(agentIds.map((id) => String(id)).filter(Boolean))) {
      const definition = lookup ? await lookup(agentId).catch(() => null) : null;
      cache.set(agentId, definition?.name == null ? null : String(definition.name));
    }
    return (agentId: string) => cache.get(String(agentId)) ?? null;
  }

  /** 显示名：按需取并缓存（组织里没有批量按 id 取用户的仓储方法）。 */
  async #displayNames(repos: Loose, userIds: readonly string[]) {
    const cache = new Map<string, string | null>();
    for (const userId of new Set(userIds)) {
      const user = await repos.organizations.getUser(userId).catch(() => null);
      cache.set(String(userId), user?.displayName == null ? null : String(user.displayName));
    }
    return (userId: string) => cache.get(String(userId)) ?? null;
  }

  async getTaskDetail(actor: Loose, reviewTaskId: string) {
    const { orgId } = await this.#reviewer(actor);
    const repos = this.#repos();
    const task = await this.#taskOr404(reviewTaskId, orgId, repos);
    const scope = { orgId: task.orgId, userId: task.requesterUserId };
    // Run 行先取：触发消息 id 只在 Run 上（审核任务表没有这一列），而用户提问
    // 的范围是「截至该 Run」。
    const run = await repos.runs.getById(task.runId, scope);
    const [items, materials, events, questions] = await Promise.all([
      repos.reviews.listItems(task.reviewTaskId),
      repos.reviews.listMaterials(task.reviewTaskId),
      repos.reviews.listEvents(task.reviewTaskId),
      run
        ? repos.reviews.listUserQuestionsUpToRun({
            conversationId: task.conversationId,
            orgId: task.orgId,
            userId: task.requesterUserId,
            triggeringMessageId: run.triggeringMessageId,
            limit: MAX_QUESTIONS,
          })
        : Promise.resolve([]),
    ]);
    const versionChains = await this.#versionChains(repos, items, events, task);
    const versionActorIds = [...versionChains.values()]
      .flatMap((chain) => chain.map((entry) => entry.uploaded_by_user_id))
      .filter(Boolean) as string[];
    const nameOf = await this.#displayNames(repos, [
      task.requesterUserId,
      task.assigneeUserId,
      task.decidedBy,
      ...versionActorIds,
    ].filter(Boolean) as string[]);
    const agentVersion = await repos.catalog.getVersionById(task.agentVersionId);
    const agentDefinition = typeof repos.catalog?.getDefinitionById === 'function'
      ? await repos.catalog.getDefinitionById(task.agentId).catch(() => null)
      : null;

    return {
      review_task_id: task.reviewTaskId,
      status: task.status,
      revision: task.revision,
      run_status: task.runStatus,
      run_id: task.runId,
      conversation_id: task.conversationId,
      requester: { user_id: task.requesterUserId, display_name: nameOf(task.requesterUserId) },
      assignee: task.assigneeUserId
        ? { user_id: task.assigneeUserId, display_name: nameOf(task.assigneeUserId) }
        : null,
      agent: {
        agent_id: task.agentId,
        // §3.2.3：元信息里要显示智能体名称，而不只是「智能体版本：1」。
        name: agentDefinition?.name == null ? null : String(agentDefinition.name),
        version_no: agentVersion?.versionNo ?? null,
      },
      created_at: task.createdAt,
      claimed_at: task.claimedAt,
      decided_at: task.decidedAt,
      decided_by: task.decidedBy
        ? { user_id: task.decidedBy, display_name: nameOf(task.decidedBy) }
        : null,
      feedback: task.feedback,
      questions: questions.map((question: Loose) => ({
        message_id: question.messageId,
        sequence_no: question.sequenceNo,
        text: question.text,
        created_at: question.createdAt,
        // §3.2.7：标出触发本次任务的那一条提问，其余是上文（前端可折叠）。
        triggering: run != null && question.messageId === run.triggeringMessageId,
        attachments: question.attachments.map((attachment: Loose) => ({
          attachment_id: attachment.attachmentId,
          filename: attachment.filename,
          mime_type: attachment.mimeType,
          size: attachment.sizeBytes,
        })),
      })),
      materials: materials.map((material: Loose) => ({
        material_id: material.materialId,
        attachment_id: material.attachmentId,
        filename: material.filename,
        mime_type: material.mimeType,
        size: material.sizeBytes,
        snapshot_status: material.snapshotStatus,
      })),
      items: items.map((item: Loose) => ({
        item_no: item.itemNo,
        name: item.name,
        mime_type: item.mimeType,
        size: item.sizeBytes,
        sha256: item.sha256,
        original_artifact_id: item.originalArtifactId,
        current_artifact_id: item.currentArtifactId,
        revised: item.currentArtifactId !== item.originalArtifactId,
        versions: (versionChains.get(item.itemNo) ?? []).map((version: Loose) => ({
          artifact_id: version.artifact_id,
          current: version.current,
          revision: version.revision,
          uploaded_by_kind: version.uploaded_by_kind,
          uploaded_by_user_id: version.uploaded_by_user_id,
          // 修订版的上传者是审核员：给出显示名；原件是智能体，没有用户 id。
          uploaded_by_display_name: version.uploaded_by_user_id
            ? nameOf(version.uploaded_by_user_id)
            : null,
          created_at: version.created_at,
          size: version.size,
        })),
      })),
      events: events.map((event: Loose) => ({
        event_id: event.eventId,
        event_type: event.eventType,
        actor_user_id: event.actorUserId,
        item_no: event.itemNo,
        from_artifact_id: event.fromArtifactId,
        to_artifact_id: event.toArtifactId,
        detail: event.detail,
        created_at: event.createdAt,
      })),
    };
  }

  /**
   * 每件交付物的版本链（形状与来源见 `review-version-chain.ts`）。
   *
   * 这里只负责把 exec 的元数据接上：大小与时间以 exec 的产物记录为权威，取不到就留
   * `null`。**失败降级**——审核面暂时不可用时详情仍要能打开（只有这几列显示「—」）。
   */
  async #versionChains(repos: Loose, items: Loose[], events: Loose[], task: Loose) {
    const chains = buildVersionChains({
      items,
      events,
      taskCreatedAt: task.createdAt == null ? null : String(task.createdAt),
    });
    const transport = this.#transport;
    const ids = collectArtifactIds(chains);
    if (!transport || ids.length === 0) return chains;
    try {
      const identity = await this.#identityFor(task);
      applyArtifactMeta(chains, await transport.readArtifactMeta({ artifactIds: ids }, identity));
    } catch {
      /* 增强项：exec 元数据取不到不影响详情与决定。 */
    }
    return chains;
  }

  /** 任务里所有版本的 artifact id（原件 + 每个修订目标）。 */
  async #allVersions(repos: Loose, reviewTaskId: string) {
    const [items, events] = await Promise.all([
      repos.reviews.listItems(reviewTaskId),
      repos.reviews.listEvents(reviewTaskId),
    ]);
    const ids = new Set<string>();
    for (const item of items) {
      ids.add(item.originalArtifactId);
      ids.add(item.currentArtifactId);
    }
    for (const event of events) {
      if (event.eventType !== 'revised') continue;
      if (event.fromArtifactId) ids.add(event.fromArtifactId);
      if (event.toArtifactId) ids.add(event.toArtifactId);
    }
    return { items, ids };
  }

  // ── 领取 / 释放 ───────────────────────────────────────────────────────

  async claim(actor: Loose, reviewTaskId: string) {
    const { orgId, userId } = await this.#reviewer(actor);
    const repos = this.#repos();
    const task = await this.#taskOr404(reviewTaskId, orgId, repos);
    // U8：发起人本人不能审自己的任务。先于状态判定，避免"已被别人领走"的提示
    // 盖掉职责分离这条更重要的拒绝理由。
    if (task.requesterUserId === userId) throw selfForbidden();
    if (isReviewTerminalStatus(task.status)) throw alreadyDecided();
    const changed = await repos.reviews.claim({ reviewTaskId, orgId, actorUserId: userId });
    if (changed === 0) throw alreadyClaimed();
    await repos.reviews.appendEvent({
      eventId: assertUlid(this.#generateId(), 'eventId'),
      reviewTaskId,
      eventType: 'claimed',
      actorUserId: userId,
      itemNo: null,
      fromArtifactId: null,
      toArtifactId: null,
      detail: null,
    });
    return await this.getTaskDetail(actor, reviewTaskId);
  }

  async releaseClaim(actor: Loose, reviewTaskId: string) {
    const { orgId, userId } = await this.#reviewer(actor);
    const repos = this.#repos();
    const task = await this.#taskOr404(reviewTaskId, orgId, repos);
    if (isReviewTerminalStatus(task.status)) throw alreadyDecided();
    // 领取人本人，或 admin 改派（design §5.2「领取人或 admin」）。
    const isAdmin = await this.#isAdmin(actor);
    if (!isAdmin && task.assigneeUserId !== userId) throw notAssignee();
    if (!task.assigneeUserId) throw notAssignee();
    const changed = await repos.reviews.releaseClaim({
      reviewTaskId,
      orgId,
      assigneeUserId: task.assigneeUserId,
    });
    if (changed === 0) throw versionConflict(task.revision);
    await repos.reviews.appendEvent({
      eventId: assertUlid(this.#generateId(), 'eventId'),
      reviewTaskId,
      eventType: 'released_claim',
      actorUserId: userId,
      itemNo: null,
      fromArtifactId: null,
      toArtifactId: null,
      detail: isAdmin && task.assigneeUserId !== userId ? 'admin released the claim' : null,
    });
    return await this.getTaskDetail(actor, reviewTaskId);
  }

  // ── 修订 ──────────────────────────────────────────────────────────────

  /**
   * 上传修订版（U3）：调 exec 生成 `held` 的新产物，再把 item 的当前版本指过去。
   *
   * **exec 调用在事务外**：跨服务调用不能进数据库事务。代价是「exec 已建产物、
   * agent 记账失败」会留下一件不可见的孤儿 `held` 产物——它不占发起人配额、不对
   * 任何人可见，可以接受；反过来（先记账后调 exec）会留下指向不存在产物的指针，
   * 那才是坏的。
   */
  async uploadRevision(
    actor: Loose,
    reviewTaskId: string,
    itemNo: number,
    input: { baseRevision: unknown; filename?: string | null; mimeType?: string | null; bytes: Uint8Array },
  ) {
    const { orgId, userId } = await this.#reviewer(actor);
    const baseRevision = parseBaseRevision(input?.baseRevision);
    const repos = this.#repos();
    const task = await this.#taskOr404(reviewTaskId, orgId, repos);
    if (isReviewTerminalStatus(task.status)) throw alreadyDecided();
    if (task.assigneeUserId !== userId) throw notAssignee();
    if (task.revision !== baseRevision) throw versionConflict(task.revision);
    if (task.status !== 'IN_REVIEW') throw alreadyClaimed();

    const item = await repos.reviews.getItem(reviewTaskId, Number(itemNo));
    if (!item) throw notFound();
    const bytes = input?.bytes;
    if (!bytes || bytes.byteLength === 0) throw fileInvalid('revision file is empty');
    if (bytes.byteLength > MAX_REVISION_BYTES) throw fileInvalid('revision file is too large');

    const identity = await this.#identityFor(task);
    const record = await this.#requireTransport().submitRevision(
      {
        originalArtifactId: item.originalArtifactId,
        bytes,
        name: input?.filename ?? item.name,
        mimeType: input?.mimeType ?? item.mimeType,
      },
      identity,
    );
    if (!record.artifactId) {
      throw new ReviewError(502, 'DEPENDENCY', 'Sandbox returned no artifact for the revision');
    }

    const changed = await repos.reviews.updateItemCurrentArtifact({
      reviewTaskId,
      orgId,
      itemNo: Number(itemNo),
      expectedCurrentArtifactId: item.currentArtifactId,
      newArtifactId: record.artifactId,
      name: record.name || item.name,
      mimeType: record.mimeType || item.mimeType,
      sizeBytes: record.size,
      sha256: record.sha256,
      expectedRevision: baseRevision,
    });
    if (changed === 0) throw versionConflict(task.revision);

    await repos.reviews.appendEvent({
      eventId: assertUlid(this.#generateId(), 'eventId'),
      reviewTaskId,
      eventType: 'revised',
      actorUserId: userId,
      itemNo: Number(itemNo),
      fromArtifactId: item.currentArtifactId,
      toArtifactId: record.artifactId,
      detail: null,
    });
    return await this.getTaskDetail(actor, reviewTaskId);
  }

  // ── 字节读取（材料快照与交付物任一版本）───────────────────────────────

  /** 材料快照：只认本任务、且快照已就绪的行。 */
  async readMaterial(actor: Loose, reviewTaskId: string, materialId: string) {
    const { orgId } = await this.#reviewer(actor);
    const repos = this.#repos();
    const task = await this.#taskOr404(reviewTaskId, orgId, repos);
    const material = await repos.reviews.getMaterial(reviewTaskId, materialId);
    if (!material || material.snapshotStatus !== MATERIAL_SNAPSHOT_STATUS.READY || !material.snapshotArtifactId) {
      throw notFound();
    }
    const identity = await this.#identityFor(task);
    const artifact = await withTransferLimit(() => this.#requireTransport().getArtifact(
      { artifactId: material.snapshotArtifactId! },
      identity,
    ));
    return {
      filename: material.filename,
      mimeType: material.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    };
  }

  /** 交付物的任一版本——**限本任务内的 artifact**（design §7）。 */
  async readArtifact(actor: Loose, reviewTaskId: string, artifactId: string) {
    const { orgId } = await this.#reviewer(actor);
    const repos = this.#repos();
    const task = await this.#taskOr404(reviewTaskId, orgId, repos);
    const { ids } = await this.#allVersions(repos, reviewTaskId);
    if (!ids.has(artifactId)) throw notFound();
    const identity = await this.#identityFor(task);
    const artifact = await withTransferLimit(() => this.#requireTransport().getArtifact({ artifactId }, identity));
    return {
      filename: artifact.name || artifactId,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      visibility: artifact.visibility,
      revisionOf: artifact.revisionOf,
    };
  }

  // ── 通过 / 驳回（P5）──────────────────────────────────────────────────

  async approve(actor: Loose, reviewTaskId: string, input: { baseRevision: unknown; note?: unknown }) {
    const note = sanitizeText(input?.note, MAX_NOTE_LEN, 'note', false);
    return await this.#decide(actor, reviewTaskId, {
      baseRevision: input?.baseRevision,
      status: 'APPROVED',
      feedback: note,
    });
  }

  async reject(actor: Loose, reviewTaskId: string, input: { baseRevision: unknown; feedback?: unknown }) {
    // 驳回反馈**必填**（U3）：空反馈让发起人无从知道要改什么。
    const feedback = sanitizeText(input?.feedback, MAX_FEEDBACK_LEN, 'feedback', true);
    return await this.#decide(actor, reviewTaskId, {
      baseRevision: input?.baseRevision,
      status: 'REJECTED',
      feedback,
    });
  }

  /**
   * 通过 / 驳回的**唯一**事务边界。
   *
   * 一个事务里做完：CAS 改任务状态 → 审计事件 → 原 Run 上的 `artifact.released` /
   * `review.rejected` 事件 → 会话消息 → outbox（放行/撤回 + 通知）。
   *
   * 放行本身**不在**这个事务里：它要调 exec（跨服务），所以经 outbox 由
   * agent-worker 的审核循环投递，exec 侧幂等（design §5.3 原话）。
   */
  async #decide(
    actor: Loose,
    reviewTaskId: string,
    input: { baseRevision: unknown; status: 'APPROVED' | 'REJECTED'; feedback: string | null },
  ) {
    const { orgId, userId } = await this.#reviewer(actor);
    const baseRevision = parseBaseRevision(input.baseRevision);
    const now = this.#now();
    const generateId = this.#generateId;

    const outcome = await this.#tx.run(async (trx: Loose) => {
      const repos = this.#createRepositories(trx);
      const task = await repos.reviews.getTask(reviewTaskId, orgId);
      if (!task) throw notFound();
      if (isReviewTerminalStatus(task.status)) throw alreadyDecided();
      if (task.assigneeUserId !== userId) throw notAssignee();
      if (task.status !== 'IN_REVIEW') throw alreadyClaimed();
      if (task.revision !== baseRevision) throw versionConflict(task.revision);

      const { items, ids } = await this.#allVersions(repos, reviewTaskId);
      const session = await repos.sessions.getById(task.agentSessionId, {
        orgId: task.orgId,
        userId: task.requesterUserId,
      });
      const run = await repos.runs.getById(task.runId, {
        orgId: task.orgId,
        userId: task.requesterUserId,
      });
      if (!run || !session) throw notFound();

      const changed = await repos.reviews.decide({
        reviewTaskId,
        orgId,
        expectedRevision: baseRevision,
        assigneeUserId: userId,
        status: input.status,
        feedback: input.feedback,
      });
      if (changed === 0) throw versionConflict(task.revision);

      await repos.reviews.appendEvent({
        eventId: assertUlid(generateId(), 'eventId'),
        reviewTaskId,
        eventType: input.status === 'APPROVED' ? 'approved' : 'rejected',
        actorUserId: userId,
        itemNo: null,
        fromArtifactId: null,
        toArtifactId: null,
        detail: input.feedback,
      });

      const approved = input.status === 'APPROVED';
      // `originalArtifactId`：前端聊天卡片的 id 是智能体提交的原件；有修订时靠它把卡片对上当前版本。
      const releasedArtifacts = items.map((item: Loose) => ({
        artifactId: item.currentArtifactId,
        originalArtifactId: item.originalArtifactId,
        name: item.name,
        mimeType: item.mimeType,
        size: item.sizeBytes,
        revised: item.currentArtifactId !== item.originalArtifactId,
      }));

      // 原 Run 上的事件：前端刷新后靠会话事件重放拿到审核结果（U2 只审交付物，
      // 所以事件挂在产出它的那次 Run 上）。
      await appendRunEventInTxn(repos, {
        run,
        type: approved ? 'artifact.released' : 'review.rejected',
        data: approved
          ? { reviewTaskId, artifacts: releasedArtifacts }
          : { reviewTaskId, feedback: input.feedback, artifacts: releasedArtifacts.map(({ artifactId, originalArtifactId, name }: Loose) => ({ artifactId, originalArtifactId, name })) },
        generateId,
        now,
      });

      // 会话消息：通过是 assistant 的交付说明，驳回是 system 的状态说明。
      // 两者都在 plan §8.7 冻结的枚举内（`text` / `status`）。
      await repos.messages.append({
        messageId: assertUlid(generateId(), 'messageId'),
        conversationId: task.conversationId,
        orgId: task.orgId,
        userId: task.requesterUserId,
        agentSessionId: task.agentSessionId,
        runId: task.runId,
        role: approved ? 'assistant' : 'system',
        messageType: approved ? 'text' : 'status',
        contentJson: approved
          ? { kind: 'review_released', review_task_id: reviewTaskId, artifacts: releasedArtifacts }
          : { kind: 'review_rejected', review_task_id: reviewTaskId, feedback: input.feedback },
        createdAt: now,
      });

      // 放行/撤回的工作项：当前版本放行、其余版本撤回（原件与中间修订）。
      const updates = approved
        ? [
            ...items.map((item: Loose) => ({ artifactId: item.currentArtifactId, visibility: 'released' as const })),
            ...[...ids]
              .filter((artifactId) => !items.some((item: Loose) => item.currentArtifactId === artifactId))
              .map((artifactId) => ({ artifactId, visibility: 'withdrawn' as const })),
          ]
        : [...ids].map((artifactId) => ({ artifactId, visibility: 'withdrawn' as const }));

      // 有修订时把当前版本导入工作区 `审核版/`，让模型基于审核员改过的版本继续
      // 修改（§5.4）。放行与导入都经 outbox：跨服务调用不进事务。
      const imports = approved
        ? items
            .filter((item: Loose) => item.currentArtifactId !== item.originalArtifactId)
            .map((item: Loose) => ({
              artifactId: item.currentArtifactId,
              targetPath: `${REVIEW_REVISION_DIR}/${item.name}`,
            }))
        : [];

      await repos.outbox.insert({
        outboxId: assertUlid(generateId(), 'reviewOutboxId'),
        aggregateType: AGGREGATE_TYPE_REVIEW,
        aggregateId: reviewTaskId,
        eventType: EVENT_TYPE_REVIEW_DECIDED,
        // payload **不带 runId 键**：RunEventStream 的 eligibility 会认领任何带
        // `payload.runId` 的行（见 outbox-status.ts 的注释）。
        payloadJson: {
          reviewTaskId,
          orgId: task.orgId,
          requesterUserId: task.requesterUserId,
          conversationId: task.conversationId,
          agentSessionId: task.agentSessionId,
          workspaceId: String(session.workspaceId),
          decision: input.status,
          updates,
          imports,
        },
      });

      await repos.outbox.insert({
        outboxId: assertUlid(generateId(), 'reviewNotificationOutboxId'),
        aggregateType: AGGREGATE_TYPE_REVIEW_NOTIFICATION,
        aggregateId: reviewTaskId,
        eventType: EVENT_TYPE_REVIEW_DECIDED_NOTIFICATION,
        payloadJson: {
          reviewTaskId,
          orgId: task.orgId,
          requesterUserId: task.requesterUserId,
          decision: input.status,
        },
      });

      return { reviewTaskId };
    });

    return await this.getTaskDetail(actor, outcome.reviewTaskId);
  }
}

/**
 * 在审核事务里追加一条挂在原 Run 上的运行事件。
 *
 * 形状与 `FencedToolGovernanceRecorder.#appendEventInTrx` 一致（`{context, data}` +
 * 同事务的 outbox 行），因为前端重放与 SSE 都按这个形状读。
 */
async function appendRunEventInTxn(
  repos: Loose,
  input: { run: Loose; type: string; data: Record<string, unknown>; generateId: () => string; now: Date },
): Promise<void> {
  const { run } = input;
  const eventId = assertUlid(input.generateId(), 'eventId');
  const outboxId = assertUlid(input.generateId(), 'outboxId');
  const context = {
    orgId: run.orgId,
    userId: run.userId,
    conversationId: run.conversationId,
    agentSessionId: run.agentSessionId,
    runId: run.runId,
    traceId: run.traceId,
    spanId: null,
  };
  const stored = await repos.runEvents.append({
    eventId,
    runId: run.runId,
    orgId: run.orgId,
    userId: run.userId,
    eventType: input.type,
    eventVersion: 1,
    payloadJson: { context, data: input.data },
    traceId: run.traceId,
    createdAt: input.now,
  });
  await repos.outbox.insert({
    outboxId,
    aggregateType: AGGREGATE_TYPE_RUN,
    aggregateId: run.runId,
    eventType: input.type,
    payloadJson: {
      eventId: stored.eventId,
      eventVersion: 1,
      sequence: stored.sequenceNo,
      type: input.type,
      timestamp: input.now.toISOString(),
      context,
      data: input.data,
      runId: run.runId,
      orgId: run.orgId,
      userId: run.userId,
    },
  });
}

export { InternalReviewError };
