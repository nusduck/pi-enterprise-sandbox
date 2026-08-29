# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Skill 入口脚本允许嵌套在 `scripts/` 子目录下**: 守卫要求脚本路径匹配 `/scripts/<单个文件>$`，于是仓库自带的首方包**当场就跑不了**——`xlsx/scripts/office/pack.py`、`skill-creator/scripts/` 之外的 `eval-viewer/generate_review.py` 都被 `SKILL_SCRIPT_COMMAND_DENIED` 拒绝，而这是唯一被放行的执行入口。现在 `scripts/` 下任意深度都接受；同时补上 `..` 拒绝——旧的扁平正则顺带挡住了 `…/scripts/../hidden.py` 这类「读起来像 scripts/」的路径，放开嵌套后必须显式挡。

### Removed

- **删掉从未进入模型的 `PLATFORM_SYSTEM_PROMPT_LAYER` / `composeSystemPrompt`**: 注释写着「平台安全层总会 append、env 关不掉」，运行时却走 `resolveEnterpriseSystemPrompt`，这两个符号只在单测里互相调用。路径边界、审批、artifact 交付、密钥不进回复已经在企业契约和代码护栏里；再接线只会把写死的 `submit_artifact` 清单带回基座。`AGENT_SYSTEM_PROMPT` 仍然只做人设 lead。

### Changed

- **Wave 6 checkJs 收口**: `agent/tsconfig.json` 不再 `exclude` 存活 JS；去掉 44 个 Wave 6 占位 `@ts-nocheck` 横幅，checkJs 仍为 0。布局棘轮收回 W2-D 为 `@ts-expect-error` 抬过的四条预算（`execute-run-service` / `fenced-tool-governance-recorder` / `create-http-server` / `trace-span-repository`），`internal-files-read-http.js` 已低于 1000 行退出 hotspot。
- **Compose 构建上下文改为仓库根**: `agent` / `exec` 镜像需要 `file:../runtime` 与 `file:../contract`，因此 `docker-compose.yml` 的 build context 从包目录改为 `.`，Dockerfile 分别为 `agent/Dockerfile` 与 `exec/Dockerfile`。Agent 增加精确钉 `jiti@2.6.1` 以加载 `pi-mcp-adapter` 的 TypeScript 源。Exec 健康检查改为 Node `fetch`（`node:22-slim` 没有 curl），并去掉已删除的 Python `seccomp-bubblewrap.json`。

- **System prompt 补上 Doing work 工作纪律**: 基座仍是 Pi 风格的短契约，但补了「本轮把请求做完并验证、不擅自缩放范围、进度写在用户可见回复、密钥不进回复、有交付工具就走交付工具」。todo / memory / `ask_user` / `spawn_subagent` / `submit_artifact` / `bash` 的用法加强写在各自 `promptGuidelines` 上，只有绑了这些工具的 run 才看得到——基座故意不点名，避免重复「没启某个 extension 却读到它的工具名」那类漂移。

- **`skill_edit` 一次提交一组文件**: 参数从单个 `path` + `content` 改为 `files: [{path, content}]`（同一个 package，最多 32 个文件；旧形参仍然接受，这样部署前记录的审批仍能重放）。每次 Skill 变更都要花一次审批，而按文件拆分让「改一个 Skill」= N 次横幅——用户点到第三次就变成机械同意，审批疲劳本身就在削弱这道闸门；更糟的是用户可能批准一个只改了一半的 package。批次是全成或全败：先对整批做完校验（路径、包归属、`.git`、体积、`SKILL.md` 名字），再全部写进临时文件，最后统一换入，中途失败会把已换入的文件回滚。
- **拒绝信息和 system prompt 现在都写明可执行形态**: 旧的拒绝理由只说「必须是 python *.py / bash *.sh 且无 shell 操作符」，**完全没提 `scripts/` 这条**，而 system prompt 的 Skills 段只讲了只读和 `ls`/`find` 的差别、一个字没讲怎么执行。模型撞墙后既读不到规则也猜不出缺了什么，只能反复试。两处现在都给出完整形态与被排除的写法（`cd &&`、管道、重定向、`$(...)`、glob、`python -m`、换解释器、`cat`）。

- **千行棘轮扩到 `frontend/src` 与 `api-server/src`**: AGENTS.md §3 的「生产文件 ≤1000 行」对四个服务都成立，但 `tests/test_repository_layout.py` 只扫 `agent/` 与 `sandbox/`，于是前端三个文件在没人发现的情况下越了线（`runReducer.ts` 1492、`ChatContext.tsx` 1456、`InlineRuntimeSteps.tsx` 1011），`api-server` 则完全没被钉住（`agent-client.js` 已 944 行且在长）。两个目录现在都在扫描范围内；越线的四个前端文件按既有做法**钉在当前行数**记为显式债务——只能减不能增，加一行就在加它的那个 PR 里失败。`api-server` 无需任何预算即通过。

- **System prompt 不再自称 pi / coding assistant**: 默认身份改为「风控通用智能体」——一个通用企业智能体，风控/合规/运营是它当前的部署场景而不是能力边界；同时明确「用用户的语言回复」。原先挂在“For risk work:”下面的那条纪律（交代查了什么、没查什么、结论有多确定，并区分观察与推断）改为无条件生效，否则模型对任何它不归类为风控的任务都可以跳过。非空的 AgentVersion / `AGENT_SYSTEM_PROMPT` lead 会**替换**默认身份句而不是叠加，所以两个 lead 槽位都必须写完整人设，不能只写一条补充规则——`.env.example` 已写明。

- **`## Available tools` 那份写死的 13 项闭合清单改为按 run 渲染**: 旧清单和内部 extension 包名一起去掉了，但没有换成一份“if present”的散文清单——那只是保真度更低的同一个错误：没启 `skill-lifecycle` 的 run 照样会读到 `skill_list`，而 `spawn_subagent` 谁都没提。工具的 name/description/parameters 本来就在本轮请求的 tools 数组里，prompt 里再抄一遍必然漂移。现在 `## Tools` 的正文由 `renderToolSurface` 从**本 run 实际绑定的工具**生成，数据源是每个工具定义上早就写好的 `promptSnippet` / `promptGuidelines`（sandbox-bridge、skill-lifecycle、subagent-spawn、user-interaction，以及 `mcp__<server>__<tool>` 包装器都有），由 Pi 按活的 registry 聚合；sandbox-bridge 在 `before_agent_start` 上把它拼进去。**顺带补回了此前完全丢失的 `promptGuidelines`**（仅 sandbox-bridge 的 13 个工具就有 31 条）——那是跨调用的工作流规则（例如 read 的“沿着 nextOffset 读完，不要重复同一页”），放在单个工具的 description 里天然错位，此前因为走 customPrompt 分支而哪儿都没去。没有拼接时 prompt 依然成立：`## Tools` 只说各工具自己的 schema 为准，外加 MCP 命名、审批会等待、缺能力就直说这三条静态跨工具规则。

### Added

- **`ls` 现在可以列 Skill 目录（`find` / `grep` 仍然不行）**: 此前三个搜索工具一律拒绝 Skill 路径，模型只能 `read`——于是一个 Skill 除非在 `SKILL.md` 里自己写明，它随包发的 `reference/`、`scripts/` 就无从发现，渐进披露反而变成了看不见。这从来不是安全边界：只有调用者自己的目录会被绑进来，跨租户在构造上就搜不到。现在按工具区分：`ls` 放行，`find` / `grep` 保持关闭（全树内容检索恰好会把渐进披露想挡住的东西一次性拉进上下文，而模型总可以先 `ls` 再 `read` 那一个文件）。实现没有新开内部面——`ls` 沿用既有 search 面：`InternalSearchCommand` 本来就带着与签名绑定的 `org_id`/`user_id`，`_resolve_search_root` 是唯一的根解析接缝，它返回的 `public_prefix` 本来就负责把物理路径写回逻辑路径。用户层的裸根 `/home/sandbox/skill-user` **解析为调用者自己的 `<org>/<user>` 目录**（`ls` 的意义就是“不知道有什么才来看”，要求先写全自己的 org/user 等于把这次改动的收益退回去）；返回的每一项都带完整逻辑前缀，所以 `ls` 的结果可以直接喂给 `read`。`<root>/<其他租户>` 与只写到 `<root>/<org>` 的裸 org 段都拒绝——后者会枚举该 org 下的用户——并与格式错误的路径共用同一个不透明错误码，避免探测。物理目录由 `user_skill_dir_for()` 唯一决定，与执行时 bwrap 绑定走的是同一个函数。

- **模型可以自己搭一个 Skill 并直接安装**: `skill_install` 新增 `source="sandbox"`——模型用普通 `write` / `bash` 在 workspace 或 `/tmp` 里搭好包、跑通脚本、打成 `.zip` / `.skill`，然后把归档路径交给它。此前只有两条路：把 `SKILL.md` 拆成 `skill_create` 的结构化字段（连 frontmatter 都控制不了），或者打完包让用户下载再上传一遍——bundled `skill-creator` 教的正是后者，所以模型会一路做对最后一步卡住。归档路径先过 `normalizeLogicalPath`（Skill 根显式拒绝：只读挂载不能既是源又是目标），再由 Sandbox 的 `parse_sandbox_path` 二次限定在该 session 的 workspace/temp 内；取字节走已有的 owner-scoped `files/download`，然后与上传路径汇流到**同一个** `installSkillArchive`。Sandbox 侧零改动，特权写入仍然只有那一处。审批语义不变（high risk，一次 tool call），但用户批的是一个已经落盘、可被检视的包。

- **bundled `skill-creator` 改写为本平台的流程**: 原版是上游 Claude Skills 的说明书，教的是“复制到可写位置编辑 → `package_skill.py` 打包 → 让用户去装”，还依赖 `claude` CLI 和 subagent 跑 eval——这里两者都不存在。现在按实际可用的两条路径重写（小包 `skill_create`，其余在沙盒里搭完 `skill_install(source="sandbox")`），写明 Skill 树只读、可 `ls` 可 `read` 但不可 `find`/`grep`、名字/描述的校验口径与各项上限，并点名哪些自带脚本在这里不可用。文中给出的打包命令是实测过的（`PYTHONPATH` 与输出目录两个参数都必需，否则脚本要么 import 失败、要么试图写进只读的 Skill 根）。

- **Capabilities → Skills 区分系统与用户两层**: 此前该页只列内置 Skill——`extensions/diagnostics` 拿的是进程级 skill 根，而用户 Skill 装在 `<base>/<orgId>/<userId>` 下，扫描基目录一个也匹配不到（那一级没有 `SKILL.md`），于是"装没装上"在界面上完全看不出来。请求里其实早就带着身份（BFF 发 `X-Acting-*`，Agent 路由也已解出），只是投影时被丢掉了。现在 diagnostics 用**与 Run 相同的解析器**（`resolveSkillScopeForIdentity`）取该调用者的 skill 根，每项按 `source` 标 `shared-skill-root` / `user-skill-root`，前端分成 "My Skills" 与 "System Skills" 两栏。无身份的请求仍只投影系统层——用户层基目录不整根扫描，否则会列出其他租户已安装的 Skill。

- **read 工具支持图片（模型可以直接看工作区里的图）**: `read` 命中图片时返回 Pi `ImageContent` 而不是 `{binary:true}` 空壳——对齐 Pi 原生 read 的做法（Pi 没有独立 vision 工具，图片能力就做在 read 里）。此前一轮 Run 渲染出来的图表、截图、PDF 转页对模型完全不可见，唯一出路是 OCR。Sandbox 侧按**内容**嗅探类型（`image_sniff.py`，png/jpeg/gif/webp/bmp；工作区路径是模型自己写的，扩展名不作数），在 2MiB 预算内随响应回传 base64；超预算返回 `imageOmitted: IMAGE_TOO_LARGE` 并告诉模型先降采样再读，而不是静默给空。Agent 侧复用 SDK 导出的 `convertToPng` / `resizeImage` / `formatDimensionNote` 归一化并压到 Pi 的内联预算，且对到达的字段独立复核（base64 形状、类型白名单、解码后长度）——Sandbox 是跨网络的另一个服务，不能只凭它说了算。

- **Ctrl+V 粘贴图片为附件（前端）**: 输入框支持从剪贴板粘贴图片/文件。剪贴板图片没有文件名，按嗅探到的 MIME 命名为 `pasted-image-<时间戳>-<序号>.<ext>`——附件白名单按扩展名判定，不改名会被当作禁止类型拒收。与上传按钮、Ctrl+U 共用同一道「Run 运行中不可附加」门禁；剪贴板只有文本时不拦截事件，正常落进输入框。

- **Sandbox MCP bash 执行工具**: `sandbox-mcp` 新增 `sandbox_shell_execute`，在与 `sandbox_python_execute` 相同的 Bubblewrap 隔离工作区里执行 bash 命令（`execution_manager.run_command` 既有路径：网络黑名单预检 + `--unshare-net`、非 root、ulimit/seccomp 全套生效）。安全增量接近零——Python 本就能等价 spawn shell。命令长度上限 `SANDBOX_MCP_MAX_COMMAND_LENGTH`（默认 20000，Sandbox 桥侧同名上限 200000）；返回字段与 python 工具对齐（status/exit_code/stdout_preview/stderr_preview/duration_ms/truncated）。`sandbox/config.py` 热点预算 1488→1491（新增一个配置项的三行）。

- **消息气泡操作与滚动体验（前端）**: 助手气泡 hover 后出现 Copy（复制全文纯文本）与 Regenerate（仅最后一条助手气泡、且无活跃 Run 时显示，取前一条用户回合文本重发为新 Run——语义是追加一轮而非原地改写）；距底部超过 120px 时右下角出现「回到最新」浮标（sticky 定位，smooth 滚动）。流式渲染性能：`MessageBubble` 改为 `React.memo` + 内容指纹比较（投影层每个 SSE tick 都重建气泡对象，身份比较永远失效；气泡内不再订阅 chat context，否则 memo 被穿透），流式中的气泡照常更新，已完成气泡不再随每个 token 重新解析 markdown。

- **子 Run 不再注册 `ask_user`**: 子 Run 的对话被刻意排除在会话列表外，任务提示按契约自包含，也没有任何路径把子 Run 的提问送到发起父 Run 的人面前——注册这个工具只会让它停在 WAITING_INPUT 等一个没人看得见的问题。现在直接不注册，模型自行决定或失败，而不是挂死。extension 本身仍然装载（registry 对 AgentVersion 的 extension 列表是精确校验）。
- **停泊 Run 的取消回收对齐**: `run-recovery-service` 处理 WAITING_APPROVAL 的 cancel intent 已久，但 WAITING_INPUT 分支从不检查它——interaction 还是 PENDING 就直接跳过。带 cancel intent 的停泊 Run 因此可能永远卡住。两条分支现在共用一条路径（`run-recovery-parked-cancel.js`），WAITING_INPUT 的就地了结逻辑也从 `CancelRunService` 抽到 `parked-interaction-cancel.js`，与既有的 `parked-approval-cancel.js` 对称，由直接取消与恢复共用。
- **子 Run 级联取消**: 取消父 Run 会为其所有存活后代写入持久 cancel intent（沿 `parent_run_id` 深度有界遍历）并发出 Redis 取消信号（子 Run id 列表随取消响应返回）。这里只写 intent：`execute-run-service` 在进入 runtime 前及每步前后都会检查它（先读 MySQL，Redis 仅为加速），所以排队中的子 Run 在被捡起时就地终止、运行中的子 Run 走它自己那条已有的取消路径——无需为每个子 Run 复刻 WAITING_INPUT/WAITING_APPROVAL 的停泊终结逻辑。已终态的父 Run 同样会回收其存活子 Run（父 Run 失败后子 Run 仍在烧预算）。子 Run 自己更早的取消原因不会被父级覆盖（first-writer-wins）。`spawn_subagent` 现在拒绝在已终态或已请求取消的父 Run 下创建新子 Run——父行的 `FOR UPDATE` 让取消与创建串行，两种先后顺序都安全。
- **子 Conversation 不再进入会话列表**: `conversations.parent_run_id`（migration `20260822000003`）标记子 Run 自己的 Conversation，`listForOwner` 默认过滤掉它们（`includeSubagent: true` 可取回）。`getById` 不过滤——子任务的 transcript 仍可按 id 读取，这正是当初否掉"创建即 archive"方案的理由。
- **子 Run（sub-agent）**: 新增可选 extension `subagent-spawn`，注册 `spawn_subagent` / `check_subagent`。子 Run 是普通 Run——同一张 `runs` 表、同一个 `agent-runs` 队列、同一套 worker 与恢复路径，只多了 `source='subagent'` / `parent_run_id` / `subagent_depth` 血缘（migration `20260822000001`）。每个子 Run 有自己的 Conversation 与 AgentSession（父 Run 整个生命周期持有其执行 fence，共用会话必然死锁），继承父 Run 的 AgentVersion、`trace_id` 与父 span。`toolCallId` 作幂等键保证一次 tool call 只产生一个子 Run；深度与并发上限在父行加锁后于事务内复查，可用 `AGENT_SUBAGENT_MAX_DEPTH` / `AGENT_SUBAGENT_MAX_CONCURRENT` 或 AgentVersion `configJson.subagent` 收紧。
- **持久任务状态**: 新增可选 extension `task-state`，注册 `todo_write` / `todo_read`（按 AgentSession 整体替换的计划清单）与 `memory_write` / `memory_search`（owner 级、跨对话的追加式备忘）。两张表 `task_todos` / `task_memories`（migration `20260822000002`）全程 org+user 作用域。
- **Provider 并发闸门与 429 冷却**: 每个 Agent 进程一个闸门（不是每个 Run 一个——那样只会限制本已串行的单个 prompt 循环），在 `before_provider_request` 取号、`after_provider_response` 归还；等待有界，超时后降级直通并交回**空操作**的 release，所以降级调用方不会释放别人的名额。连续 429 按 key 指数延长冷却窗口，非 429 响应立即清除。`AGENT_PROVIDER_MAX_CONCURRENT` / `AGENT_PROVIDER_COOLDOWN_MS` 可调。
- **OTel 工具 span**: 配置了 OTLP endpoint 时，每次工具执行产生一个 CLIENT span（`agent.tool.<name>`），挂在当前 Run span 下；失败只记录结果的稳定 code，绝不把工具输出带进链路。Run 中断遗留的 span 与 provider 名额都在 `session_shutdown` 收口。
- **A2A v0.3 对齐**: Agent Card 发布 skills；streaming status 事件符合 SDK schema；发出官方 task-lifecycle 流。
- **用户 Skill 生命周期**: 新增可选第一方 extension `skill-lifecycle`，支持上传安装、Agent 生成、编辑与卸载，全部限制在 per-user Skill 根内并走审批。Sandbox 执行侧的 read/bind 认可用户 Skill 路径。
- **模型能力**: 模型选择、视觉输入与 thinking UI；MCP 发现到的 schema 投射给模型。
- **工作区搜索工具**: 新增 `ls` / `find` / `grep` 三个 sandbox-bridge 工具，走 `/internal/v1/files/{ls,find,grep}` HMAC 内部平面。此前 SDK 同名工具因会读 Agent 容器文件系统而被永久排除，却没有替代品——模型只能用 `bash` 探索工作区（串行、无结构、无预算）。三者只读、可与 `read` 并行、有默认与上限预算，并把截断和跳过的目录如实报给模型。`SANDBOX_TOOL_NAMES` 由 10 增至 13。
- **Run 收敛保护**: 为每个 Pi Run 增加模型回合、总工具调用和相同工具/参数调用上限；达到上限后禁止继续调用工具，并要求模型依据已有结果作答。三个上限均可通过 `AGENT_RUN_MAX_*` 配置。
- **MCP 启动发现**: Agent 启动时连接每个启用的 MCP Server 并执行 `tools/list`；发现到的工具以 `mcp__{serverId}__{toolName}` 注册，对应的连接与工具数量会出现在 readiness/diagnostics。

### Security

- **`skill_install(source="sandbox")` 的审批现在绑定字节，而不只是路径**: 该分支的参数只有 `{ source, path }`，没有任何摘要；`archive_sha256` 是**批准之后**下载时才算的，只写进审计日志。而 `skill_install` 是 high risk——参数先入账本、用户批准后**重放**执行——这期间 workspace 一直可写。于是模型可以先递一个人畜无害的归档、等批准、覆写该路径、让重放去装另一份。现在 `source="sandbox"` **必须**带 `source_digest`（64 位小写十六进制 sha256）：下载完成后按字节重算，不等就拒绝安装，错误里同时给出两个摘要并写明什么都没装。模型自己算摘要不削弱这一点——想装别的包它本来就可以直接提议，那正是审批要挡的；digest 挡住的是**批准之后掉包**。Attachment 分支不受影响：它由用户本回合上传的 attachment id 锚定，Sandbox 给了 `x-dataset-sha256` 时还会再校一次。校验在工具与 SkillManager 两处各做一遍——manager 是独立的 API 面，“没有 digest 的沙盒安装”在哪一面都不该存在。

### Fixed

- **A2A 官方流式调用现在会收到终态事件**: `message/stream` 与 `tasks/resubscribe` 在 `submitted` / `working` 之后就断流——没有 `status-update(final=true)`，也没有 Agent 最终正文；而 `tasks/get` 同时报 `completed` 并能读到完整回复。只依赖流式事件的官方客户端因此永远等不到终态，只能额外轮询 `tasks/get`。根因不在 SSE 传输层，而在事件词表对不上：A2A 投影器的 `RUN_STATUS_EVENT_TYPES` 列的是 `run.succeeded` / `run.status` / `run.terminal`，**这三个名字全仓没有任何一处发出过**；Run 服务实际写进账本的是 `plan.md` §事件词表里那一套——`applyRunTransitionInTxn` 默认 `run.status.changed`，成功终态是 `run.completed`。于是终态事件在投影时被整条丢掉，流跑到 Run 终态后静默返回。现有单测没能挡住，因为它们自己也用 `run.succeeded` 造数据。修复三处：投影器认下真实词表（`run.status.changed` / `run.completed`）；`run.status.changed` 这类**名字不含目标状态**的事件只认账本 payload 里的 `status`，绝不回落到「当前 Run 行状态」——那是分页时读到的，可能已经终态，会投出过早的 `final: true`；治理面写的 `{ context, data }` 形状 payload 也纳入状态提取。**同一根因还吞掉了 Agent 的最终正文**：`message.completed` 由 observability 投影器写成 `{ context, data }` 形状，`role` / `message` / `messageId` 都在 `data` 下面一层，而投影只看 `event.*` 与 `event.payload.*`——于是**没有任何一条 message.completed 投影得出来**，官方客户端从流里拿不到回复文本。这一条是重建容器后拿真实 Run 的事件日志回放才暴露的（单测 fixture 恰好用的是扁平形状）。现在两种形状都读，`user` / `toolResult` 回合仍然不投影为 agent 消息。另外，流在 Run 终态收尾时如果一个 `final: true` 帧都没发过，现在会按权威 Run 状态补发一帧终态 `status-update`（A2A 0.3 §3.1.2 要求任务生命周期流以 final 帧收尾），并且只有在事件页确实排空后才相信「Run 行已终态」这个信号——一整页事件可能还压着后续的终态事件。回归测试 `agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js` 用真实词表复现，并加了一条棘轮：`src/application` 里任何 `eventType: 'run.*'` 字面量若不在投影器词表内即失败。

- **Sandbox 出站调用全部有超时了**: AGENTS.md §2 要求「所有出站调用有超时」，但两侧 Sandbox 公共面客户端都漏了。Agent 侧 `sandbox-client.js` 的 `sbFetch` 默认 `timeoutMs = null`，公开面**没有一个方法**传超时——会话删除时的工作区 GC（`conversation-service`）、运维进程面的 logs/read/stdin/signal/cancel（`process-access-service`）、文件与 artifact 读取，全都能被一个挂起的 Sandbox 无限期钉住；`checkHealth()` 连 AbortSignal 都没有。BFF 侧同样：`routes/files.js` 三处字节代理（文件下载、artifact 下载、上传）与 `routes/datasets.js` 两处（上传、列表）都是裸 `fetch`，而同仓 `agent-client.js` 早有 `AbortSignal.timeout` 先例，config 注释也只豁免 SSE 流。现在两侧都有默认 deadline：控制面 30s（BFF 用既有的 `SANDBOX_REQUEST_TIMEOUT_MS`），字节流只约束「到响应头」这一段，拿到 header 后清掉定时器，大文件不会被拦腰截断；上传因为要先把 body 送上去，单独给一个宽松但有界的 10 分钟上限。BFF 超时映射为 504 `SANDBOX_TIMEOUT`，浏览器自己断开仍走调用方原本的错误，不会被误报成 Sandbox 超时。未新增环境变量。

- **流式 Run 不再被 trace 投影的乐观锁判失败**: 带 thinking/message delta 的长回答（数百到数千条事件）在工具和模型都成功后仍可能 `FAILED: trace span optimistic upsert did not converge`。根因是 append 事务在 InnoDB REPEATABLE READ 下用非锁定 `SELECT` 读 Run 根 span，再对 `attributes_json` + `updated_at` 做 CAS；`GET /runs/{id}/trace` 的 `materializeRunFacts` 不持有 `runs` 行锁，提交更新后 append 的 16 次重试仍读到同一份快照，几毫秒内耗尽。表现就是 8 月 23 日真实用户场景和 Run `01M0YZ6C0HZAQX1GGZ8CHAA9K5`：工具完成、回答写完，终态却是失败。事务内改为 `SELECT … FOR UPDATE`（锁定读看到最新行并串行化该 span 的写者）。投影 CAS 若仍 livelock，append **提交事件、不回滚**——事件是账本，trace 可由 `GET /trace` 重建；其它投影错误仍然随事务失败。

- **标题式 artifact 名不再丢后缀**: 上一条修好了「名字怎么送到浏览器」，但 `submit_artifact` 的 `name` 是模型给的**标题**——`随机 Markdown 文档` 本身就没有扩展名，后缀只活在 `relative_path`（`random-markdown.md`）里，于是三层都忠实地把一个没后缀的名字保留了下来，Markdown 存下来仍然打不开。顺带一提，注册时 `mimetypes.guess_type(display)` 同样猜不出类型，这条 artifact 的 `mime_type` 被记成 `application/octet-stream`。现在名字没有扩展名时从 stored path 借一个（`with_path_extension()`），public / internal / MCP 三个下载出口都传入 path；注册时的 mime 在 display 猜不出时回落到 `stored_path`。前端 `downloadAttrName(name, path)` 同样要改——`download` 属性一旦有值就**完全覆盖** `Content-Disposition`，只修服务端在走链接下载时看不到效果。名字自带的扩展名优先，两边都没有则保持原样。

- **`submit_artifact` 下载下来带原文件名和后缀**: 交付物点下载，保存成没有扩展名的 `artifact-download`，中文名（如 `季度报告.pptx`）尤其明显。两处叠在一起：前端所有下载链接写了空的 `download=""`，Chrome 因此忽略 `Content-Disposition`，改用 URL 最后一段 `/api/files/artifact-download`；BFF 在沙箱没带 disposition 时又退回 `filename="<artifactId>"`（ULID，同样没后缀），ASCII `filename=` 兜底也不保留 `.pptx` / `.md`。现在链接带真实 basename；`filename=` 对纯 CJK 名是 `download.pptx`（后缀还在），完整原名走 `filename*` 与 `X-Artifact-Filename`；BFF 转发沙箱 header，不再用 ULID 顶替。

- **模型选择按对话记住，不再全局串台**: Composer 的模型选择器是一份 `pi.selectedModelId`，切到另一个会话 picker 还停在上一个会话的模型，发出去的 `model_id` 也是那一个。现在按 `conversationId` 分槽（未保存的新对话单独一份 draft）；切会话时恢复该对话上次的选择，没有手动选过则用该对话最近一次 run 的 `model_id`。旧的全局 key 只迁到新对话 draft，不会覆盖已有会话。

- **`write` / `edit` 接受中文（及任何 Unicode）文件名**: `write` 到 `workspace/专项汇报.md` 返回 `FILES_WRITE_PAYLOAD_INVALID: path must be bounded visible ASCII`，`fetchCalls: 0`——请求根本没离开 Agent。根因在 Agent→Sandbox 的 HTTP transport：`normalizePath()` 复用了给协议标识符准备的 `requireVisibleAscii()`（`[\x21-\x7e]`），于是中日韩文件名、连带空格一起被拒。Sandbox 侧的 `_path()` 契约、request hash、Python 写入器、文件系统全都本来就接受 Unicode——只有这一层不接受。路径改为**按结构 + 字符黑名单**校验：仍然拒绝 NUL/控制字符、C1、零宽与 bidi 覆盖字符（`U+200B–200F`/`U+202A–202E`/`U+2066–2069`/`U+FEFF`，文件名伪装）、孤立代理对、反斜杠、`//`、`.`/`..`、workspace 前缀之外的路径，以及首尾带空白的路径段；长度同时按码元与 UTF-8 字节双向封顶 512（对齐 Sandbox 契约）。`toolCallId` / `expectedVersion` 继续走 ASCII——它们是协议标识符，不是用户数据。

- **长参数的工具在审批放行后不再让整个 Run FAILED**: 带审批的工具调用只要有任一参数字符串超过 512 字符，审批通过后的重放就抛 `tool_call_id replay conflicts with existing args integrity`，Run 直接 FAILED。根因不在完整性校验本身，而在**重放读错了地方**：ToolExecution 账本存的是完整性信封，`$integrity` 承诺的是**原始** args，`$payload` 却是 `redactPayload()` 脱敏后的视图——超过 `DEFAULT_MAX_STRING`（512）的字符串会被截断并补上 `_bytes`/`_sha256`/`_truncated` 兄弟字段。`resumeApprovedToolCall` 拿 `argumentsJson`（即 `$payload`）去重放，指纹自然对不上；更糟的是——**即使指纹对得上，被批准的工具也会用截断后的参数执行**（一个 600 字符的 `write` 会写出被截断的文件）。现在重放的权威来源是 Pi 会话里那条发出调用的 assistant 消息（`findToolCallArgumentsInSession`）；只有当账本视图的指纹可证明等于 `$integrity`（即短参数、脱敏无损）时才回退到账本；两者都不可用时以 `APPROVED_TOOL_ARGS_UNRECOVERABLE` 明确失败，而不是拿脱敏视图去执行。另外 `packJsonWithIntegrity` 超限时改抛稳定的 `ARGUMENT_TOO_LARGE`，让"存不下"与"脱敏截断导致的重放冲突"在日志里可区分。

- **官方 A2A 客户端可以建立流式连接**: 官方 a2a-python / a2a-js 客户端能取到 Agent Card 与 skill 列表，但 `message/stream` 报 `Expected response header Content-Type to contain 'text/event-stream', got 'application/json'`。根因是内容协商过严：`assertSendConfiguration()` 把**空的** `acceptedOutputModes` 判成 `CONTENT_TYPE_NOT_SUPPORTED`，而 a2a-python 的 `ClientConfig.accepted_output_modes` 默认就是空列表，且 `ClientFactory` 总会附上 `MessageSendConfiguration`；流式方法上的 JSON-RPC 错误以 `application/json` 返回，客户端便报成 SSE 协议错误。空列表现在按"无偏好"处理；同时接受 A2A 规范样例与 SDK 常用的短别名 `text` 与 `*/*`、`text/*` 通配。真正不支持的集合（如只要 `image/png`）与 push notification 配置仍然拒绝。仓库自带的 `StandardA2aClient` 模拟器此前从不发送 `configuration`，所以 110 条 A2A 用例全绿却漏掉了真实线格式——模拟器已改为按官方客户端的形状发送。

- **Run 进行中刷新不再丢失 assistant 正文**: Run 还在跑时刷新页面，气泡只剩 `Agent Execution Steps`，正文消失，且 Run 结束后也不会自己回来——要等用户再发一条消息，旧回答才重新出现并重新排序。根因在 `rehydrateConversation()`：Run 状态为 running/pending/queued 时**跳过**持久事件回放，完全依赖 SSE 重连；而工具账本无论如何都会回放，于是"有步骤、没回答"。刷新期间 Run 恰好结束（或 SSE 没及时恢复）时，重连已无增量可送，正文就永久缺席。现在**总是先回放 durable events，再连 SSE 取增量**——reducer 按 event id 去重，重复投递是安全的；`runtime_available === false` 分支里那次补偿性回放随之删除（不再需要，也避免二次回放）。

- **Skill 目录的 `ls`/`find`/`grep` 给出可操作的错误**: Agent 侧路径规范化放行 Skill 只读路径并把请求转给 Sandbox，但 Sandbox 的 `parse_sandbox_path()` 只认 workspace 与 `/tmp`，于是模型拿到的是 `PATH_INVALID` / "search request failed" 这种不知所云的结果。三层口径就此统一：注定被拒的请求不再发给 Sandbox，`ls`/`find`/`grep` 在 Agent 层就返回 `PATH_SKILL_SEARCH_UNSUPPORTED` 并点名该用哪个工具；`bash` 的既有拒绝理由也补上了同一句指引。企业系统提示此前写着「没有 skills 段时用 `ls` 看 `${skillRoot}`」——那正是第四层不一致。（本条最初把三层统一在“Skill 目录一律不可搜索”上；同一未发布区间内 `ls` 已被放开，最终口径见上面 Added 中的 `ls` 一条。）

- **图片分析不再让 Run FAILED（`Out of sort memory`）**: 上传图片做分析时 Run 失败，前端弹出 `select * from messages where agent_session_id = … order by sequence_no asc limit 500 - Out of sort memory…`。根因是 Pi journal 读取会 filesort：优化器为这条查询选了 `idx_messages_session_pi_kind (agent_session_id, pi_entry_kind, sequence_no)`，而查询过滤的是 `message_type`、从不约束中间那列 `pi_entry_kind`，索引因此给不出 `sequence_no` 顺序 → MySQL 退化成对整行（含 `content_json`）排序。平时无害（journal 行 1–3KB），但 `read` 内联图片上限是 `MAX_READ_IMAGE_BYTES = 2MiB`，base64 后单条 entry ≈ 2.7MB，一条就超过默认 256KB 的 `sort_buffer_size`，直接 ER_OUT_OF_SORTMEMORY。触发面很宽：`recover()` 在**每次 Run 启动**都读一遍，`persist()` 更是在写入那条图片 entry 之后**立刻回读**——失败即回滚，所以事后查库根本看不到那条大行（这一点很容易把排查带偏）。改为 `FORCE INDEX (idx_messages_session)`：`(agent_session_id, sequence_no)` 天生按 `sequence_no` 有序，排序整个消失，`LIMIT` 也能提前停止。同一份真实数据 A/B：旧查询 `ERROR 1038`，新查询正常返回 22 行；真机重跑此前失败的那轮图片分析，SUCCEEDED，且 journal 里确实留下了一条 2.015MB 的 entry。

- **依赖 `~/.config` 的应用可以在 Session 内保留配置**: Bubblewrap 的根是**每次执行新建的 tmpfs**，而持久绑定只有 workspace 与 `/tmp`，所以 `$HOME` 可写但每次工具调用都被重建为空——LibreOffice 之类的应用每次重建用户 profile，写进 `~/.config/libreoffice/4/user/basic/Standard/Module1.xba` 的宏在下一次调用中消失（已用真实 bwrap 复现：第一次写入、第二次读回得到 `GONE`）。现在 `~/.config`、`~/.cache`、`~/.local/share` 显式绑定到 `<session tmp>/.home/` 下的对应目录，并同步设置 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME`。放在 Session 自己的持久 `/tmp` 树里是刻意的：保留策略、配额与清理全部沿用 `/tmp` 既有的那一套（随 Session 私有、随 Session 清理），不新增第四个存储根，也天然不跨租户共享。用真实 bwrap 验证：同一 Session 两次独立执行之间配置 `PERSISTED`，workspace 与 `/tmp` 行为不变。

- **上传 Skill 后 bash / python 全部失效（P1）**: 通过前端按钮上传 `skill.zip` 后，同一会话里 `bash`、`python` 连 `pwd` 都失败，报 `bwrap: Can't find source path /home/sandbox/skill-user/<org>/<user>`；只有 `read`/`write`/`ls`/`find`/`grep` 还能用（它们不经过 bwrap）。根因是 **Node 的 `fs.mkdir` 会把 `mode` 施加到递归创建的每一级目录**：安装流程第一步是 `mkdir('<base>/<org>/<user>/.tmp-install-<token>', { recursive: true, mode: 0o700 })`，首次为某用户安装时 `<org>` 与 `<user>` 尚不存在，于是这两级也被打成 `0700`、属主是 Agent 的 `node`(uid 1000)。而这两级正是 Bubblewrap 用户 Skill 层的 **bind source**，Sandbox 以 uid 10001 解析它 → `realpath()` 返回 **EACCES**；`--ro-bind-try` 只宽容 `ENOENT`，不宽容 `EACCES`，于是 bwrap 直接死掉，把该用户的每一次沙盒启动一起带走，且**持续到目录权限被修复为止**。现在安装与生成两条路径都先 `ensureTraversableUserSkillRoot()` 建好 `0755` 的身份目录再建私有 staging，并顺带修复已被打坏的目录（用户下一次安装即自愈）。`0755` 不是放松：这条路径上其它目录本来就是 `0755`，租户隔离靠的是"只把调用者自己的 `<org>/<user>` bind 进命名空间"，从来不是这两位权限位。

- **一个用户的 Skill 根坏掉不再连累 bash/python**: 承上，Sandbox 侧加了纵深防御——bind 之前先 `stat()` 探测 user skill 源，`ENOENT`（没装过）与其它 `OSError`（不可遍历）都降级为"只挂系统层"并记一条 warning，而不是把一个注定失败的路径交给 bwrap。丢掉一个用户的 Skill 永远不应该等于丢掉他的全部工具。

- **缺失的系统 Skill 根不再表现为「bash 坏了」**: 系统 Skill 层是硬 `--ro-bind`（有意为之：缺失即部署故障，应当大声失败），但 `skills_root.resolve()` 不做存在性检查，缺失时要等 bwrap 启动才报 `bwrap: can't find source path …`——表现是 `pwd`、`bash`、`python` 一起失败、Run FAILED，完全看不出是挂载问题。改为启动前检查并抛出点名路径与 `SKILLS_ROOT` 挂载的错误。用户 Skill 层本就是 `--ro-bind-try`（没装过 Skill 是正常状态），保持不变。

### Removed

- **两侧死代码清理（2026-08-26 专项审查落地）**: 都经过全仓 grep 逐条确认后才删，运行路径为零。Agent：`sandbox-client.js` 余下 16 个模块级封装（`authRegister`/`authLogin`/`authMe`/`readFile`/`writeFile`/`listFiles`/`lsFiles`/`findFiles`/`grepFiles`/`downloadFileStream`/`downloadArtifactStream`/`submitArtifact`/`listArtifacts`/`removeSessionWorkspace`/`artifactDownloadPath`/`ensureTraceId`）——全仓唯一的静态 import 只取 `createSandboxClient`，`checkHealth` 是唯一还有调用方的模块级导出（`http-main.js` 动态 import 作 `/health` 探针），其余指向已退役路由，`ensureTraceId` 更是引用了本文件根本没 import 的 `randomUUID`（调用即 `ReferenceError`）；`skills/install.js` 的 `_testHelpers`（连测试都不用）。Frontend：`api/client.ts` 的 `createConversation`（零调用）与两条转出口 `readSSEStream` / `isAllowedApiUrl,safeApiUrl`（生产与测试一律直接从 `sse/parser`、`security/url` 导入）、`entities/store.ts` 的 `getRun` 选择器（外部一律用 `api/runs.ts` 的同名函数）、`Composer.tsx` 末尾那条「for tests」的转出口（测试实际从 `shared/state` 导入）；`schemas/api.ts` 的转出口桶只留下生产真正经它导入的 `ConversationEventsResponseSchema` 及其类型。Sandbox：14 处未用 import，以及 `safe_env.py` 的 `sanitize_for_log`——它只把「password」「token」这类**键名**替换成 `***`，对真实值不做任何事，唯一的引用是 `audit_logger.py` 一条同样没用上的 import，留着比删掉更危险。`artifact/infrastructure/manager.py` 的四个 disposition 名与 `formal_artifact_runtime.py` 的 `workspace_manager` 看着也像未用 import，但前者经 `services/artifact_manager.py` 星号垫片被测试消费、后者被测试按字符串路径 monkeypatch，两处都补了注释说明为何保留。
- **`config/agent/settings.json`**: 与已删的 `models.json` 同类的遗留文件。pi SDK 确实会自动发现 `settings.json`，但它找的是 agent home（`AGENT_PI_AGENT_DIR`，容器里是 `/app/pi-agent-home`），而 `config/agent` 挂在 `/app/config/agent`——那个目录里只有 `TOOL_RISK_POLICY_PATH` 指向的 `tool-risk.json` 和 `model-registry.json` 被真正读取。文件里声明的扩展名 `enterprise-sandbox` 在 agent 扩展注册表里也不存在。
- **Agent `sandbox-client.js`里指向已下线路由的死方法**: 该 client 是 owner-scoped 公共面封装（模型自己的工具调用不走这里，走签名内部面 `sandbox-bridge-http-transport.js`）。Sandbox 早已撤掉自己的 session 创建、conversation、临时执行与审批面，但对应方法一直留着——调用即 404：`createSession` / `getSession`（`POST /sessions`、`GET /sessions/{id}`）、整个 `/conversations/*` 六个方法、`executeCommand`（`/sessions/{id}/executions/command`）、`getExecutionLogs` / `listExecutionEvents`、以及 `createApproval` / `approvalCheck` / `getApproval` / `decideApproval`（`/approvals`、`/approve`）。更糟的是一批模块级封装：`startProcess` / `getProcess` / `waitProcess` / `cancelExecution` / `cancelActiveExecution` / `cancelSessionProcesses` / `readFileWithRange` 委托的 client 方法**根本不存在**（`TypeError`），而 `getProcessLogs` / `writeProcessStdin` / `signalProcess` / `cancelProcess` 四个模块级封装**参数错位**——把 `processId` 当成 `sessionId` 传进去。全部删除，共 -223 行；随之删掉只为 `executeCommand` 存在的 `timeoutForSeconds` / `REQUEST_GRACE_MS` 及其单测。留下的每个方法都对得上 `/openapi.json` 里仍在服务的路由，文件头补上了这条规则。`api-server` 那份同名 client 已经是干净的，未改动。
- **`config/agent/models.json`**: 与 `model-registry.json` 重复的第二份模型目录，全仓库零引用——不被任何代码读取，也不在 pi SDK 查找 `models.json` 的 `AGENT_PI_AGENT_DIR` 下（容器里 `/app/pi-agent-home/` 是空的）。留着只会继续和真实目录漂移。
- **`disabled-test-model` 与 `ZERO_PRICING`**: 前者是只为测试存在却出货在生产 seed 里的假模型，已移进测试自己的 fixture；后者随之失去全部引用（`normalizeModelEntry` 本就把各价格字段内联默认为 0）。

### Changed

- **模型目录对齐真实网关**: registry 此前列的 `gpt-5.5` / `mimo-v2.5` / `mimo-v2.5-pro` / `gemini-3.5-flash` 在实际 LLMIO 网关上都不存在——选中即失败（`mimo-v2.5` 报 "supported API model names are…"，`gpt-5.5` 更早地因 `supports_developer_role: true` 报 `unknown variant 'developer'`）。现在只保留网关真正提供的三个：`deepseek-v4-flash`（默认）、`deepseek-v4-pro`、新增的 `deepseek-v4-flash-vision-exp`（唯一支持图片输入的 id，这也是上面 read 图片能力在本部署里唯一可用的模型）。

  两处都要改才生效：`buildRegistry` 是「源码 seed + 文件」合并，文件只增不减，所以只清 `config/agent/model-registry.json` 会让删掉的模型继续从 `SEED_MODELS` 暴露出来。

- **模型注册表测试改用自带 fixture**: 「registry 是数据驱动而非硬编码」这类机制测试原本依赖 `SEED_MODELS` 里恰好存在的 gemini/gpt 作对照，导致改动出货目录就会打断无关测试。现在用测试文件内的 `FIXTURE_MODELS`，出货目录另有一条断言单独覆盖。

- **一轮 Run 合并为一个助手气泡（前端）**: 同一 Run 的相邻 assistant 行在投影末尾合并成一条消息。此前「出文本 → 调工具 → 再出文本」的一轮会摊成一叠各自带头像和「UPRC Agent」抬头的碎片，读起来像好几个人在说话。身份字段取首行（React key 与回合起始时间稳定），存活状态取末行。步骤树随之挂到该 Run 的**第一个**气泡并渲染在正文之前，**默认折叠**——它在回合顶端，展开会把回答本身顶到屏幕外；折叠态摘要行仍显示步骤数与耗时。

- **`task-state` 默认装载**: `defaultAgentConfigJson()` 发的是 `extensions: []`，而空列表只选必需的四个 + `skill-lifecycle`，所以 `todo_write` / `todo_read` 从来没有真正到过模型手上——表现就是「Agent 不会拆解多步任务」，每一轮都从 transcript 重新推导计划，compaction 之后彻底丢失。现在与 `skill-lifecycle` 同规则：store 就绪且 AgentVersion 未显式列出 extensions 时自动装载。显式列表仍然权威（`pi-runtime-factory` 精确校验 factory 列表，静默追加会把合法 AgentVersion 变成 `PI_EXTENSIONS_COUNT` 错误），因此显式列表也是关闭它的方式。

- **纯文本模型收到图片不再让 Run 失败**: 此前给不支持 vision 的模型附图会直接 `FAILED: does not support image input`，把用户打的字连同图片一起丢掉。现在丢弃图片并在 prompt 里告知模型（文件名、原因、附件仍可当文件读），对齐 Pi 原生 read 对非 vision 模型的降级提示。`read` 读到的图片同理：不支持 vision 时只回文本注记，绝不把图片字节送给收不下的 provider。

- **代码与文档整理**: 删除未接入的 TypeScript contracts 包、历史 approval waiter 与 Sandbox 中未使用的 Agent/审批 DTO；跨语言 golden fixture 统一到 `tests/fixtures/contracts/`，开发与 SDK 升级文档按当前 `src/` 布局和持久化模型修订。
- **Run 与对话投影**: Run 列表/详情补充模型、token usage、规范化生命周期时间及最新 durable event ID；对话历史保留 durable message ID、Run ID 与顺序，且只显示当前用户回合而非整个历史 prompt。
- **运行管理界面**: 按 Agent 的权威状态过滤 Run，支持 `WAITING_INPUT`，并兼容 `completed_at` 与历史 `finished_at` 字段。
- **Artifact 下载**: 对非 ASCII 文件名使用 RFC 5987 `filename*`，同时提供 ASCII fallback，避免下载响应因 HTTP header 编码失败。
- **必需 Extension 增至四个**: `user-interaction` 从 `enterprise-policy` 拆出并成为必需，`ask_user` 由它注册；`enterprise-policy` 回归纯拦截器，不再注册任何工具。仅给出旧的三个名字仍可用，隐含启用 `user-interaction`。
- **Sandbox 公共执行路由删除**: `POST /sessions/{id}/executions/*` 及 Sandbox 侧的 `/approvals`、`/conversations` 全部移除。执行只存在于 `/internal/v1/*` HMAC 平面；审批与 Conversation 的唯一权威是 Agent MySQL。
- **Sandbox 网络**: 开发态给出 egress，生产 overlay 明确剥离。
- **Web UI**: 会话恢复与 Run 生命周期同步；模型选择器改版。
- **行数闸门**: `HOTSPOT_LINE_BUDGETS` 改为钉在各文件当前长度——只能缩不能涨。六个超限文件按职责拆分，闸门自 2026-07-31 以来首次转绿。
- **CI**: 修正 Agent syntax-check 指向的失效路径 `agent/testing/fake-openai-provider.js`（实际位于 `agent/tests/support/`），该 job 因此长期失败。

### Removed

- ADR 0002 / 0003（2026-07-19，`7370220d`）——内容已被 `plan.md` 取代，编号不再复用。

### Fixed

- **输入法组合期回车误发送**：Composer 的回车提交未检查 `isComposing`，中文/日文输入法按回车确认候选词会把拼音原文直接发出去。现在组合期间的 Enter 不再触发提交（`isEnterSubmitKey` 纯函数 + 回归测试）。
- **Ctrl+U 上传快捷键空头支票**：上传按钮文案宣称支持 Ctrl+U，但全局 keydown 里该分支只有注释没有实现。现在由 Composer 旁的监听器真正打开文件选择器（与按钮同一运行中禁用门控），且 `Ctrl/Cmd+L`（新建会话）在 macOS 上也能通过 Cmd 触发；快捷键在输入法组合期间同样不触发。
- **消息日志 aria-live 刷屏**：流式输出时每个 SSE token 都进入整段 transcript 的 live region，读屏软件被逐 token 重读。MessageList 改为显式 `aria-live="off"`——`role="log"` 隐式就是 polite live region，只删显式属性并不会让它安静下来。Run 状态播报继续走 FlashZone 的 `role="status"`。

## [4.0.0] — 2026-07-04

### Added

- **三容器架构 (v4)**: 前端 (Nginx + SPA) + API Server (Node.js + pi-coding-agent) + Sandbox (Python FastAPI)，前端零 Agent，LLM Key 仅存服务端

### Changed

- **文档全面重写**: README.md、docs/architecture.md、docs/deployment.md、docs/development.md、docs/api.md、docs/webui.md 全部基于实际代码重写
- **端口规范化**: 统一 host→container 端口标注格式，修正所有文档中的端口不一致问题
- **API 文档**: 补全三层 API（Frontend → API Server → Sandbox），新增 Conversations、Approvals、Traces、MCP 端点文档，补充 SSE 事件协议完整列表
- **部署文档**: 更新架构图和端口，标注 docker-compose.prod.yml 服务名不匹配问题

### Removed

- **旧设计文档移除**: 早期 system-design 草稿不再保留；以 `plan.md` 与活跃 `docs/*` 为准

## [0.2.0] — 2026-07-03

### Added

- **Frontend/Backend Separation**: Modularized monolithic `server.js` into 9 focused modules (`config.js`, `services/sandbox-client.js`, `services/conversation-manager.js`, `services/agent-factory.js`, `routes/status.js`, `routes/conversations.js`, `routes/chat.js`, `routes/static.js`)
- **WebUI Frontend Modules**: Split monolithic `app.js` into ES modules (`js/api.js`, `js/utils.js`, `js/chat.js`, `js/conversations.js`, `js/app.js`)
- **Light Theme**: Added toggleable light theme via `[data-theme="light"]` CSS
- **Code Copy Button**: One-click copy for code blocks in chat messages
- **Collapsible Tool Calls**: Tool execution indicators are now expandable to show arguments
- **Skeleton Loading**: Loading state animations for better UX during initialization
- **Comprehensive Documentation**: Added `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/` directory with architecture, API, deployment, development, and WebUI guides
- **WebUI Test Suite**: Added tests for the WebUI server API (`tests/test_webui_api.py`)
- **Configuration Tests**: Added tests for config defaults and version consistency
- **Entrypoint Tests**: Added tests for the sandbox entrypoint parameter handling

### Changed

- **README.md**: Completely rewritten with detailed architecture, quick start, configuration reference, and project roadmap
- **webui/index.html**: Updated to load ES modules, added theme-color meta tag
- **webui/style.css**: Enhanced with light theme variables, copy button styles, collapsible tool styles, skeleton animations
- **webui/server.js**: Now a thin entry point that delegates to route modules

### Fixed

- **首个管理员无法创建**：注册忽略客户端提供的 role/organization_id（正确），而 `BFF_DEV_ACTING_ROLE` 只在关闭鉴权时生效，导致任何真实部署上 `/api/a2a/config` 等管理员面不可达。新增 `SANDBOX_AUTH_ADMIN_USERNAMES`：名单内用户名注册即晋升 admin。
- **进程控制、取消与上传错误路径**：QA 发现的六处缺陷修复（admin bootstrap、process control、cancel 与 upload 错误处理）。
- **Agent `/internal/*` 平面在 token 未配置时无鉴权**：这些路由直接信任 `X-Acting-*` 头，能触达端口即能冒充任意用户。现在空 token 直接关闭内部平面；无鉴权运行必须显式设置 `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL=true`，生产配置校验拒绝该选项，启动日志明示当前模式；token 比较改为常量时间。
- **api-server 与 agent 容器以 root 运行**：两个 Dockerfile 现在在移交写入路径后降权到基础镜像的 `node` 用户。存量部署注意：`agent_user_skills` 卷是以 root 创建的，需重建或 chown 一次。
- **BFF 全部出站调用无超时**：上游接受连接但不响应时会无限悬挂并钉死浏览器请求与 socket。Agent 调用现受 `AGENT_REQUEST_TIMEOUT_MS`（默认 15s）约束，Sandbox 调用受 `SANDBOX_REQUEST_TIMEOUT_MS`（默认 15s）约束。
- **Sandbox JWT 密钥 fail-open**：`auth_enabled=true` 但未配置密钥时回退到公开默认值，可伪造任意身份 token。现在缺失即启动失败（fail-closed）。


## [0.1.0] — 2026-06-28

### Added

- Sandbox Service with Session/Workspace/Execution management
- ToolPolicyChecker (low/medium/high risk levels)
- Path escape protection
- Non-root execution + safe_env
- stdout/stderr preview limits
- Serial execution per session
- Resource limits (timeout, output size)
- File API (read/write/list/preview/download)
- Artifact API (register/list/download)
- Audit logging
- Prometheus metrics
- Health / Readiness checks
- MCP Server Adapter
- Docker multi-stage build
- EnterpriseToolAdapter with policy pre-check
- SandboxClient SDK
- Pi Extension (TypeScript)
- Approval workflow for high-risk tools
- Trace ID middleware
- SQLite persistence (WAL mode)
- Session restore via enterprise_session_id
- Built-in Skills (document-parser, data-analysis, sql-query)
- WebUI chat interface with SSE streaming
