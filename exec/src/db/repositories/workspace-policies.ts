/**
 * exec 工作区交付策略——`tbl_agsvc_exec_workspace_policies`。
 *
 * design `agent-output-review.md` §3.1 / ADR 0016 D1：审核工作区里的产物在放行前
 * 对发起人不可见，**而产物库与导入路径根本不经过 agent**，所以「这个工作区要审核」
 * 必须是 exec 自己记录并执行的事实。策略由 agent 在会话确保时经 HMAC 内部面传入，
 * 这里只负责存与读。
 *
 * **只能设置、不能撤销。** 会话绑定的 AgentVersion 不可更换（design F5），策略在
 * 会话创建时就固定，因此没有撤销接口；写入用 `INSERT IGNORE`，重复 ensure 不会把
 * `review` 改回别的值。这条性质是刻意的：一个能撤销的接口就是一个可以把审核关掉的
 * 后门，而它的调用方是模型可达的那条路径。
 *
 * 读失败必须 fail-closed（调用方把 null 与"查询失败"分开处理，见
 * `requireOwnedSession`）：「查不到策略」被当成「不需要审核」正是这个功能要防的。
 */

import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ExecDbPool as Pool } from '../failover-pool.js';

/** 目前只有一种非默认策略。`direct` 等于没有行。 */
export type WorkspaceDelivery = 'review';

export interface WorkspacePolicyRecord {
  readonly workspaceId: string;
  readonly orgId: string;
  readonly delivery: WorkspaceDelivery;
  readonly createdAt: Date;
}

export interface WorkspacePolicyStore {
  /** 记录这个工作区需要审核。已存在即无操作（只能设置、不能撤销）。 */
  rememberReview(workspaceId: string, orgId: string): Promise<void>;
  /**
   * 读审核策略绑定的组织。`null` = 没有审核策略（direct 工作区或从未 ensure）。
   *
   * 用途唯一：`DELETE /sessions/:id` 的跨租户 404。exec 侧没有 sandbox session
   * 表，这是唯一能判定"这个审核工作区是谁的"的事实：由 HMAC 内部面 ensure 经
   * 已校验 claims 写入（`rememberReview`），只能设置、不能撤销。direct 工作区
   * 没有行，调用方仍走轻量归属（上游 agent/BFF 已做过 owner 校验）。
   *
   * **实现必须把 I/O 失败抛出去**，不能吞成 `null`：调用方 fail-closed 503。
   */
  reviewOwnerOf(workspaceId: string): Promise<string | null>;
  /**
   * 读工作区策略。`null` = 没有策略，即 direct。
   *
   * **实现必须把 I/O 失败抛出去**，不能吞成 `null`：调用方按
   * 「null = 直接交付」放行，把查询失败伪装成 null 就等于审核可以靠一次
   * 数据库抖动被绕过。
   */
  deliveryOf(workspaceId: string): Promise<WorkspaceDelivery | null>;
}

interface Row extends RowDataPacket {
  workspace_id: string;
  org_id: string;
  delivery: string;
  created_at: Date;
}

function mapRow(r: Row): WorkspacePolicyRecord {
  return {
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    // 未知取值一律当成 review：库内出现第未知值只可能是更新的写入方，
    // 把「看不懂的策略」降级成 direct 会让审核静默失效。
    delivery: 'review',
    createdAt: r.created_at,
  };
}

export class MySqlWorkspacePolicyStore implements WorkspacePolicyStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'tbl_agsvc_exec_workspace_policies',
  ) {}

  async rememberReview(workspaceId: string, orgId: string): Promise<void> {
    // INSERT IGNORE：重复 ensure 是常态（每次 Run 都会调），而"已存在"必须保持
    // 原值而不是覆盖——否则一个能改策略的调用方就能把它改回去。
    await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO ${this.table} (workspace_id, org_id, delivery)
       VALUES (?, ?, 'review')`,
      [workspaceId, orgId],
    );
  }

  async deliveryOf(workspaceId: string): Promise<WorkspaceDelivery | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT workspace_id, org_id, delivery, created_at FROM ${this.table} WHERE workspace_id = ?`,
      [workspaceId],
    );
    const row = rows[0] as Row | undefined;
    return row === undefined ? null : mapRow(row).delivery;
  }

  async reviewOwnerOf(workspaceId: string): Promise<string | null> {
    // 无需迁移：`org_id` 列已存在，这里只读它，不改变 `deliveryOf` 语义。
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT org_id FROM ${this.table} WHERE workspace_id = ?`,
      [workspaceId],
    );
    const row = rows[0] as Row | undefined;
    return row?.org_id ?? null;
  }
}

export class InMemoryWorkspacePolicyStore implements WorkspacePolicyStore {
  private readonly map = new Map<string, WorkspacePolicyRecord>();

  async rememberReview(workspaceId: string, orgId: string): Promise<void> {
    if (this.map.has(workspaceId)) return;
    this.map.set(workspaceId, {
      workspaceId,
      orgId,
      delivery: 'review',
      createdAt: new Date(),
    });
  }

  async deliveryOf(workspaceId: string): Promise<WorkspaceDelivery | null> {
    return this.map.get(workspaceId)?.delivery ?? null;
  }

  async reviewOwnerOf(workspaceId: string): Promise<string | null> {
    return this.map.get(workspaceId)?.orgId ?? null;
  }
}
