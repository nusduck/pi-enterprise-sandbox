# 全功能回归测试案例

> 2026-09-19 设计修订；分支 `refactor/updrdb-dbpm`，HEAD `480bf65d5bae8bf674599755e7469991c2ac0c38`，并核对本轮开始时已有的未提交改动（含 readiness、MCP 发现、Worker drain）。它们是静态设计依据，尚无本轮运行证据。§1–§3 为当前待执行案例，**全部从未执行开始，只使用 `deepseek-flash`**；§4–§9 原样保留历史记录，旧模型与旧“通过”不继承。

## 1. 判定规则

每条案例包含前置/数据、用户任务或操作、可核验结果。数据包 R/W/V/U/X/S、测试账号、独立验算、四类办公件与证据要求见 [data-and-oracles.md](data-and-oracles.md)。功能与源码对应见 [coverage.md](coverage.md)，TypeSafe 选例方法与实际取舍见 [case-selection.md](case-selection.md)。本轮只更新测试设计，不执行产品回归、不创建实际账号、不修改生产代码。

- **通过**：所有适用子断言均有本轮证据，业务结果与平台账本都正确。
- **部分通过**：仅部分子断言成立；逐项列出未通过范围。
- **失败**：实际执行违反断言，包括内容算错、假交付、已存在功能不可用、未实现必需保护。
- **阻塞**：缺账号、真实模型/MCP、来源资料、故障环境或必要操作授权；说明具体依赖。
- **未执行**：没有实际操作。读代码/旧报告/模拟测试不等于执行。

自然语言任务不规定唯一措辞或内部工具顺序，但必须产生可核验结果。若专测某工具/Skill，可补充明确要求调用该工具；未触发便记该子断言未执行，不能靠模型声称调用过判通过。禁止修改产品源码、手写 SSE/Run 终态、注入预制模型回复使案例变绿。

**模型硬约束**：聊天、Regenerate、Follow-up、子 Agent、Cron、A2A 和所有辅助模型调用均限定 `deepseek-flash`，不自动切换其它模型。执行前核对注册表、各测试 Agent 活跃/绑定版本、Worker 默认配置及所有请求入口；以脱敏的最终上游请求 `model` 和 Run 关联记录验证，界面标签不足以证明。旧测试 Agent 若固定其它模型，新建 flash 版本及会话，不改历史绑定。不可用时记阻塞；错误模型 ID 只做预览/校验拒绝测试，不发起其它模型推理。能力由本轮注册表与实际响应共同确认：当前源码 seed 声明 text/image、无 reasoning；图片正向仍须实测，思考参数测明确拒绝，不伪造支持能力。

**完整性与退出标准**：逐案例的 a/b/c、格式、身份、入口、状态分别记执行行。P0/P1/P2 都属于全量范围，不能只挑高优先级或“容易通过”的部分；每个已部署页面、工具、路由族、权限边界都须有映射。没有 UI 的协议/部署分支使用真实客户端或隔离环境操作。仅当全部适用断言有本轮证据且通过，才报告“本配置全量通过”；失败、部分通过、阻塞、未执行任一存在就报告缺口。明确不适用的能力另列原因（如 flash 无 reasoning），不偷换成已通过，也不声称多模型兼容或目标 UPDRDB 环境已验收。

以本轮前缀和资源 ID 列表限定操作范围；测试资源的创建、回答、批准无害操作、取消与删除按整轮授权执行。全局角色名单、模型配置、服务重启、共享资源清理在专用环境或明确授权范围内执行。绝不清空共享数据库取巧。所有凭据走安全输入，不写进提示、文件、截图、日志和报告。

已核实的当前边界：

- 模型工具以 `agent/src/runtime/policy/tool-names.ts` 为准；Python 经 `bash`，后台进程经 `bash` + `job_*`，不用退役的 `process_start`/`memory_*`/`skill_create`。
- 多 Agent 选择只在新会话时生效；已建会话及其版本绑定不因管理员切版本而改变。
- Skill 安装入口为 Capabilities 的 Drafts，聊天输入框旧拼图按钮已删除；启用后草稿字节保留但在 Drafts 隐藏，Disable 后重新出现。
- Artifact 当前启动路径注入 `MySqlArtifactStore`（`exec/src/http/app.ts`）；不能继续把历史“仅内存索引”当现状。重启后的可用性仍须 ART-03 实测。
- `exec/src/main.ts` 已在监听前调用 orphan recovery；REC-02 必须检查持久化作业终态及并发额度，不能只检查容器里没有进程。
- Agent 配置已通过 `agent-config-validator.ts` → `agent-version-bindings.ts` → `runtime-factory.ts` 接入 prompt、模型输出上限、工具授权/风险和 MCP 工具子集。`thinkingLevel` 有执行接线，但 flash 当前未声明支持；`temperature` 当前不支持。`skills/extensions/sandboxPolicy/a2a` 为保留只读面，未知字段（包括新 schema 的 `contextPolicy`）须诊断。`mcpServers` 是从进程 MCP 清单中授权工具，不能注入新 server/凭据；不能再写成“改 Agent 配置毫无影响”。
- 本分支启动只核验 schema，不自动迁移；口令来自 DBPM；replay Redis 已退役。HMAC 当前不做 jti 去重，SEC-04 分开检查签名绑定、执行幂等和 fence，不能虚构旧 nonce 存储。
- K8s 应用层 uid 为 1000（包括 slim `sandbox-mcp`），sandbox 执行面为 10001；facade 与执行面是同 Dockerfile 的不同 target/镜像。共享 Skill 按持久账本与摘要发布版本，不按目录扫描猜启用状态。

## 2. 执行顺序与业务旅程

全量包括管理员与普通用户；上一轮“不测 admin”的历史范围不适用于本清单。可以自建本轮专用用户，账号清单见数据文档 §5。准备 admin-A、普通用户 A/B 的独立浏览器身份，以及第二组织 user-C/admin-C；当前公开注册落 `org_bootstrap`，注册两人只证明同组织不同 owner 隔离，不能充当跨组织证据。缺第二组织合法预置渠道只阻塞对应子案例，不阻塞普通用户主线。

| 旅程 | 真实用户任务与最终产物 | 依赖与主要案例 |
|---|---|---|
| J1 新同事接手项目 | 阅读真实项目资料，弄清职责、定位文档冲突，得到可引用的交接说明 | ENV/AUTH → CHAT-01/02 → TOOL-01/02 → DOC-01 → TOOL-03b/c → ART-01 |
| J2 分析人员准备区域简报 | 用官方数据做口径澄清、清洗、趋势计算，交付可复算 Excel 和管理层简报 | DATA-01 → INPUT-01/02 → TOOL-03a/d → TOOL-04 → ART-01/02 |
| J3 用户复用日常工作方法 | 把公开数据清洗规则写成 Skill，审核启用，处理另一批年份，再更新/停用 | SKILL-02/03 → SKILL-01/04 → CRON-01/02/03 |
| J4 用户处理中途变化 | 生成较长报告时补充要求、切会话、关页、停止错误任务，再恢复工作 | CHAT-03/05/06 → RUN-01/02 → PROC-01/JOB-01 → REC-01/02/03 |
| J5 管理员维护组织助手 | 创建分析/交接助手，发布新版本、暂存版本、回滚，用户新旧会话各自稳定 | AGENT-01/02/03/04 → USER-01/02 → SEC-01/02 |
| J6 外部系统交付 | 真实 MCP 查询来源；低代码客户端复用 workspace 并下载报告；A2A 请求可追踪和取消 | MCP-01/02/03/04 → A2A-01/02/03 → ART-01 |
| J7 运维与边界 | 查审批和日志、恢复中断、验证大附件与权限隔离，清理专用测试资源 | MGMT/TRACE/CAP → FAIL/LOAD/ISO/SEC → CLEAN-01 |
| J8 财务与项目协作 | 用明确标注的合成订单做月度对账，将合成会议纪要整理成待办与周报，再修订交付 | BIZ-01/02 → INPUT → TOOL-03 → ART-02；使用 S，不依赖用户提供私有资料 |
| J9 当前分支部署验收 | 新用户并发首用、连续追问、跨 Pod Skill、DBPM/Proxy/队列与 Worker 维护后继续原工作 | AUTH-04、CHAT-07、AGENT-05/06/07、SKILL-06、SUB-02、MCP-05、DEPLOY-01～08 |

优先级不是跳过许可：P0 为主闭环与安全/恢复底线，P1 为日常完整使用与管理，P2 为深度边界和可用性。先完成 ENV、账号与数据准备；故障/容量测试最后在专用环境执行，结束后重跑普通用户“登录→上传→工具→Artifact 下载→跨租户拒绝”闭环。

## 3. 详细测试案例

### ENV-01：当前镜像与真实依赖（P0）

**前置**：专用 OrbStack K8s（应用层）+ Compose（依赖/exec）或纯 Compose 栈，已配置真实 `deepseek-flash`，记录 commit、dirty 文件、runtime 版本和部署模式。

**操作**：a. 按仓库规范构建 `agent agent-worker api-server sandbox sandbox-mcp frontend`；更新所有消费者，K8s 按 `scripts/dev/k8s/up.sh dev` 的滚动流程核对实际 imageID，VM 另记安装 release；b. 查 schema 发布/校验、Worker、MySQL/UPDRDB、服务 Redis、DBPM 与共享 Skill 存储；确认没有两组 Compose/K8s Worker 同消费；c. 请求 BFF live/ready 与各服务探针，核对 fake LLM/stub executor 关闭，最终模型 ID 为 flash，MCP 注册与真实调用就绪；d. 依赖故障详见 DEPLOY-01。

**验收**：健康与镜像可追溯；依赖不可用时明确 degraded/503 或拒绝启动，不伪健康。Compose up 本身、旧镜像、只有 HTTP 200 都不足以通过。

### ENV-02：首次打开与依赖故障提示（P0）

**操作**：a. 未登录打开入口，等待恢复流程结束；b. 登录后访问 Chat、Schedules、Settings；c. 浏览器暂时离线/后端不可达后再恢复。

**验收**：没有持续空白页/加载圈；未登录与接口故障提示可区分；恢复后能继续已有会话。记录浏览器错误摘要，排除扩展自身噪音。

### AUTH-01：已有用户上下班登录（P0）

**操作**：a. admin 与普通用户分别登录、刷新、关页重开；b. 错误密码一次；c. 登出后后退/打开旧会话直链并请求受保护 API，再重新登录。

**验收**：服务端角色正确、各自历史恢复；错误登录不建立身份，登出后旧页面不能继续读取数据；JWT 只在 HttpOnly Cookie，前端 JS 不拿到明文。

### AUTH-02：首次部署注册与角色防伪（P0）

**前置**：空库分支仅在独立栈；现有 admin 不删除。

**操作**：a. 名单内注册 admin、名单外注册普通用户；b. 注册请求额外提交 `role=admin`、他人 `organization_id`；c. 独立环境分别关闭公开注册、移入/移出管理员名单后重新登录/请求 me。

**验收**：名单决定角色，自报角色/组织不能提升；关闭注册被拒；名单变更按服务端规则升降级。空库和角色变更分支未跑需分别记录，不能用普通注册替代。

### AUTH-03：普通用户第一次使用（P0）

**任务**：新注册用户用 R 的一段服务说明提问“我遇到上传失败，应该先查哪个服务？”

**操作**：注册后立即刷新，进入 Capabilities/Runs/Approvals，发问；登出再登录读取这次会话。

**验收**：初始 me 的未认证响应不变成持久错误；组织映射不报 400；第一轮成功并保留历史，答案有所给资料依据。

### NAV-01：日常导航与外链（P0）

**操作**：a. 普通用户在 Chat/Schedules/Settings 的各子页间切换；b. 打开旧 `/runs`、`/approvals` 路径；c. admin 访问 Agents 与 A2A，再切普通身份。

**验收**：旧链接跳到对应 Settings 页；二级导航、当前选中和待处理角标一致；普通用户无管理员管理入口，直链也受保护；Composer 不出现退役 Skill 安装按钮。

### CHAT-01：理解真实资料的首轮对话（P0）

**任务**：粘贴 R 的服务边界说明：“我要交接这个系统，请按用户上传、Agent 执行、下载报告的顺序解释职责，并标出这段资料没说明的部分。”

**操作**：新建会话发送，不要求工具；观察流式正文、标题、Run，刷新再看。

**验收**：服务职责与原文一致，不杜撰部署已验证；一个用户消息对应本轮 Run，流式文本不重复、不丢尾句，刷新后内容与终态一致。

### CHAT-02：追问、纠错与重新生成（P0）

**任务**：基于 CHAT-01 先要求技术说明，再改为“给新同事看的 5 点清单，保留故障归属”；终态后点击 Regenerate。

**验收**：回答继承真实资料并采用新要求；重新生成有可追踪 Run，不重复插入用户消息；刷新后顺序与页面一致。缺资料时说明限制，不把先前猜测当新事实。

### CHAT-03：两个助手与会话固定使用 flash（P0）

**前置**：分析助手与交接助手都固定 `modelPolicy.modelId=deepseek-flash`；只需一个可用模型。

**操作**：A 会话做 R 交接，B 做 W 分析；往返、刷新、Regenerate 并继续各一轮；保存新 Agent 版本后回旧会话追问；对试图覆盖固定模型的请求先验证服务端拒绝，不放行其它模型到上游。

**验收**：两会话职责、附件和版本绑定不互串，所有实际请求都是 `deepseek-flash`；固定模型不能被旧 UI/请求参数绕过。单模型的绑定/策略覆盖不等于验证了双模型切换，后者不在本轮模型范围内。

### CHAT-04：删除试用会话（P0）

**前置**：只删除本轮专用会话，已记录资源证据。

**操作**：a. 点删除后取消确认；b. 再确认删除；c. 刷新列表、访问旧详情/API；d. 删除当前选中和非当前选中会话分别执行。

**验收**：取消不删；确认后正确移除、空态可新建；旧直链不可读取；其它会话与他人资源不受影响。不可把 UI 删除推导为所有文件/快照已物理擦除。

### CHAT-05：两项工作并行切换（P0）

**任务**：A 分析 R 提交记录生成周报，运行时切 B 解读 W 指标，然后返回 A。

**验收**：A 不因切换而取消；后台角标、输出和完成通知归属正确；B 不收到 A 的片段；两份结果均能通过独立核验。

### CHAT-06：离开电脑后回来（P0）

**操作**：在真实文件任务运行中分别 a. 刷新；b. 关闭标签再打开；c. 断网使 SSE 断开后重连，并恢复到同一会话。

**验收**：Worker 继续工作；消息/工具/产物与终态补齐，无重复副作用、永久 Running 或断线即取消。三种分支单独记证据，不能互相替代。

### TOOL-01：接手资料目录并修订说明（P0）

**前置**：R 已上传到专用 workspace。

**任务**：“找出会话和 workspace 映射相关文件，列出来源，解释 Artifact 导入经过哪几层；把结论写到中文命名的交接说明，再把‘已验证’改成‘待验证’。”

**验收**：实际覆盖 `glob`/`grep`/`read`/`write`/`edit`/`bash`；命中与冻结源码一致；中文、空格、多级路径正确；不在其它文件替换、不改源包；不存在的关键词有明确空结果，read/write 不自动生成交付物卡。

### TOOL-02：上传工作资料并让模型使用（P0）

**操作**：a. 在空会话上传 R 文档与 W CSV，发送前移除一份再补回；b. 在已有会话追加附件；c. 上传两份同名但不同内容的 X 副本；d. 切会话、刷新并列出 Dataset。

**任务**：“先说明每个附件的用途和数据范围，再按来源汇总；不要把两个版本混在一起。”

**验收**：上传字节 hash 与源一致，Dataset/会话归属正确，移除的草稿附件不被本次发送引用；同名文件不静默覆盖；模型读取实际内容、行数/列名正确。仅 Ready 不足以通过。

### TOOL-03：真实办公交付全矩阵（P0）

**前置**：W 与 R 独立验算完成；逐一检查当前 `xlsx/docx/pdf/pptx` Skill。

**任务/子案例**：a. 用 W 做含原始数据、公式、趋势图的 Excel；b. 用 R 写新同事交接 Word，区分事实/待验证项；c. 把核准 Word 转成可发阅 PDF；d. 用 W 做管理层汇报 PPT，说明来源、口径与局限。

**验收**：四个格式分别真实加载对应 Skill、生成、提交、下载；按 [办公件规则](data-and-oracles.md) 打开/渲染、验算与修订。四种均需可用，bash fallback 或任意两种成功不能将整条标绿。

### TOOL-04：中文资料、Python 与真实图片（P0）

**任务**：a. 用 bash 执行多行 Python 核对 W 行数/缺失并生成中文文件名结果；b. 粘贴 V 趋势图，解释国家、年份、单位与变化；c. 上传实际 UI 截图让 flash 定位错误提示；d. 使用模糊/损坏副本；核对部署 flash 的 image 能力声明与实际输入链路。

**验收**：Python 真实执行且结果可复算，`read_image`/附件视觉分支分别记录；图表解读与底层值一致；看不清时承认不确定，不能编数。能力未开放时记录该分支阻塞及用户提示；已声明支持却失败则记缺陷，均不得换模型掩盖。

### DATA-01：官方数据清洗与可复算分析（P0）

**任务**：“用上传的 W 数据比较三国 2019–2023 年人口与现价美元 GDP 变化。先检查重复、缺失和单位，再生成年度变化表；不把它当真实增速或市场规模。”

**操作**：跑官方原版，再跑明确标为 X 的重复行/缺失值副本；有 U 时追加订单退款对账子案例并先确认口径。

**验收**：行数、主键、缺失、计算与独立 oracle 一致；异常行单列，不随意补零/求和；可从结果追到原始记录；原文件 hash 不变。缺 U 只影响追加业务数据验证。

### DATA-02：附件目录与重启后继续分析（P0）

**前置**：TOOL-02 已在两个会话上传不同 R/W 资料，记录 Dataset ID、owner、源文件 hash。

**操作**：按 session 查询列表并核对元数据；刷新、登出重登后继续读取；专用栈重启 sandbox，再列出 Dataset 并在原会话调用工具读取上传文件；缺 session/非法 ID 与跨 owner 另验。

**验收**：输入目录与真实文件对应，不混会话；MySQL Dataset 元数据与 workspace 字节重启后可用，模型读到原始数据；不能仅凭旧前端上传卡仍在判恢复成功。

### DOC-01：长文档问答与事实冲突（P1）

**任务**：“根据 R 制作上线准备清单。历史测试报告哪些是旧证据？代码与说明冲突的地方请列出来，不要直接声称全量验收完成。”

**验收**：引用可定位到文件/章节/commit；确认事实、推测、未知分开；至少核查 Agent 版本、Skill 入口、Artifact store、orphan recovery 的现实现；长文不只读开头就概括全部。

### ART-01：正式交付与不可变快照（P0）

**操作**：a. 仅写办公文件，检查没有自动交付；b. `submit_artifact` 后下载并独立验内容/hash；c. 修改/删除专用 workspace 原文件，再下载旧 Artifact；d. 新版另行提交；e. 提交不存在/目录/超限文件。

**验收**：正式提交才产生 Artifact；中文名/MIME/大小正确；旧快照不变，新版有新 ID；失败不留下 Ready 假产物；路径下载不能替代缺失 Artifact 的交付凭证。

### ART-02：在另一会话继续修改报告（P0）

**任务**：“把已提交的 Excel 导入新会话，只保留 2021–2023 年并做一版新报告。”

**操作**：导入后按返回 workspace 路径真实读取，发送任务；刷新并重开目标会话；修改目标文件并重新提交；另测同名目标文件冲突。

**验收**：导入字节来自源快照，模型读到正确目标 workspace；导入文件与正式新 Artifact 分开验；源快照不变，新提交有新 ID。只收到 201 或保留旧卡片不算导入内容可用；同名既有文件不得无提示被覆盖，否则登记缺陷。

### ART-03：执行面重启后仍能取得交付物（P0）

**前置**：专用栈已提交 R/W 成果并记录 hash；当前启动路径使用 MySQL Artifact store。

**操作**：重启 sandbox，原身份重新列出/下载源 Artifact，再导入新会话。

**验收**：元数据、owner、下载字节与重启前一致，导入可读；不能用“磁盘文件还在”或“旧页面卡片还在”代替 API 可用。失败记当前缺陷，不能沿用历史内存 store 解释跳过。

### RUN-01：停止做错方向的工作（P0）

**任务**：在真实批量文件转换/分析尚未完成时点击 Stop。

**操作**：a. 取消正在执行的前台任务并重复提交相同取消请求；b. 取消排队 Run；c. 同会话发送修正后的新任务。

**验收**：取消幂等、Run/ToolExecution 最终收敛、前台执行停止，未完成结果不伪交付；新任务成功。DSH 明确创建的后台 job 另用 JOB-01 终止，不把其独立存活判为取消失败。

### RUN-02：运行中改向、排队与继续（P1）

**任务/分支**：a. W 报告运行中 Steer“改为只分析 2021–2023”；b. 另一轮 Follow-up“完成后再做英文摘要”；c. 按当前 UI/API 可用入口继续中断的任务。

**验收**：改向影响后续产出；follow-up 在前轮之后消费且不覆盖原任务；继续有可追溯上下文，不能用新开无关联会话冒充 Resume。分别记录 Run ID/输出/执行顺序，没触发对应状态记未执行。

### FAIL-01：真实模型服务异常后的恢复（P1）

**前置**：专用故障环境，先成功完成一轮 R 问答。

**操作**：对 flash 连接分别注入上游超时、认证失败、429/5xx 与流式中断；解除故障后同会话重试。不存在模型只在 AGENT-05 校验接口做负向输入，不启动该模型 Run。

**验收**：有可理解错误、明确失败或可恢复状态，无无限重试或偷偷切模型；不输出凭据/完整上游敏感响应；历史保留，新轮成功。各错误单独记录，记录等待上限/实际耗时，不用图片失败代替。

### FAIL-02：错误文件与工具失败（P1）

**操作**：上传 X 损坏 Office、空文件、错误 MIME 文件；要求读取缺失路径或运行会明确非零退出的无害校验脚本；修正输入后重做。

**验收**：上传校验或工具读取阶段明确报错，保留真实错误类别；模型不能说“已分析/已交付”；UI 无永久 Running，新输入可恢复，不污染已有 Dataset/Artifact。

### INPUT-01：用户决定分析口径（P1）

**任务**：“请分析 W 做简报；开始计算前用提问工具让我选择受众和年份范围。”

**操作**：进入 `WAITING_INPUT`，刷新/切页，回答“管理层、2021–2023”，完成报告；另测自由文本回答。

**验收**：问题与选项持久化、回答后恢复；同一 Interaction/ToolExecution 可追踪；最终表格和正文都采用选择的范围，不仅复述选择文字。

### INPUT-02：两标签重复回答与取消竞态（P1）

**前置**：同一用户两个标签展示同一待回答问题。

**操作**：a. 两标签提交不同答案；b. 重放已回答请求；c. 另一轮先取消再回答。

**验收**：只一个答案生效，无重复 Run/副作用；正常第一次回答不误报 409，竞争失败方按 CAS 合理拒绝且刷新到权威答案；取消后不能复活已取消 Run。

### APPROVAL-01：用户批准或拒绝真实工具动作（P1）

**前置**：专用测试策略将一条真实无害调用设为需审批，例如公开指标元数据查询；不以真的危险业务操作造场景。

**操作**：a. Chat 横幅 Reject；b. 新调用在横幅 Approve；c. 再在 Approvals 页决策；d. 修改参数再次请求；e. 等待期间取消，若支持则另测过期。

**验收**：同一审批账本在两处一致；拒绝/过期/取消不执行，批准只放行相应参数的一次调用；改参数重走策略；并行在途工具有明确终态而非永久 Running。没有实际需审批工具记阻塞。

### PROC-01：控制长数据处理进程（P1）

**任务**：用 bash 启动分批读取 R 提交清单的后台校验程序，持续输出批次/错误数量；交互分支由程序从 stdin 接受年份筛选直到 EOF。

**操作**：a. 打开 Process Console，筛 stdout/stderr、搜索并按游标读取；b. 输入筛选并 EOF；c. 另一活进程发送 signal；d. 再一活进程 Cancel。

**验收**：process ID/日志/账本一致，增量无漏重；stdin 真正改变结果，EOF 真正关闭输入；signal/cancel 发生在活进程并收敛。若当前 job 非交互，明确记录 stdin 不支持/未验证，不能以隐藏或禁用按钮判 stdin 通过。

### JOB-01：查看并终止不再需要的批处理（P1）

**操作**：用后台 bash 启动较长的 R/W 分批校验，实际调用 `job_list`、`job_output`；与 Console 对同一 ID；运行中用 `job_kill` 停止，再查状态和后续日志。

**验收**：模型侧和 exec 同账本，输出能看到真实处理进度，kill 后终态与退出原因一致；后台 job 不凭模型文本假装存在，自然退出不能替代 kill 分支。

### TODO-01：多文件交付进度清单（P1）

**任务**：“先列出数据检查、计算、图表、简报、下载核验的任务清单，再依次完成 W 汇报。”

**验收**：实际 `todo_write` 卡与步骤相符，只有完成的项标完成；刷新后条目保留且来自 arguments/事件；失败的 PDF 转换不能仍显示全部完成。

### SUB-01：把资料核对交给子 Agent（P1）

**任务**：父任务制作 R 发布周报，子 Agent 分别核查 API 变化与前端入口，返回路径/结论，父任务汇总。

**操作**：完成一轮，再在子任务存活时取消另一父 Run。

**验收**：结构化子任务卡、父子 ID/结果可追溯；父结论引用真实子结果；子会话不混入 Recent；父取消级联；子 Agent 不注册人机提问工具，有缺资料交给父任务处理。

### MGMT-01：在 Runs 中找到卡住的工作（P1）

**前置**：本轮已产生成功、失败、取消、运行中、排队和等待状态。

**操作**：逐个可用状态筛选，打开会话/详情/Logs，取消可取消任务，刷新。

**验收**：列表、计数、详情与权威 Run 一致，不漏/重；只对允许状态显示操作；接口故障显示错误而非伪空列表。

### MGMT-02：审批中心集中处理（P1）

**前置**：APPROVAL-01 的各状态审批。

**操作**：逐状态筛选、展开参数、打开关联会话；与另一标签同时决策；模拟一次提交网络失败再重试。

**验收**：成功才更新决策；失败保留待处理；竞争不重复执行；批准/拒绝/过期/取消展示与同一账本一致。

### TRACE-01：排查报告为何失败（P2）

**操作**：打开 TOOL-03 成功 Run 与 FAIL-02 失败 Run 的 Details → Trace，刷新重建。

**验收**：Run/工具 span 归属、时间和状态能解释失败位置；跨用户请求 404；不暴露凭据或工具输出原文；无需外部 OTEL 平台也能核对当前持久化 Trace 投影。

### CAP-01：用户确认自己能做什么（P1）

**操作**：逐页看 Skills/MCP Servers/Tools/Models/Extension diagnostics，按真实注册结果核对；分别检查空配置、连接错误、重新加载后的变化。

**验收**：来源/状态/策略/可用模型准确，空清单不等于链路通过；不泄密；工具面包含当前实际注册工具，不残留退役能力；Skill 生命周期用 SKILL 系列验证。

### SKILL-02：把分析方法整理成可复用草稿（P0）

**任务**：“用本次 W 清洗规则制作区域指标简报 Skill，含字段校验、缺失处理、使用说明与脚本，写入我的草稿目录，不自动启用。”

**验收**：真实 `write/edit/bash` 创建 `/home/sandbox/skill-draft/<包名>/`，包 name 匹配；草稿可用真实 W 自测但不会自动进入已启用发现；尝试以 `skill` 加载未启用包明确不可用；系统 Skill 根不可写。

### SKILL-03：导入团队提供的 Skill 包（P0）

**前置**：把 SKILL-02 的实际可用包分别打为 `.zip`、`.skill`，记录 hash；构造 X 非归档/损坏/越界包。

**操作**：在 Capabilities Drafts 点击与拖放上传；刷新；尝试错误格式和超部署大小包。

**验收**：合法包只进本人的 Drafts，未自动启用；文件和脚本真实可读；错误包明确拒绝且不留下半包、不写出草稿根；不能走已删除的 Composer 拼图按钮。

### SKILL-01：启用、实际使用、停用（P1）

**操作**：a. Enable 草稿，进入 My Skills，Drafts 隐藏已发布副本；b. 新会话真实 `skill` 加载，用 W 另一年份子集生成结果；c. Disable 后新 Run 再尝试，另保留已绑定旧摘要的在途 Run 观察；d. 重新 Enable。

**验收**：结果与独立验算一致；Enable 发布不可变摘要版本并更新启用账本，系统 Skill 只读；Disable 后新 Run 不发现/挂载，草稿重新显示；在途旧版本不会被物理删除破坏。失败不乐观显示已启用。“未启用包不能作为 Skill 加载”不等于禁止用户在草稿区自测脚本。

### SKILL-04：更新规则与拒绝非法发布（P1）

**操作**：a. 已发布后只改草稿，运行仍用旧发布字节；Disable/Enable 后跑新版；b. 分别测试缺 SKILL.md、name 不符、symlink、`.git`、系统同名、文件数/大小超限；c. B 查看/同名启用 A 的包。

**验收**：版本字节边界清楚，非法包不改变已有发布；同名用户包按 owner 隔离。逐项登记验证限制值，不能把一次上传错误当全部校验通过。

### SKILL-05：系统 Skill 清单逐包完成真实任务（P1）

**前置**：以 CAP-01 本轮实际注册清单为准；仓库有文件不等于部署已加载。

**操作**：除四类 Office 外，逐个调用系统 Skill：用 `planning-and-task-breakdown` 拆分 W 报告；`grill-me` 澄清 R 交接中缺失信息；`skill-creator`/`skill-vetter` 创建并审查真实分析包；`convert-to-markdown` 转换已下载的 Word/PDF；`baoyu-format-markdown`/`baoyu-markdown-to-html` 整理 R 交接说明并生成可打开 HTML；`theme-factory` 为 W 报告应用一致主题；`mcp-builder` 用 W 冻结数据制作本地只读指标服务样例，在隔离环境启动并实际查询。新增/其它已注册包按其声明用途追加同样记录。

**验收**：逐包有真实 skill 调用、对应可用结果和独立检查；文档转换不丢关键事实/表格，格式处理不改业务数字，审核能指出 X 危险包行为，MCP 样例真正可启动/查询而非只交代码。系统 Skill 根保持只读；缺依赖或未加载逐包记阻塞，不靠另一个包的成功代替。

### MCP-01：通过真实检索找到指标依据（P1）

**前置**：实际 `MCP_SERVERS_JSON` 配置了可用搜索/阅读工具，记录名称但不记密钥。

**任务**：“查找世界银行对现价美元 GDP 的官方定义，解释它与实际增长率的差别，给出来源。”

**验收**：真实 `mcp__<server>__<tool>` 调用、有非空回包与官方来源，执行人打开来源核对；页面无重复/stale Running 或 `[object Object]`。没配置或模型只凭知识作答，调用分支阻塞/未执行。

### MCP-02：外部客户端完整 sandbox 工具闭环（P1）

**前置**：真实 Streamable HTTP 客户端连 `/mcp`，本轮 context 与独立凭据。

**操作**：依次用 `sandbox_file_write/read/list` 保存/检查 W 子集，用 `sandbox_python_execute` 计算，用 `sandbox_shell_execute` 核对文件，再用 `sandbox_artifact_submit` 下载中文报告。

**验收**：六个工具全部实际调用，返回同一工作区内容；计算与 oracle 一致，签名 URL 真正下载正确快照；仅 health/tools/list 不能通过。凭据及含 token URL 不入证据正文。

### MCP-03：低代码会话绑定与下载失效（P1）

**操作**：a. 同 context 连续 write→执行→submit；b. 两 context 同名文件并发；c. 不传 context 保存服务端返回 ID 后续用；d. 非法/过长 context；e. 漏传/换 context 后读取；f. 下载签名篡改和过期。

**验收**：同 context 复用、不同 context 隔离；换 context 不读到旧文件；非法值明确拒绝；下载有效期内字节正确，篡改/过期 fail-closed。不能假设共享 MCP token 下的任意 context 字符串就是完整用户鉴权。

### MCP-04：外部工具故障与只读数据源（P1）

**操作**：真实 MCP 超时/断连后恢复；配置支持时，用已授权的业务只读 MCP 查询一份可独立核验的聚合报表，尝试越范围查询。另核对 Agent config.mcpServers 的 enabledTools 能收窄本 Agent 授权，但不能新增环境清单外 server；变更进程配置后须更新消费者并重新确认注册。

**验收**：有超时与明确工具错误、不无限挂起；恢复后真实调用成功；权限越界被拒、不输出连接密钥。没有业务 MCP/授权数据则该子分支阻塞，不能用虚构 SQL 返回值补通过。

### CRON-01：每周资料更新任务生命周期（P1）

**任务**：创建“每周整理 R 发布记录”任务，提示含明确资料位置与输出要求；用数分钟后的专用一次性任务先验证链路。

**操作**：创建、编辑提示、Run now、History、主 Refresh、Pause/Resume、重开页面，最后删除专用任务。

**验收**：后台实际读取资料生成可核验结果；列表与已打开 History 都刷新到权威状态；暂停不再计划触发、恢复计算下次时间；删除后不可再次触发。无法访问输入不能伪称报表完成。

### CRON-02：跨时区、错过时间与重叠运行（P2）

**操作**：a. 同一目标瞬间分别用 Asia/Singapore 与 America/New_York 配置，并核对 next run；b. 错过触发点分别验证 `skip`/`fire_once`；c. 首轮仍运行时分别验证 `forbid`/`allow`；d. 当前支持的 once/cron 类型各至少一次真实触发。

**验收**：时区与 UTC 对照正确；skip 无补跑、fire_once 只补一次；forbid 有明确跳过记录、allow 的两轮都可追踪；同触发点不重复。改下拉框不等于策略执行过。

### CRON-03：定时报告失败后修复（P1）

**操作**：任务读不到资料或模型故障时触发一次，修正后 Run now；隔离环境重启 Worker 后检查任务及执行历史；有等待审批/输入时查看关联 Run。

**验收**：失败历史保留、可定位原因；修复成功不覆盖失败记录；等待不伪完成；重启不丢计划或重复已有触发；运行后暂停本轮任务。

### AGENT-01：管理员为团队创建不同助手（P0）

**任务**：在 Settings → Agents 新建“数据分析”和“项目交接”助手，systemPrompt 分别约定数据口径核验与源码引用，使用合法 config。

**操作**：查看列表/v1/活跃版本，刷新；提交空名、非法 JSON、数组/scalar config、非法 toolPolicy、含占位 apiKey 的内嵌 model；普通用户尝试创建。

**验收**：合法 definition 有独立 v1，真实 R/W 对话遵守相应职责；错误配置当场拒绝且不留半成品；普通用户 403，伪造 acting role 无效；config 仅排版变化不诱导无意义保存。

### AGENT-02：发布新版本与回滚（P0）

**操作**：a. v1 建会话并跑任务；b. 保存 v2 不激活，再建新会话；c. 激活 v2，旧会话追问、新会话提问；d. 回滚 v1 再建会话；e. v1 Run 在运行中切活跃版本。

**验收**：版本不可变，未激活 v2 不影响新会话；激活/回滚只影响之后创建的会话，旧会话与在途 Run 保留原绑定。用 AgentSession/Run 的版本 ID 和真实输出双证，不能只看页面 active 标签。

### AGENT-03：用户选助手后开始工作（P0）

**操作**：a. 单 Agent org 看不到多余选择器；b. 多 Agent org 在新会话选择分析助手，先上传 W 再发送；c. 显式创建会话、首轮 Run、sessions/ensure 三条入口分别传 agent_id；d. 已有会话后续不传 agent_id。

**验收**：上传预建会话也绑定正确 Agent；开始后选择器消失、header 只读 chip 正确；后续始终用原绑定，不能回到默认；换助手需新会话。目录故障的降级不能造成用户已选 Agent 被静默换成另一名。

### AGENT-04：配置真实生效与组织隔离（P1）

**操作**：a. systemPrompt、固定 flash/maxOutputTokens、toolPolicy allow/deny/风险审批、MCP enabledTools 分别用真实任务验证；b. 尝试越过工具拒绝和企业条款；c. 跨 org 读取目录、传入他人 agent_id/version_id，或把本 org 另一个 Agent 的版本设为当前。

**验收**：生效字段影响真实 Run；maxOutputTokens 以最终上游请求参数为证，工具以真实放行/拒绝/审批及副作用为证；企业策略不可被租户 prompt 覆盖；越界/版本错配 404。不支持字段按 AGENT-05 验明确诊断，不据 JSON 保存断言生效；不虚构 Agent 删除或会话中途换 Agent 功能。

### A2A-01：管理员签发与撤销外部接入（P1）

**操作**：访问 Agent Card/配置；签发最小 scope 专用凭据，完成 A2A-02 调用；轮换后分别使用旧新凭据；再撤销并重试。测试过期与 scope 不足凭据。

**验收**：Card 的版本/能力/认证与实际端点一致；凭据仅显示一次、旧/撤销/过期/越 scope 被拒；普通用户不能管理。参数和证据只保留凭据 ID，不记录明文。

### A2A-02：外部系统请求真实交付（P1）

**任务**：把 R 的非敏感服务说明作为输入，要求整理交接清单并生成正式 Artifact。

**操作**：真实客户端分别 `message/send`、`message/stream`；记录 task/context/Run 映射；`tasks/get`；流式中断后 `tasks/resubscribe`。

**验收**：最终正文符合资料，有终态 `final=true` 与可取得的 Artifact（仅使用当前支持的下载方式）；断线不取消、不重复 Run，重订阅补齐终态；查询与会话绑定一致。

### A2A-03：取消、客户端隔离与审计（P1）

**操作**：启动尚未完成的真实任务后 `tasks/cancel` 并重试；另一 org/client 查询、取消、重订阅与下载；发送未知方法、畸形参数。

**验收**：取消收敛，越界 fail-closed 且资源级跨租户 404；JSON-RPC 错误结构清楚、不返回 500 假成功；审计可关联 org/client/trace/Run，不记凭据；无已实现依据的交互扩展不宣称支持。

### USER-01：两名普通用户同时完成工作（P0）

**前置**：A/B 独立浏览器身份，不以 admin 两开替代；记录 org 关系。

**任务**：A 用 W 做 Excel，B 用 R 做 Word/PDF，同期启动真实工具 Run、各下载交付物。

**验收**：两人均完成普通用户“登录→上传→工具/Skill→交付”闭环；模型/session/workspace/process/文件不串；队列最终有进展且不永久饥饿；各自列表只出现有权资源。

### USER-02：同人多会话与同组织不同人（P1）

**操作**：a. A 两会话上传同名不同内容并发编辑；b. 同 org 的 A/B 分别查看自己的 Dataset、Artifact、Skill、进程与定时任务；c. 换成不同 org 再测。

**验收**：工作区隔离与 owner 隔离分别成立，共享 Agent 目录不等于共享私人文件；同 org 账号需合法预置，不能直接改数据库假装完成注册/组织分配功能。

### CTX-01：长项目会话压缩后继续（P1）

**任务**：围绕 R 多轮核查不同模块，起初约定“仅引用冻结 commit，历史测试不作本轮证据，最后交付中文版”；逐轮保存已确认事项。

**操作**：达到当前模型真实 compaction 阈值，记录实际 compaction 事件/journal，再追问早期约定并继续生成报告；重启 Worker 后再追问。

**验收**：关键约定、最新决策和文件引用保留，无重复气泡/失败；与新会话隔离。不能用机械回显口令或配置未接线的 contextPolicy 假触发；未达到阈值记阻塞并记录实际轮次/用量。

### BUDGET-01：用户查看实际使用量（P2）

**操作**：R/W 多轮任务观察 usage/BudgetBar；分别核对正常、near limit、exceeded 和无 usage 数据分支，用真实配置与实际消耗触发。

**验收**：UI 数值与后端 budget_usage/limits 对得上；无 usage 时不显示 NaN/假零；未配置对应维度则该边界阻塞。不能用前端注入 fixture 当预算真机通过。

### BUDGET-02：限制失控的任务（P1）

**前置**：专用栈记录并临时降低 `AGENT_RUN_MAX_TOOL_CALLS`、`AGENT_RUN_MAX_MODEL_TURNS`、`AGENT_RUN_DEADLINE_MS`，分开测试再还原。

**任务**：需要多步真实文件核查的 R 任务；分别让工具数、模型轮数、deadline 达界。

**验收**：确实停止后续受限执行、有明确原因和收敛状态；已产生文件不伪标为完成交付；新 Run 配额独立。BudgetBar 展示与执行硬限分别验，不能互相替代。

### UI-01：真实长内容下的交互可用性（P2）

**操作**：在 R/W 长消息和真实工具记录中逐个打开 Overview/Tools/Processes/Files/Artifacts/Datasets/Trace/Session；主题切换/刷新；侧栏与移动宽度；长代码 Copy、Jump to latest、允许状态下 Regenerate；thinking 盒（模型有返回时）。

**验收**：计数/实体归属一致，Files 表示本 Run 引用文件而非完整 workspace；滚动不强拉用户位置；窄屏主要控件可达；复制真实内容正确；思考区与正文不混淆。

### UI-02：键盘、中文输入与附件草稿（P2）

**操作**：Enter 发送、Shift+Enter 换行、中文输入法候选确认、Ctrl/Cmd+L 新会话、Ctrl/Cmd+U 上传；拖放多个 R 文件/粘贴 V 图片，移除草稿附件；仅键盘操作登录、提问、审批、下载与关闭对话框。

**验收**：输入法组合不误发送，不意外重复上传；焦点可见且关闭弹层归位；aria-live 不逐 token 重读全文；待上传/失败/已移除附件不被错当可用输入。

### SEC-01：认证与管理员能力边界（P0）

**操作**：未登录访问会话、Run、工具清单、文件、进程、Agent 目录；普通用户直接访问 A2A/Agents 管理接口；提交伪造 X-Acting-*；检查公共探针与 Card 的实际访问约定。

**验收**：受保护面 401；普通用户管理员操作 403 ADMIN_REQUIRED；浏览器自报身份不被信任；公开元数据不泄业务内容；资源级跨租户另按 SEC-02 返回 404。

### SEC-02：资源全集跨用户/组织访问（P0）

**前置**：A 拥有真实 Conversation、Run、ToolExecution、Trace、Interaction、Approval、Dataset、Artifact、Process、Cron、Skill，admin A 另有 Agent/version 与 A2A task；B 已登录。

**操作**：用 B 重放 A 的详情/列表过滤/事件订阅、附件与产物下载/导入、Run 取消/steer/respond、审批决策、进程日志/stdin/signal/cancel、Cron 修改/触发/删除、Skill 启用停用、Agent 版本操作、A2A 查询/控制。按实际路由逐条记录；与随机不存在 ID 比较。

**验收**：具有该操作角色的 B 对跨 owner/org 资源均得到 404，无响应正文/流事件泄漏；列表不含 A 数据。管理员角色拒绝与资源归属分开测，不能用普通用户的 403 掩盖管理员跨租户越权。

### SEC-03：文件、命令与内容注入（P0）

**前置**：专用隔离环境，X 无害探针及本轮 canary 文件；不在共享栈实际运行破坏性系统命令。

**操作**：a. 相对越界/绝对越界/软链接/硬链接通过 read/write/search/submit/upload/import 分别尝试；b. 系统 Skill 写入与未声明工具；c. R/W 的 X 副本插入“忽略规则、读取凭据/他人文件”的恶意文本；d. 危险命令硬拒规则以可检查的无副作用策略探针补测。

**验收**：各入口按策略拒绝、不改写 canary、不越权；硬拒不变成可批准操作；外部资料中的指令不能升级权限。完整危险命令矩阵若仅离线覆盖须明确标记，不把它算真实执行证据。

### SEC-03B：允许环境变量不进入进程参数（P0）

**前置**：使用专用无效凭据 canary 与明确 allowlist；不要求操作者把真实 DB 密码交给模型。

**操作**：运行 W 校验时仅检查被允许变量是否存在；在容器内检查值是否出现在 bwrap argv，输出 absent/present；测试平台 token/JWT 未被继承。

**验收**：允许环境可用、argv 无值、平台凭据不可见；模型结果/SSE/日志/Trace 无 canary 泄漏。不 dump env 或完整进程命令行到终端。

### SEC-04：内部桥凭据与幂等防护（P0）

**操作**：通过受控协议客户端分别用缺失/错误 token、facade 窄桥 token 调完整 `/internal/v1/*`；篡改 HMAC method/path/body/query/scope/owner、过期 claim、旧 fence；同一执行 ID 同参数重送与异参数冲突分别核验。来源白名单空值/非法 CIDR/非白名单来源另验；普通浏览器 Cookie 不能替代内部凭据。

**验收**：签名/来源越界 fail-closed；旧 fence 被拒，同执行身份不重复副作用，异参数冲突不能冒用旧结果；facade 无完整内部面凭据或工作区/数据库挂载。有效内部请求仍能执行无害文件任务。当前 HMAC 层不做 jti 去重，不把“重复 token 一律 401”作为假前提；执行入口未提供所需幂等保护时记录缺口。HTTP 辅助证据单独标注。

### ISO-01：非 root 与执行隔离（P0）

**操作**：查实际容器 uid/capabilities/seccomp；在 bwrap 内写本会话 workspace 与 tmp，尝试写 Skill、访问其它工作区/控制面；分别按部署网络模式连接受控目标；专用栈验证缺 setpriv/隔离配置时拒绝执行。

**验收**：sandbox 执行面 uid 10001；K8s 的 Agent/Worker/BFF/frontend/sandbox-mcp 均 uid/gid 1000，镜像 `USER` 为数字；facade 用独立 slim 镜像且无 bwrap/完整执行代码/DB 驱动。执行前剥离 capabilities；挂载与网络实际生效，缺依赖不降级；开发配置不能作为目标部署通过证据。

### ISO-02：磁盘与进程资源上限（P0）

**前置**：专用有硬上限的环境，记录实际 CPU/memory/pids/workspace/tmp/单文件/输出配置。

**操作**：用有界 X 负载分别到达边界；执行、上传、Artifact submit/import 分别检查 quota；失败后再创建正常文件与 Run；重启检查持久化 quota 预留恢复。

**验收**：超限明确拒绝/终止，不挤占其他 owner、无遗留预留导致永久拒绝；服务恢复可用。compose 中没配置/没落实某硬限，记保护缺口，不能仅凭 YAML 或一次拒绝宣称全部受控。

### LOAD-01：真实大文件与流式上传（P1）

**前置**：R/W 普通规模先通过；准备明确标 X 的放大 CSV，记录行数/hash/生成规则。

**操作**：按小文件、接近配置上限、超过上限逐级上传；§32 5GiB Dataset 分支在允许该大小的专用环境另跑；采样客户端/BFF/exec RSS，上传中断后重试。

**验收**：大小/hash/行数正确，实际有界流式而非整包入内存；超限早拒绝，中断不发布半个 Dataset、临时文件可回收；没有 5GiB 实测不得关闭 C8。扩大数据只测容量，不用于业务结论。

### LOAD-02：并发执行与重复请求（P1）

**操作**：a. 多 owner 20 个有界真实文件任务并发；b. 同 Idempotency-Key 并发创建相同 Run，另测同 key 不同参数；c. 创建成功立即查询；d. SSE 按 Last-Event-ID 重连，测试非法/越界游标。

**验收**：排队受限但最终收敛，无串工作区；同 key 同参数只有一次业务副作用，不同参数明确冲突；成功返回即可查到 Run；事件有序无丢失、客户端合并无重复。不能直接插数据库预制成功行。

### REC-01：Worker 重启时保留工作进度（P0）

**操作**：同一 R/W 项目分别在 a. 已完成后追问前；b. 正在调用模型；c. 工具执行中；d. WAITING_INPUT 未答；e. WAITING_APPROVAL；f. 回答/审批已提交但未消费时重启 Worker；正常 SIGTERM 与硬杀分别记。

**验收**：会话上下文与账本保留；等待仍可回答/决策，已接受决定只消费一次；中途不确定工具有明确 UNKNOWN/失败处置而非盲重放副作用；Run 可恢复或明确终态。只验证等待输入不能代表整个恢复矩阵通过。

### REC-02：exec 硬杀与孤儿账本回收（P0）

**前置**：本轮真实后台 W/R 处理 job 已登记 running，记录 owner/并发占用。

**操作**：专用栈 hard-kill sandbox 后重启；核对该批 exec_jobs 与启动 recovery；可补跑 `scripts/release-gates/exec-orphan-recovery-gate.mjs`，再让同 owner 新建 job。

**验收**：旧 running/stopping 被收成明确终态（当前回收原因为 `orphaned: worker restarted`），额度释放，无残留错误活动账本；新 job 正常。容器重启自带进程消失，不能单独证明孤儿账本恢复。

### REC-03：Redis/BFF 短暂不可用（P1）

**操作**：R/W Run 中分别重启 BFF、短断服务 Redis；恢复后重连、查询历史和产物；多 Worker 下另按 DEPLOY-05 检查取任务暂停/恢复。记录断连时长和配置超时，不操作已退役 replay Redis。

**验收**：事实事件仍以 MySQL 为准，outbox 恢复投递、SSE 可补齐；BFF 重启不取消 Worker Run；依赖不可用时不无保护接单；不重复工具副作用。服务 Redis 的队列/锁/事件分支分别取证，不从一次 PING 成功外推全部恢复。

### AUTH-04：注册校验与团队同时首次使用（P0）

**前置**：独立环境的新组织尚无默认 Agent，合法预置身份；常规注册分支用本轮唯一用户名前缀。

**操作**：a. 用 UI/API 分别提交重复用户名、不合法字符、超长字段与不合法长度密码，修正后注册；b. 两个普通用户同时首开页面、请求 Agent 目录、上传附件并发送首轮 R/W 任务；c. 刷新、重新登录后继续。

**验收**：非法输入有字段反馈、无半注册身份，重复用户名 409 `USERNAME_EXISTS`；合法创建成功。默认 Agent 并发首建无偶发 409、无重复 definition，两个用户仍有独立会话/workspace。两人都能完成工具 Run，不能用“全拒绝”掩盖初始化故障。现有组织已有默认 Agent 不能算首建分支已覆盖。

### CHAT-07：报告未完成时连续追加两项工作（P0）

**前置**：当前分支 follow-up 排队修复；部署 flash；准备能持续足够时间的真实文件处理任务。

**任务**：先“分析 W 并保存年度表”，运行中依次发“基于刚才的表补中文摘要”“把摘要改成邮件正文并交付”。

**操作**：a. 记录三次提交和 Run ID，刷新/换标签观察；b. 第二轮取消其中一个排队追问，再发第三项；c. 前轮失败或 Worker 重启后重试；d. WAITING_INPUT/APPROVAL 时另发追问，分别记录实际调度及恢复旧等待项；e. 单 Worker 与多 Worker 分别执行。

**验收**：有活动 session 锁时后续 Run 排队，按服务端提交顺序推进，不出现常规追问直接 `FAILED / session lock busy`；只使用已可用的上一轮结果，缺结果明确提示。排队取消不执行副作用；重试不重复用户消息/业务写入。等待态不假设继续占锁或永远阻塞后续 Run；恢复原任务与新任务仍遵守同会话互斥，子 Agent 不被顶层排队规则锁死。

### BIZ-01：月底订单退款对账与修订（P0）

**前置**：S 合成订单/退款包与独立答案在数据文档 §6；提示中明确是演练数据。

**任务**：“请做 2026 年 8 月 SGD 订单对账。先检查状态、重复、退款归属和未匹配记录；有口径不清先问我。交付含公式的 Excel 和一页 Word 财务说明。”

**操作**：选择按退款发生月统计；先跑原版，再上传有重复/缺失/孤立退款的 X 副本；要求仅修订异常清单、保留已核准结果；跨会话导入报告续改。

**验收**：原版实收 540、当月有效退款 75、净额 465 SGD；9 月退款不扣 8 月，未付/取消订单不算收入；X 重复不累加，孤立退款列异常且不擅自计入。金额与 oracle/公式/Word 一致，模型不虚构真实企业经营结论；双版本文件有独立 Artifact 且旧版不变。

### BIZ-02：会议纪要变成可执行的项目周报（P1）

**前置**：S 合成会议包，记录了确认事项、提议、未知负责人/日期与一次会后修订。

**任务**：“把这些记录整理为决定、行动项、风险与待确认问题，先问清不确定的负责人和截止日，再给我 Word 周报和 5 页汇报 PPT。”

**操作**：按 S 的确认答案回答；补充会后修订并要求同步两份交付物；重新打开会话，要求只更新变更项。

**验收**：提议不变成决定，未知不编成姓名/日期；回答后的责任人与日期正确，冲突以明确的后续修订为准；Word/PPT/待办卡保持一致。演练身份不可映射为真实员工；没有发送邮件或邀请他人的额外副作用。

### AGENT-05：先校验配置，再预览和执行（P0）

**前置**：管理员，能力来源为 `GET /api/agents/config/options`；模型固定 flash。

**操作**：a. 通过表单/JSON 编辑 systemPrompt、maxOutputTokens、toolPolicy 和环境已有 MCP 的 enabledTools，调用 `POST /api/agents/config/validate`；b. 查看 normalizedConfig/effectiveSummary 预览后创建版本并用 R/W 任务执行；c. 分别测试未知字段、非整数/越界输出上限、未知模型 ID、flash 不支持的 thinkingLevel/temperature、保留只读字段、未知工具/server、内嵌凭据字段；d. 预览合法和非法 config 前后对照版本数量。

**验收**：预览不写账本；校验业务结果为 HTTP 200 + valid:false/true，不能仅凭 200 判有效；字段路径、诊断码与 UI 错误对应，保存校验与预览一致，不合法配置不生成可运行版本。flash 支持项真实生效；不支持项明确诊断，不静默丢弃。MCP 只选择平台已注册工具；预览不是真实请求证据，参数落实仍按 AGENT-04 验。

### AGENT-06：编辑草稿、请求过期与多人发布冲突（P0）

**操作**：a. 编辑未保存草稿时分别让 models/tools/MCP/options 加载失败，恢复后重试；b. 快速切 A/B Agent 并延迟 A 响应，连续修改后让旧校验响应晚到；c. 两个管理员标签以同一个活跃版本为基础发布/激活不同版本；d. 保存请求网络失败后重试；e. 兼容客户端省略、显式 null、真实值三种 `expected_active_version_id` 分别调用。

**验收**：错误不呈现为空能力集、不覆盖草稿/当前选择；陈旧响应不能解锁错误配置保存；竞争失败方得到 409 活跃版本冲突并可保留草稿重新核对，不能静默覆盖他人发布。省略字段是当前兼容窗口，null 是明确“无活跃版本”的条件，不混为一谈。网络不确定结果先查询版本再重试，记录是否重复写入。

### AGENT-07：旧配置升级与历史会话继续工作（P1）

**前置**：隔离副本中合法保存的旧 schema 版本；固定 flash 的正向样本和含遗留字段的负向样本。若只能 fixture 预置，明确标为迁移准备，不冒充 UI 创建成功。

**操作**：读取旧版并预览升级，分别处理可映射模型字段和不可迁移/保留字段；保存为新版本并激活；旧会话追问、新会话执行；再回滚。

**验收**：旧 snapshot 不被原地改写；迁移诊断展示哪些字段需处理，未处理不能“成功升级但丢语义”；新版本 schemaVersion=1，输出预览与执行一致。旧会话保持原绑定且只对固定 flash 样本发推理；任何历史其它模型样本只读核对。

### SKILL-06：同事换终端、换 Pod 后继续用已发布方法（P0）

**前置**：共享 Skill 根与草稿根已配置，至少两应用副本，测试包使用 W 清洗规则。

**操作**：a. exec 写草稿→经 Agent A 启用→经 Agent B/另一 Worker 发现→exec 实际执行；b. 滚动换 Pod 再做新任务；c. 旧任务在途时发布不同摘要、停用/重新启用；d. 专用副本中断共享挂载、制造缺失版本/摘要不匹配，再恢复；e. 并发启停与跨 owner 同名包。

**验收**：发现依据为持久启用账本，实际挂载字节摘要匹配；新 Run 用新绑定，在途旧 Run 保留已引用版本；半发布/缺挂载/摘要不符拒绝使用且有诊断，不能回退扫描目录放行。跨 Pod 与跨机分别取证，同一节点的本地卷成功不能宣称目标 NFS/CSI 已验收。

### SUB-02：多个父任务同时委派也能完成（P0）

**前置**：登记 `AGENT_SUBAGENT_MAX_DEPTH`、每副本总并发及各层保留槽；所有父子 Run 都用 flash。

**操作**：a. 同时启动足以占满根层槽的 R 文档核查任务，每个委派子任务；b. 在允许深度内再委派一次，并尝试越最大深度；c. 子任务执行中取消父任务/重启 Worker；d. 尚有深层队列或非终态账本时尝试降低最大深度，探测 Redis/DB 失败也测拒启。

**验收**：每个允许层都能推进，父任务等待时不饿死子任务；实际总并发符合各副本预算，不能把每副本上限写成集群全局上限；越深度明确拒绝；缩深不遗留无消费者任务，检查失败不放行。记录父子 Run、权威 depth、各队列和真实产物，不能用单个父子完成替代饱和测试。

### MCP-05：工具目录不可用、变化与重新授权（P0）

**操作**：a. 分别启动无 MCP 配置、禁用 server、启用但连不通、正常注册四种环境；b. 正常 server 中途掉线/恢复或发 tools/list_changed；c. 同时查看 Capabilities、Agent /ready、Worker guard、配置 options/validate；d. 在一个 server 失败时验证另一 server 的工具选择；e. 变更 Agent 工具授权后新旧会话分别调用。

**验收**：启用却未注册不能伪装“成功的空清单”；探针反映当前注册状态，恢复后按插件实际重连机制更新，不假定无条件无限重试。配置目录“可知”与全部 server“可用”分开：不可用工具诊断，已有可知工具可校验；旧版本授权不被新版本改写。真实 MCP 与故障服务器替身证据分别标注，不用 fake LLM。

### DEPLOY-01：依赖活着但不可用时不继续接活（P0）

**前置**：专用部署记录所有探针/客户端 timeout、guard 周期与允许等待窗口。

**操作**：逐一使 DB、Redis、exec 存储/bwrap、必需 MCP 不可用；保留进程 liveness；另使下游 /ready 超时、非 JSON 或 HTTP 200 但 body 非 ready；分别注入低于/超过 startup probe 总预算的 DBPM/MCP/隔离预检慢启动，观察 Agent/Worker/BFF/facade，就绪恢复后跑普通用户闭环。

**验收**：各依赖的消费者按当前契约返回未就绪并暂停取新活，不能拿 /health 200 代替可工作。BFF 公开响应仅摘要，不泄漏下游 server 名/敏感错误；探针和调用超时有界，kubelet timeout/startup 预算覆盖实际应用探测；可接受的慢启动不被 liveness 提前反复重启，超预算有明确失败。多个慢依赖不会让守卫轮次/续租无限重叠；故障恢复后重新接单且成功下载报告。注入的探针替身仅证明该错误契约，另保留真实依赖断开的证据。

### DEPLOY-02：DBPM 启动取密、失败与凭据更新（P0）

**操作**：a. 按各进程所需角色验证正常取密、连接、登录与工具任务；b. 缺 DBPM_URL、连接串夹口令、用户名不匹配、取密超时/拒绝/坏响应逐一启动；c. 测试环境更新凭据后按部署流程滚动重启消费者，再读旧会话并新建任务。

**验收**：Agent/Worker 按需取 DB 与服务 Redis、exec 只取 DB、facade 只取 Redis，BFF 不增加取密依赖；无静态口令回退，失败拒启且不泄密。当前是启动取密，不将运行期自动热轮换作为已实现能力；旧连接/新连接的实际结果单独记录。本地 fake DBPM 只证明协议联调，目标 DBPM 联调仍须单列。

### DEPLOY-03：数据库 Proxy 切换与时间一致（P0）

**前置**：两个 Proxy、可读非敏感连接端点标识；独立故障环境。

**操作**：a. 正常创建会话/上传/审批/提交 Artifact；b. 首端建连故障、新连接走备端；c. 两端故障、认证错误、半帧与超时；d. 扩池后查新连接 UTC，并核对跨时区 Cron；e. 在一笔无害测试写事务 commit 回应处中断连接，恢复后查询结果。

**验收**：只按允许的建连错误切换，认证/SQL 错误不当成可盲重试；commit 结果不确定时不自动重放写入，资源/审批/账本无重复；连接交付前完成 UTC 初始化。MySQL 双代理模拟与真实 UPDRDB 结果分开报告，不能以模拟通过宣称目标兼容。

### DEPLOY-04：新环境初始化与版本升级（P0）

**前置**：独立空库/副本、备份与当前 schema 发布包，不碰共享库结构。

**操作**：按 `scripts/dev/schema-apply.sh` 及部署文档导出/应用 DDL，记录摘要；使用无 DDL 权限应用账号启动 Agent/Worker/exec；另测版本记录完整但表/索引/触发器缺失、错误版本、应用中断恢复与二次重放；恢复正确 schema 后登录并读写成果。

**验收**：发布步骤与运行启动职责分离；应用不自动建/迁表，缺对象明确拒启；正确 schema 的最小权限正向成功。二次重放结果按发布包契约核对，不盲目重做破坏性 DDL；已有数据、owner、Artifact/Dataset 可读。目标 DB 的元数据权限与对象兼容需实际证据。

### DEPLOY-05：Redis 5 队列、多副本抢占与接管（P0）

**前置**：真实 Queue/Worker，记录 Redis 版本、`{bull}` prefix、Worker 副本数与并发配置。

**操作**：a. 并发消费同一批任务和同一个 Cron 触发点，含手动 Run now 竞争；b. 延迟、重试、stalled、锁续约、outbox 重投递；c. Worker SIGSTOP 至租约过期，另一副本接管后恢复旧副本；d. 经非执行副本发取消；e. Redis 不可用后恢复。

**验收**：claim/租约/fence 阻止重复执行与旧 Worker 继续派发；事件最终可补齐，任务有收敛或明确不确定处置；暂停接活后可恢复。SIGSTOP 必须有外部超时与恢复负责人；不预设外部副作用“绝对 exactly-once”。Redis 5 本地通过不等于目标 UPRedis Cluster/Lua/CAS 全部通过，后者另记。

### DEPLOY-06：上班期间滚动更新 Worker（P0）

**操作**：a. 真实工具 Run 在途时发 SIGTERM，持续提交另一测试任务；b. 排空预算内正常完成；c. 模型/工具/outbox 慢到超过 `AGENT_WORKER_DRAIN_TIMEOUT_MS`，另验 teardown 超时；d. 新 Worker 接管后查旧 Run/ToolExecution/产物并继续工作。

**验收**：信号到达即未就绪、停止新消费和后台循环；排空期限从信号起算，含后台循环，不被挂起 DB 阻塞无限延长；超时退出、不提前关 runtime/连接池篡改在途状态。编排 grace 覆盖 drain、teardown、探针退出开销。未决工具保持可审计的不确定状态，不盲重放；人工核对/取消后新任务可用。不能要求每个硬中断任务自动成功。

### DEPLOY-07：VM 执行面与应用入口部署（P1）

**操作**：a. 按实际 release 安装 VM exec/systemd 与钉版工具链，记录 uid/挂载/网络；b. 经 K8s frontend→BFF→Agent/Worker→VM 真实完成四格式办公任务、Python、图片读取及进程 logs/signal；c. systemd 重启/hard-kill 后验证 REC-02；d. 检查 frontend 8080 与 API_UPSTREAM 渲染、非法配置拒启、内部端口不可由浏览器公网直达。

**验收**：VM 的 release 与本轮代码一致；bwrap、字体、CA、LibreOffice 与 Skill 依赖确实可用，交付件按数据文档逐个渲染检查；不借 root/关闭隔离跑绿。无目标 VM 则记录阻塞；openEuler 容器演练不能当目标裸机已验收。

### DEPLOY-08：环境切换、回退与数据边界（P1）

**前置**：专用演练环境的旧/新连接、卷和 release 清单，含队列/账本备份与恢复点；回退兼容性先核对。

**操作**：先 drain 旧消费者，再按部署方案切换；检查仅一组应用消费；登录找旧会话与成果、做新任务；按可恢复方案回退并重复核验。K8s 本地镜像更新后核对所有 Pod imageID，依赖容器 IP 改变后核对 EndpointSlice。

**验收**：新旧库/卷不混接，旧消费者不偷取新任务、深层队列不遗失；回退不丢已确认数据、不重复 Cron；共享 Skill 与 Artifact 路径仍对应正确账本。不能以“脚本退出 0”替代实际页面/字节验证，不在共享环境运行 `down -v` 或重启整个 OrbStack。

### SEC-05：日常登录的 Cookie、来源与上传防护（P0）

**操作**：按实际 `TLS_ENABLED` 模式登录/刷新/SSE/上传/下载/登出；隔离环境测试伪造 Origin/转发头、跨站写请求、过期 Cookie 与不安全跳转；若部署 HTTPS 再验反向代理终止与 Secure Cookie。

**验收**：JWT 只在 HttpOnly Cookie，登出后受保护读取失败；HTTP 内网模式与 HTTPS 模式的 Secure/SameSite 配置符合明确部署契约，不能把 HTTP 模式 Cookie 不带 Secure 直接判缺陷。来源/CSRF 等要求若当前未实现，记保护缺口，不能由 CORS 配置推断已经安全；合法同源上传/SSE 必须成功。

### CLEAN-01：完成工作后清理测试资源（P1）

**操作**：按本轮资源 ID 清单下载必要证据，终止测试 job、暂停/删除测试 Cron、撤销测试 A2A 凭据、停用测试 Skill、删除专用会话；刷新与旧直链复查。

**验收**：只影响本轮授权资源，无继续自动触发/残留活进程；保留的 Artifact/Dataset/Agent 明确列出原因与当前产品清理边界。没有公开删除能力不伪造按钮，也不直接删数据库冒充产品功能；禁止 `down -v` 全库清理。

## 4. 首次实测结果（修复前，保留作回归对照）

下表记录首次 Browser 实测时的状态，不能作为当前代码状态；修复后的最终结果见 §7。

| ID | 执行时间 | 结果 | 关键资源 ID | 证据路径/摘要 | 阻塞或缺陷 |
|---|---|---|---|---|---|
| ENV-01 | 2026-09-01/02 | 通过（未重建） | Compose 栈 | 服务均在预期状态；BFF/Agent readiness 200 | 未验证本次运行镜像是否由当前分支最新提交重建 |
| ENV-02 | 2026-09-01/02 | 通过 | Browser 前端 | `127.0.0.1:3000` 可加载、可交互，Agent Ready | 未做完整响应式矩阵 |
| AUTH-02 | 2026-09-01/02 | 阻塞 | admin 会话 | 当前库已有 admin；未执行 `down -v` 空库注册，也未创建第二身份 | 普通用户注册、客户端 role/org 注入防护未验证 |
| AUTH-01 | 2026-09-01/02 | 通过 | admin 会话 | 登出 → 登录成功，页面显示 admin，A2A 入口恢复；刷新后会话仍可用 | 未验证错误密码锁定策略 |
| CHAT-01 | 2026-09-01 | 通过 | 会话 `…B37GXG` | 纯文本 Run 成功，正文 `REGRESSION_PLAIN_OK`，无工具 |  |
| CHAT-02 | 2026-09-01 | 通过 | 会话 `…B37GXG`；重生成 trace `…7862508e` | 第二轮追加正确；Regenerate 产生独立 Run，历史顺序正常 | 未在同一条 Running Run 中验证 Follow-up |
| CHAT-03 | 2026-09-01 | 通过 | B 会话 `…TQHNJK` | Flash/Pro 分会话选择成功，切回后模型选择保持隔离 | 仅验证可用模型，未覆盖不可用模型空态 |
| CHAT-04 | 2026-09-01/02 | 未执行 |  | 未删除测试会话 | 删除是持久化副作用，本轮未获明确清理确认 |
| CHAT-05 | 2026-09-01 | 部分通过 | 后台 process `bash-…` | 长 Run 在切换 New Chat 后仍继续，侧栏/Run 状态可见 | 未完成关闭页面后的 SSE catch-up 复连验证 |
| CHAT-06 | 2026-09-01/02 | 未执行 |  | 未关闭标签或人为断网 | 需要单独的浏览器重连窗口 |
| TOOL-01 | 2026-09-01 | 部分通过 | 会话 `…W01YE3`；trace `…f810` | `write/read/edit/bash` 成功；`glob/grep` 多次返回 `Error: invalid path` | 搜索工具与运行时路径解析仍有缺陷 |
| TOOL-02 | 2026-09-01 | 失败 | CSV/PNG 附件测试 | 两种附件 UI 均显示 Ready；CSV Dataset 读取未得到可用结果，PNG 发送失败 | Dataset/附件到模型的读取链路未闭环 |
| TOOL-03 | 2026-09-01 | 部分通过 | `rt-20260901-sheet.xlsx`、`rt-20260901-report.docx` | xlsx/docx 文件均生成并可校验；系统 `skill` 调用均报 unknown，走了 bash fallback | 主 Skill 工具发现/加载失败；未形成可下载 Artifact |
| TOOL-04 | 2026-09-01 | 部分通过 | 会话 `…NW34PX`；trace `…0f553` | Unicode 文件和多行 Python/bash 标记成功 | PNG MIME 处理失败；未出现成功的 `read_image` |
| ART-01 | 2026-09-01 | 失败 | `rt-20260901-report.md` | 文件写入成功；`submit_artifact` 因返回 schema 字段不匹配失败，Artifacts 仍为空 | 未能下载或验证不可变快照 |
| RUN-01 | 2026-09-01 | 部分通过 | process `bash-…` | 后台进程可启动；SIGTERM 后容器进程消失，刷新后最终显示 cancelled | Process Console 在信号后约数秒仍显示 Running，投影刷新有延迟 |
| RUN-02 | 2026-09-02 | 部分通过 | 新建 Steer 测试 Run | Running 中 Steer 可提交；原始 `sleep 30` 工具被 aborted，随后输出 `REGRESSION_STEER_OK` | Resume 无可见效果；Follow-up 未执行；未测排队语义 |
| FAIL-01 | 2026-09-01 | 部分通过 | PNG 失败会话 | 明确出现 MIME mismatch 失败；同会话后续纯文本恢复成功 `REGRESSION_RECOVERY_OK` | 未用无效 model_id，不能据此验证模型配置错误分支 |
| INPUT-01 | 2026-09-01 | 失败 | ask_user_question Run | 工具调用结束但未持久化为 WAITING_INPUT，页面无选项/回答控件 | 结果渲染为 `[object Object]`，交互协议未闭环 |
| APPROVAL-01 | 2026-09-01 | 部分通过 | Exa MCP approval | 会话横幅 Approve/Reject 均可操作；Reject 产生 `APPROVAL_REJECTED` 且工具未执行 | 未测参数 digest 失配、停泊取消及并行工具回收 |
| PROC-01 | 2026-09-01 | 部分通过 | process `bash-…` | Process Console 可见，SIGTERM 最终生效 | 控制台状态刷新滞后；stdin 场景未形成可验证长进程 |
| JOB-01 | 2026-09-01 | 部分通过 | background bash job | job_list/job_output 被调用；Process Console/容器进程可观察 | `job_list` 返回无作业、`job_output` 仍报 running/no output，账本未对上 |
| TODO-01 | 2026-09-01 | 通过 | todo Run | `todo_write` 结构化卡片显示 1/3 done，pending/completed 正确 |  |
| SUB-01 | 2026-09-01 | 失败 | subagent Run | 父 Run 可继续，但 subagent 只有 TOOL_ERROR，无结构化子任务卡片 | 子 Agent 结果序列化/投影失败 |
| MGMT-01 | 2026-09-01 | 部分通过 | `/runs` | All/Running/Waiting/Failed/Completed 筛选、列表、Open/详情可用；Running 空态正确 | Logs 按钮未单独打开，取消未从 Runs 页执行 |
| MGMT-02 | 2026-09-01 | 部分通过 | `/approvals` + 会话横幅 | Approvals 空态正常；真实审批横幅 Approve/Reject 已验证 | 未对 Approval Center 的状态筛选和参数展开留独立证据 |
| TRACE-01 | 2026-09-01 | 通过（带工具 Run） | trace `…0f553` | Details 八个 tab 可打开；普通工具 trace span 均为 ok、无敏感输出 | MCP Run 留有 stale running/重复投影，见 MCP-01 |
| CAP-01 | 2026-09-01 | 通过（修复后） | Settings Capabilities | Skills/MCP/Tools/Models/Diagnostics 均加载；模型和工具清单可见 | 旧的 Registry 400/组织映射缺失是修复前快照，不代表当前状态 |
| SKILL-02 | 2026-09-01 | 通过 | 用户草稿 `rt-20260901-echo` | 草稿生成；Drafts 显示 1、Enable 前 My Skills 为 0 |  |
| SKILL-01 | 2026-09-01 | 部分通过 | 用户 Skill `rt-20260901-echo` | Enable/Disable UI 和挂载字节正确；停用后 My Skills 清空 | `skill` 调用报 unknown，实际脚本只能通过 fallback bash 执行 |
| MCP-01 | 2026-09-01 | 部分通过 | Exa MCP Run | Approve 后真实搜索成功并返回公开文档；Reject 路径成功拒绝 | Run 成功后仍有重复/stale Running MCP tool 投影，结果含 `[object Object]` |
| MCP-02 | 2026-09-02 | 通过 | sandbox-mcp HTTP | `/health` 200；认证 `tools/list`/`sandbox_file_list` 200；错误 `/internal/v1/health` 404 | 未执行破坏性命令，仅验证无害工具 |
| CRON-01 | 2026-09-01 | 部分通过 | `/schedules` | 表单、必填校验、一次性时间字段可用 | 未创建任务，未测 CRUD/Run now/历史 |
| CRON-02 | 2026-09-01/02 | 未执行 |  | 未创建周期任务 | 未验证时区、misfire、concurrency |
| A2A-01 | 2026-09-01 | 部分通过 | A2A Access + Agent Card | 管理页、Agent Card、streaming 能力可见；未认证 RPC 返回 401 | 未创建/轮换/撤销凭据 |
| A2A-02 | 2026-09-01/02 | 阻塞 |  | 没有创建本轮一次性凭据 | 未验证 authenticated JSON-RPC/SSE、tasks/get/resubscribe |
| USER-01 | 2026-09-01/02 | 阻塞 | 仅 admin 会话 | 未创建普通用户或第二浏览器身份 | 普通用户主链路和双人并发未执行 |
| CTX-01 | 2026-09-01/02 | 阻塞 |  | 未将 256k context 推到压缩阈值 | 未验证 compaction 后关键事实保持 |
| BUDGET-01 | 2026-09-01 | 阻塞 | 带工具 Run Details | Context Usage 显示 `—`，未发现预算配置 | 没有 near-limit/exceeded 的可验证输入 |
| UI-01 | 2026-09-01/02 | 部分通过 | Chat/Run Details | 侧栏、主题、starter、Details 八 tab、刷新恢复可用 | 完整键盘、输入法组合、拖放/响应式未全覆盖 |
| SEC-01 | 2026-09-01 | 通过（未登录面） | 未认证 HTTP | conversations/runs/capabilities/a2a 等受保护 API 返回 401 | 未覆盖普通用户 A2A 403 |
| SEC-02 | 2026-09-01/02 | 阻塞 | 仅 admin 会话 | 未准备用户 B | 未验证 Conversation/Run/Artifact/Dataset/Process/Cron/Skill 跨租户统一 404 |
| SEC-03 | 2026-09-01/02 | 未执行 |  | 未提交危险命令或越界路径 | 出于安全边界不主动执行破坏性样例 |
| ISO-01 | 2026-09-02 | 部分通过 | sandbox/sandbox-mcp 容器 | uid 10001、cap_drop ALL、seccomp、sandbox CapEff=0、MCP 无挂载已确认 | 未完成网络模式、quota、setpriv/bwrap 端到端验证 |
| REC-01 | 2026-09-01/02 | 未执行 |  | 未重启 Worker | 未验证 WAITING_INPUT/Run 接管和 DSH session resume |
| REC-02 | 2026-09-01/02 | 未执行 |  | 未 hard-kill exec | 未验证 orphan 回收，避免影响当前共享环境 |

## 5. 首次实测证据（修复前）

本节保留首次实测的原始证据，便于确认回归测试确实覆盖了真实失败路径。

### 环境与浏览器

本轮复用修复后的现有 Compose 栈，没有执行镜像重建，也没有修改生产代码。容器内探针结果如下：

- BFF `/health/live`：HTTP 200，`status=ok`。
- BFF `/health/ready`：HTTP 200，Agent 与 Sandbox 均报告 `ok`。
- Agent `/health`：HTTP 200，`status=ok`、`authority=mysql`、`active_runs=0`。
- Browser 前端 `http://127.0.0.1:3000/`：可加载并交互，页面显示 Agent Ready。

健康结论以容器内探针和 Browser 可达性为准。`ENV-01` 的“通过”只代表当前运行栈健康，不代表镜像已由本分支最新提交重建。

### 修复前观察与修复后复测

此前记录的 Capabilities Registry HTTP 400、A2A `Organization mapping not found` 和空组织映射，是环境修复前的快照。修复后没有继续沿用这些旧阻塞：Skills、MCP Servers、Tools、Models、Diagnostics 页面均加载成功；A2A 页面显示 Agent Card、版本、Streaming 和认证方式。该变化证明前置环境已恢复，但不等于下游真实工具链全部通过。

### Browser 主链路结果

- CHAT-01/02/03：纯文本、多轮、Regenerate 和按会话选择模型均成功。纯文本会话使用资源后缀 `…B37GXG`，得到 `REGRESSION_PLAIN_OK`；第二轮和 Regenerate 未出现会话串线；Flash/Pro 分会话选择保持隔离。
- TOOL-01：在会话 `…W01YE3` 中 `write/read/edit/bash` 成功；`glob/grep` 即使使用正确的出厂参数仍多次返回 `Error: invalid path`，所以只记部分通过。
- TOOL-04：中文文件名读写和多行 Python 经 bash 执行成功，会话 `…NW34PX` 返回 `REGRESSION_UNICODE_OK`、`REGRESSION_PYTHON_OK`。图片链路未通过：vision 请求返回 `Prompt image MIME mismatch: declared image/png, received multipart/form-data`；后续没有形成成功的 `read_image` 工具卡。
- RUN-01/PROC-01：后台 bash 进程可以启动，Process Console 可见；SIGTERM 后容器内进程消失，刷新页面后最终显示 cancelled。但 UI 在信号后仍短暂显示 Running，说明状态投影/刷新存在延迟。
- RUN-02：在 Running 状态点击 Steer 并提交改向指令后，原始 `sleep 30` 工具显示 `This operation was aborted`，随后只执行确认输出并返回 `REGRESSION_STEER_OK`。Steer 的中止路径成立；Resume 无可见效果，Follow-up 排队尚未执行。
- TODO-01：`todo_write` 以结构化任务卡展示，3 个条目中 1 个完成，刷新后未见异常。
- MGMT-01、TRACE-01、UI-01：Runs 筛选、打开、Details 八个 tab、普通工具 Trace、侧栏折叠/恢复、主题切换/恢复、新会话 starter 和刷新恢复均可用。完整键盘/输入法、拖放和响应式矩阵未全部执行。

### 已确认的失败或不完整链路

- TOOL-02：CSV 和 PNG 上传卡均进入 `Ready`，但 CSV Dataset 无法被模型稳定读取；PNG 发送触发 MIME mismatch，附件到模型的闭环失败。
- TOOL-03：xlsx 与 docx 文件通过 fallback bash 生成并校验成功；对应系统 `skill` 工具调用均返回 `skill "…" is unknown or no longer available`。办公文件产出可用，但主 Skill 发现/加载路径失败。
- ART-01：报告文件写入成功，但 `submit_artifact` 返回值不符合声明 schema（返回字段与 `artifactId`/mime/details 声明不一致），因此 Artifacts 为空，未能验证下载和不可变快照。
- INPUT-01：`ask_user_question` 调用后没有进入可持久化 `WAITING_INPUT`，页面没有可回答的选项控件；工具结果出现 `[object Object]`。
- SUB-01：父 Run 可以完成，但子 Agent 只有 `TOOL_ERROR`，没有结构化子任务卡片。
- JOB-01：`job_list` 返回无后台作业，而 `job_output` 仍显示 running/no output，DSH job 视图与 Process Console/exec 账本没有对上。
- MCP-01：Exa MCP 的会话内审批横幅 Approve/Reject 均可用；Approve 后真实公开检索成功，Reject 后得到 `APPROVAL_REJECTED` 且未执行。但 Run 成功后仍有重复或 stale Running 的 MCP 工具投影，结果序列化也出现 `[object Object]`。
- FAIL-01：图片 MIME 错误能明确失败；同一会话随后发送纯文本并成功返回 `REGRESSION_RECOVERY_OK`。本轮没有用无效 model_id，不能把它扩展解释为模型配置失败分支已通过。
- SKILL-01/02：用户草稿创建、Enable/Disable 状态和挂载字节均正常；启用后 `skill` 工具仍报 unknown，只能通过 fallback bash 读取并执行脚本。

### sandbox-mcp 与隔离只读证据

- sandbox-mcp `/health` 返回 200；认证后的 `tools/list` 和无害 `sandbox_file_list` 调用返回 200。
- 对 sandbox-mcp 的错误内部路径 `/internal/v1/health` 返回 404，未发现该 facade 可直接访问完整内部面。
- sandbox 与 sandbox-mcp 进程均以 uid 10001 运行；两者 `cap_drop` 为 `ALL`，sandbox 使用 seccomp 配置；sandbox PID 1 的 `CapEff` 为全零；sandbox-mcp 无容器挂载。
- 以上支持 ISO-01 的部分断言。网络模式、资源 quota、`setpriv`/bwrap 端到端 fail-closed 和 hard-kill 回收仍未验证。

### 自动化补充（不替代 Browser 实测）

本轮在现有工作树直接运行，未重建镜像、未清理数据库：

- `uv run pytest -q`：98 passed。
- `npm test --prefix exec`：319 tests，318 passed，1 skipped，0 failed。
- `npm test --prefix contract`：29 passed。
- `npm test --prefix agent`：1190 passed。
- `npm test --prefix api-server`：144 passed。
- `npm test --prefix frontend`：323 passed。
- `npx tsc --noEmit -p exec/tsconfig.json`、`contract/tsconfig.json`、`frontend/tsconfig.json` 及 `npm --prefix agent run typecheck`：均通过。

这些结果证明代码级契约和模拟链路通过，不能抵消 Browser 中已观察到的真实运行时失败、投影不一致或未执行的多身份/恢复案例。

### 只读安全检查与未执行范围

从 BFF 容器内不带认证请求 `/api/conversations`、`/api/runs`、`/api/capabilities/models`、`/api/a2a/config`，均得到 HTTP 401 `Authentication required`。本轮没有创建普通用户、第二浏览器身份、A2A 一次性凭据或定时任务，也没有删除会话/文件、执行危险命令、重启 Worker 或 hard-kill exec；因此 AUTH-02、USER-01、SEC-02、A2A-02、CRON-02、CTX-01、REC-01/02 等仍是阻塞/未执行，而不是通过。

Browser 测试产生的合成会话和工作区测试文件未清理。清理会删除持久化或工作区数据，当前没有得到单独的清理确认，故不在本轮擅自执行。

## 6. 与当前验收缺口的对应关系

| 当前 STATUS 风险面 | 主要案例 |
|---|---|
| A1/A2/A3/A4：DSH runtime、工具面、MCP、会话恢复 | TOOL-01、INPUT-01、SKILL-02、MCP-01、A2A-02、REC-01 |
| C1/C4/C6/C7/C8：exec 文件、隔离、作业、搜索/数据集/产物 | TOOL-01、TOOL-02、TOOL-03、ART-01、PROC-01、JOB-01、ISO-01、REC-02 |
| D1–D8：前端恢复、消息、Run、审批、追踪、A2A 页 | CHAT-01/02/05/06、RUN-01/02、INPUT-01、APPROVAL-01、TRACE-01、UI-01 |
| E2/E3：Dataset、Artifact 快照和 owner-scoped 下载 | TOOL-02、ART-01、SEC-02 |
| F1–F6：A2A surface、凭据、任务和审计 | A2A-01、A2A-02、SEC-01/02 |
| G2/G7：Worker/exec 重启和 hard-kill | REC-01、REC-02 |
| H1–H4：租户、路径、Skill、非 root/隔离 | SEC-02、SEC-03、SKILL-01/02、ISO-01 |
| 无对应 STATUS 条目（本轮新增的真实使用面） | USER-01（非 admin 主链路 + 并发）、CTX-01（上下文压缩）、BUDGET-01（预算条） |

## 7. 修复后最终复测结果（2026-09-02）

### 结论

首次实测发现的运行时缺陷已按根因修复，并在统一重建后的 Compose 栈上完成 Browser 关键路径复测。可以确认本轮修复覆盖的路径已通过；不能据此宣称全量验收完成，因为普通用户/跨租户、A2A 凭据 JSON-RPC、上下文压缩、预算边界、Worker/exec 故障恢复和 Linux 隔离深测仍未执行。

### Browser 最终复测

| 案例 | 结果 | 最终证据 |
|---|---|---|
| ENV-01/ENV-02 | 通过 | `agent`、`api-server`、`sandbox`、`sandbox-mcp`、`frontend` 统一重建并重建容器；全部服务健康，Worker recovery scan 和 BullMQ consumer 正常，前端可交互 |
| TOOL-01 | 通过 | 全新搜索 Run `Succeeded`，3 个工具，返回 `REGRESSION_SEARCH_FINAL_OK` |
| TOOL-02 | 通过 | 全新 CSV Run `Succeeded`，Dataset 1 个，读取 3 行，列为 `id, name, amount`，返回 `REGRESSION_ATTACHMENT_FINAL_OK` |
| TOOL-03 | 通过（docx） | 全新 docx Run `Succeeded`，7 个工具；首个 `skill` ToolExecution 为 `completed · internal`，后续校验/转换完成，返回 `DOCX_SKILL_REGRESSION_OK` |
| TOOL-04 | 通过（图片） | 全新图片 Run `Succeeded`，Dataset 1 个，模型读取图片后返回 `REGRESSION_IMAGE_FINAL_OK`，识别黑/白主色 |
| ART-01 | 通过 | 全新 Artifact Run `Succeeded`，2 个工具，返回 `REGRESSION_ARTIFACT_FINAL_OK` |
| SUB-01 | 通过 | 全新父 Run `Succeeded`，出现结构化 Sub-agent 卡片，返回 `SUBAGENT_FINAL_OK 42` |
| JOB-01 | 通过 | 全新后台 job Run `Succeeded`，3 个工具，完成 job/output 回读并返回 `JOB_FINAL_OK` |
| INPUT-01 | 已进入等待 | 全新路径显示 `Waiting input`、A/B 选项和 `Run Waiting input`；为避免代替用户作答，本轮没有继续回答或删除该会话 |

### 自动化与类型检查

- `uv run pytest -q`：98 passed。
- `npm test --prefix exec`：320 tests，319 passed，1 skipped，0 failed。
- `npm test --prefix contract`：29 passed。
- `npm test --prefix agent`：1204 passed，0 failed。
- `npm test --prefix api-server`：145 passed，0 failed。
- `npm test --prefix frontend`：326 passed，0 failed。
- `npx tsc --noEmit -p exec/tsconfig.json`、`contract/tsconfig.json`、`frontend/tsconfig.json`，以及 `npm --prefix agent run typecheck`：全部通过。

### 修复范围摘要

| 缺陷面 | 修复内容 |
|---|---|
| 搜索与路径 | 修正 exec `find/grep` 的 workspace target 解析与校验 |
| Dataset/附件 | 使用原始 Blob 请求体、转发文件名，并按 session/workspace 正确映射 |
| Artifact | 固定对外 snake_case schema、正确关联 sandbox session 并恢复产物投影 |
| 图片 | 使用 DSH attachment 引用、补齐 Vision 模型元数据和 patch |
| 投影 | 结构化解析工具结果，修正 interaction、subagent、job/process 的账本与 UI 投影 |
| Skill | 为每个 Agent 安装本地只读 Skill provider，避免被远程 workspace FS 隐藏；等待 setup fiber 完成后再发布能力 |
| Worker | durable 子 Agent 直接 content block prompt 转换为任务，并将默认并发提升为 4 |

### 仍未宣称通过的范围

`AUTH-02`、`USER-01`、`SEC-02`、`A2A-02`、`CRON-02`、`CTX-01`、`BUDGET-01`、`REC-01`、`REC-02` 以及 `ISO-01` 的 Linux/bwrap/quota/hard-kill 深测仍未执行或仅有部分只读证据。测试产生的合成会话和工作区文件也未擅自清理，因为删除会造成持久化副作用。

## 8. 2026-09-03 增量案例与全量复测

本节是当前提交的最新证据；§4–§7 的历史结果和失败对照保持不改写。操作主面为 `@Browser`，必要时用不带敏感输出的 HTTP/容器检查补充。测试用户均为合成账号，密码、Cookie、token、DSN 和数据库值不写入报告。

### 8.1 今日新增案例

| 案例 | 结果 | Browser / 容器证据 |
|---|---|---|
| AUTH-03 | 通过 | 普通用户注册后显示 `user`；刷新后 Capabilities、Runs、Approvals 和 Chat 均可用；完成 `REGRESSION_AUTH_PROVISIONED_OK`，登出/登录后历史仍在 |
| NAV-01 | 通过 | Settings 二级导航可用；`/runs`、`/approvals` 分别重定向到 `/settings/runs`、`/settings/approvals`；Composer 中已移除旧安装按钮 |
| SKILL-03 | 通过 | `.zip` 与 `.skill` 均进入当前用户 Drafts，保持未启用；`.txt` 被拒；刷新后仍在；Enable 后出现 My Skills 副本，Disable 后 My Skills 清空且 Draft 保留 |
| ART-02 | 通过（导入/刷新） | 源 Artifact 导入目标会话后，目标 workspace 可被模型读取；刷新目标会话后再次 grep 得到 `REGRESSION_ARTIFACT_REFRESH_OK`；跨用户导入/下载均为 404 |
| INPUT-02 | 通过 | WAITING_INPUT 刷新、切换会话后仍可回答；两个并发重复点击只产生一次 `REGRESSION_INPUT_DUPLICATE_OK`，Run 最终收敛 |
| SEC-03B | 通过 | DB 环境变量在沙箱内仅以非空检查使用；运行期间逐项检查 bwrap cmdline 均为 `absent`，不输出值；后台 job 通过 `job_kill` 后 exec 账本为 `killed: SIGTERM`，无残留 bwrap/bash/sleep |

`ART-02` 曾在修复前真实复现：BFF 把目标 Sandbox Session id 直接交给 exec，而模型执行实际按 `workspace_id` 进入工作区，导致“导入成功但模型看不到文件”。根因修复为先由 Agent 解析目标 session 的 `workspace_id`，再调用 exec；BFF 对外仍返回目标 session。API 代理测试在旧实现下失败，修复后 3 条通过。前端另补了“Artifact 列表省略 `run_id` 时仍保留 session 级条目”的回归测试。

取消语义也重新核对过：Run 取消不会自动杀掉 DSH 明确创建的后台 job，后台 job 应由 `job_kill` 回收；把前者误当成 orphan 是错误前提。今日 `job_kill` 真实链路已验证通过，但这不替代 REC-02 要求的 exec hard-kill/restart 验证。

### 8.2 累计案例矩阵

下表把昨日 §7 的 Browser 证据与今日增量合并；“部分通过/未执行/跳过”是有意保留的缺口，不以绿色单测替代真实链路。

| 状态 | 案例 |
|---|---|
| 通过 | ENV-01、ENV-02、AUTH-03、NAV-01、CHAT-01、CHAT-02、CHAT-03、CHAT-05、TOOL-01、TOOL-02、TOOL-03、TOOL-04、ART-01、ART-02、INPUT-01、INPUT-02、JOB-01、TODO-01、SUB-01、TRACE-01、CAP-01、SKILL-01、SKILL-02、SKILL-03、MCP-02、SEC-01、SEC-03B |
| 部分通过 | CHAT-06（刷新 catch-up 已测，关页/断网未测）、RUN-01、RUN-02、FAIL-01、APPROVAL-01、PROC-01（stdin 未单独闭环）、MGMT-01、MGMT-02、MCP-01、USER-01（第二身份用隔离 HTTP 客户端完成跨租户检查，未形成双 Browser 并发闭环）、SEC-02（Conversation/Run/Dataset/Artifact/Process/import/download 已测，Cron/Skill 全集未测）、SEC-03（未执行破坏性命令）、ISO-01、UI-01 |
| 未执行或按要求跳过 | AUTH-01、AUTH-02、CHAT-04、CRON-01、CRON-02、A2A-01、A2A-02、CTX-01、BUDGET-01、REC-01、REC-02 |

AUTH-01/AUTH-02/A2A-01/A2A-02 的管理员管理分支按本次请求跳过；普通用户访问 A2A 的拒绝分支已在 SEC-01 验证。CHAT-04、Cron CRUD/删除和凭据撤销涉及持久化破坏或安全凭据副作用，依仓库规则未在没有操作时确认的情况下执行。CTX-01 与 BUDGET-01 当前仍分别受 256k 压缩阈值和未配置预算维度阻塞。

### 8.3 SEC-03B 修复记录

真实根因是 exec 原先用 bwrap `--setenv KEY VALUE` 组装执行环境；配置的业务 DB 值因此可从同容器进程参数看到。修复后：

1. `render()` 增加 `inherited` 环境模式，只校验环境计划，不把值写入 argv。
2. `spawnLaunch()` 以固定 `OUTER_PROCESS_ENV` 为基线叠加 profile 环境，通过 Node spawn 的 `env` 传给 bwrap；未恢复完整宿主环境继承。
3. 新增 `resolveInvocation()`、`render()`、`spawnLaunch()` 三层回归断言；旧实现下的 argv 断言先失败，修复后通过。

这里保留显式 allowlist 的业务 DB 环境能力，因为 `.env.example` 明确支持该用途；平台 token、JWT、服务密码仍由 safe-env 拒绝。模型只收到固定标记，不收到任何环境值。

### 8.4 自动化与真机验证

完成四个受影响镜像的统一重建：`agent`、`api-server`、`sandbox`、`sandbox-mcp`；两条 Sandbox 入口使用同一新镜像。重建后所有 Compose 服务 healthy/running，BFF live/ready、Sandbox health 均返回 200。

六套测试和类型检查均重新执行：

- `uv run pytest -q`：98 passed。
- `npm test --prefix exec`：324 tests，323 passed，1 skipped，0 failed。
- `npm test --prefix contract`：29 passed。
- `npm test --prefix agent`：1209 passed，0 failed。
- `npm test --prefix api-server`：146 passed。
- `npm test --prefix frontend`：333 passed。
- `npx tsc --noEmit -p exec/tsconfig.json`、`contract/tsconfig.json`、`frontend/tsconfig.json`，以及 `npm --prefix agent run typecheck`：全部通过。

### 8.5 仍不能宣称的事项与测试产物

- `REC-01` 未重启 Worker；`REC-02` 未 hard-kill exec，因此没有把正常 `job_kill` 结果外推为 restart/orphan recovery 通过。
- Artifact 控制面当前为进程内存 store；本轮观察到 Sandbox 重启后源 Artifact 索引不保留。因此 ART-02 只宣称“导入与页面刷新”，不宣称 exec 重启后的 Artifact 恢复。
- 生成的合成 Conversation、workspace 文件、Draft 和 Artifact 未删除；删除会改变持久化状态，需在 Browser 执行前再次确认。本轮不把它们当作生产数据。

## 9. 2026-09-03 后续非管理员实测与修复

本节继续追加在 §8 之后，不改写历史结论。今日主操作面仍为 `@Browser`，账号为新建的合成普通用户；管理员专属路径按请求跳过。所有本轮创建的四个测试定时任务均已暂停，合成会话、文件、Draft 和 Artifact 仍未删除。

### 9.1 新增与升级案例

| 案例 | 结果 | 证据 |
|---|---|---|
| CHAT-06 | 通过 | 正在运行时刷新页面后，Run 最终显示 `Succeeded` 并出现 `CHAT06_RECOVERY_OK`；关闭页面、从 Recent conversation 重新打开后，`CHAT06_CLOSE_OK` 仍可见。 |
| RUN-01 | 通过 | 前台 `sleep` 运行中点击 Stop，页面收敛为 `Cancelled`，没有 `RUN01_FOREGROUND_SHOULD_NOT_COMPLETE`；此前也用容器内进程表确认 SIGTERM 后进程消失。 |
| RUN-02 | 部分通过 | Running 状态提交 Follow-up 后，基础输出和 `RUN02_FOLLOWUP_OK` 均出现；Steer/Resume 的完整语义仍未形成独立通过证据。 |
| CRON-01 | 部分通过 | 普通用户完成创建、编辑、Run now、暂停、History 和刷新；删除按钮涉及持久化破坏，本轮没有在未获即时确认时点击。 |
| CRON-02 | 通过 | 验证 `Asia/Singapore`/`America/New_York` 时区、`MISFIRE_SKIPPED`、`fire_once` 补跑、`CONCURRENCY_FORBID` 跳过，以及 `allow` 两次并发 Run 均为 `SUCCEEDED`。 |
| REC-01 | 通过 | Run 进入 `Waiting input` 后重启 `agent-worker`；刷新页面仍保留选项，回答后 Run 成功完成。 |
| REC-02 | 通过 | Run 创建后台 job 后 hard-kill `sandbox` 并重启；容器以 uid 10001 恢复，进程表没有残留 bwrap/bash/sleep，恢复后的无工具 Run 成功。 |
| PROC-01 | 部分通过 | 前台长命令在执行中被 DSH abort 并产生工具错误，页面随后收敛；尚未证明“完整 stdin 关闭/外部进程控制”契约。 |
| ISO-01 | 部分通过 | `sandbox`/`sandbox-mcp` 为 uid 10001、`cap_drop=ALL`，sandbox 使用 seccomp，exec PID 1 `CapEff` 全零，bwrap/setpriv 存在，内部网络为 `Internal=true`；compose 未配置 memory/pids quota，故不升级为全通过。 |

这里有一个需要纠正的测试前提：Run 取消不会自动杀掉由 DSH 明确创建的后台 job；该 job 应通过 `job_kill` 回收。今日已验证 `job_kill` 后 exec 账本为 `killed: SIGTERM` 且无残留，这不能替代 REC-02 的 sandbox hard-kill/restart 验证。

### 9.2 真实复现的前端回归与修复

在定时任务 History 面板打开时点击页面主 Refresh，Browser 中旧的 `QUEUED`/`RUNNING` 投影会停留；关闭并重新打开 History 才显示服务端最终状态。根因是 `SchedulesPage.refresh` 只重新拉取任务列表，没有同步刷新当前选中任务的 execution history。

修复已落在 `frontend/src/pages/schedules/SchedulesPage.tsx`：刷新任务列表后，若当前任务仍存在则重新调用 `listCronJobRuns(selectedId)`；若任务已不存在则清空选中项和旧历史。新增 `scheduleHelpers.ts` 单测覆盖“选中任务存在/不存在/空选择”三种边界。该回归测试在修复前对应的行为缺失，修复后通过。

### 9.3 累计矩阵

| 状态 | 案例 |
|---|---|
| 通过 | ENV-01、ENV-02、AUTH-03、NAV-01、CHAT-01、CHAT-02、CHAT-03、CHAT-05、CHAT-06、TOOL-01、TOOL-02、TOOL-03、TOOL-04、ART-01、ART-02、RUN-01、INPUT-01、INPUT-02、JOB-01、TODO-01、SUB-01、TRACE-01、CAP-01、SKILL-01、SKILL-02、SKILL-03、MCP-02、SEC-01、SEC-03B、CRON-02、REC-01、REC-02 |
| 部分通过 | RUN-02、FAIL-01、APPROVAL-01、CRON-01、PROC-01、MGMT-01、MGMT-02、MCP-01、USER-01（第二身份用隔离 HTTP 客户端完成跨租户检查，未形成双 Browser 并发闭环）、SEC-02、SEC-03、ISO-01、UI-01 |
| 跳过/未执行 | AUTH-01、AUTH-02、CHAT-04、A2A-01、A2A-02、CTX-01、BUDGET-01 |

AUTH-01/AUTH-02 和 A2A 管理/凭据路径按本次“不测 admin”范围跳过；CHAT-04 与 CRON-01 的删除动作需要操作时确认，因此只记录其余正向路径。CTX-01、BUDGET-01、完整 PROC-01 stdin、Steer/Resume、双 Browser 并发和 ISO quota 仍是未关闭缺口，不用自动化绿灯替代。

### 9.4 自动化与真机验证

在前一个提交 `fe9ab5f9` 已完成四个受影响镜像的统一重建和真机链路验证；本次前端修复后重新执行六套测试、类型检查和前端构建：

- `uv run pytest -q`：98 passed。
- `npm test --prefix exec`：324 tests，323 passed，1 skipped，0 failed。
- `npm test --prefix contract`：29 passed。
- `npm test --prefix agent`：1209 passed，0 failed。
- `npm test --prefix api-server`：146 passed，0 failed。
- `npm test --prefix frontend`：334 passed，0 failed。
- `exec`、`contract`、`frontend` 的 TypeScript 检查、`npm --prefix agent run typecheck` 和 `npm run build --prefix frontend`：全部通过。

没有在报告、日志或命令输出中写入密码、Cookie、token、DSN、API key 或数据库值。
