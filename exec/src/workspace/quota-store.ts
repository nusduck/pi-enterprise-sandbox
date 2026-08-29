/**
 * 配额预留的持久化接口——**主控要求的窄接口**，交给 W3-D 接手正式仓储层
 * （见任务说明"数据库怎么处理"一节）。这里不建平行仓储体系：只定义接口 +
 * 一个 `mysql2` 实现 + 一个测试用内存实现，迁移权威仍在 `agent/`。
 *
 * 为什么预留记录要挪进这里而不是继续用 Python 版的做法：Python 版
 * `sandbox/services/workspace_quota_ledger.py` 把预留写成
 * `control_root/quota/{workspace_id}/res/{reservation_id}` 下的一个个文件，
 * 理由写在它的 docstring 里——"reservations live **outside** the untrusted
 * workspace bind; untrusted children cannot delete/tamper reservation files
 * to oversell quota"。这条设计意图必须原样保留：**不可信子进程能删掉工作区
 * 内的文件，账本必须放在工作区外面**，否则子进程删掉几个预留文件就能让
 * 账本以为配额还有富余，超卖磁盘。
 *
 * 数据库天然满足"工作区外面"这条要求——它不挂进 Bubblewrap 的任何绑定，
 * 子进程物理上摸不到。比起 Python 版的控制面文件树，DB 还多两条好处：
 * 一是不需要 `fcntl.flock` 之类的同机多进程文件锁（`WorkspaceLock` 接口
 * 已经覆盖了单实例场景下的互斥，见 `lock.ts`）；二是配额记录天然对齐到
 * `exec/` 这一批新表要用的同一个 MySQL 实例，不用再运维一棵独立的
 * 控制面目录树。
 *
 * **本文件不建表、不跑迁移**——见 `MySqlQuotaStore` 顶部注释列出的所需列，
 * 迁移由 `agent/` 权威仓库执行。
 */

/** 配额预留的持久化窄接口。`WorkspaceQuotaLedger`（`quota-ledger.ts`）是
 * 唯一消费者；不要绕开它直接操作这个接口——业务规则（超卖判定、净增量计算）
 * 全在 ledger 层，store 只负责"读写一个 (workspaceId, reservationId) → bytes
 * 的键值对，以及按 workspaceId 求和"。 */
export interface QuotaStore {
  /** 某个 workspace 当前全部**活跃**预留字节之和。workspace 从未有过预留
   * 时返回 0。 */
  sumReserved(workspaceId: string): Promise<number>;

  /** 读取单条预留的字节数；不存在时返回 0（`releaseReservation()` 的幂等
   * 重放、`reserveReplacement()` 读取"此前是否有同 id 的预留"都依赖这个
   * 幂等语义）。 */
  getReservationBytes(workspaceId: string, reservationId: string): Promise<number>;

  /** 落一条预留记录，覆盖写（不存在则创建，存在则更新字节数）。调用方
   * （ledger 层）负责保证这一步发生在 `WorkspaceLock` 的临界区内，
   * store 本身不做额外的并发控制。 */
  putReservation(workspaceId: string, reservationId: string, bytes: number): Promise<void>;

  /** 幂等删除一条预留；不存在时不报错（对应释放已释放的预留、或者
   * `reserveReplacement()` net_growth 归零时清理占位记录）。 */
  deleteReservation(workspaceId: string, reservationId: string): Promise<void>;

  /** 释放底层连接（`MySqlQuotaStore` 用；内存实现是空操作）。 */
  close?(): Promise<void>;
}

/**
 * 测试用内存实现——`exec/test/workspace-quota-ledger.test.ts` 用它验证
 * `WorkspaceQuotaLedger` 的业务逻辑，不依赖真实数据库。
 *
 * 用两层 `Map`（`workspaceId → reservationId → bytes`）表示，`sumReserved`
 * 对内层 Map 的值求和——语义上等价于 Python 版 `_sum_disk_reservations()`
 * 对 `control_root/quota/{workspace_id}/res/*` 目录的求和，只是介质从文件
 * 换成了内存。
 */
export class InMemoryQuotaStore implements QuotaStore {
  private readonly byWorkspace = new Map<string, Map<string, number>>();

  private bucket(workspaceId: string): Map<string, number> {
    let bucket = this.byWorkspace.get(workspaceId);
    if (!bucket) {
      bucket = new Map();
      this.byWorkspace.set(workspaceId, bucket);
    }
    return bucket;
  }

  async sumReserved(workspaceId: string): Promise<number> {
    const bucket = this.byWorkspace.get(workspaceId);
    if (!bucket) return 0;
    let total = 0;
    for (const bytes of bucket.values()) total += bytes;
    return total;
  }

  async getReservationBytes(workspaceId: string, reservationId: string): Promise<number> {
    return this.byWorkspace.get(workspaceId)?.get(reservationId) ?? 0;
  }

  async putReservation(workspaceId: string, reservationId: string, bytes: number): Promise<void> {
    this.bucket(workspaceId).set(reservationId, bytes);
  }

  async deleteReservation(workspaceId: string, reservationId: string): Promise<void> {
    const bucket = this.byWorkspace.get(workspaceId);
    if (!bucket) return;
    bucket.delete(reservationId);
    if (bucket.size === 0) this.byWorkspace.delete(workspaceId);
  }
}

/** `MySqlQuotaStore` 需要的连接池最小形状——只声明用到的方法，不强绑
 * `mysql2` 的具体类型，方便测试用手写替身（虽然本包的单测目前只跑
 * `InMemoryQuotaStore`，这个接口留给 W3-D 接手正式仓储层时复用）。 */
export interface MySqlPoolLike {
  execute(sql: string, params: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

interface SumRow {
  readonly total: number | string | null;
}
interface BytesRow {
  readonly bytes: number | string;
}

function isRowArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value);
}

/**
 * `mysql2` 支撑的实现。**所需的表结构**（迁移由 `agent/` 权威仓库执行，
 * 这里只写出需要哪些列，交给 W3-D）：
 *
 * ```sql
 * CREATE TABLE workspace_quota_reservations (
 *   workspace_id   VARCHAR(191)      NOT NULL,
 *   reservation_id VARCHAR(191)      NOT NULL,
 *   bytes          BIGINT UNSIGNED   NOT NULL,
 *   created_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 *   updated_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
 *                                    ON UPDATE CURRENT_TIMESTAMP(3),
 *   PRIMARY KEY (workspace_id, reservation_id)
 * );
 * ```
 *
 * `PRIMARY KEY (workspace_id, reservation_id)` 同时是 `sumReserved()` 那条
 * `WHERE workspace_id = ?` 查询的天然索引前缀，不需要额外建索引。
 *
 * 每个方法都是单条语句，事务性由调用方（`WorkspaceQuotaLedger`）通过
 * `WorkspaceLock` 的临界区保证，不在这里开事务——单实例部署下，同一个
 * `workspaceId` 的读-判定-写已经被 `WorkspaceLock` 串行化，数据库事务不是
 * 必需的额外层；多实例部署换锁实现时（ADR 0008 D5 的预留扩展点），如果
 * 换成了不提供跨请求串行化的锁（理论上不应该，但留个提醒），才需要重新
 * 评估这里是否要包事务。
 */
export class MySqlQuotaStore implements QuotaStore {
  constructor(
    private readonly pool: MySqlPoolLike,
    private readonly table: string = 'workspace_quota_reservations',
  ) {}

  async sumReserved(workspaceId: string): Promise<number> {
    const [rows] = (await this.pool.execute(
      `SELECT COALESCE(SUM(bytes), 0) AS total FROM ${this.table} WHERE workspace_id = ?`,
      [workspaceId],
    )) as [SumRow[]];
    const first = isRowArray(rows) ? (rows[0] as unknown as SumRow | undefined) : undefined;
    return Number(first?.total ?? 0);
  }

  async getReservationBytes(workspaceId: string, reservationId: string): Promise<number> {
    const [rows] = (await this.pool.execute(
      `SELECT bytes FROM ${this.table} WHERE workspace_id = ? AND reservation_id = ?`,
      [workspaceId, reservationId],
    )) as [BytesRow[]];
    const first = isRowArray(rows) ? (rows[0] as unknown as BytesRow | undefined) : undefined;
    return Number(first?.bytes ?? 0);
  }

  async putReservation(workspaceId: string, reservationId: string, bytes: number): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.table} (workspace_id, reservation_id, bytes)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE bytes = VALUES(bytes)`,
      [workspaceId, reservationId, bytes],
    );
  }

  async deleteReservation(workspaceId: string, reservationId: string): Promise<void> {
    await this.pool.execute(
      `DELETE FROM ${this.table} WHERE workspace_id = ? AND reservation_id = ?`,
      [workspaceId, reservationId],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
