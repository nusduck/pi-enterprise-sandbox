# 全功能回归测试案例

## 1. 判定规则

每条案例填写 `未执行`、`部分通过`、`通过`、`失败` 或 `阻塞`。环境、账号、模型或 MCP 未就绪时记为 `阻塞`，不能记为通过；同一案例中只有部分断言成立时记为 `部分通过`。

每条通过/失败记录至少包含：执行时间、浏览器入口、会话/Run/资源 ID、关键页面现象、必要的 HTTP/容器证据。截图不得包含密码、Cookie、Bearer token、API key、完整内部路径或个人数据。

### 测试数据

使用以下合成内容，实际文件放在 `.runtime/` 或系统临时目录，不提交仓库：

- `rt-20260901-note.txt`：`REGRESSION_FILE_OK`
- `rt-20260901-table.csv`：3 条虚构记录，金额和姓名均为非真实数据
- `rt-20260901-专项汇报.md`：中文文件名；内容 `REGRESSION_UNICODE_OK`
- `rt-20260901-report.md`：提交 Artifact 用的短报告
- `rt-20260901-sheet.xlsx`：一张 3 行虚构表（可用系统 `xlsx` Skill 生成，不必预置二进制）
- 可选图片：一张小于 2MiB 的 PNG，文件名 `rt-20260901-chart.png`，内容为合成柱状图
- 文本断言标记：`REGRESSION_PLAIN_OK`、`REGRESSION_ATTACHMENT_OK`、`REGRESSION_PROCESS_OK`、`REGRESSION_UNICODE_OK`、`REGRESSION_OFFICE_OK`、`REGRESSION_SKILL_OK`、`A2A_REGRESSION_OK`

### 真实使用最小闭环（空库必跑，不可跳）

本地刚 `down -v` 后没有用户、没有会话。按这个顺序先跑完，再并行其余案例：

1. ENV-01 → ENV-02
2. AUTH-02（空库注册）→ AUTH-01（登录/刷新/登出）
3. CHAT-01（纯文本）→ TOOL-01（工作区）→ TOOL-02（上传）
4. TOOL-03（系统办公 Skill，真实使用主路径）→ ART-01（含中文显示名）
5. SKILL-02（模型写草稿）→ SKILL-01（启用/停用）
6. RUN-01（取消/刷新）→ CHAT-04（删会话）→ CHAT-05（后台 Run）
7. USER-01（普通用户正向闭环 + 双人并发）
8. SEC-01 / SEC-02 / SEC-03

MCP 未配置时 MCP-01 记 `阻塞`，不能拿空清单当「MCP 可用」。Vision 模型未配置时 TOOL-04 的图片分支记 `阻塞`。

## 2. 执行顺序与总览

先执行环境门槛，再执行 P0 主链路；P1 管理功能和安全/恢复链路可以并行，但必须保留依赖关系。

| ID | 优先级 | 场景 | 操作面 | 预期结果 |
|---|---|---|---|---|
| ENV-01 | P0 | 重建镜像、启动和健康检查 | Compose + HTTP | 所有必需服务就绪；确认运行的是本分支镜像 |
| ENV-02 | P0 | Browser 前端入口 | Browser | 页面可打开，无阻塞性加载错误 |
| AUTH-02 | P0 | 空库注册与管理员名单 | Browser | 名单内用户名注册即为 admin；客户端 `role` 不被采信 |
| AUTH-01 | P0 | 管理员登录、刷新、登出 | Browser | `admin` 会话角色为 admin；登出后受保护资源不可用 |
| CHAT-01 | P0 | 新会话和无工具对话 | Browser | 流式状态、消息落库、Run 成功和标题正常 |
| CHAT-02 | P0 | 多轮、追问、重新生成 | Browser | 顺序正确，同一会话不重复、不串会话 |
| CHAT-03 | P0 | 模型选择按会话隔离 | Browser | 会话 A/B 的模型选择互不覆盖 |
| CHAT-04 | P0 | 删除会话与空态 | Browser | 删除后列表/直链不可用；不删他人会话 |
| CHAT-05 | P0 | 后台 Run 与会话切换 | Browser | 切会话不取消后台 Run；侧栏标记正确 |
| CHAT-06 | P1 | 关页/断 SSE 后 Run 继续 | Browser | Worker 继续；重开能追上终态 |
| TOOL-01 | P0 | 文件读写、编辑、搜索和 bash | Browser → Agent | 当前工具名语义正确，路径不越界 |
| TOOL-02 | P0 | 附件上传和 Dataset 读取 | Browser → Sandbox | 上传可用，模型能读取，重复文件不覆盖 |
| TOOL-03 | P0 | 系统办公 Skill 真任务 | Browser | xlsx/pdf/docx/pptx 至少两条链路产出可下载件 |
| TOOL-04 | P0 | 中文路径、python、粘贴图片 | Browser | Unicode 文件可读写；python 经 bash；图片可分析或明确降级 |
| ART-01 | P0 | Artifact 提交、下载和不可变快照 | Browser | 下载字节正确；提交后修改工作区不影响快照 |
| RUN-01 | P0 | Run 状态、取消、刷新恢复 | Browser | 状态最终收敛，无重复事件或永久 Running |
| RUN-02 | P1 | steer、follow-up 和中断续跑 | Browser | 改向/排队/恢复语义正确 |
| FAIL-01 | P1 | 失败 Run 与模型错误 | Browser | 明确 FAILED，可新开一轮，不丢历史 |
| INPUT-01 | P1 | ask_user_question 等待输入与回答 | Browser | `WAITING_INPUT` 可持久化并恢复 |
| APPROVAL-01 | P1 | 高风险工具审批 | Browser | Pending → approve/reject；参数不匹配不能复用 |
| PROC-01 | P1 | 长进程控制台、日志、stdin、信号 | Browser → exec | 增量日志、控制和终态正确 |
| JOB-01 | P1 | DSH job_list / job_output / job_kill | Browser | 作业工具与 Process Console 对得上同一 process id |
| TODO-01 | P1 | todo_write 任务卡 | Browser | 清单来自 arguments / 事件，不从 result 解析 |
| SUB-01 | P1 | 子 Agent | Browser | 结构化卡片；子会话不进侧栏；父取消级联 |
| MGMT-01 | P1 | Runs 页面 | Browser | 筛选、详情、日志、打开和取消正确 |
| MGMT-02 | P1 | Approvals 页面 | Browser | 筛选、参数展开、批准/拒绝和回到会话正确 |
| TRACE-01 | P2 | Trace 面板 | Browser | span 树可看，不含密钥/工具原文 |
| CAP-01 | P1 | Capabilities 与诊断 | Browser | Skills/MCP/Tools/Models/diagnostics 与后端一致且不泄密 |
| SKILL-02 | P0 | 模型在草稿根搭包 | Browser | 草稿不进 prompt；Enable 前模型不能当已启用 Skill 调用 |
| SKILL-01 | P1 | 用户 Skill 启用、使用、停用 | Browser | 仅启用包可被执行，停用后不可见/不可用 |
| MCP-01 | P1 | 真实 MCP 工具调用 | Browser | 有配置则 `mcp__*` 可调用；空配置记阻塞 |
| MCP-02 | P2 | sandbox-mcp 对外 facade | HTTP | 独立 token；够不到 `/internal/v1/*` |
| CRON-01 | P1 | 定时任务 CRUD、立即运行和历史 | Browser | 创建、暂停、恢复、编辑、执行、历史、删除正确 |
| CRON-02 | P2 | 时区、misfire、concurrency | Browser | 策略按页生效；同一时刻不重复触发 |
| A2A-01 | P1 | Agent Card、凭据和撤销 | Browser + HTTP | admin 可管理；凭据作用域、轮换、撤销正确 |
| A2A-02 | P1 | A2A JSON-RPC 流式与重订阅 | HTTP | SSE 有最终事件和最终正文，任务可查询/重订阅 |
| USER-01 | P0 | 普通用户正向主链路与双人并发 | Browser 多身份 | 非 admin 也能完成聊天→上传→办公件→交付物；两人同时跑 Run 不互相干扰 |
| CTX-01 | P1 | 长会话自动压缩 | Browser | 触发 compaction 后上下文不丢关键事实，Run 不失败 |
| BUDGET-01 | P2 | 预算用量条与超限 | Browser | 有 usage 时显示 Budget 条；near limit / exceeded 有明确提示 |
| UI-01 | P2 | 侧栏、详情、主题、键盘和响应式 | Browser | 不丢状态，主要控件可操作 |
| SEC-01 | P0 | 未登录和非 admin 访问 | Browser + HTTP | 受保护面 fail-closed；A2A 对普通用户 403 |
| SEC-02 | P0 | 跨租户资源访问 | Browser 多会话 + HTTP | Conversation/Run/Artifact/Dataset/Process/Cron 统一 404 |
| SEC-03 | P0 | 路径、命令和敏感信息安全 | Browser → Agent | 越界/危险命令拒绝；物理路径和凭据不进入输出 |
| ISO-01 | P0 | Bubblewrap、非 root、网络和配额 | 容器检查 | 隔离配置生效；不满足时拒绝执行 |
| REC-01 | P0 | Worker 重启后的会话/交互恢复 | 容器 + Browser | MySQL 权威事实保留，Run 可继续或明确终态 |
| REC-02 | P1 | exec hard-kill 与 orphan 回收 | 容器 + HTTP | 孤儿作业可发现、清理，账本不出现假 Running |

## 3. 详细测试案例

### ENV-01：重建镜像、启动和健康检查

**前置**：`.env` 已配置，但不在报告中显示任何密钥；若启用真实模型，确认 LLMIO 可用。

**步骤**

1. 按仓库要求同时重建 `agent`、`api-server`、`sandbox`、`sandbox-mcp`；若前端镜像也有改动，一并重建 `frontend`。
2. 启动完整 Compose 栈，检查 `agent-migrate` 已成功退出，Agent Worker、Agent、BFF、Sandbox、MCP facade、MySQL、Redis、`sandbox-replay-redis`（重放/幂等库，与主 Redis 是两个实例，不能只看一个）和前端均处于预期状态。
3. 检查 BFF `/health/live`、`/health/ready` 与 Agent/Sandbox 探针；确认镜像时间/版本对应当前分支。
4. 对 `sandbox` 和 `sandbox-mcp` 使用同一重建镜像，不能只重建其中一个。

**通过标准**：readiness 为健康；依赖未就绪时 BFF 返回 degraded/503 而不是假成功；没有缺失 HMAC、JWT、MCP 或数据库配置后仍放行的情况。

### ENV-02：Browser 前端入口

1. 在 Browser 打开前端入口，等待 `Restoring session…` 消失。
2. 检查侧栏、Chat、Runs、Approvals、Schedules、Settings 是否能渲染。
3. 检查页面控制台是否有持续的网络/JavaScript 错误；只记录错误摘要，不复制 Cookie、响应中的 token 或密钥。

**通过标准**：页面可交互；后端未启动时应显示可理解的错误/空态，不能伪装成已有数据。

### AUTH-02：空库注册与管理员名单

空库（刚 `docker compose down -v`）没有账号。管理员身份只来自 `SANDBOX_AUTH_ADMIN_USERNAMES`，注册接口忽略客户端提交的 `role`。

1. 打开 `Sign In / Register`，用名单内用户名（通常是 `admin`）走 **Register**，密码只在表单输入。
2. 确认注册后直接进入已登录态，用户区角色为 `admin`，侧栏出现 A2A。
3. 登出后用一个**不在名单内**的用户名再 Register，确认角色为普通 `user`，没有 A2A 入口。
4. 用浏览器开发者工具或 HTTP 客户端给 `/api/auth/register` 塞 `role=admin` / 自选 `organization_id`，确认被忽略。

**通过标准**：名单内注册即 admin；名单外不能靠请求体提升；JWT 只进 HttpOnly Cookie，前端 JS 读不到明文。

**admin 已存在时**：步骤 1/2 属于空库一次性路径，库里已有 admin 就不要为了跑它去 `down -v`（会清掉本轮全部证据）。记「本轮前已完成，未复现」，直接跑步骤 3/4——名单外用户名注册为普通 `user`、请求体 `role=admin` / 自选 `organization_id` 被忽略——这两步任何时候都可跑，且是本案例真正的安全断言。步骤 3 注册出来的普通用户请保留，USER-01 与 SEC-01/02 都要用它。

**阻塞判定**：`SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER=false` 时记阻塞并改走已有账号登录；JWT secret 缺失导致注册 5xx 记部署前置，不是前端缺陷。

### AUTH-01：管理员登录、刷新、登出

1. 若 AUTH-02 已注册，先登出。点击 `Sign In / Register`，用同一 `admin` 凭据 **Login**。
2. 检查用户区显示用户名和 `admin` 角色，侧栏出现 A2A 入口。
3. 刷新页面并重新打开 Chat、Runs、Settings，确认会话仍有效。
4. 点击用户区的 `Log Out`，确认回到未登录状态；直接访问受保护 API/页面，确认被拒绝或返回未登录空态。
5. 用一次错误密码检查错误提示，不进行连续尝试以免触发部署侧锁定策略。

**通过标准**：登录成功只能以服务端返回的 admin 身份为准；浏览器 JavaScript 不得到 JWT 明文；登出会清理会话。

**阻塞判定**：`admin` 不存在时先跑 AUTH-02，不要用普通账号代替管理员验收 A2A。JWT secret 缺失或管理员名单未配置时记 `AUTH-01 blocked`。

### CHAT-01：新会话和无工具对话

1. 点击 `New Chat`，确认出现欢迎页和四个 prompt starter。
2. 输入 `请只回复 REGRESSION_PLAIN_OK，不调用工具。`，发送。
3. 观察 `ACCEPTED/QUEUED/RUNNING` 等中间状态、流式正文和最终 `Succeeded`。
4. 检查侧栏标题、当前会话、Run 状态、耗时、模型和最终正文；刷新后确认消息仍在。

**通过标准**：用户消息和 Agent 消息各出现一次；SSE 最终事件收尾；Run、Conversation 和 session 关联一致；不出现宿主机物理路径或密钥。

### CHAT-02：多轮、追问、重新生成

1. 在 CHAT-01 的会话发送第二轮确定性问题，确认消息追加到原会话。
2. 在 Run 运行期间切换 `Steer`，输入短指令；若当前状态不允许 steer，验证 UI 自动提供 `Follow-up` 并在当前 Run 后排队。
3. Run 完成后，对最后一个 Agent 回复使用 `Regenerate`，确认只重发上一条用户内容。
4. 切换到另一会话再回来，检查顺序、Run ID 和正文没有串线或重复。

**通过标准**：follow-up 创建新 Run 但保持同一 Conversation；重生成不改写历史用户消息；后台 Run 不因切换会话而被错误取消。

### CHAT-03：模型选择按会话隔离

1. 会话 A 选择模型 M1，发送包含 `MODEL_A_OK` 的确定性问题。
2. 新建会话 B 选择 M2，发送包含 `MODEL_B_OK` 的确定性问题。
3. 回到 A，刷新并确认仍显示 M1；回到 B，确认仍显示 M2。

**通过标准**：模型选择保存在会话维度，不能由最近一次全局选择覆盖。若只有一个模型可用，记为 `blocked`，不能声称隔离通过。

### CHAT-04：删除会话与空态

1. 在侧栏对一条测试会话点删除（垃圾桶），确认当前视图回到欢迎页或另一会话。
2. 刷新后该会话不再出现在 Recent Conversations。
3. 用原 Conversation ID 请求 `/api/conversations/{id}` 与 `/api/runs?conversation_id=`，确认 404 或不返回该会话数据。
4. 用用户 B 的 ID 尝试删除用户 A 的会话，确认 404。

**通过标准**：删除是 owner-scoped 的持久化副作用；工作区/附件随会话回收的行为按实际契约记录。执行前再次确认，只删 `rt-20260901-` 测试会话。

### CHAT-05：后台 Run 与会话切换

1. 会话 A 发起一个可持续数十秒的合成 Run（例如 bash sleep + 打印标记）。
2. 在 Running 时点 `New Chat` 打开会话 B，发一条短问题。
3. 确认 A 的 Run 仍在跑：侧栏 A 有 active 标记，Runs 页能看到 A；B 的发送没有取消 A。
4. 切回 A，SSE/history catch-up 补齐已有正文和工具步骤，不重复气泡。

**通过标准**：focus 改变只切 UI，不 abort 其他 conversation 的 fetch controller；后台 Run 与前台 Run 的 ID 不串。

### CHAT-06：关页/断 SSE 后 Run 继续

1. 发起一个可持续的 Run，确认已进入 RUNNING。
2. 关闭标签页或停掉浏览器网络数秒（不要停 Worker）。
3. 重新打开同一会话，确认 Run 仍在或已到明确终态，消息可 catch-up。

**通过标准**：浏览器断开不取消 Run（Worker 所有权）；重连后无永久 Running、无重复助手气泡。

### TOOL-01：文件读写、编辑、搜索和 bash

当前模型工具面是 DSH 出厂名：`read` / `write` / `edit` / `glob` / `grep` / `bash`（`ls`/`find` 已映射为 `glob`，不要按旧工具卡验收）。

让 Agent 在当前测试会话中完成一个可验证的小任务：创建 `rt-20260901-note.txt`，读取并编辑内容，再用 `glob`/`grep` 找到它，最后用 bash 输出 `REGRESSION_FILE_OK`。

**检查点**

- 时间线中的工具名是出厂名，不是 `ls`/`find`/`python`/`skill_install`；点击工具卡可以展开详情。
- 一轮「出文本 → 调工具 → 再出文本」合并成**一个**助手气泡，步骤树默认折叠。
- 读取/编辑前后内容符合预期，版本冲突不会静默覆盖。
- 工作区外的绝对路径、`..`、`~`、越界软链接均被拒绝，错误只显示 `<workspace>` 等脱敏根。
- 模型不可调用 Agent 容器本机文件系统、任意本机 shell 或未声明的工具。

### TOOL-02：附件上传和 Dataset 读取

1. 点击附件按钮或使用 `Ctrl/Cmd+U` 上传合成 `rt-20260901-table.csv`。
2. 等待附件卡显示文件名、大小和 `Ready`；测试上传中的按钮禁用、失败后的 `Retry`、移除附件。
3. 发送提示，要求 Agent 读取 CSV 并只返回 `REGRESSION_ATTACHMENT_OK` 以及行数。
4. 上传两个同名测试文件，检查各自目录和内容不覆盖；刷新后重新查看附件/会话。
5. 再上传一个**二进制办公件**（`rt-20260901-sheet.xlsx` 或一个小 PDF）和 `rt-20260901-chart.png`，确认上传不被按文本处理、大小/类型显示正确，且模型能通过 Skill 或 `read_image` 打开它——真实用户传的多数是这类文件，只测 CSV 不构成附件链路通过。

**通过标准**：上传超限/失败有明确错误码和 trace id；附件不整包暴露给无关会话；Dataset 发布是原子操作；模型只能读取当前会话数据。Run 进行中附件按钮与 Ctrl+U 禁用。拖放、多文件并发（最多 3 个）与移除/Retry 都要点到。

### TOOL-03：系统办公 Skill 真任务

这是本产品最常见的真实使用路径。系统 Skill 只读、永远进发现。至少跑两条，记录用了哪个包：

1. 上传或让模型生成 `rt-20260901-table.csv`，要求用 `xlsx` 做成工作簿，再 `submit_artifact`。
2. 要求用 `docx` 或 `pptx` 或 `pdf` 产出一份短报告（标题可用中文，如 `回归测试报告`），提交为 Artifact。
3. 可选：`convert-to-markdown` / `baoyu-format-markdown` 把上一份文档转成 md。

**检查点**

- 模型通过 `skill` 工具加载系统包，而不是声称没有办公能力。
- `bash` 执行 Skill 脚本时路径在 `scripts/` 下（允许嵌套，如 `xlsx/scripts/office/pack.py`）。
- 产出文件可在 Deliverables 下载，打开后内容可核对；LibreOffice/`~/.config` 在同一 Session 内应能保留配置（不要因为第二次调用丢宏/配置就当隔离成功）。
- 工作区 `write` **不会**自动出现在交付物列表。

**阻塞判定**：系统 Skill 根未挂载导致 bash 全挂，记部署故障，不是「办公 Skill 不可用」的产品结论。

### TOOL-04：中文路径、python、粘贴图片

1. 让 Agent `write` `rt-20260901-专项汇报.md`，内容含 `REGRESSION_UNICODE_OK`，再 `read` 回来。
2. 用 `bash` 跑一段多行 python（`python3 - <<'PY'` 或脚本文件），打印同一标记。没有独立 `python` 工具，时间线应是 `bash`。
3. 在输入框 Ctrl+V 粘贴一张合成 PNG（或上传 `rt-20260901-chart.png`）。若当前会话模型支持 vision（如 `deepseek-v4-flash-vision-exp`），要求描述图中内容；若不支持，确认图片被丢弃并在 prompt 里说明、文字请求仍能完成，Run 不 FAILED。

4. 让模型读取工作区里的那张 PNG，确认时间线出现 **`read_image`**（出厂 `dsh-tool-fs` 注册的第四个文件工具，见 `tool-names.ts`），而不是用 `read` 读二进制后乱码或直接声称做不到。

**通过标准**：Unicode 文件名不被 `visible ASCII` 拒掉；python 物化后能在 bwrap 里跑；粘贴图按 `pasted-image-<ts>-<n>.png` 命名；超 2MiB 图给出可操作错误而不是空结果；`read_image` 在非 vision 模型下给出明确降级理由而不是 Run FAILED。

### ART-01：Artifact 提交、下载和不可变快照

1. 让 Agent 创建 `rt-20260901-report.md` 并调用 `submit_artifact` 提交。再提交一次中文显示名（如 `回归测试报告.md`），内部路径保持 ASCII。
2. 在 Deliverables 面板点击下载，核对保存文件名（含后缀）、字节数和 SHA-256。浏览器 `download` 属性不得覆盖成 `artifact-download`。
3. 提交后修改工作区原文件，再次下载同一 Artifact；内容应保持提交时快照。
4. 在另一测试会话导入该 Artifact，确认目标会话出现工作区副本且没有新建重复 Artifact。
5. 用 `/api/files/download?session_id=&path=` 下载工作区未提交文件，确认这不是 Artifact 通道，且跨会话 404。

**通过标准**：只能通过 `artifact_id` 下载交付物；Artifact 与 owner/session 绑定；下载链接为同源 `/api/...`；中文 `filename*` 与 ASCII fallback 都有后缀。

### RUN-01：Run 状态、取消、刷新恢复

1. 发起一个可持续数十秒的合成 Run，并在页面显示 Running 时刷新。
2. 在刷新前后记录同一个 Run ID、Conversation ID、已有工具步骤和消息。
3. 对另一个运行中的测试 Run 点击 Stop/Cancel，确认出现必要的确认对话框并观察 `CANCELLING → CANCELLED` 或明确失败终态。
4. 打开 Runs 页面，再返回会话，确认 SSE/history catch-up 不重复消息、工具或 Artifact。

**通过标准**：没有永久 `RUNNING`、重复工具账本或丢失终态；取消写入 durable intent；刷新不取消仍在后台执行的 Run。

### RUN-02：steer、follow-up 和中断续跑

1. 在明确支持 steer 的 Running Run 上发送改向指令，验证当前 Run 的后续模型方向改变。
2. 用 `Follow-up` 排队下一条消息，确认它不会并发写同一会话工作区。
3. 人为中断本地测试 Run，刷新页面，确认出现 `Run was interrupted` 和 `Resume`。
4. 点击 Resume，确认恢复后使用原会话上下文，不重复执行已完成且不可重放的工具。

### FAIL-01：失败 Run 与模型错误

1. 选一个不存在的 `model_id`（或临时断开 LLMIO）发一条短消息。
2. 确认 Run 进入明确 `FAILED`，页面有可读错误，不出现永久 Running。
3. 恢复模型后在同一会话再发一条，确认新 Run 成功，旧失败气泡仍在。

**通过标准**：失败不吞掉用户原文；错误文本不含 API key / 物理路径；可继续开新 Run。

### INPUT-01：ask_user_question 等待输入与回答

工具名是 `ask_user_question`（旧名 `ask_user` 只用于渲染历史）。

1. 让 Agent 调用 `ask_user_question`，要求它等待用户选择。
2. 验证 Run 为 `WAITING_INPUT`，页面显示问题、选项和输入框，侧栏有待处理标记。
3. 切换到 Runs/Chat 或刷新页面，再回到会话，确认问题仍在。
4. 选择一个选项或输入文本，验证 `respond` 后 Run 恢复并最终收敛。

### APPROVAL-01：高风险工具审批

**前置**：必须有真实启用且 `require_approval` 的测试工具；如果当前配置没有这样的工具，记为阻塞，不把空的 Approval Center 当成审批链路通过。

1. 触发一次高风险但可安全撤销的测试调用，确认工具进入 Pending、Run 为 `WAITING_APPROVAL`，Approval Center 出现工具名、风险级别、原因、参数和 owner。
1b. **会话内审批横幅**：同一时刻 Chat 页顶部 FlashZone 应出现 `⚠ Approval required` 横幅（`role="alertdialog"`）及其自带的 Approve / Reject 按钮。真实用户绝大多数是在这里决策，不是去 Approvals 页。至少有一条审批走横幅按钮完成，确认它与 Approval Center 是同一条账本（页面刷新后状态一致，不会两处各算一次）。
2. 走一次 `Reject`，确认工具未执行、Run 有明确终态或可继续状态。
3. 对另一条完全相同参数的审批走 `Approve`，确认只允许这一条 ToolExecution 继续。
4. 改变命令或路径后重试，确认旧的 `source_digest`/参数授权不能复用。
5. 在停泊状态取消 Run，确认审批和 Run 都能回收。
6. 若同一轮有其它并行工具在飞，确认它们收敛为 `UNKNOWN` / `RUN_PARKED_PARALLEL_TOOL_UNKNOWN`，不留下永久 Running 账本。

### PROC-01：长进程控制台、日志、stdin、信号

**没有 `process_start` 工具**：`process_*` 整族已退役（`runtime/policy/tool-names.ts` 里只作为旧名别名映射到 `job_*`）。长进程由模型用 `bash` 起后台作业产生，exec 侧登记为 session process，前端 `Process Console` 读的是 BFF `/api/processes` → exec `/sessions/:id/processes`。若时间线出现 `process_start`，那是案例写错或旧快照，不是产品能力。

让 Agent 用 `bash` 启动一个只写测试标记、不会接触网络的长进程：先输出 `REGRESSION_PROCESS_OK_1`，等待 stdin，再输出 `_2`。

**检查点**

- 后台 `bash` 作业产生 process ID；Runs/时间线可打开 `Process Console`，且该 id 与 `job_list` 看到的一致（同一 exec 账本，见 JOB-01）。
- status 能看到 Running/完成；stdout/stderr 过滤和日志搜索可用。
- 连续读日志使用增量游标，不重复返回；可发送 stdin/EOF。
- 对仍在运行的进程发送指定 signal/cancel，状态与退出码最终一致；不要用自然结束后的进程冒充主动终止通过。
- 进程列表、详情和控制仅属于当前 owner；控制台关闭/重开不丢日志。
- BFF 走的是 exec `exec_jobs` 公共面（先由 Agent 授权 session），不是已删除的 Agent `/internal/processes*`。

### JOB-01：DSH job_list / job_output / job_kill

1. 让模型用后台 `bash` 起一个短作业，再调用 `job_list` / `job_output`。
2. 对照 Process Console 的 process id：DSH 透传的 id 应能在 exec 账本查到。
3. 用 `job_kill` 结束仍在跑的作业，确认状态与退出原因一致。

**阻塞判定**：若模型侧同步 `job_list` 还拿不到异步 exec 结果（STATUS C7 已知缺口），记 `partial/阻塞` 并写明现象，不要标通过。

### TODO-01：todo_write 任务卡

1. 发一个需要拆步的合成任务，确认模型调用 `todo_write`。
2. 时间线任务卡展示清单条目（pending/completed），而不是只显示 `Updated todo list: n pending`。
3. 刷新后清单仍在（arguments / `todo/write` 事件），不依赖 result JSON。

### SUB-01：子 Agent

1. 要求模型把一个可验证的小任务交给 `subagent`（one-shot）。
2. 父 Run 时间线出现结构化子任务视图（子 Run 状态），不是裸 JSON。
3. 侧栏 Recent Conversations **不出现**子 Conversation。
4. 取消父 Run，确认存活子 Run 也被写入 cancel intent 并收敛。
5. 子 Run 不得再问 `ask_user_question`（未注册）；父 Run 的提问仍走 INPUT-01。

### MGMT-01 / MGMT-02：Runs 与 Approvals 页面

在已有 Run/Approval 数据基础上执行：

- Runs 的 `All/Running/Waiting Approval/Waiting Input/Failed/Completed` 筛选；打开 Conversation；查看 Logs/Detail；对可取消状态执行 Cancel。
- Approvals 的 `All/Pending/Approved/Rejected/Expired/Cancelled` 筛选；展开/收起参数；批准/拒绝；打开关联会话；刷新后状态仍正确。

**通过标准**：API 数据和浏览器 entity store 合并后不重复；API 不可用时的空态明确标为降级，不冒充数据为空。

### TRACE-01：Trace 面板

1. 在已完成的带工具 Run 上打开 Details → Trace。
2. 确认有 span 树（至少 run.execute 与工具 span），时间与状态可读。
3. 刷新后仍能从 `/api/runs/{id}/trace` 重建；跨租户 404。

**通过标准**：span 不含工具输出原文、密钥、物理路径。没有 OTEL 后端不能当失败——本阶段只验 MySQL 投影。

### CAP-01：Capabilities 与诊断

依次打开 Settings 的 `Skills`、`MCP Servers`、`Tools`、`Models`、`Extension diagnostics`：

- 清单、状态、来源、风险等级、审批策略、超时、启用状态和模型协议与后端返回一致。
- 未配置 MCP/模型时显示可理解的空态；不因为空态误报“功能关闭”。
- 页面不显示 MCP secret、API key、Cookie、物理路径或完整内部凭证。
- 刷新后选中的页面和清单仍可用；配置错误应显式报错。

### SKILL-02：模型在草稿根搭包（用户 Skill 主创建路径）

`skill_create` / `skill_install` 已取消。模型用 `write`/`edit`/`bash` 写 `/home/sandbox/skill-draft/<package>/`。

1. 让 Agent 按 `skill-creator` 在草稿根建 `rt-20260901-echo`：`SKILL.md` 的 `name` 等于目录名，`scripts/echo.sh` 打印 `REGRESSION_SKILL_OK`。
2. 确认 Capabilities → Drafts 出现该包，`enabled=false`；`skill` 发现/prompt **没有**它。
3. 让模型直接 `skill` 调用该包，应失败或声明未启用。
4. 改草稿后再看：My Skills 仍没有它（两份字节，启用前不进挂载）。

**通过标准**：草稿可写、可自测、不进发现；系统 Skill 根仍只读。不要把 Composer 拼图按钮当成特权解包 API——它只是上传 ZIP 附件并预填「Install the attached Skill ZIP…」，真正落草稿仍靠模型解压/写入。

### SKILL-01：用户 Skill 启用、使用、停用

前置：SKILL-02 已有合法草稿，或手动把包写进草稿根。

1. 在 Capabilities Drafts 点 Enable。非法包（缺 SKILL.md、name 不匹配、symlink、`.git`、遮蔽系统同名、超 50MiB/512 文件）必须被拒，My Skills 不变，页面 `role="alert"`，UI 不乐观改写。
2. 启用成功后包进入 My Skills；同一会话让 Agent 用 `skill` 加载并跑 `scripts/echo.sh`，输出 `REGRESSION_SKILL_OK`。
3. 以另一个用户检查该包不可见、不可绑定。
4. 停用后再次尝试使用，确认它从 exec 挂载计划中消失；草稿仍在 Drafts。再 Enable 是整包替换。
5. （可选）拼图按钮上传 ZIP：只产生工作区附件 + 预填提示。模型解到草稿后走同一条 Enable。不要预期上传瞬间直接进 My Skills。

**通过标准**：系统 Skill 只读且无 Enable/Disable 按钮；用户 Skill 按 org/user 隔离；未启用包不能被模型当 Skill 执行。

### MCP-01：真实 MCP 工具调用

CAP-01 只验清单。这里验模型真的能调。

1. 打开 Capabilities → MCP Servers。若 `MCP_SERVERS_JSON=[]` 或 Agent `/ready` 因 MCP 失败，记 `阻塞`，不要标通过。
2. 发一条必须走外部 MCP 才能完成的短问题（例如配置了 Exa 就做一次检索）。
3. 时间线出现 `mcp__<server>__<tool>`；结果回包；无密钥进气泡。
4. 改 `MCP_SERVERS_JSON` 后**重启 Agent** 才生效；热改配置不应被当成已加载。

### MCP-02：sandbox-mcp 对外 facade

1. 对 `127.0.0.1:8082/health` 应 200。
2. 用 `SANDBOX_MCP_TOKEN` 调 MCP 面一条无害工具（如 health/execute 的最小命令）。
3. 同一 token 打 `sandbox:8081/internal/v1/*` 应失败；MCP 进程没有 workspace/artifact 挂载。

**通过标准**：MCP facade 与执行面同镜像不同入口、不同凭据；一次 RCE 拿不到完整内部面。

### CRON-01：定时任务 CRUD、立即运行和历史

1. 在 Schedules 创建名称带 `rt-20260901-` 的一次性或短周期测试任务，填写明确的时区和提示。
2. 检查列表、下一次执行时间和 Enabled 状态；执行 `Run now`，查看历史。
3. Pause/Resume，编辑提示和策略，确认列表与历史更新。
4. 删除测试任务并确认历史保留规则符合页面提示。

**通过标准**：服务端持久化任务；刷新/Worker 重启后不丢；同一时间点不重复触发；删除只影响测试任务。创建/删除属于持久化副作用，执行时需操作人确认。

### CRON-02：时区、misfire、concurrency

1. 创建一个 `timezone` 非 UTC 的一次性任务（`schedule_type=once`，`run_at` 在 2–5 分钟内），名称带测试前缀。
2. 创建一条 `concurrency_policy=forbid` 的短周期任务，在仍有一次 Run 未结束时点两次 `Run now`，确认不会并发写同一工作区。
3. 把 `misfire_policy` 在 `skip` / `fire_once` 间改一次，记录下一次执行时间是否按页面说明变化。
4. 测完删除这两条任务。

### A2A-01 / A2A-02：Agent Card、凭据和 JSON-RPC

**A2A-01 步骤**

1. 以 admin 打开 A2A 页面，确认 Agent、版本、Streaming、Authentication、Agent Card 和 Endpoint。
2. 创建只用于本轮的最小 scope 凭据；一次性 token 只在安全输入中短暂使用，不截图、不写文档、不提交剪贴板历史。
3. 验证 Agent Card 的版本、能力、协议和安全声明。
4. 轮换凭据，确认旧凭据失效、新凭据只显示一次；撤销后确认调用被拒绝。

**A2A-02 步骤**

1. 使用有效 scope 发送 A2A v0.3 JSON-RPC `message/stream`，要求返回 `A2A_REGRESSION_OK`。
2. 记录 SSE 的 submitted/working/消息/终态序列；确认有最终事件和最终 Agent 正文。
3. 用 `tasks/get` 查看历史，再用 `tasks/resubscribe` 重放；确认不重复创建 Run，不丢终态。
4. 用无效、过期、已撤销或 scope 不足的凭据重试，确认 fail-closed。

### USER-01：普通用户正向主链路与双人并发

SEC-01/SEC-02 只验普通用户「够不到什么」。产品的真实主用户就是普通用户，必须有一条**正向**闭环，否则「全功能通过」只覆盖了 admin。

用 AUTH-02 步骤 3 注册的名单外普通用户（另一个浏览器 profile 或隐身窗口，与 admin 会话并存）：

1. 登录后确认侧栏**没有** A2A 入口，其余 Chat / Runs / Approvals / Schedules / Settings 可正常进入。
2. 走一遍 CHAT-01 → TOOL-02 → TOOL-03 → ART-01 的最小闭环：纯文本对话、上传附件、用系统办公 Skill 产出一份文档、提交并下载 Artifact。
3. 确认这些资源只出现在该用户自己的列表里，admin 侧栏/Runs 页不混入（反向由 SEC-02 验证）。
4. **双人并发**：admin 与普通用户在同一时刻各自发起一个数十秒的 Run。确认两条 Run 各自到达终态，Runs 页各看各的，工作区、DSH session 和 process id 不串；worker 队列不会让一方饿死或把另一方的输出投给对方。

**通过标准**：普通用户能独立完成办公主路径并拿到可下载交付物；并发下无跨用户串线、无一方永久 QUEUED。

**阻塞判定**：`SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER=false` 且没有第二个可用账号时记阻塞，不要用 admin 跑两遍冒充多用户。

### CTX-01：长会话自动压缩

Agent 侧的 compaction 由 DSH `dsh-compaction` 负责，当前使用其默认策略（`enabled=true`、`reserveTokens=16384`、`keepRecentTokens=20000`）。真实用户的会话会跑到这条线上，但目前没有任何案例碰它。

1. 在一个测试会话开头让模型记住一个一次性口令（例如 `CTX_TOKEN_20260901`），并明确要求后续随时可复述。
2. 用可控方式把上下文推到压缩阈值：连续多轮让模型读写/输出较长内容（例如反复 `read` 一个几百行的合成文件并摘要），或直接选 `contextWindow` 较小的模型。记录轮次与大致 token 量。
3. 观察压缩发生时的页面表现：Run 不得 FAILED、不得卡在 RUNNING、不得出现重复助手气泡。
4. 压缩后让模型复述口令与最早一轮的关键约定，确认关键事实被保留而不是整段丢失。
5. 新开一个会话，确认它的压缩行为不受上一会话影响（策略来自 AgentVersion，不写回共享 settings）。

**通过标准**：压缩过程对用户是平滑的；压缩后仍能复述早期关键事实；策略不跨会话/跨租户泄漏。

**阻塞判定**：若当前可用模型的 `contextWindow`（deepseek 系为 262144）在合理轮次内推不到阈值，记 `阻塞` 并写明已尝试的轮次和 token 量，不要标通过。

### BUDGET-01：预算用量条与超限提示

`ConversationHeader` 在后端返回 usage 时渲染 `BudgetBar`（`budgetUsage` / `budgetLimits` / `budgetWarning`，含 `near limit` 与 `exceeded` 两种告警态）。

1. 跑几轮真实 Run 后观察会话头是否出现 Budget 条，摘要文本与百分比是否随用量变化。
2. 若部署配置了每 Run 预算，构造一次接近上限的 Run，确认出现 `near limit`；超限时确认出现 `exceeded` 且 Run 有明确终态（不是静默截断）。
3. 后端不返回 usage 时确认整条 Budget 条**不渲染**（而不是显示 0/0 或 NaN）。

**阻塞判定**：当前部署未配置预算维度时记 `阻塞`，不要把「不显示」当成通过——先确认后端确实没返回 `budget_usage`。

### UI-01：侧栏、详情、主题、键盘和响应式

1. 折叠/展开侧栏，切换 Chat、Runs、Approvals、Schedules、Settings；检查移动宽度下抽屉和遮罩。
2. 在时间线选择 Tool/Process/Task/Trace，打开 Details，把 Context Inspector 的**八个 tab 逐个点到**：`Overview` / `Tools` / `Processes` / `Files` / `Artifacts` / `Datasets` / `Trace` / `Session`，复制非敏感值。其中 `Files` 是从工具 arguments 反推的「本 Run 引用过的文件」（不是工作区列表），`Session` 显示 DSH session 归属——这两个 tab 有独立逻辑，不能靠点 Trace 顺带覆盖。tab 上的计数要与面板内条目数一致。
3. 切换亮/暗主题并刷新；检查主题和会话状态不丢。
4. 验证 Enter 发送、Shift+Enter 换行、中文输入法组合期间 Enter 不误发送、Ctrl/Cmd+L 新会话、Ctrl/Cmd+U 上传。
5. 产生长消息并滚动，检查 Jump to latest、代码 Copy、Regenerate 只在允许状态显示。
6. 有 thinking 的模型应出现可折叠 thinking 盒；流式时 `aria-live` 不逐 token 重读整段 transcript。
7. 拖放文件到输入区、粘贴图片、移动宽度下抽屉/遮罩再关。

### SEC-01：未登录和非 admin 访问

1. 登出后直接请求 `/api/conversations`、`/api/runs`、`/api/capabilities/tools` 和文件/进程接口。
2. 用普通测试用户打开 `/settings/a2a` 并请求 `/api/a2a/config`。
3. 检查健康探针仍按文档对外提供，业务数据不公开。

**通过标准**：受保护资源未登录被拒绝；普通用户访问 A2A 得到 403 `ADMIN_REQUIRED`；不透传浏览器伪造的 `X-Acting-*` 头；跨租户资源不返回 403 泄漏存在性。

### SEC-02：跨租户资源访问

准备用户 A 和用户 B 的独立会话。A 创建 Conversation、Run、Artifact、Dataset、Process、Cron 和已启用 Skill；B 使用 A 的资源 ID 直接打开对应页面或请求对应 API（含 `/api/files/artifact-download`、`/api/processes/{id}/signal`、`/api/capabilities/skills/{name}/enable`）。

**通过标准**：所有跨 owner/org 读取、下载、控制、导入和修改统一返回 404；B 的列表中不出现 A 的资源。Skill 启用态也按 owner 隔离。若单个浏览器无法保持两个 Cookie 上下文，使用独立浏览器 profile 或本地 HTTP 客户端补测，并记录方式。

### SEC-03：路径、命令和敏感信息安全

在测试会话中分别尝试 `../`、绝对路径、越界软链接、`sudo`、`rm -rf /`、`dd`、`mkfs`、危险权限修改和未声明工具。

**通过标准**：越界和硬拒命令在执行前被拒绝；硬拒命令不创建 Approval；错误文本不泄漏宿主机路径；模型消息、工具结果、SSE、审计和 Artifact 元数据不包含真实凭据或测试密钥原文。

### ISO-01：Bubblewrap、非 root、网络和配额

该案例不能只靠页面完成，需在已重建容器中补充检查：

- Sandbox/Sandbox-MCP 进程以 uid 10001 运行，exec 执行前剥离 capabilities；缺 `setpriv` 或隔离配置不完整时 fail-closed。
- `render(profile)` 与 preflight 使用同一隔离计划；workspace 和当前会话 `/tmp` 可写，Skill 只读，其他宿主根不可达。
- 按当前部署的 `SANDBOX_NETWORK_MODE` 验证断网/允许网行为，不把 development 的 unrestricted 推导成 production 已通过。
- 超 CPU、内存、进程数、输出和文件大小限制有确定错误，服务仍可继续处理后续请求。

### REC-01：Worker 重启后的会话/交互恢复

1. 启动一个可恢复的长 Run 或 `WAITING_INPUT` Run，记录 Conversation、Agent session、Run、ToolExecution 和 interaction ID。
2. 终止当前 Worker，等待新 Worker 接管；不要删除 MySQL/Redis 权威数据。
3. 刷新 Browser，检查状态、历史事件、待回答问题和模型上下文。
4. 回答/Resume 后观察终态和工具账本；确认旧 Worker fence 不能写脏数据。
5. 多轮会话：Worker `SIGKILL` 后 follow-up 必须 `resume` 同一 DSH session（不是每次 `create`），模型能复述上一轮一次性口令。

**通过标准**：MySQL 中的 durable facts 保留；恢复后不重复执行状态不明的工具；无法安全恢复时进入明确人工处理状态，不假装成功。

### REC-02：exec hard-kill 与 orphan 回收

在隔离的本地测试栈中启动一个长进程，硬杀 exec 服务后重启；通过 owner-scoped jobs API、Runs 页面和容器进程列表检查：

- orphan 被发现并清理；
- 进程状态、日志游标和退出原因不制造假 Running；
- 其他租户/会话不能看到或控制该作业；
- 服务恢复后仍可执行新的短命令。

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
