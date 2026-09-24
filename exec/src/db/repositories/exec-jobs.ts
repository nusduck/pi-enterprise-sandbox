/**
 * exec_jobs 仓储的 DB 层收口——W2-B 已定义的窄接口的正式落地位置。
 *
 * 同 `workspace-quotas.ts`，本文件不另起接口，只重导出 `JobStore`
 * 并固化 DDL。`job-store-mysql.ts` 头注释已论证"为什么不是
 * `process_executions`"：那张表的 `sandbox_session_id`/`run_id`/
 * `execution_id` 均为 `NOT NULL` 且 FK 指向 `sandbox_sessions`/`runs`，
 * 而 `exec/` 信封只到 `workspaceId` 一层，复用会破坏约束或让 exec
 * 反向依赖 agent 会话表；`exec_jobs` 是 ADR 0008 §6 允许的 exec 自有表。
 */

export type {
  JobStore,
  JobRecord,
  JobRecordInsert,
  JobRecordStatusPatch,
  JobOwnerScope,
  JobStatus,
} from '../../shell/job-types.js';
export { MySqlJobStore, DEFAULT_JOBS_TABLE } from '../../shell/job-store-mysql.js';
export { InMemoryJobStore } from '../../shell/job-store-memory.js';

/**
 * `exec_jobs` 建表 DDL（交给 `agent/` 权威迁移）。
 *
 * 列清单与 `job-store-mysql.ts:JobRow`/`JobRecord` 1:1 对应；`reported`
 * 用 `TINYINT(1)` 存布尔，`status` 用枚举字符串（与 `dsh-jobs` 五态对齐，
 * 不照抄 Python 十态）。
 */
export const EXEC_JOBS_DDL = `
CREATE TABLE tbl_agsvc_exec_jobs (
  process_id         VARCHAR(64)       NOT NULL,
  kind               CHAR(16)          NOT NULL DEFAULT 'bash',
  label              VARCHAR(1024)     NOT NULL DEFAULT '',
  org_id             CHAR(26)          NOT NULL,
  user_id            CHAR(26)          NOT NULL,
  workspace_id       VARCHAR(191)      NOT NULL,
  run_id             VARCHAR(64)       NULL,
  status             VARCHAR(32)       NOT NULL DEFAULT '',
  detail             TEXT              NULL,
  output_limit_bytes BIGINT UNSIGNED   NULL,
  pid                INT               NULL,
  pgid               INT               NULL,
  start_identity     VARCHAR(512)      NULL,
  exit_code          INT               NULL,
  reported           TINYINT(1)        NOT NULL DEFAULT 0,
  started_at         DATETIME(3)       NULL,
  finished_at        DATETIME(3)       NULL,
  created_at         DATETIME(3)       NOT NULL DEFAULT '1970-01-01 00:00:00.000',
  PRIMARY KEY (process_id),
  KEY ind_agsvc_ej_i2 (org_id, user_id, workspace_id),
  KEY ind_agsvc_ej_i3 (run_id),
  KEY ind_agsvc_ej_i4 (status),
  KEY ind_agsvc_ej_i1 (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();
