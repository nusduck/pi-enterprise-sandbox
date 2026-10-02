/**
 * 共享申请账本（ADR 0015 D6，design §5.2 的 `tbl_agsvc_skill_share_requests`）。
 *
 * ## 这条流程存在的理由
 *
 * 用户自己的「启用」只让 Skill 进入**作者自己**的上下文。进入 org 层意味着它进入
 * **他人**的 prompt 与执行环境，是信任等级的提升——所以不能复用用户自己的启用，
 * 必须留下「谁申请、申请的是哪一份字节、谁批准」的记录。这个仓储就是那本账。
 *
 * ## 状态机
 *
 * ```
 * pending ──批准──▶ approved
 *    │      └─驳回──▶ rejected
 *    ├─撤回──▶ withdrawn
 *    └─同名再次申请──▶ superseded
 * ```
 *
 * `approved` / `rejected` / `withdrawn` / `superseded` 都是**终态**：状态只能从
 * `pending` 迁出。允许回退会让「这条申请被拒过」这个事实消失。
 *
 * ## 为什么「至多一条 pending」是应用层约束而不是唯一键
 *
 * 历史行必须保留（审批轨迹是审计材料），所以不能对 `(org, requester, name)` 做唯一约束
 * ——那样第二次申请会撞以前的终态行。约束因此落在事务内：`supersedePending` 先把旧
 * `pending` 置为 `superseded`，再插新行。
 */
import { physicalTableName } from '../schema-tables.js';
import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';
import type { KeysetPosition } from '../../../application/keyset-cursor.js';

type Loose = any;

const REQUESTS = physicalTableName('skill_share_requests');

/** 申请状态。除 `pending` 外都是终态。 */
export type ShareRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'superseded';

export interface ShareRequestRow {
  readonly requestId: string;
  readonly orgId: string;
  readonly requesterUserId: string;
  readonly name: string;
  readonly contentDigest: string;
  readonly note: string;
  readonly status: ShareRequestStatus;
  readonly decidedByUserId: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string;
  readonly createdAt: string;
}

export class ShareRequestError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ShareRequestError';
    this.code = code;
  }
}

function mapRow(row: Loose): ShareRequestRow {
  const raw = String(row.status);
  const status: ShareRequestStatus = raw === 'approved'
    || raw === 'rejected'
    || raw === 'withdrawn'
    || raw === 'superseded'
    ? raw
    : 'pending';
  return {
    requestId: String(row.request_id),
    orgId: String(row.org_id),
    requesterUserId: String(row.requester_user_id),
    name: String(row.skill_name),
    contentDigest: String(row.content_digest),
    note: String(row.note ?? ''),
    status,
    decidedByUserId: String(row.decided_by_user_id ?? ''),
    // dateStrings 读回无时区的 UTC 串；转成带 Z 的 ISO，与其它账本 DTO 一致。
    decidedAt: formatDateTime(row.decided_at),
    decisionNote: String(row.decision_note ?? ''),
    createdAt: formatDateTime(row.created_at) ?? '',
  };
}

/** 终态：只能从 `pending` 迁出，且不能再改。 */
const TERMINAL: readonly ShareRequestStatus[] = ['approved', 'rejected', 'withdrawn', 'superseded'];

export class SkillShareRequestRepository {
  constructor(
    private readonly db: Loose,
    private readonly opts: { now?: () => Date; generateId?: () => string } = {},
  ) {
    if (!db) throw new Error('SkillShareRequestRepository requires a knex executor');
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  private id(): string {
    if (typeof this.opts.generateId !== 'function') {
      throw new Error('SkillShareRequestRepository requires generateId');
    }
    return this.opts.generateId();
  }

  /**
   * 新建一条申请，并把同名**旧 pending** 置为 `superseded`。
   *
   * 两步在**同一个事务**里：中间态（两条 pending）会让「管理员该批哪一条」没有答案，
   * 而两条都批会让同一份字节被发布两次。
   */
  async create(input: {
    orgId: string;
    requesterUserId: string;
    name: string;
    contentDigest: string;
    note?: string;
  }): Promise<ShareRequestRow> {
    const requestId = this.id();
    const now = toMysqlDateTime(this.now());
    return this.db.transaction(async (trx: Loose) => {
      await trx(REQUESTS)
        .where({
          org_id: input.orgId,
          requester_user_id: input.requesterUserId,
          skill_name: input.name,
          status: 'pending',
        })
        .update({
          status: 'superseded',
          decided_by_user_id: input.requesterUserId,
          decided_at: now,
          decision_note: 'superseded by a newer request for the same skill',
        });
      const row = {
        request_id: requestId,
        org_id: input.orgId,
        requester_user_id: input.requesterUserId,
        skill_name: input.name,
        content_digest: input.contentDigest,
        note: input.note ?? '',
        status: 'pending',
        decided_by_user_id: '',
        decided_at: null,
        decision_note: '',
        created_at: now,
      };
      await trx(REQUESTS).insert(row);
      return mapRow(row);
    });
  }

  async get(requestId: string): Promise<ShareRequestRow | null> {
    const row = await this.db(REQUESTS).where({ request_id: String(requestId) }).first();
    return row ? mapRow(row) : null;
  }

  /**
   * 本 org 的申请，可按状态过滤（管理员列表）。
   *
   * 排序 `created_at desc, request_id desc`（design ui-polish §2.4）：本来的
   * 升序没有主键参与，同毫秒的两条申请在 keyset 翻页里会重复/漏掉；主键是
   * `CHAR(26)`，字典序与「同一时刻内后建的排在前面」一致。
   */
  async listForOrg(input: {
    orgId: string;
    status?: ShareRequestStatus;
    limit?: number;
    before?: KeysetPosition | null;
  }): Promise<ShareRequestRow[]> {
    let query = this.db(REQUESTS).where({ org_id: String(input.orgId) });
    if (input.status) query.where({ status: input.status });
    if (input.before) {
      const at = toMysqlDateTime(input.before.sortValue);
      const id = String(input.before.key);
      query = query.andWhere((w: Loose) => {
        w.where('created_at', '<', at).orWhere((w2: Loose) => {
          w2.where('created_at', '=', at).andWhere('request_id', '<', id);
        });
      });
    }
    const rows: Loose[] = await query
      .orderBy('created_at', 'desc')
      .orderBy('request_id', 'desc')
      .limit(Math.max(1, Math.min(Number(input.limit) || 200, 500)));
    return rows.map(mapRow);
  }

  /** 本人的申请（用户侧列表）。 */
  async listForRequester(input: {
    orgId: string;
    requesterUserId: string;
  }): Promise<ShareRequestRow[]> {
    const rows: Loose[] = await this.db(REQUESTS)
      .where({
        org_id: String(input.orgId),
        requester_user_id: String(input.requesterUserId),
      })
      .orderBy('created_at', 'desc');
    return rows.map(mapRow);
  }

  /**
   * 把一条 **pending** 申请迁到终态。
   *
   * 三条 fail-closed 判定，都在事务内、对着锁住的行做：
   * - 申请不存在 → `SKILL_SHARE_REQUEST_UNKNOWN`（HTTP 层给 404）；
   * - 已是终态 → `SKILL_SHARE_REQUEST_DECIDED`：不能二次决定，否则「被拒过」会消失；
   * - 只有 `pending` 能迁出（上面两条合起来就是这条）。
   */
  async decide(input: {
    requestId: string;
    status: Exclude<ShareRequestStatus, 'pending' | 'superseded'>;
    decidedByUserId: string;
    note?: string;
  }): Promise<ShareRequestRow> {
    return this.db.transaction(async (trx: Loose) => {
      const existing: Loose = await trx(REQUESTS)
        .where({ request_id: String(input.requestId) })
        .forUpdate()
        .first();
      if (!existing) {
        throw new ShareRequestError(
          `share request ${input.requestId} does not exist`,
          'SKILL_SHARE_REQUEST_UNKNOWN',
        );
      }
      const current = mapRow(existing);
      if (current.status !== 'pending') {
        throw new ShareRequestError(
          `share request ${input.requestId} is already ${current.status}`,
          'SKILL_SHARE_REQUEST_DECIDED',
        );
      }
      const now = toMysqlDateTime(this.now());
      await trx(REQUESTS).where({ request_id: current.requestId }).update({
        status: input.status,
        decided_by_user_id: input.decidedByUserId,
        decided_at: now,
        decision_note: input.note ?? '',
      });
      return mapRow({
        ...existing,
        status: input.status,
        decided_by_user_id: input.decidedByUserId,
        decided_at: now,
        decision_note: input.note ?? '',
      });
    });
  }

  /**
   * 批准之后发布字节失败：把申请退回 `pending`（ADR 0015 D6）。
   *
   * 批准先迁状态、后发字节（与撤回互斥）；字节失败时必须退回，否则留下「已批准但
   * org 层没有这个版本」。只退回**本次批准**：状态仍是 approved 且决定人是同一个
   * 管理员，否则什么都不做（已被别的流程改过，不覆盖）。
   *
   * @returns 是否真的退回了
   */
  async reopenApproval(input: { requestId: string; decidedByUserId: string }): Promise<boolean> {
    return this.db.transaction(async (trx: Loose) => {
      const existing: Loose = await trx(REQUESTS)
        .where({ request_id: String(input.requestId) })
        .forUpdate()
        .first();
      if (!existing) return false;
      const current = mapRow(existing);
      if (current.status !== 'approved' || current.decidedByUserId !== String(input.decidedByUserId)) {
        return false;
      }
      await trx(REQUESTS).where({ request_id: current.requestId }).update({
        status: 'pending',
        decided_by_user_id: '',
        decided_at: null,
        decision_note: '',
      });
      return true;
    });
  }

  /** 撤回本人的 pending 申请。非 pending 或非本人一律拒绝。 */
  async withdraw(input: {
    requestId: string;
    requesterUserId: string;
  }): Promise<ShareRequestRow> {
    return this.db.transaction(async (trx: Loose) => {
      const existing: Loose = await trx(REQUESTS)
        .where({ request_id: String(input.requestId) })
        .forUpdate()
        .first();
      if (!existing) {
        // 别人的申请也走这里：**跨用户一律 404**，不泄漏存在性。
        throw new ShareRequestError(
          `share request ${input.requestId} does not exist`,
          'SKILL_SHARE_REQUEST_UNKNOWN',
        );
      }
      const current = mapRow(existing);
      if (current.requesterUserId !== String(input.requesterUserId)) {
        throw new ShareRequestError(
          `share request ${input.requestId} does not exist`,
          'SKILL_SHARE_REQUEST_UNKNOWN',
        );
      }
      if (current.status !== 'pending') {
        throw new ShareRequestError(
          `share request ${input.requestId} is already ${current.status}`,
          'SKILL_SHARE_REQUEST_DECIDED',
        );
      }
      const now = toMysqlDateTime(this.now());
      await trx(REQUESTS).where({ request_id: current.requestId }).update({
        status: 'withdrawn',
        decided_by_user_id: current.requesterUserId,
        decided_at: now,
        decision_note: 'withdrawn by the requester',
      });
      return mapRow({
        ...existing,
        status: 'withdrawn',
        decided_by_user_id: current.requesterUserId,
        decided_at: now,
      });
    });
  }

  /**
   * 成员被移出 org 时把其 pending 申请置为 `withdrawn`（design §12）。
   *
   * 不删行：审批轨迹是审计材料，「他申请过、因为离开组织而作废」是事实的一部分。
   */
  async withdrawAllForRequester(input: {
    orgId: string;
    requesterUserId: string;
  }): Promise<number> {
    const now = toMysqlDateTime(this.now());
    const affected = await this.db(REQUESTS)
      .where({
        org_id: String(input.orgId),
        requester_user_id: String(input.requesterUserId),
        status: 'pending',
      })
      .update({
        status: 'withdrawn',
        decided_by_user_id: String(input.requesterUserId),
        decided_at: now,
        decision_note: 'requester left the organization',
      });
    return Number(affected) || 0;
  }

  /** 供测试与审计：断言终态集合没有被动过。 */
  static isTerminal(status: ShareRequestStatus): boolean {
    return TERMINAL.includes(status);
  }
}
