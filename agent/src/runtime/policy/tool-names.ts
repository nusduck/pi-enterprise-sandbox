/**
 * 模型侧工具名的**唯一事实源**（ADR 0009 D4）。
 *
 * ## 为什么放在 `src/runtime/policy/`
 *
 * `src/runtime` 是叠在 `dsh-base` 上的组合层，是本仓最底的一层——策略挂载点、
 * 风险表、provider 都在这里，且它单独跑 strict（`tsconfig.runtime.json`）。
 * 工具名是 DSH 契约面，属于这一层；`infrastructure/dsh/constants.ts` 从这里
 * **转出**，方向是 infrastructure → runtime，反过来会造成本包唯一一处反向依赖。
 *
 * ## 为什么必须只有一份
 *
 * 风险表与分类器是 fail-closed（未知工具 → `deny` / `critical`），所以工具名是契约面：
 * 名单漏一个，那个工具在运行时就整片被拒。ADR D4 的原方案是「四处同一次改齐」，
 * 但 2026-08-31 复核发现**那四处当时就已经不齐**——`risk-table.ts` 写的是
 * `process_poll`/`process_write_stdin`，`constants.ts` 写的是 `process_status`/`process_read`，
 * `config/agent/tool-risk.json` 还多出 `skill_create`/`skill_edit`/`todo_read`。
 * 「同一次改齐」这个做法已经失败过一次，所以改成：**这里是唯一的一份，
 * 其余位置引用它**，`tool-risk.json` 由启动期断言校验（见 `assertToolRiskTableNames`）。
 *
 * ## 名单从哪来
 *
 * 2026-08-31 起栈实测 `ctx.tools.schemas()` 的结果（`agent/scripts/dump-tool-registry.ts`，
 * 证据 `docs/evidence/2026-08-31-dsh-tool-registry.md`），**不是**从文档或 tarball 抄的。
 * 加进这份名单前先问：boot 之后它真的在注册表里吗？
 */
export const SANDBOX_TOOL_NAMES = Object.freeze([
  // dsh-tool-fs
  'read', 'write', 'edit', 'read_image',
  // 自建 remote-fs-search（注册名与出厂 dsh-tool-fs-search 一致，ADR 0009 D8）
  'glob', 'grep',
  // dsh-tool-bash
  'bash',
  // dsh-tool-jobs
  'job_list', 'job_output', 'job_kill',
  // dsh-tool-todo
  'todo_write',
  // dsh-tool-skill
  'skill',
  // dsh-tool-subagent（one-shot，见 cordis.patch.yml）
  'subagent',
]);

/** 问人。`dsh-tool-ask-user` 注册的名字，与出厂一致。 */
export const ASK_USER_TOOL_NAME = 'ask_user_question';

export const ENTERPRISE_DEFAULT_TOOLS = Object.freeze([
  ...SANDBOX_TOOL_NAMES,
  ASK_USER_TOOL_NAME,
]);

/**
 * 旧 Pi 工具名 → 新出厂工具名的**只读别名映射**（ADR 0009 D4「存量数据」）。
 *
 * AgentVersion 的 `configJson` 是 Run 创建时冻结的不可变快照，里面的 `toolPolicy`
 * 存的是旧名。不迁移、不回写——**只在读取 `toolPolicy` 时投影一次**。
 *
 * **本表不接受新增条目。** 新工具直接用新名；这里只服务于 2026-08-31 之前建好的
 * AgentVersion 快照。映射到 `null` 表示该能力本阶段整体退役（ADR 0009 D10），
 * 读取方应给稳定理由码而不是把它当未知工具。
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string | null>> = Object.freeze({
  // 目录列举：出厂 tool-fs 没有 ls；ADR 0009 D4「目录列举靠 glob 或 bash」
  ls: 'glob',
  find: 'glob',
  // 进程族 → 作业族。语义不一一对应（旧的是「起一个进程」，新的是「看作业」），
  // 按整体映射，理由码稳定即可——存量 toolPolicy 只用来判「允不允许这类操作」。
  process_start: 'job_list',
  process_status: 'job_list',
  process_read: 'job_output',
  process_poll: 'job_output',
  process_write_stdin: 'job_output',
  process_kill: 'job_kill',
  // skill 变更工具整套取消（ADR 0009 D7），发现与调用归 tool-skill 的单工具面
  skill_list: 'skill',
  skill_install: 'skill',
  skill_create: 'skill',
  skill_edit: 'skill',
  skill_uninstall: 'skill',
  // 子 Agent 工具面收敛成单工具
  spawn_subagent: 'subagent',
  check_subagent: 'subagent',
  // 问人
  ask_user: ASK_USER_TOOL_NAME,
  // todo 只有写这一个工具面
  todo_read: 'todo_write',
  // 出厂没有独立的 python 工具，脚本走 bash
  python: 'bash',
  // 本阶段不做 memory（ADR 0009 D10）：没有新名，读取方给 TOOL_RETIRED
  memory_write: null,
  memory_search: null,
  // 产物提交：旧 Pi Extension 删除后没有任何插件注册它（2026-08-31 实测）。
  // 待决策——补一个自建 tool 插件，还是承认产物提交不再是模型工具。
  // 在决策落地前按退役处理，理由码稳定，好过静默 UNKNOWN_TOOL。
  submit_artifact: null,
});

/** 本阶段整体退役的能力用这个理由码，区别于「没见过的工具」。 */
export const RETIRED_TOOL_REASON_CODE = 'TOOL_RETIRED';

/** 把一个可能是旧名的工具名投影成当前名；`null` = 该能力已退役。 */
export function resolveToolNameAlias(toolName: string): string | null {
  if (SANDBOX_TOOL_NAMES.includes(toolName) || toolName === ASK_USER_TOOL_NAME) return toolName;
  if (Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAME_ALIASES, toolName)) {
    return LEGACY_TOOL_NAME_ALIASES[toolName] ?? null;
  }
  return toolName;
}

/** 该工具名是否是「已退役能力」（区别于未知工具）。 */
export function isRetiredToolName(toolName: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAME_ALIASES, toolName) &&
    LEGACY_TOOL_NAME_ALIASES[toolName] === null
  );
}

