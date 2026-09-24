# AgentVersion、runtime、plugin 与 prompt 接入优化计划

日期：2026-09-05。状态：**实施中，尚未完成验收**。代码核对基线：`d3870cae`。

目标：管理员在前端配置的内容，必须与 AgentVersion 保存的配置、Worker 实际使用的
模型参数和工具权限一致；不支持的配置在保存前说明原因，不再静默接受。
本文是实施计划，不是已完成的验收证据，不修改冻结的 `docs/plan.md`。

## 1. 依据、范围与优先级

依据：AGENTS.md §1–§4、plan §8.4/§8.5、ADR 0007/0008/0009。
仓库已有 ADR 0010（A2A）；本计划不改 A2A 协议。如果实施中确需新增 ADR，先检查最新编号。

本次审查已核对生产接线，并用真实 DSH 插件树、真实工厂和工具执行管线复现下列问题。
探针使用内存会话替身与无外部副作用的测试工具，未验证 Docker/真实模型端到端。
相关 67 条既有测试通过；宿主为 Node 26，不替代固定 Node 22 的验收。

| ID | 优先级 | 已确认的问题 | 必须得到的结果 |
|---|---|---|---|
| AV-01 | P1，阻塞发布 | `toolPolicy.tools` 被解析并传为 `toolPolicyBinding`，工厂不消费；配置 deny 的 `todo_write` 仍执行成功 | 显式 deny 在真实工具管线生效，任何模型/工具入口不能绕过 |
| AV-02 | P1，阻塞发布 | AgentVersion 的 MCP 引用范围没有成为执行权限；`mcpServers: []` 的 Run 仍可调用平台配置为 low 的测试 MCP 工具 | 未引用 server/tool 一律拒绝；风险低或已审批都不能增加授权范围 |
| AV-03 | P2 | 自定义 prompt 包含 `## Paths (hard rules)` 就跳过企业条款 | 企业 section 始终存在，不用正文标题判断幂等 |
| AV-04 | P2 | 自定义文本中的 `{{customer_name}}` 被 DSH 当作模板变量并报错 | 普通 prompt 按字面量处理，保存/预览/执行一致 |
| AV-05 | P2 | 工厂只向 DSH 传 provider/model，模型生成参数断线 | 显式支持的参数出现在实际模型请求；不支持的值保存时拒绝 |
| AV-06 | P2 | bootstrap 提供的 workspace/skill roots 没传入 prompt 拼装 | prompt 使用同一份服务端解析的逻辑路径 |
| AV-07 | P2 | 管理页只有 JSON 编辑，后端仅做部分字段校验；无效/遗留字段可表现为保存成功 | 表单、字段错误、生效摘要和遗留配置处置可直接操作 |
| AV-08 | P2 | 活跃文档仍描述旧 prompt 机制；`skills/extensions/sandboxPolicy/a2a` 的配置承诺大于实际消费面 | 文档与 UI 明确区分有效配置、继承项和未支持项 |

AV-01/02 不能放进非阻塞债务表。`riskApproval` 也需纳入 AV-01 回归：目前解析了该表，
但 runtime 的最终决定使用固定风险映射；MCP 嵌套风险投影亦需证明没有在 resolver 重算时丢失。

不在本轮范围：重写 Agent Loop、引入 per-Run preset、每 Run 新建 MCP 连接、增加通用
插件市场、重新开放本机执行族、重做 A2A、将网络/容器权限交给 AgentVersion。

## 2. 保留的架构与要收紧的边界

```text
Frontend：表单草稿 / 服务端校验结果 / 版本管理 / 会话绑定展示
   ↓ HTTP
BFF：鉴权投影、限时转发、原样传递结构化错误
   ↓
Agent Catalog：配置校验、不可变版本、激活指针（MySQL 权威）
   ↓ 同一个配置解析入口
Worker：版本配置 + 当前平台约束 + 当前租户/用户身份 → 有效运行配置
   ↓
DSH per-Run scope：persona / 企业条款 / 模型参数 / 权限 guard / 工具可见性
   ↓
进程级插件树与 MCP；fs/shell/jobs 经 ALS + HMAC 调用 exec
```

1. 平台决定“装了什么、隔离到哪里”；版本只选择能力并增加使用约束。
2. 工具授权与风险审批分开。先检查授权，再计算是否审批；最终取最严格决定。
3. 允许列表用于生成模型可见面，guard 仍为执行权威。二者从同一个授权结果派生。
4. frontend/BFF 不依赖 DSH；agent 的配置类型放在 agent 内部，HTTP DTO 按既有 API
   类型/校验方式提供。不要为这次表单另建一个跨全仓的 runtime 配置框架。
5. 持久化的原始版本与临时有效配置分开。平台撤销能力会收紧旧版本，但不改写历史 JSON/hash。

## 3. 配置契约与兼容规则

新增配置写入 `schemaVersion: 1`；无此字段的记录按 legacy 解读。旧记录不原地迁移。
新写入由统一 validator 生成规范配置；读取 legacy 时使用兼容投影，并返回字段级提示。
v1 对规范配置使用现有 hash 算法，规范化时固定字段顺序；不重算历史 hash。
前端语义差异基于规范化结果比较，历史 hash 仍只代表当时保存的原始配置。

| 字段 | v1 本期行为 | 前端 |
|---|---|---|
| `systemPrompt` | 纯文本 persona/任务要求，不能替换企业 section；本期不开放模板变量 | 多行文本，明确显示与平台规则的关系 |
| `modelPolicy.modelId` | 选择平台目录中 Worker 确实可路由的模型；省略表示平台默认 | 默认选项 + 模型选择器 |
| `modelPolicy.maxOutputTokens` | 映射 DSH `maxTokens`，按模型能力与平台上限校验 | 数字输入，显示上限与继承值 |
| `modelPolicy.thinkingLevel` | 映射该模型实际支持的 reasoning effort；不能把旧枚举任意截断/猜映射 | 只列该模型支持的选项；未设置与关闭是不同状态 |
| `modelPolicy.temperature` | 只有模型适配器和 Run 接线共同支持时可用 | 不支持时禁用并解释，不展示虚假的可编辑值 |
| `toolPolicy.tools` | 当前标准工具名 → allow/deny/require_approval；未写为继承平台 | 工具列表，四态：继承/允许/审批/禁止；允许不能覆盖平台禁止 |
| `toolPolicy.riskLevels` / `classRiskLevels` / `riskApproval` | 保留并统一消费，只能收紧平台；别名仅在兼容读取时解析 | 高级配置及生效摘要；基础表单不重复提供两套冲突旋钮 |
| `mcpServers` | 显式 server 引用；v1 省略或 `[]` 均不授权 MCP；每个引用必须有 `enabledTools`，`[]` 表示不授权任何工具 | server/工具复选；“选择当前全部”展开成当前工具清单，新增工具不会自动获权 |
| `mcpServers[].toolPolicy` | server/工具权限、风险统一合入同一个决策入口 | 显示最终权限和来自平台的限制 |
| `skills` | 本轮不新增按 AgentVersion 选择技能的产品能力；技能继续依赖系统包与当前用户启用集 | 展示继承关系，入口跳转现有 Capabilities 页面；不提供无效勾选框 |
| `extensions` / `sandboxPolicy` / `a2a` | 本轮不作为可编辑运行配置；空值允许兼容读取，新配置不输出这些占位字段 | 显示平台管理/暂不支持，不混在可编辑表单里 |

v1 MCP 配置不接收 `secretRef/timeoutSec/toolInputSchemas/toolDescriptions` 等连接或发现字段。
连接地址、密钥引用和超时仍由进程配置决定，schema/description 来自实际注册工具。
legacy 内嵌完整 Model、顶层模型参数及 `reference/modelRef` 仅保留读取兼容；升级为 v1 时
必须能映射到已支持的模型目录，否则阻止升级并给出差异，不把 endpoint/headers 塞进新版本。

### 兼容细则

- legacy 无 MCP 引用或空数组：按 ADR 0009 的授权语义收紧为无 MCP 权限，不保留已发现的越权行为。
  发布前盘点受影响版本，需 MCP 的管理员显式发布新版本；旧会话不能因“兼容”获得未绑定能力。
- legacy 已引用 server 但 `enabledTools` 省略/为空：本计划按无工具授权处理，不从“引用了
  server”推导“授权其所有工具”。这属于有意收紧的兼容变化，P0 统计影响，发布说明明确提示；
  需要该能力的管理员发布带显式工具列表的新版本，不自动把当前注册表写成用户授权。
- 不支持的非空遗留字段：历史记录可查看；继续运行不凭这些字段授予新权限。复制为新版本时
  给出保留原文的迁移差异，要求明确处理，不能在切换表单/JSON 时静默丢字段。
- `skills` 非空历史配置仍可能用于 A2A 展示，不能机械删除。升级 UI 应提示该差异；本轮不
  把它变成执行授权。若产品以后需要按版本筛选技能，另补系统/组织/个人的引用和启用语义。
- 未知键和拼写错误：v1 在保存时拒绝，返回字段路径；legacy 显示“未识别/未生效”，不假称已支持。
- 冻结的是版本配置，不是外部 MCP 清单和用户启用集的永久快照；有效配置应附平台能力 revision，
  在每次 Run 开始重新解析。能力撤销必须立即收紧，不能靠历史预览继续执行。

## 4. 后端实施

### 4.1 配置解析与实际生效配置

在 `agent-version-bindings.ts` 周边建立明确的配置类型和唯一解析入口，逐步替换
runtime-factory 边界的 `Record<string, any>`。不要求顺带消灭全仓 any。

解析结果至少包含：版本身份、模型选择及有效参数、persona、工具授权、风险决策、
逻辑路径，以及字段诊断。分别传给对应装配点，不再靠未消费的 `toolPolicyBinding` 宣称已应用。

保存、预览、启动 Run 使用同一字段语义；Run 启动还要校验当前目录可用性和调用者身份。
写入验证不运行工具、不调用模型、不创建会话或临时装配 MCP。

模型目录需核对 `model-registry.ts` 与插件 manifest 中 DSH model 列表的一致性：前端能选的
ID 必须在 Worker 可解析，支持的 effort/上下文/输出上限来自同一有效目录投影。

### 4.2 工具权限、可见性、审批

- 将 toolPolicy 的显式决定、MCP server 引用及工具 allowlist 接到 per-Run guard。
- 风险判定消费完整的风险策略结果，包含 `riskApproval` 和 MCP 嵌套风险；不能只传一个等级
  然后重新用另一张固定表恢复决定。
- 审批仅能满足“已授权操作需要人批准”的条件；历史 APPROVED 不得覆盖当前 deny、平台撤销或
  MCP 引用缺失。参数指纹、一次性消费、租户、Run/fence 校验保持。
- 空 allowlist 必须真的得到零工具；修复 `visible.length > 0` 这种把空列表当“不限制”的分支。
- `getAllTools()` 从当前 agent scope 投影，而非根 ctx；工具 guidance 与 schema 采用同一 scope。
- MCP `tools/list_changed` 新增工具、名称规范化/哈希、重连后工具消失都要走同一过滤规则。
- 主 Run、重放续跑和 durable 子 Run 全部使用有效配置入口，防止侧路重新获得全量工具。

### 4.3 Prompt 与模型参数

- 拆成独立的企业 section 与 persona section；企业 section 只由部署约束和逻辑路径生成。
- 移除正文标题幂等逻辑。按 DSH 的字面量安全路径传入 persona，避免任意用户文本被再次插值。
  先用真实 `renderPrompt` 证明 `{{x}}`、代码片段、JSON、中文和标题样例保持原文。
- roots 从服务端既有路径解析入口传递；区分模型可见逻辑路径与物理宿主根，后者不进入 prompt。
- 工具 schema/说明继续由 DSH 工具提供；Skills catalog/显式技能内容继续由消息层渐进注入。
  system section 顺序只表示渲染顺序，不作为安全权限层。
- `maxOutputTokens` 映射 `AgentOptions.maxTokens`；reasoning 使用当前模型支持的 effort ID。
  temperature 按 DSH 实际 call-config seam 接入；如果固定版本不支持某种组合，就拒绝该组合。
- 对 create、resume、后续模型 step、压缩/标题等辅助请求分别定义参数作用域：AgentVersion 的
  对话生成参数用于主对话请求，辅助请求继续遵循各自策略，不能无差别覆盖所有 LLM 调用。
- 以 fake provider 捕获最终 wire request 验收；只检查 createAgent 收到了字段不算完成。

### 4.4 Plugin 启动验证

保留进程级 manifest → YAML → boot；不通过 AgentVersion 装卸 Cordis 插件。
补启动后的关键 provider 类型、禁用服务缺席和必需工具存在断言，缺必需能力拒绝运行。
可选 MCP 断连可以降级，但配置、注册、连接三种状态需区分，不能用“没工具”冒充“未配置”。
复核 MCP readiness 的缓存更新和 Worker/HTTP 进程差异；前端目录不得以 HTTP 进程快照冒充
某个 Worker 的确定实时状态。无法确认的状态显示 unknown/stale。

## 5. 前端与 HTTP 接入

### 5.1 API 增量

复用 `/api/agents` 新建/版本/激活接口和现有 `/api/capabilities/models|tools|mcp|skills`。
能力目录返回需先通过 org/admin 作用域检查；原有接口若无法满足，不得直接暴露全进程清单。
补充两条配置接口，Agent 负责语义，BFF 仅限时转发：

| API | 返回内容 | 限制 |
|---|---|---|
| `GET /api/agents/config/options` | 配置 schemaVersion、字段支持情况、平台约束及 capability revision；目录沿用现有 capability API | admin；不返回连接地址、密钥、私有宿主路径、其他用户技能 |
| `POST /api/agents/config/validate` | `{ valid, errors, warnings, normalizedConfig?, effectiveSummary, capabilityRevision }` | admin；只解析；请求包含 config，可带同 org 的 agent_id；有容量和时间上限 |

错误条目固定为 `{ path, code, message }`，如 `modelPolicy.thinkingLevel`、
`mcpServers[0].enabledTools[1]`；结构错误用 400，合法请求的业务校验结果用 200/valid=false，
越权与不可见资源按既有 404 规则；未支持字段、无权引用分别给稳定错误码。
创建/发布版本仍重新验证，不能信任浏览器传来的 normalizedConfig/valid/revision。

`effectiveSummary` 是部署约束下的配置摘要，不是完整模型上下文：展示模型参数、工具允许/
审批/拒绝及原因、persona 和安全的企业条款预览、技能继承规则。动态历史、workspace
AGENTS.md、技能正文及完整 tool-result 不在此预览中；不得声称它等于某次未来请求全文。

对版本保存/激活增加可选 `expected_active_version_id`：新 UI 必传，冲突返回 409，防止两位
管理员互相覆盖激活指针。旧客户端兼容窗口在 API 文档中说明；版本号仍由 MySQL 事务决定。

### 5.2 管理页信息结构

扩展现有 `AgentsPage.tsx`，复用 mgmt 组件与 Capabilities API，不新增一套配置中心。
按职责拆出表单、校验结果和版本比较组件，避免把页面堆成新的千行热点。

| 区域 | 管理员操作 | 生效反馈 |
|---|---|---|
| 基本信息与角色 | 新建 Agent 的名称/描述；编辑 persona | 平台规则只读展示，自定义内容与平台规则来源清晰 |
| 模型 | 选择模型、输出限制、推理强度、支持时设置 temperature | 显示继承值/上限；换模型后指出不兼容参数，不能静默重置 |
| 工具权限 | 查看工具、搜索、设置继承/允许/审批/禁止 | 展示有效决定和限制来源；平台禁止项不可被 UI 放开 |
| 外部服务 | 选择组织可用的 MCP server 和具体工具 | 未选择为不授权；离线/未知/权限不足分别提示 |
| 技能与平台设置 | 查看技能继承规则、前往已有启用管理 | 不呈现会保存成功却没有效果的技能/插件/沙箱开关 |
| 校验与版本 | 查看字段错误、生效摘要、与当前版本差异 | 保存未激活版本、保存并激活、查看/复制/回滚历史版本 |

高级 JSON 编辑仍保留，但与表单共用一份草稿。无效 JSON 不切换表单；未知/遗留字段
保留原文并阻止无损转换失败，不能经表单往返偷偷删除。规范化差异在保存前可见。
错误标到字段并提供顶部摘要、键盘可达的焦点跳转；不只用颜色表示允许/禁止。

### 5.3 交互与异步边界

1. 加载当前活跃版本、配置支持项和能力目录；缺目录时保留草稿，显示不可用，不能把网络错误
   转成“没有权限/空清单”，更不能用空响应覆盖已有配置。
2. 编辑后调用服务端 validate；使用取消请求或序号，旧响应不得覆盖新草稿的校验结果。
3. 保存前校验当前草稿并显示语义差异；分别提供“保存新版本”和“保存并启用”。校验 pending/
   errors 阻止提交；纯提示不阻塞。必要目录无法确认时阻止依赖它的新增/修改项。
4. 激活冲突保留本地草稿、刷新服务端版本，展示差异后再提交，不自动重试覆盖。
5. 跳转到其他 Agent、切表单模式、刷新目录均保护未保存草稿；修改格式不应造成虚假的语义差异。
6. 历史版本可查看配置和兼容提示；激活前重新校验当前平台约束，不允许回滚恢复已撤销权限。

### 5.4 聊天接入

保留 `useAgentSelection`：新建会话只发送 agent_id，不由浏览器选择版本。
会话详情由 Agent 返回实际绑定的版本号/ID；前端可只读展示“当前会话使用 vN”，
不从 Agent 的最新 active_version 推测旧会话版本。配置升级提示可引导新建会话，不能偷偷换绑。
模型选择器与版本固定模型约束一致：如果会话版本固定了模型，禁用不兼容选择并说明原因；
服务端仍验证直接 HTTP 请求。聊天页不展示 admin 才能读取的 persona 或全部授权规则。

## 6. PR 顺序与完成标准

以下全部为待办。一个 PR 一个主题；每个后端字段只有真实接入后，才能在表单开放。

| 阶段 | 交付范围/主要文件 | 依赖 | 完成条件 |
|---|---|---|---|
| P0 复现与影响盘点 | 新增 factory/工具/模型请求级回归；统计 legacy 配置字段与授权引用的脱敏数量；复核 STATUS A2/A3/A5/H5/H6 | 无 | AV-01～06 修复前失败；legacy MCP 空值语义、模型 effort 支持有证据；不写入配置原文/密钥 |
| P1 授权修复 | `tool-risk-bindings/resolver`、`runtime/policy`、`runtime-factory`；前端先明确提示旧权限问题，文档同步 | P0 | deny、MCP 引用、riskApproval、空 allowlist、审批续跑和子 Run 一致，真实 exec 链通过；不等待完整表单才修安全问题 |
| P2 配置契约与校验 API | `agent-version-bindings`、`agent-catalog-service`、agents routes、BFF/DTO | P0；以 P1 后规则为准 | v1/legacy 读取和写入策略明确；字段错误、作用域、反伪造身份、未知键和安全摘要验证通过 |
| P3 prompt/模型/启动收口 | runtime prompt/factory、bootstrap/manifest/模型目录 | P2 | 字面量 prompt、路径、模型 wire 参数、create/resume/辅助请求作用域通过；插件启动门禁和能力状态真实 |
| P4 管理与聊天前端 | AgentsPage/agentHelpers/shared API、Capabilities 复用、会话绑定展示 | P1～P3 | 表单—JSON—校验—差异—发布/冲突—回滚全链；不支持字段不可假配置；直接 HTTP 绕过 UI 仍被拒 |
| P5 联调与发布 | 真机证据、新版本管理员迁移说明、相关活跃文档/STATUS/PROCESS_LOG | P1～P4 | 六套测试及类型检查、真实模型与工具、浏览器验收通过；无 open 的阻塞项 |

P2 可先发布向后兼容的读取/校验 API，P4 再启用表单。启用 v1 写入前，所有 Worker 必须
支持 v1；未知 schemaVersion fail-closed，不能作为 legacy 继续跑。滚动升级期间不混用
不同授权语义的 Worker。安全修复的回滚不应恢复绕过路径，必要时关闭对应能力并前向修复。

## 7. 验收矩阵

| 范围 | 必测场景 | 判据 |
|---|---|---|
| 授权 | deny 的本地工具；未引用 MCP；允许 server 下未选工具；空列表；规范化名称；平台 deny + 版本 allow | 工具 body 调用次数为 0，拒绝原因稳定；不能只检查 schema 不含工具 |
| 审批 | allow/ask/deny 组合；批准后权限撤销；重放参数变化；重复消费批准 | 审批不增加权限；批准只对同租户/Run/参数生效一次 |
| 并发 | 两租户同时 Run、两个同租户不同版本、子 Run、scope dispose 后新 Run | 工具、persona、参数、身份、预算和技能不串台 |
| Prompt | 标题碰撞、`{{x}}`、JSON/代码/中文、空 persona、自定义 roots、重复 setup/resume | 企业 section 恰好一份；原文无误插值；无物理路径泄漏 |
| 模型 | 两个不同参数的并发 Run；不支持 effort；更换模型；多 step/resume；辅助模型请求 | 捕获最终请求字段与作用域；不支持值保存时报错，不靠模型回答推断生效 |
| 插件/Skills | 必需 provider 缺失、禁用服务误挂、MCP 断连/新增工具、用户技能启用/禁用 | boot/运行 fail-closed；可选服务状态明确；新权限不自动增加；技能不跨用户可见 |
| API | member 写入、跨 org agent_id、伪造 X-Acting-*、未知字段、过期 capability revision、直接 POST 绕过 UI | 权威校验在 Agent；BFF 纯代理；404 不泄露归属；字段错误可渲染 |
| UI | 表单和 JSON 往返、遗留字段、校验响应乱序、目录失败、未保存切换、重复点击、激活 409 | 不丢草稿、不丢字段、不误报生效、不覆盖别人激活结果 |
| 版本 | 创建未激活 v2、激活 v2、旧会话 follow-up、新会话、回滚 v1 | 旧会话保持钉住版本；新会话由服务器选择活跃版本；历史 JSON/hash 未变 |

按 AGENTS.md 顺序执行：失败测试或真实请求复现 → 根因 → 修复/回归 → 真机验证。
每个运行路径 PR 必须重建 `agent api-server sandbox sandbox-mcp` 并启动容器；最低链路：
登录 → 建会话 → 带工具 Run → process logs/signal → 跨租户 404。新增权限/审批场景在此基础上扩展。
P5 再加一次浏览器管理员配置—发布—普通用户新建会话—模型工具调用的完整操作。

提交检查：pytest、exec、contract、agent、BFF、frontend 六套测试；exec/contract/BFF/
agent（含 runtime strict）/frontend 类型检查；前端 build。Node 22 / Python 3.11 / DSH
固定版本按 `runtime-versions.json`；真机结果不可被宿主 Node 26 的绿测替代。

## 8. 文档、证据与交付

- 行为变更同 PR 更新 `architecture.md/api.md/webui.md/development.md`；涉及环境配置时同步
  `deployment.md/.env.example`。修正 `design/multi-agent-selection.md` 中“消费面已完整”的过时前提。
- 用户可感知修复记入 CHANGELOG `[Unreleased]`；PROCESS_LOG 只追加并标注 STATUS IDs。
- STATUS A2/A3/A5 的已有完成证据不能证明本次配置链完整：P0 根据新证据补充/重开具体缺口，
  不删除历史证据，也不把整项未经区分地翻红/翻绿。P5 以实际验收更新相关状态。
- 真实验收只新增带日期的 evidence 文件，包含版本、环境、请求/结果摘要与脱敏后的验证方法。
  本计划不链接 `/tmp` 探针或一次性本地交付物作为长期证据。
- 发布说明必须包括 legacy MCP 收紧影响、v1 新旧字段差异、旧会话不换版本、管理员如何发布
  新版本和检查生效。交付“前端可配置”必须同时交付“工具/模型实际按配置执行”的证据。

最终成功条件：管理员无需理解 DSH 插件内部细节，就能知道自己配置了什么、实际生效什么、
什么受平台限制；后端不依赖管理员或模型的自觉兑现这些限制。
