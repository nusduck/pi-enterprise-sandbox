/**
 * 审核账本（design `agent-output-review.md` §5.1，ADR 0016 D2）。
 *
 * 四张表，权威都在 agent 的 MySQL（exec 只持有**产物可见性**，见 D1）：
 *
 * - `tbl_agsvc_review_tasks`：一行 = 一个 Run 提交的一组待审产物。
 *   `UNIQUE(run_id)` 与「一个 Run 至多一条任务」是同义的；追问会产生新的 Run、
 *   因而产生新的任务。
 * - `tbl_agsvc_review_items`：任务里的每件交付物。修订历史不在这里——它是 exec 里
 *   的 `revision_of` 链，本表只钉「原件」与「当前版本」。
 * - `tbl_agsvc_review_materials`：审核材料快照（U5）。`snapshot_status` 让
 *   「快照失败」是一个**看得见的状态**而不是静默缺失。
 * - `tbl_agsvc_review_events`：只追加的审计。
 *
 * 命名按 UPspec（ADR 0013）。索引缩写：`rt`（tasks）、`rv`（events）；items 与
 * materials 只有复合主键，主键最左列已经覆盖「按任务取明细」，不再另建索引。
 * `ri` / `re` 已被 `run_interactions` / `run_events` 占用，不复用。
 *
 * 外键只给 `run_id`：它已经被 `ind_agsvc_rt_a1` 的最左列覆盖，knex 不会因此
 * 另建一个名字不合规的索引（`20260928000001` 的注释记录过这个坑）。其余列不建
 * 外键——审核行要能在 Run 归档策略下保留，级联删除不是这里想要的语义。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const REVIEW_TASKS_TABLE = 'tbl_agsvc_review_tasks';
export const REVIEW_ITEMS_TABLE = 'tbl_agsvc_review_items';
export const REVIEW_MATERIALS_TABLE = 'tbl_agsvc_review_materials';
export const REVIEW_EVENTS_TABLE = 'tbl_agsvc_review_events';

/** 状态机（design §5.2）：`PENDING → IN_REVIEW → APPROVED | REJECTED`。 */
export const REVIEW_TASK_STATUSES = Object.freeze([
  'PENDING',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
]);

const ID_TYPE = 'CHAR(26)';
const ARTIFACT_ID_TYPE = 'VARCHAR(64)';
/**
 * 时间列的显式默认值：knex 的 `defaultTo(knex.fn.now(3))` 在 5.7 上会写成
 * `CURRENT_TIMESTAMP(3)`，与既有迁移保持一致直接写字面量。
 */
const NOW3 = 'CURRENT_TIMESTAMP(3)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(REVIEW_TASKS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('review_task_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('requester_user_id', ID_TYPE).notNullable();
      t.specificType('conversation_id', ID_TYPE).notNullable();
      t.specificType('agent_session_id', ID_TYPE).notNullable();
      t.specificType('run_id', ID_TYPE).notNullable();
      // 审计用：当时的配置，以及 Run 以什么状态结束（含 CANCELLED / FAILED）。
      t.specificType('agent_id', ID_TYPE).notNullable();
      t.specificType('agent_version_id', ID_TYPE).notNullable();
      t.specificType('run_status', 'CHAR(16)').notNullable().defaultTo('');
      // PENDING | IN_REVIEW | APPROVED | REJECTED
      t.specificType('status', 'CHAR(16)').notNullable().defaultTo('PENDING');
      t.specificType('assignee_user_id', ID_TYPE).nullable();
      t.specificType('claimed_at', 'DATETIME(3)').nullable();
      // 乐观并发版本号：每次改动 +1，客户端带 base_revision 提交决定。
      t.integer('revision').notNullable().defaultTo(0);
      // 驳回反馈（必填）或通过备注（可选）。
      t.text('feedback').nullable();
      t.specificType('decided_by', ID_TYPE).nullable();
      t.specificType('decided_at', 'DATETIME(3)').nullable();
      // §5.4：已决任务的注入文本每个任务只注入一次，这里记注入了哪一次 Run。
      t.specificType('context_injected_run_id', ID_TYPE).nullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw(NOW3));
      t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw(NOW3));

      t.primary(['review_task_id'], 'pk_review_tasks');
      // 一个 Run 至多一条审核任务——与「本轮没有产物就不建任务」共同定义了 U4。
      t.unique(['run_id'], { indexName: 'ind_agsvc_rt_a1' });
      // 审核池：本 org 按状态倒序取。
      t.index(['org_id', 'status', 'created_at'], 'ind_agsvc_rt_i1');
      // 「我领取的」。
      t.index(
        ['org_id', 'assignee_user_id', 'status'],
        'ind_agsvc_rt_i2',
      );
      t.foreign('run_id').references('tbl_agsvc_runs.run_id');
    });

    await tracker.createTable(REVIEW_ITEMS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('review_task_id', ID_TYPE).notNullable();
      t.integer('item_no').notNullable();
      t.specificType('original_artifact_id', ARTIFACT_ID_TYPE).notNullable();
      t.specificType('current_artifact_id', ARTIFACT_ID_TYPE).notNullable();
      // 跟随 current 版本的展示元数据（列表不必回 exec 取）。
      t.string('name', 1024).notNullable().defaultTo('');
      t.string('mime_type', 255).notNullable().defaultTo('application/octet-stream');
      t.specificType('size_bytes', 'BIGINT UNSIGNED').notNullable().defaultTo(0);
      t.specificType('sha256', 'CHAR(64)').notNullable().defaultTo('');

      t.primary(['review_task_id', 'item_no'], 'pk_review_items');
    });

    await tracker.createTable(REVIEW_MATERIALS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('review_task_id', ID_TYPE).notNullable();
      t.specificType('material_id', ID_TYPE).notNullable();
      t.specificType('attachment_id', ARTIFACT_ID_TYPE).notNullable();
      t.string('filename', 1024).notNullable().defaultTo('');
      t.string('mime_type', 255).notNullable().defaultTo('application/octet-stream');
      t.specificType('size_bytes', 'BIGINT UNSIGNED').notNullable().defaultTo(0);
      // exec 里的不可变快照产物（`visibility=withdrawn`）。快照失败时为 NULL。
      t.specificType('snapshot_artifact_id', ARTIFACT_ID_TYPE).nullable();
      // `ready`（快照可用）| `unavailable`（快照失败，界面要明确提示，不静默缺失）
      t.specificType('snapshot_status', 'CHAR(16)').notNullable().defaultTo('unavailable');

      t.primary(['review_task_id', 'material_id'], 'pk_review_materials');
    });

    await tracker.createTable(REVIEW_EVENTS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('event_id', ID_TYPE).notNullable();
      t.specificType('review_task_id', ID_TYPE).notNullable();
      // created / claimed / released_claim / revised / approved / rejected
      t.specificType('event_type', 'CHAR(32)').notNullable().defaultTo('');
      t.specificType('actor_user_id', ID_TYPE).nullable();
      t.integer('item_no').nullable();
      t.specificType('from_artifact_id', ARTIFACT_ID_TYPE).nullable();
      t.specificType('to_artifact_id', ARTIFACT_ID_TYPE).nullable();
      t.text('detail').nullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw(NOW3));

      t.primary(['event_id'], 'pk_review_events');
      t.index(['review_task_id', 'created_at'], 'ind_agsvc_rv_i1');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // 子表先删：items / materials / events 都引用 tasks 的键。
  await knex.schema.dropTableIfExists(REVIEW_EVENTS_TABLE);
  await knex.schema.dropTableIfExists(REVIEW_MATERIALS_TABLE);
  await knex.schema.dropTableIfExists(REVIEW_ITEMS_TABLE);
  await knex.schema.dropTableIfExists(REVIEW_TASKS_TABLE);
}
