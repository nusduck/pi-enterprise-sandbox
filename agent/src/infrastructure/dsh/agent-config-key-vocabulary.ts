/**
 * AgentVersion 配置的**顶层键词汇表**——绑定期 fail-closed 护栏的事实源。
 *
 * ## 为什么需要它
 *
 * AgentVersion 是不可变的，Worker 只读它、不校验它（写入时由
 * `application/agent-config-validator.ts` 按白名单校验）。滚动升级时会出现
 * **更新的写入方 + 更旧的 Worker**：新字段（例如 ADR 0015 的 `skillPolicy`）已经落库，
 * 旧 Worker 不认识它。如果旧 Worker 把它当作「省略」继续跑，绑定就**静默失效**——
 * 配置说「这个 Agent 只带 pdf」，实际跑的是「全部系统 Skill + 用户启用」，
 * 而日志里没有任何痕迹。这正是 ADR 0015 「后果」一节要求先单独发布前置改动的原因。
 *
 * 所以：`schemaVersion: 1` 的记录里出现本进程不认识的顶层键 → 绑定时拒绝
 * （`DSH_CONFIG_UNSUPPORTED`），不是忽略。
 *
 * ## 为什么不能「未知键一律拒绝」
 *
 * legacy 记录（**没有** `schemaVersion` 键）本来就携带 v1 已删除的键
 * （`skills` / `extensions` / `sandboxPolicy`），甚至 `model`、`maxOutputTokens`。
 * 它们不可变、不迁移，绑定期仍会读其中一部分。对它们套用同一条规则会把在跑的
 * 旧 Agent 全部打死。因此判定的**开关是 `schemaVersion` 是否存在**，不是键本身。
 *
 * ## 表的分工
 *
 * - `V1_TOP_LEVEL_KEYS`：v1 记录允许出现的顶层键。**它是上界**——验证器认识的键
 *   必须都在这里，`agent-version-unknown-keys.test.ts` 钉住这一点，防止新字段
 *   写进验证器却漏配这张表（那会让新版本被自己的 Worker 拒绝）。
 *
 * legacy 记录**不走白名单**（见 `unknownTopLevelKeys`）。`LEGACY_RECORD_TOP_LEVEL_KEYS`
 * 只是记录事实：这些键在 v1 里已无对应字段，但旧记录仍会携带、绑定期也仍会读其中
 * 一部分。它不参与判定——放行 legacy 是无条件的。
 *
 * 包封字段（`configJson` 等）由 `parseAgentVersionConfigJson` 负责，
 * 不属于顶层配置词汇表。
 */

/**
 * v1 记录允许的顶层键——验证器接受的键集合的上界。
 *
 * 新增 v1 字段时**必须同时**改这里与 `agent-config-validator.ts` 的
 * `TOP_LEVEL_V1_KEYS`；两者漂移会被单测抓住。
 */
export const V1_TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'systemPrompt',
  'modelPolicy',
  'toolPolicy',
  'mcpServers',
  'delegation',
  'dataSources',
  // ADR 0015：Skill 目录与绑定。v1 增量可选字段，不升 schemaVersion。
  'skillPolicy',
  // ADR 0016：交付物人工审核。同样是 v1 增量可选字段。
  'deliveryPolicy',
]);

/**
 * 无 `schemaVersion` 的 legacy 记录里，绑定期仍会读取、因而必须认识的顶层键。
 *
 * 这些键在 v1 里已无对应字段（`CONFIG_UNKNOWN_FIELD` / `LEGACY_FIELD_REQUIRES_MIGRATION`），
 * 这里只是让旧记录继续可跑，不是重新承认它们的语义。
 */
export const LEGACY_RECORD_TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  'model',
  'maxOutputTokens',
  'temperature',
  'skills',
  'extensions',
  'sandboxPolicy',
]);

const V1_KEY_SET = new Set(V1_TOP_LEVEL_KEYS);

/**
 * 这份配置是否声明自己是 v1 记录。
 *
 * 判定用 `Object.hasOwn`：`{ skillPolicy: ... }` 没有 `schemaVersion` 就是 legacy，
 * 与验证器 `validate()` 的 `legacy` 判定保持同一语义。
 *
 * @param configJson 解包后的 AgentVersion 配置对象
 */
export function isSchemaVersionedConfig(
  configJson: Record<string, unknown>,
): boolean {
  return Object.hasOwn(configJson, 'schemaVersion');
}

/**
 * 列出本进程**不认识**的顶层键。
 *
 * - v1 记录（有 `schemaVersion`）：以 `V1_TOP_LEVEL_KEYS` 为白名单，白名单外的键全部报告。
 * - legacy 记录（无 `schemaVersion`）：**不检查**，永远返回空数组。它不可变、不迁移，
 *   本轮也没有「把旧记录清干净」的职责；对未知键报错会把在跑的旧 Agent 全部打死。
 *
 * @param configJson 解包后的 AgentVersion 配置对象
 * @returns 未知顶层键，保持出现顺序；空数组表示可绑定
 */
export function unknownTopLevelKeys(
  configJson: Record<string, unknown>,
): string[] {
  if (!isSchemaVersionedConfig(configJson)) return [];
  return Object.keys(configJson).filter((key) => !V1_KEY_SET.has(key));
}
