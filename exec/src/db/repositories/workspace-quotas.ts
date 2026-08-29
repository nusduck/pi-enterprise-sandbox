/**
 * workspace_quota_reservations 仓储的 DB 层收口——W2-C 已定义的窄接口的
 * 正式落地位置。
 *
 * 为什么不另起一套接口：`exec/src/workspace/quota-store.ts` 已定义
 * `QuotaStore`（`sumReserved`/`getReservationBytes`/`putReservation`/
 * `deleteReservation`）及 `MySqlQuotaStore`/`InMemoryQuotaStore`。W3-D
 * 的职责是"收口"，不是"另起炉灶"（`_shared.md #7`），所以本文件**不
 * 重新发明接口**，只做两件事：
 * 1) 重导出 `QuotaStore` 类型，供 `exec/src/db/` 的统一 barrel 透出；
 * 2) 固化 DDL 全文，交给 `agent/` 权威迁移（exec 侧不自写迁移）。
 */

export type { QuotaStore } from '../../workspace/quota-store.js';
export { InMemoryQuotaStore, MySqlQuotaStore } from '../../workspace/quota-store.js';

/**
 * `workspace_quota_reservations` 建表 DDL（交给 `agent/` 权威迁移，
 * 见 `agent/src/infrastructure/mysql/migrations/`）。
 *
 * 设计意图（`quota-store.ts` 头注释原话复述）：预留记录必须在**工作区
 * 外面**——子进程能删掉工作区内的文件，账本放里面就能被篡改来超卖配额；
 * DB 天然满足"在外面"，且不需要 `fcntl.flock`。
 */
export const WORKSPACE_QUOTA_RESERVATIONS_DDL = `
CREATE TABLE workspace_quota_reservations (
  workspace_id   VARCHAR(191)      NOT NULL,
  reservation_id VARCHAR(191)      NOT NULL,
  bytes          BIGINT UNSIGNED   NOT NULL,
  created_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (workspace_id, reservation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

/** 索引说明：`PRIMARY KEY (workspace_id, reservation_id)` 已是
 * `WHERE workspace_id = ?` 的最左前缀，无需额外索引；`reservation_id`
 * 的单列索引也不需要——所有查询都带 `workspace_id`。 */
export const WORKSPACE_QUOTA_RESERVATIONS_INDEXES: readonly string[] = [
  'PRIMARY KEY (workspace_id, reservation_id) covers sumReserved()',
];
