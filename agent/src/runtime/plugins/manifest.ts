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
 * 2. `name` 指向源码路径，而运行时加载的是编译产物。
 *
 * 这个模块让**这两种错都写不出来**：
 * - 替换出厂插件只有 `replaceFactory()` 一个入口，它自动展开成
 *   "disabled 出厂行 + insert 自建行"，没有"改 name"这个选项。
 * - 自建插件的路径由 `ownModule()` 统一加 `../providers/` 前缀，调用方给的是模块名。
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

/**
 * 自建插件的模块路径，相对 **patch 文件所在目录**解析（cordis 的
 * bareModuleBaseUrl 语义）。patch 在 `<out>/runtime/bundle/`，provider 在
 * `<out>/runtime/providers/`，所以是 `../providers/`。
 */


function ownModule(name: string): string {
  return `../providers/${name}.js`;
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
          id: 'deepseek-v4-flash-vision-exp',
          name: 'DeepSeek V4 Flash Vision',
          contextWindow: 262144,
          inputModalities: ['text', 'image'],
        },
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
  {
    comment:
      'glob / grep：注册名与出厂 dsh-tool-fs-search 逐字一致，执行改走 exec 的' + '\n' +
      '/internal/v1/fs/{find,grep}（ADR 0009 D8）。出厂那个要本机 subprocess + ripgrep，' + '\n' +
      '而本机执行族一律不挂（ADR 0007 D11）——不为它单独恢复 subprocess。' + '\n' +
      '名字抄出厂是为了：将来若换回出厂实现，风险表 / tool-risk.json / 前端一处都不用改。',
    insert: [{ id: 'remote-fs-search', name: ownModule('remote-fs-search'), config: {} }],
  },
  {
    comment:
      'ask_user_question：dsh-base 只带 dsh-user-questions 这个 seam（ctx.userQuestions），\n' +
      '**没有带对应的工具**，所以模型今天问不了人。这个包是那个 seam 的 Consumer，\n' +
      '注册名 ask_user_question（ADR 0009 D3 的两个缺口之一）。\n' +
      '停泊/续跑仍由 application 承担：WAITING_INPUT + 现有应答 API + 重放。',
    insert: [{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', config: {} }],
  },
  {
    comment:
      'submit_artifact：ADR 0009 D4 说「我们自建的，保留」，但 2026-08-31 起栈实测' + '\n' +
      '发现**根本没有插件注册它**——旧 Pi Extension 删除后没补，能力静默缺失了。' + '\n' +
      '补回来而不是按退役处理：exec 侧 /internal/v1/artifacts/submit 一直都在。',
    insert: [{ id: 'submit-artifact', name: ownModule('submit-artifact'), config: {} }],
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
  // approval **不再** disabled（ADR 0009 D5 改写了 ADR 0007 D4）：
  // dsh-user-approval 提供的是通道中立的 `ctx.approval` seam，**本身没有 answerer**，
  // 缺 answerer 时 fail-closed 到 unavailable。企业审批的「大脑」仍在
  // policy/install.ts 的四个挂载点（判 ask、铸 PENDING、digest、租户、预算、账本），
  // seam 只是「嘴」。answerer 由 enterprise-approval-answerer 插件提供（下方 ADDITIONS）。
  //
  // permission 继续关：那是 dsh-permission-presets，一个把 sandbox-mode 与
  // approval-policy 打包成产品级下拉的 process-level 旋钮，没有租户维度。
  // 2026-08-31 查 registry 确认 approval 不依赖它（只依赖 schemastery）。
  disable('permission', '不组合 dsh-permission-presets：process-level、无租户维度；' + '\n' +
    '隔离权威是 Bubblewrap / exec，不是 DSH 本机围栏（ADR 0009 D5）。'),
  disable('session-persistence-jsonl', '关掉本机 JSONL 会话落盘。MySQL PersistenceBackend 由\nboot.mountSessionPersistence 挂到根 ctx.sessionPersistence。'),
  disable('session-checkpoint-policy'),
  disable('session-query-sqlite'),

  // ——— 以下八组是 2026-08-31 起栈实测（scripts/dump-tool-registry.ts）才发现的：
  // 它们在 dsh-base 里就是激活的，模型能看见，而 ADR 0009 完全没提。风险表与分类器
  // 是 fail-closed 的，所以它们的现状是「模型看得见、一调必被拒」。
  //
  // 默认按本 ADR 自身的原则一律关掉，理由逐条写在下面。每一条都可以单独翻转：
  // 打开 = 删掉这里的 disable() + 把工具名加进 runtime/policy/tool-names.ts。
  // 处置表见 docs/design/dsh-host-tools.md H2.0。
  disable('web', '出网面不进 agent 进程：`web_search` 让模型直接联网，而\nplan.md §12 要求业务数据只经受控的数据库 MCP。'),
  disable('web-search-deepseek'),
  disable('tool-web'),
  disable('tool-workflow', '`workflow` 在本进程 worker thread 里跑 JS 编排子 Agent\n——那是本机执行面，ADR 0007 D11 不挂。'),
  disable('workflow-worker-thread'),
  disable('tool-ralph', '`ralph` 是朝一个不可变目标反复重试的自主循环，不受每 Run\n预算与账本约束，不在本阶段范围。'),
  disable('tool-subagent-fork', '子 Agent 只有 durable one-shot 一种形态\n（subagent-spawn-in-process 已关）。fork 与 control 面都要求可续聊的\nsame-process 子 Agent，与我们的 provider 对不上。'),
  disable('subagent-fork-in-process'),
  disable('tool-subagent-control'),
  disable('tool-subagent-list-agents'),
  disable('tool-goal', 'goal 三件套是会话内目标状态机：没有企业面、没有前端卡片、\n没有风险表条目。与 memory 同理（D10），本阶段不做。'),
  disable('plan-mode', 'plan mode 的交接工具同上。'),
  disable('tool-str-replace-editor', '与 read/write/edit 功能重复的第二套编辑工具。\n留着就是「同一件事两处各算一遍」，且要在风险表里维护两份条目。'),
];

/**
 * 完整清单，顺序即 patch 应用顺序（最后写入获胜）。
 *
 * MCP 不进这份提交的 YAML。`MCP_SERVERS_JSON` 是运行时 env（compose `.env`），
 * 镜像构建时是空的；写进 patch 会让 Docker 部署永远装不上 MCP。boot 时由
 * `buildMcpRuntimePatches()` 按当前环境叠进去。
 */
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
