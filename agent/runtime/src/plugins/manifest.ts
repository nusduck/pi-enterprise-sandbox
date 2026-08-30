/**
 * 插件清单——**唯一事实源**。`bundle/cordis.patch.yml` 由它生成。
 *
 * ## 为什么要有这一层
 *
 * DSH 的 patch 是 YAML，能静默写错，而且写错时**没有任何人报错**——插件装不上
 * 就是出厂实现留在原位。2026-08-30 一天之内踩到两种写法错误：
 *
 * 1. 在已有行上改 `name` 想替换插件。`dsh-app-boot` 把 `name` 当**断言**：
 *    `if (name && name !== target.name) { warn("name mismatch … skipping") }`
 *    ——整条 patch 被跳过，于是 `ctx.credentials` 一直是出厂的
 *    `LocalCredentialProvider`，正是 ADR 0007 点名不得组合的那个。
 * 2. `name` 指向 `../src/*.js`，而源码是 `.ts`、产物在 `dist/`。
 *
 * 这个模块让**这两种错都写不出来**：
 * - 替换出厂插件只有 `replaceFactory()` 一个入口，它自动展开成
 *   "disabled 出厂行 + insert 自建行"，没有"改 name"这个选项。
 * - 自建插件的路径由 `ownModule()` 统一加 `../dist/` 前缀，调用方给的是模块名。
 *
 * ## 新增一个插件怎么做
 *
 * 只改这个文件，然后 `npm run gen:patch`：
 * - 出厂插件调参 → `FACTORY_TUNING`
 * - 自建插件替换出厂的 → `REPLACEMENTS`
 * - 自建插件纯新增的 → `ADDITIONS`
 * - 关掉出厂插件 → `DISABLED`
 *
 * `plugins.test.ts` 断言仓库里的 YAML 与本清单生成结果一致，所以忘了跑生成
 * 会让测试红，而不是让线上静默跑错配置。
 */

/** 自建插件的模块路径。统一由 `dist/` 解析——源码是 .ts，运行时加载编译产物。 */
function ownModule(name: string): string {
  return `../dist/providers/${name}.js`;
}

export interface PatchEntry {
  readonly id?: string;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly config?: Record<string, unknown>;
  readonly insert?: readonly PatchEntry[];
  /** 生成 YAML 时写在该条目上方的注释。 */
  readonly comment?: string;
}

/** 关掉一个出厂插件。 */
function disable(id: string, comment?: string): PatchEntry {
  return { id, disabled: true, ...(comment !== undefined ? { comment } : {}) };
}

/**
 * 用自建实现替换一个出厂插件。
 *
 * **展开成两条**：禁用出厂行 + 顶层 insert 自建行。这是 dsh-app-boot 唯一
 * 支持的替换方式；在原行上改 `name` 会被当作断言不匹配而整条跳过。
 */
function replaceFactory(input: {
  factoryId: string;
  ownId: string;
  module: string;
  config?: Record<string, unknown>;
  comment?: string;
}): PatchEntry[] {
  return [
    { id: input.factoryId, disabled: true, ...(input.comment !== undefined ? { comment: input.comment } : {}) },
    {
      insert: [
        {
          id: input.ownId,
          name: ownModule(input.module),
          config: input.config ?? {},
        },
      ],
    },
  ];
}

// ── 出厂插件的调参（不替换实现，只改 config）───────────────────────────────

const FACTORY_TUNING: readonly PatchEntry[] = [
  {
    id: 'llm-deepseek',
    comment:
      '模型目录：固定路由名 deepseek-official（包自占），指向自有网关，协议与官方一致。',
    config: {
      apiKeyEnv: 'LLMIO_API_KEY',
      // 生成器会把这个占位符还原成 `!!js (...)` 表达式。
      baseURL: '!!js:LLMIO_BASE_URL',
      defaultContextWindow: 262144,
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 262144 },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 262144, reasoning: true },
        {
          id: 'private-reasoner',
          description: 'Company-hosted reasoning model',
          contextWindow: 512000,
          reasoning: true,
        },
      ],
    },
  },
  {
    id: 'tool-subagent',
    comment:
      'tool-subagent 退回 one-shot：base 配的 `continuable` 要求 provider 实现\n' +
      '`prepareContinuable`（子会话可再开后续轮次），而我们的 durable provider 是\n' +
      '一次性作业（start → BullMQ → 轮询 → 结算，跨 Worker 可恢复，没有"续聊"）。\n' +
      '这是 ADR 0007 残余风险清单里那条的预案：对不上就退回，只丢工具层的模型体验\n' +
      '——具体丢的是"对同一个子 Agent 追加消息"，后台执行本身仍在。',
    config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'one-shot' },
  },
];

// ── 自建插件替换出厂实现 ──────────────────────────────────────────────────

const REPLACEMENTS: readonly PatchEntry[] = [
  ...replaceFactory({
    factoryId: 'credentials',
    ownId: 'enterprise-credentials',
    module: 'env-credentials',
    comment:
      '凭据：只读环境变量实现替换 dsh-credentials-local。出厂那个没有租户维度，\n' +
      '且热重载设置文件——多租户下是配置漂移面（ADR 0007「必须移除的行」）。',
  }),
  ...replaceFactory({
    factoryId: 'subagent-spawn-in-process',
    ownId: 'enterprise-durable-subagent',
    module: 'durable-subagent',
    config: { providerName: 'spawn' },
    comment: '子 Agent：原生 trusted same-process 对不上，退回 durable 队列面。',
  }),
];

// ── 纯新增的自建插件 ──────────────────────────────────────────────────────

const ADDITIONS: readonly PatchEntry[] = [
  {
    comment:
      '远程 fs/shell/jobs 以 Cordis 插件提供服务，这样 tool-bash / tool-fs 才能在\n' +
      'boot 时等到 fs/shell/jobs 并激活。本机执行族全部关闭（下方 DISABLED）。',
    insert: [
      { id: 'remote-fs', name: ownModule('remote-fs'), config: {} },
      { id: 'remote-shell', name: ownModule('remote-shell'), config: {} },
      { id: 'remote-jobs', name: ownModule('remote-jobs'), config: {} },
    ],
  },
];

// ── 明确关掉的出厂插件 ────────────────────────────────────────────────────

const DISABLED: readonly PatchEntry[] = [
  disable('sandbox', '本机执行族一律不挂（ADR 0007 D11）：Bubblewrap 在 exec 进程里，\n不在 agent 进程里。'),
  disable('sandbox-policy'),
  disable('bash-sandbox'),
  disable('pwsh-sandbox'),
  disable('fs-sandbox'),
  disable('subprocess'),
  disable('jobs'),
  disable('tool-pwsh'),
  disable('tool-fs-search', 'tool-fs-search 依赖本机 subprocess + ripgrep；搜索由 exec 的 /internal/v1/fs/* 承担。'),
  disable('approval', '不组合原生审批/权限预设（ADR 0007 D4）；企业策略走\n`policy/install.ts` 的四个挂载点。'),
  disable('permission'),
  disable('session-persistence-jsonl', '关掉本机 JSONL 会话落盘。MySQL PersistenceBackend 由\nboot.createSessionBackend 按 Run 装配。'),
  disable('session-checkpoint-policy'),
  disable('session-query-sqlite'),
];

/** 完整清单，顺序即 patch 应用顺序（最后写入获胜）。 */
export const PLUGIN_MANIFEST: readonly PatchEntry[] = [
  ...REPLACEMENTS.slice(0, 2), // credentials：禁用 + 插入
  ...FACTORY_TUNING.slice(0, 1), // llm-deepseek
  ...DISABLED,
  ...ADDITIONS,
  ...REPLACEMENTS.slice(2), // subagent：禁用 + 插入
  ...FACTORY_TUNING.slice(1), // tool-subagent
];

/** 清单里所有自建模块路径，供可解析性断言使用。 */
export function ownModulePaths(): string[] {
  const out: string[] = [];
  const visit = (e: PatchEntry): void => {
    if (typeof e.name === 'string' && e.name.startsWith('.')) out.push(e.name);
    for (const child of e.insert ?? []) visit(child);
  };
  for (const e of PLUGIN_MANIFEST) visit(e);
  return out;
}
