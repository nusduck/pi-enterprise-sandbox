# 2026-08-26 近期变更实际使用测试案例与执行报告

## 1. 测试目标

以真实用户操作验证近期变更是否在当前部署中可用：登录产品，检查运行时能力，按会话切换模型，上传交易数据并完成风控分析与 Artifact 交付，验证进程控制和运行中刷新恢复，最后使用用户手动创建的 A2A 凭据进行 Agent Card 与官方 A2A v0.3 流式调用。

本报告只记录已实际观察到的结果；“任务最终完成”与“流式客户端收到最终事件”分别判定，不互相替代。

## 2. 测试边界与环境

| 项目 | 实测信息 |
|---|---|
| 测试日期 | 2026-08-26 |
| 前端 | `http://localhost:3000/` |
| A2A Agent Card | `http://127.0.0.1:4100/a2a/agents/01M0Q5DBSXE6RQW6DS28CC8V18/.well-known/agent-card.json` |
| 操作方式 | Computer Use 控制本地 Chrome；A2A 补充测试改用本地 HTTP 客户端 |
| 部署环境 | `development`；Sandbox 网络为 `unrestricted` |
| 测试账号 | 使用用户提供的 `admin` 凭据；密码不写入报告 |
| 测试数据 | [real-user-scenario-transactions.csv](../real-user-scenario-transactions.csv)，10 条合成交易 |
| 代码变更 | 本轮未修改生产代码；仅新增本报告 |

本轮先重建 `agent`、`api-server`、`sandbox` 和 `frontend` 镜像并启动 Compose 栈。凭据和 Token 未写入文件、报告或日志。

## 3. 覆盖的近期变更面

- 按会话保存模型选择。
- Sandbox `ls`、`find`、`read`、`write`、`edit`、`python`、`bash`、Artifact 和进程工具。
- Artifact 下载时保留原文件名和扩展名。
- 运行中刷新时恢复消息、工具步骤和 Run 状态。
- Capabilities 中的用户/系统 Skill、MCP、工具和模型投影，以及 Extension diagnostics。
- A2A Agent Card、Bearer 认证、A2A v0.3 JSON-RPC `message/stream`、任务查询和重订阅。

## 4. 案例总览

| 编号 | 场景 | 判定 |
|---|---|---|
| CT-01 | 服务重建、就绪检查和运行依赖 | 通过 |
| CT-02 | 管理员登录和会话 | 通过 |
| CT-03 | Capabilities、MCP、工具、模型和扩展诊断 | 通过（只读） |
| CT-04 | 模型选择按会话隔离 | 通过 |
| CT-05 | 上传交易文件、Sandbox 分析和 Artifact 交付 | 通过（有边界观察） |
| CT-06 | 进程启动、状态、日志和终止 | 部分通过 |
| CT-07 | Run 运行中刷新恢复 | 部分通过 |
| CT-08 | A2A Agent Card 与认证 | 通过 |
| CT-09 | A2A 官方流式调用与重订阅 | 部分通过：完整流式链路失败 |
| CT-10 | 审批业务、计划任务、跨租户隔离 | 未执行 |

## 5. 详细执行记录

### CT-01：服务重建、就绪检查和运行依赖

**步骤**

1. 重建 `agent`、`api-server`、`sandbox` 和 `frontend` 镜像。
2. 启动 Compose 服务。
3. 检查 API readiness、Agent health 和 Sandbox 运行能力。

**实际结果**

- API、Agent、MySQL、Redis、Sandbox 和 Frontend 服务已启动。
- API readiness 显示 Agent 使用 MySQL authority，Sandbox workspace 可用。
- Python、bash、Node runtime 检查通过。
- Bubblewrap required/preflight 检查通过。

**判定：通过。**

### CT-02：管理员登录和会话

**步骤**

使用用户提供的 `admin` 凭据在 UI 登录，进入 Chat 和管理入口。

**实际结果**

- 本轮登录成功，管理员会话可用。
- Chat、Runs、Approvals、Schedules、Settings 和 A2A 入口可访问。
- 旧报告中曾记录首次部署时预置账号登录失败、需先注册的情况；本轮只确认当前会话可登录，未把种子账号策略重新判定为已解决。

**判定：通过；账号初始化仍是部署前提风险。**

### CT-03：Capabilities、MCP、工具、模型和扩展诊断

**实际结果**

- My Skills 为 0，System Skills 为 13。
- MCP `exa` 显示 Connected、2 tools、host-injected authorization；本轮没有调用外部 MCP。
- Sandbox 的文件、搜索、编辑、执行、进程和 Artifact 工具显示 enabled/allow；Exa 工具显示 high risk/require approval。
- 当前模型注册表实测为 `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`；旧报告中曾出现的其他模型没有在本轮模型列表中出现。
- Extension diagnostics 显示 sandbox-bridge、enterprise-policy、observability、user-interaction、skill-lifecycle、subagent-spawn、task-state 等配置。

**判定：通过（只读验证）。**

### CT-04：模型选择按会话隔离

**步骤**

1. 在会话 A 选择 `deepseek-v4-pro`，发送只要求回复字母 A 的提示。
2. 在会话 B 选择 `deepseek-v4-flash`，发送只要求回复字母 B 的提示。
3. 重新打开会话 A，检查模型选择和历史 Run。

**实际结果**

- 会话 A 输出 `A`，Run header 显示 `deepseek-v4-pro`。
- 会话 B 输出 `B`，Run header 显示 `deepseek-v4-flash`。
- 重新打开会话 A 后仍为 Pro，没有被会话 B 串改。

**判定：通过。**

### CT-05：上传交易文件、Sandbox 分析和 Artifact 交付

**步骤**

1. 上传 [real-user-scenario-transactions.csv](../real-user-scenario-transactions.csv)。
2. 要求 Agent 使用 `ls`/`find`/`read` 找到文件，用 Sandbox Python 计算统计结果。
3. 生成风控报告和摘要 CSV，编辑报告追加“复核状态：待人工确认”，并提交两个 Artifact。
4. 检查 Run 状态、Artifact 名称和下载结果。

**实际结果**

- 上传文件显示 Ready，大小 742 B。
- Run 显示 `Succeeded · 20 tools · 1m42s`。
- 统计结果与 fixture 一致：10 笔交易、总额 7,256.69 USD；金额大于 1,000 USD 的 3 笔、合计 5,098.00 USD；发现 1 组重复交易（TX-1004/TX-1005，间隔 1 分钟）。
- 风控结论包含人工复核建议。
- 两个 Artifact 已提交并可在 UI 看到；Chrome 下载记录中出现 `risk_summary.csv` 和带原始中文显示名的 `季度风控报告.md`。
- Agent 尝试用中文路径作为 Artifact 内部路径时被 Artifact path validation 拒绝，随后复制到 ASCII 内部路径 `quarterly_risk_report.md`，并以中文显示名提交成功。这是内部路径校验边界观察，不应误判为最终交付失败。

**判定：业务链路通过；内部路径与显示名边界需单独回归。**

补充说明：此前报告曾记录“工具和 Artifact 完成但 Run Failed，错误为 `trace span optimistic upsert did not converge`”。本轮相同类型的真实分析 Run 成功，但只执行了一次，不能据此关闭该历史风险。

### CT-06：进程启动、状态、日志和终止

**步骤**

通过 Agent 请求 `process_start` 执行一个短进程：输出 stdout `111`、stderr `222`，等待后输出 stdout `333`；随后调用 process status/read/kill 并检查退出状态。

**实际结果**

- Run 显示 `Succeeded · 8 tools · 46s`。
- `process_start` 返回 process ID 和 running 状态。
- `process_status` 能返回 running、随后返回完成和 exit code 0。
- stderr 能读取 `222`；stdout 后续能读取 `111` 和 `333`。
- `process_kill` 返回成功/TERM，但调用时进程已经自然完成，因此没有证明“对仍在运行的进程主动 kill”这一分支。

**判定：部分通过。**

已确认启动、状态、日志读取和自然结束；主动终止、取消后的 UI 收敛仍需单独测试。旧 UI 测试还观察到打开 Console 无输出、确认取消后页面控制失去响应，属于同一风险面。

### CT-07：Run 运行中刷新恢复

**步骤**

1. 启动一个会持续一段时间的 Run。
2. 在 UI 显示 Running 时刷新页面。
3. 检查同一会话、Run 状态和执行步骤是否恢复。

**实际结果**

- 刷新前 Run 显示 Running，已有 1 个工具步骤。
- 刷新后仍显示同一会话和同一个进行中的 Run，页面显示 `Agent Execution In Progress`。
- Computer Use 控制通道随后无法继续建立原生控制连接，因此没有在 UI 中确认该 Run 最终完成及最终正文是否回填。

**判定：部分通过。**

已确认进行中状态可以重新投影；最终收敛未确认，不能写成完整通过。

### CT-08：A2A Agent Card 与认证

**前提**

凭据由用户手动创建。本报告不记录凭据内容，也没有再次创建持久凭据。

**步骤**

对用户提供的 Agent Card URL 发起带 Bearer 凭据的 `GET`。

**实际结果**

- HTTP 200。
- 响应 `A2A-Version: 0.3`，`protocolVersion: 0.3`，`preferredTransport: JSONRPC`。
- `capabilities.streaming` 为 `true`。
- Bearer security scheme 存在，Agent Card 可被有效凭据访问。

**判定：通过。**

### CT-09：A2A 官方流式调用与重订阅

本项原计划通过 Computer Use 完成，但 Computer Use 原生控制通道在前一项刷新测试后已断开；为验证用户明确要求的本地 A2A 入口，本项改用本地 HTTP 客户端，发送 A2A v0.3 官方协议形态的请求。

**请求形态**

- JSON-RPC method：`message/stream`。
- `Accept: text/event-stream`、`Content-Type: application/json`、`A2A-Version: 0.3`。
- 带稳定 `messageId`、`Idempotency-Key`、`configuration.acceptedOutputModes=["text"]` 和 `blocking=false`。
- 消息要求 Agent 不调用工具并准确回复 `A2A_STREAM_OK`。

**实际结果**

- 初始 `message/stream` HTTP 200，响应类型为 `text/event-stream; charset=utf-8`。
- 收到初始 Task、`submitted` 和 `working` 事件。
- 流在最终事件到达前结束：没有收到最终 `status-update(final=true)`，也没有收到 `kind: message` 的最终 Agent 正文事件。
- 随后 `tasks/get` 返回 Task `YNN14EEKS5B1RMG1DGBEKXHAT1` 状态 `completed`，说明后台 Run 已完成。
- `tasks/get(historyLength=20)` 能读到用户消息和 Agent 消息，最终正文准确为 `A2A_STREAM_OK`。
- `tasks/resubscribe` 可以重放初始 Task、`submitted` 和 `working`，但同样没有最终状态或最终消息事件。

**判定：部分通过；官方流式完整链路未通过。**

已确认认证、Agent Card、任务创建、后台执行和最终回复持久化；未通过项集中在 SSE 最终事件的投影、投递或终止条件。当前证据不足以确定具体根因，不能用 `tasks/get` 的最终完成状态替代 SSE 终态事件。

### CT-10：未执行项

以下项目本轮没有执行，不作通过判断：

- 触发 Exa 或其他高风险 MCP 工具的审批 Pending → Approved/Rejected/Expired 流程。
- 创建、执行和清理计划任务。
- 创建第二租户并验证会话、Run、Artifact、Dataset、A2A 资源的跨租户 404。
- 生产网络隔离、Linux Bubblewrap 等价环境验收。
- 四套完整自动化测试命令；本报告是实机 UI/HTTP 场景证据，不替代单元测试和 CI。

## 6. 缺陷与风险

### R1：A2A SSE 未交付最终事件（中高优先级）

有效凭据可以建立 SSE，后台 Task 也完成，最终消息已写入历史；但原始流和 `tasks/resubscribe` 都在 `submitted`/`working` 后结束，没有最终状态事件或 Agent 消息事件。

影响是只依赖流式事件的官方客户端可能拿不到最终回复或终态，只能额外调用 `tasks/get` 补齐。

建议围绕事件序列、`message.completed`、Run 终态投影、Redis/MySQL 重放和 SSE terminal 条件增加真实回归；在修复或解释前，不应将当前环境的 A2A streaming 标为完整通过。

### R2：进程主动终止和取消后的 UI 收敛未证实

本轮 kill 调用与自然退出竞态，旧 UI 测试还观察到 Console 输出缺失和确认取消后页面失去响应。应使用明确尚未结束的进程，分别验证 status/read/signal/kill 以及刷新后的 UI 状态。

### R3：Run 账本终态历史风险尚未关闭

此前真实 Run 出现工具与 Artifact 已完成但 Run 为 Failed 的 `trace span optimistic upsert did not converge`。本轮一次同类业务 Run 成功，只能说明未复现，不能证明已修复；建议重复执行并保留 sequence、trace 和最终状态证据。

### R4：环境不等同于生产验收

当前为 `development`，Sandbox 网络为 `unrestricted`。本报告不能推出生产网络隔离、跨租户访问控制或高风险审批链路已通过。

## 7. 最终结论

本轮已经验证主要的“登录—选模型—上传—分析—交付”用户链路，模型按会话隔离通过，Sandbox 工具和 Artifact 交付可用。进程控制和运行中刷新是部分通过。A2A 认证、Agent Card、任务执行和最终结果持久化正常，但官方流式 SSE 缺少最终状态/最终消息事件，因此整体不能判定为全绿；当前最明确的新增问题是 A2A 流式终态事件链路。
