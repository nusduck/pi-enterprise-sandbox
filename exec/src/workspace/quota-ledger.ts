/**
 * 控制面工作区配额账本——移植自 Python 版
 * `sandbox/services/workspace_quota_ledger.py::WorkspaceQuotaLedger`。
 *
 * **设计意图（必须保留，来自任务说明，不是我自己加的）**：预留记录必须存在
 * **工作区外面**。不可信子进程（`bash`/`python` 这些直接绑进工作区、只受
 * `RLIMIT_FSIZE` 约束的进程）能删掉工作区**内**的任何文件——如果账本本身
 * 放在工作区里，子进程删掉几个预留记录，账本下次判定用量时就会低估已预留
 * 的字节数，从而把配额"超卖"给下一个写请求。这里选择的落点是
 * `QuotaStore`（`quota-store.ts`）背后的数据库表，天然不挂进 Bubblewrap 的
 * 任何绑定，子进程物理上碰不到——比 Python 版"控制面文件树 + fcntl 锁"的
 * 隔离性更强（不依赖"这棵目录没有被误挂进沙箱"这条运维纪律）。
 *
 * 并发安全：Python 版用 `threading.RLock`（进程内） + `fcntl.flock`（同机
 * 多进程）两层。ADR 0008 D5 决定 exec 服务前期单进程部署，多实例的扩展点是
 * `WorkspaceLock` 接口（`lock.ts`）——这里只用它，不重新发明第二套锁。
 *
 * `nbytes < 0`、`workspaceId` 校验等输入校验逐条保留，行为与 Python 版一致。
 */
import { randomBytes } from 'node:crypto';
import { validateOpaqueId } from './ids.js';
import type { WorkspaceLock } from './lock.js';
import type { QuotaStore } from './quota-store.js';
import { workspaceSizeBytes } from './disk-usage.js';

export class QuotaExceededError extends Error {
  override readonly name = 'QuotaExceededError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 413,
  ) {
    super(message);
  }
}

export class QuotaLedgerInputError extends Error {
  override readonly name = 'QuotaLedgerInputError';
}

/** 一次成功的预留。`release()`/`commit()` 都是幂等的——多次调用只有第一次
 * 生效，与 Python 版 `QuotaReservation.release()` 的 `_released` 哨兵一致。
 * `commit()` 是 `release()` 的别名：一次性预留模式下"提交"就是"释放"
 * （字节已经算进磁盘上真实的文件大小了，预留记录的使命结束）。 */
export class QuotaReservation {
  bytes: number;
  private released = false;

  constructor(
    readonly workspaceId: string,
    readonly workspacePath: string,
    readonly reservationId: string,
    bytes: number,
    private readonly ledger: WorkspaceQuotaLedger,
  ) {
    this.bytes = bytes;
  }

  /** 仅供 `WorkspaceQuotaLedger.tryGrow()` 在同一把锁内更新自己持有的字节数。 */
  _setBytes(bytes: number): void {
    this.bytes = bytes;
  }

  get isReleased(): boolean {
    return this.released;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.ledger._release(this);
  }

  async commit(): Promise<void> {
    await this.release();
  }
}

export interface QuotaLedgerConfig {
  /** 默认配额（MiB）；`<= 0` 视为"无正数配额"，即不限制。每次调用可用
   * `quotaMb` 覆盖，与 Python 版 `reserve(..., quota_mb=None)` 一致。 */
  readonly defaultQuotaMb: number;
}

/** 校验 workspaceKey：Python 版接受"非空、不含路径分隔符"的字符串，比
 * `validateOpaqueId()` 略宽（比如允许 `.`）。这里统一用 `validateOpaqueId()`
 * ——配额账本的 workspace 维度就是 `WorkspaceContext.workspaceId`，与
 * `ids.ts` 的其它使用点共用同一条校验规则，不必再单独放宽。 */
function requireWorkspaceId(workspaceKey: string): string {
  return validateOpaqueId(workspaceKey, 'workspace_key');
}

export class WorkspaceQuotaLedger {
  constructor(
    private readonly store: QuotaStore,
    private readonly lock: WorkspaceLock,
    private readonly config: QuotaLedgerConfig,
  ) {}

  quotaBytes(quotaMb?: number): number {
    const mb = quotaMb ?? this.config.defaultQuotaMb;
    return Math.max(0, mb) * 1024 * 1024;
  }

  /**
   * 为一次即将发生的写入预留 `nbytes` 字节。超出配额抛 `QuotaExceededError`
   * （不落任何预留记录）；`nbytes === 0` 是一条快捷路径，不需要进临界区。
   */
  async reserve(
    workspacePath: string,
    workspaceKey: string,
    nbytes: number,
    opts: { readonly quotaMb?: number } = {},
  ): Promise<QuotaReservation> {
    if (nbytes < 0) throw new QuotaLedgerInputError('reserve nbytes must be >= 0');
    const workspaceId = requireWorkspaceId(workspaceKey);
    const reservationId = randomReservationId();

    if (nbytes === 0) {
      return new QuotaReservation(workspaceId, workspacePath, reservationId, 0, this);
    }

    const quota = this.quotaBytes(opts.quotaMb);
    return this.lock.withLock(workspaceId, async () => {
      const used = await workspaceSizeBytes(workspacePath);
      const reserved = await this.store.sumReserved(workspaceId);
      const projected = used + reserved + nbytes;
      if (projected > quota) {
        throw quotaExceeded(used, reserved, nbytes, projected, quota, 'request');
      }
      await this.store.putReservation(workspaceId, reservationId, nbytes);
      return new QuotaReservation(workspaceId, workspacePath, reservationId, nbytes, this);
    });
  }

  /**
   * 只为一次原子替换的**净增量**预留字节——`existingBytes` 必须来自对目标
   * 叶子文件的一次无符号链接穿透的 open/stat（调用方职责，ledger 不重新
   * 打开文件确认）。工作区扫描本来就已经把旧文件的字节数算进 `used` 了，
   * 如果按新文件的全量再收一次费，崩溃恢复路径下会凭空触发配额超限。
   *
   * `reservationId` 传入时是"耐用 id"：调用方可以用同一个 id 重复调用做
   * 幂等重试（比如恢复流程重放同一次写入），语义与 Python 版一致——即使
   * `netGrowth === 0` 也要落一条记录（覆盖旧值），因为耐用 id 的存在本身
   * 就是"这次替换正在进行"的标记。不传 `reservationId` 时是一次性 id，
   * `netGrowth === 0` 直接跳过写库。
   */
  async reserveReplacement(
    workspacePath: string,
    workspaceKey: string,
    nbytes: number,
    opts: {
      readonly existingBytes?: number;
      readonly reservationId?: string;
      readonly quotaMb?: number;
    } = {},
  ): Promise<QuotaReservation> {
    const existingBytes = opts.existingBytes ?? 0;
    if (nbytes < 0 || existingBytes < 0) {
      throw new QuotaLedgerInputError('replacement sizes must be >= 0');
    }
    const workspaceId = requireWorkspaceId(workspaceKey);
    const netGrowth = Math.max(0, nbytes - existingBytes);
    const durableId = opts.reservationId !== undefined;
    const reservationId = durableId
      ? validateOpaqueId(opts.reservationId as string, 'reservation_id')
      : randomReservationId();

    if (netGrowth === 0 && !durableId) {
      return new QuotaReservation(workspaceId, workspacePath, reservationId, 0, this);
    }

    const quota = this.quotaBytes(opts.quotaMb);
    return this.lock.withLock(workspaceId, async () => {
      const used = await workspaceSizeBytes(workspacePath);
      const reserved = await this.store.sumReserved(workspaceId);
      const priorReservation = await this.store.getReservationBytes(workspaceId, reservationId);
      const activeReserved = Math.max(0, reserved - priorReservation);
      const projected = used + activeReserved + netGrowth;
      if (projected > quota) {
        throw quotaExceeded(used, activeReserved, netGrowth, projected, quota, 'net replacement');
      }
      if (netGrowth === 0) {
        await this.store.deleteReservation(workspaceId, reservationId);
      } else {
        await this.store.putReservation(workspaceId, reservationId, netGrowth);
      }
      return new QuotaReservation(workspaceId, workspacePath, reservationId, netGrowth, this);
    });
  }

  /** 幂等清除一条耐用预留（完成/重放之后调用）。 */
  async releaseReservation(workspaceKey: string, reservationId: string): Promise<void> {
    const workspaceId = requireWorkspaceId(workspaceKey);
    const safeReservationId = validateOpaqueId(reservationId, 'reservation_id');
    await this.lock.withLock(workspaceId, async () => {
      await this.store.deleteReservation(workspaceId, safeReservationId);
    });
  }

  /** @internal `QuotaReservation.release()` 的落地实现。 */
  async _release(reservation: QuotaReservation): Promise<void> {
    if (reservation.bytes <= 0 && !reservation.reservationId) return;
    await this.releaseReservation(reservation.workspaceId, reservation.reservationId);
  }

  /**
   * 流式写入场景：把一条已存在的预留从 `reservation.bytes` 调整到
   * `newTotal`。缩小总是允许（`newTotal === 0` 时直接删记录）；增大要重新
   * 判定配额，只把 `extra = newTotal - reservation.bytes` 计入投影用量
   * （`reservation.bytes` 本身已经算在 `reserved` 里，不能重复计费）。
   */
  async tryGrow(
    workspacePath: string,
    reservation: QuotaReservation,
    newTotal: number,
    opts: { readonly quotaMb?: number } = {},
  ): Promise<void> {
    if (reservation.isReleased) {
      throw new QuotaLedgerInputError('reservation already released');
    }
    if (newTotal < 0) throw new QuotaLedgerInputError('newTotal must be >= 0');
    if (newTotal === reservation.bytes) return;

    const workspaceId = reservation.workspaceId;

    if (newTotal < reservation.bytes) {
      await this.lock.withLock(workspaceId, async () => {
        if (newTotal === 0) {
          await this.store.deleteReservation(workspaceId, reservation.reservationId);
        } else {
          await this.store.putReservation(workspaceId, reservation.reservationId, newTotal);
        }
        reservation._setBytes(newTotal);
      });
      return;
    }

    const extra = newTotal - reservation.bytes;
    const quota = this.quotaBytes(opts.quotaMb);
    await this.lock.withLock(workspaceId, async () => {
      const used = await workspaceSizeBytes(workspacePath);
      const reserved = await this.store.sumReserved(workspaceId);
      const projected = used + reserved + extra;
      if (projected > quota) {
        throw quotaExceeded(used, reserved, extra, projected, quota, 'extra (streaming)');
      }
      await this.store.putReservation(workspaceId, reservation.reservationId, newTotal);
      reservation._setBytes(newTotal);
    });
  }
}

function quotaExceeded(
  used: number,
  reserved: number,
  requested: number,
  projected: number,
  quota: number,
  requestedLabel: string,
): QuotaExceededError {
  return new QuotaExceededError(
    'workspace_quota_exceeded',
    `Workspace quota exceeded: usage ${used} + reserved ${reserved} + ${requestedLabel} ` +
      `${requested} = ${projected} bytes, quota ${quota} bytes`,
    413,
  );
}

/** 与 Python 版 `uuid.uuid4().hex` 等价的一次性预留 id：32 位十六进制，
 * 满足 `validateOpaqueId()` 的字符集要求，不需要额外编码。 */
function randomReservationId(): string {
  return randomBytes(16).toString('hex');
}
