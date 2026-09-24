/**
 * Pi → DSH 迁移收尾：去掉库里残留的 pi 命名。
 *
 * - `agent_versions.pi_sdk_version`、`agent_session_snapshots.pi_sdk_version`：删除。
 *   它钉的是已退役的 pi SDK 版本，写入与校验两端用的是同一个常量，校验永远通过；
 *   快照格式的兼容性由 `snapshot_format` 负责。
 * - `agent_sessions.pi_session_version` → `session_version`（快照指针，语义不变）。
 * - `messages.pi_entry_id` / `pi_entry_kind` → `session_entry_id` / `session_entry_kind`。
 *   依附的唯一索引 `ind_agsvc_msg_a2` 与普通索引 `ind_agsvc_msg_i2` 随列改名。
 * - 存储标记改写：`message_type` 与 `content_json.kind` 的 `pi_journal_header` /
 *   `pi_journal_entry` → `session_journal_header` / `session_journal_entry`；
 *   UI 助手消息 `content_json.piEntryId` → `content_json.sessionEntryId`；
 *   `snapshot_format` 的 `pi_jsonl_v3` → `session_jsonl_v3`。这些都不参与
 *   payloadHash、journal digest 与快照 checksum，改写不影响恢复校验。
 *
 * 有意**不**改写：header 行的 `session_entry_id = '__pi_session_header__'`。
 * journal digest 按 `<entry_id>:<payloadHash>` 计算，protected manifest 里存着这份
 * digest（本身也在只追加的 journal 与带 checksum 的快照里）；改这个值会让所有存量
 * 会话恢复时 digest 不匹配。
 *
 * messages 与 agent_session_snapshots 挂着禁止 UPDATE 的只追加触发器。数据改写前先
 * 摘掉 UPDATE 触发器，改完原样装回；DELETE 触发器全程不动。UPSQL 5.7 没有
 * `RENAME COLUMN`，改名用 `CHANGE COLUMN` 带完整定义。
 */

const MESSAGES_UPDATE_TRIGGER = 'trg_messages_forbid_update';
const SNAPSHOTS_UPDATE_TRIGGER = 'trg_agent_session_snapshots_forbid_update';

/** [旧值, 新值] */
export const JOURNAL_KIND_RENAMES = Object.freeze([
  ['pi_journal_header', 'session_journal_header'],
  ['pi_journal_entry', 'session_journal_entry'],
]);

export const SNAPSHOT_FORMAT_RENAME = Object.freeze(['pi_jsonl_v3', 'session_jsonl_v3']);

/**
 * @param {import('knex').Knex} knex
 * @param {string} name
 * @param {string} table
 * @param {string} label
 */
async function createForbidUpdateTrigger(knex, name, table, label) {
  await knex.raw(`
    CREATE TRIGGER ${name}
    BEFORE UPDATE ON ${table}
    FOR EACH ROW
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '${label} is append-only: UPDATE is forbidden'
  `);
}

/** UI 助手消息 content_json 里指向会话条目的键：[旧键, 新键] */
export const CONTENT_ENTRY_KEY_RENAME = Object.freeze(['piEntryId', 'sessionEntryId']);

/**
 * @param {import('knex').Knex} knex
 * @param {ReadonlyArray<ReadonlyArray<string>>} kinds [from, to][]
 * @param {ReadonlyArray<string>} format [from, to]
 * @param {ReadonlyArray<string>} entryKey [from, to]
 */
async function rewriteStoredMarkers(knex, kinds, format, entryKey) {
  await knex.raw(`DROP TRIGGER IF EXISTS ${MESSAGES_UPDATE_TRIGGER}`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${SNAPSHOTS_UPDATE_TRIGGER}`);
  for (const [from, to] of kinds) {
    await knex.raw(
      'UPDATE tbl_agsvc_messages SET message_type = ? WHERE message_type = ?',
      [to, from],
    );
    await knex.raw(
      `UPDATE tbl_agsvc_messages
          SET content_json = JSON_SET(content_json, '$.kind', ?)
        WHERE JSON_UNQUOTE(JSON_EXTRACT(content_json, '$.kind')) = ?`,
      [to, from],
    );
  }
  await knex.raw(
    `UPDATE tbl_agsvc_messages
        SET content_json = JSON_REMOVE(
              JSON_SET(content_json, '$.${entryKey[1]}', JSON_EXTRACT(content_json, '$.${entryKey[0]}')),
              '$.${entryKey[0]}')
      WHERE JSON_CONTAINS_PATH(content_json, 'one', '$.${entryKey[0]}')`,
  );
  await knex.raw(
    'UPDATE tbl_agsvc_agent_session_snapshots SET snapshot_format = ? WHERE snapshot_format = ?',
    [format[1], format[0]],
  );
  await createForbidUpdateTrigger(knex, MESSAGES_UPDATE_TRIGGER, 'tbl_agsvc_messages', 'messages');
  await createForbidUpdateTrigger(
    knex,
    SNAPSHOTS_UPDATE_TRIGGER,
    'tbl_agsvc_agent_session_snapshots',
    'agent_session_snapshots',
  );
}

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await knex.raw(`
    ALTER TABLE tbl_agsvc_messages
      CHANGE COLUMN pi_entry_id session_entry_id VARCHAR(128)
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      CHANGE COLUMN pi_entry_kind session_entry_kind VARCHAR(64)
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL
  `);
  await knex.raw(`
    ALTER TABLE tbl_agsvc_agent_sessions
      CHANGE COLUMN pi_session_version session_version BIGINT NOT NULL DEFAULT 0
  `);
  await knex.raw('ALTER TABLE tbl_agsvc_agent_versions DROP COLUMN pi_sdk_version');
  await knex.raw('ALTER TABLE tbl_agsvc_agent_session_snapshots DROP COLUMN pi_sdk_version');

  await rewriteStoredMarkers(knex, JOURNAL_KIND_RENAMES, SNAPSHOT_FORMAT_RENAME, CONTENT_ENTRY_KEY_RENAME);
}

/**
 * 回滚恢复列与标记；被删列按 20260923000001 之后的定义补回，存量行填退役前唯一写入过的值。
 *
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await rewriteStoredMarkers(
    knex,
    JOURNAL_KIND_RENAMES.map(([from, to]) => [to, from]),
    [SNAPSHOT_FORMAT_RENAME[1], SNAPSHOT_FORMAT_RENAME[0]],
    [CONTENT_ENTRY_KEY_RENAME[1], CONTENT_ENTRY_KEY_RENAME[0]],
  );

  for (const table of ['tbl_agsvc_agent_versions', 'tbl_agsvc_agent_session_snapshots']) {
    await knex.raw(`
      ALTER TABLE ${table}
        ADD COLUMN pi_sdk_version VARCHAR(64)
          CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '0.80.3'
    `);
    await knex.raw(`ALTER TABLE ${table} ALTER COLUMN pi_sdk_version SET DEFAULT ''`);
  }
  await knex.raw(`
    ALTER TABLE tbl_agsvc_agent_sessions
      CHANGE COLUMN session_version pi_session_version BIGINT NOT NULL DEFAULT 0
  `);
  await knex.raw(`
    ALTER TABLE tbl_agsvc_messages
      CHANGE COLUMN session_entry_id pi_entry_id VARCHAR(128)
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
      CHANGE COLUMN session_entry_kind pi_entry_kind VARCHAR(64)
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL
  `);
}
