# 实际用户场景测试案例与执行报告

## 1. 测试目标

验证一个真实业务用户能否在当前部署中完成一次可交付的风控复核：登录产品，创建或进入私有会话，上传交易数据，要求 Agent 使用 Sandbox 计算风险指标，生成并提交可下载 Artifact，继续追问，刷新页面后恢复上下文，并查看运行、数据集和 Trace 信息。

本报告同时覆盖产品可见的管理入口：Capabilities、MCP Servers、Tools、Models、Extension diagnostics、A2A、Approvals、Schedules 和 Runs。

## 2. 已确认的测试边界

| 项目 | 本次实测值 |
|---|---|
| 测试日期 | 2026-08-23 |
| 操作方式 | Chrome 扩展控制的真实页面点击、输入、上传和页面刷新 |
| 前端 | `http://localhost:3000/`，页面标题 `UPRC Agent` |
| 服务状态 | Agent、API、Frontend、MySQL、Redis、Sandbox 等 Compose 服务已启动；就绪检查显示 Agent MySQL authority、Sandbox ready、Bubblewrap preflight passed |
| 部署环境 | `development` |
| Sandbox 网络 | `unrestricted`；不能据此声称生产网络隔离已验证 |
| 认证 | 启用；预置 `admin` 登录首次返回 Invalid credentials，按用户授权在 UI 注册后继续测试 |
| 默认模型 | `deepseek-v4-flash` |
| MCP | `exa` connected，2 tools；本次业务分析明确不调用外部 MCP |
| 测试数据 | [real-user-scenario-transactions.csv](../real-user-scenario-transactions.csv)，10 条合成交易 |

密码、Token、API 凭证和浏览器状态没有写入本报告。

## 3. 业务场景与数据预期

角色是风控分析员。输入文件包含 10 笔 USD 交易，测试要求：

1. 使用 Sandbox Python 读取真实上传文件，统计交易总数、总金额、金额大于 1000 的交易和 5 分钟内重复交易。
2. 生成 `uploaded_risk_report.md` 与 `uploaded_risk_summary.csv`。
3. 分别调用 `submit_artifact` 提交两个文件。
4. 基于相同会话继续追问人工复核优先级，不重新上传或修改文件。

由 fixture 直接计算出的关键预期是：10 笔、总额 7,256.69 USD；超过 1000 USD 的是 TX-1004、TX-1005、TX-1008，共 5,098.00 USD；TX-1004 与 TX-1005 属于同客户、同商户、同金额且间隔 1 分钟的重复组。

## 4. 案例目录

| 编号 | 场景 | 结果 |
|---|---|---|
| RT-01 | 服务就绪、登录/注册与管理员入口 | 通过（有预置账号缺口） |
| RT-02 | 内联合成数据的一轮工具 Run 与 Artifact | 失败 |
| RT-03 | 上传 CSV 后按真实文件分析并提交 Artifact | 通过 |
| RT-04 | 同会话追问人工复核优先级 | 通过 |
| RT-05 | 刷新页面后的会话与结果恢复 | 通过 |
| RT-06 | Details、Trace、Dataset、Artifact 可见性 | 通过 |
| RT-07 | Artifact 交付入口 | 部分通过 |
| RT-08 | 后台进程、控制台日志与取消信号 | 部分通过 |
| RT-09 | Capabilities 与扩展诊断 | 通过（只读） |
| RT-10 | A2A 管理页面与 Agent Card 配置 | 通过（只读） |
| RT-11 | 审批中心 | 未执行业务触发 |
| RT-12 | 计划任务页面 | 通过（只读） |
| RT-13 | 跨租户隔离 | 未执行 |

## 5. 详细执行记录

### RT-01：服务就绪、登录/注册与管理员入口

**步骤**

1. 在 Chrome 打开前端首页。
2. 用用户提供的 `admin` 账号尝试登录。
3. 登录返回 `Invalid credentials` 后，按用户明确授权选择 Register，使用同一账号完成注册。
4. 确认页面显示 `admin admin`，并出现 Settings 与 A2A 入口。

**实际结果**

- 注册后的管理员会话可用，能进入 Chat、Runs、Approvals、Schedules、Settings 和 A2A。
- “admin 已经预置并可直接登录”这一前提不成立；当前环境需要先注册。该差异会影响自动化部署验收，应补充种子账号策略或明确初始化步骤。

### RT-02：内联合成数据的工具 Run

**步骤**

在 Chat 输入包含 10 条合成交易的风控分析要求，要求使用 Sandbox Python 写入 `transactions.csv`，生成 `risk_report.md`、`risk_summary.csv`，并显式提交两个 Artifact。

**实际结果**

- Run `01M0Q5DBV7FKMESNACVJ4B4YVK` 的 6 个工具步骤均在 UI 标记为 Completed：`write`、`python`、`write`、`read`、两次 `submit_artifact`。
- 业务结果和交付物已经显示，但 Runs 页面最终状态为 `Failed`。
- Logs 详情明确显示：`trace span optimistic upsert did not converge`，`last_sequence: 2900`。

**判定：失败。**

这是一个用户可见的一致性缺陷：工具副作用和 Artifact 已完成，但 Run 账本的终态错误。不能只看回答文本判定成功。本次只做复现和记录，没有改动生产代码。

### RT-03：上传 CSV 后按真实文件分析

**步骤**

1. 通过 Attach files 选择 [real-user-scenario-transactions.csv](../real-user-scenario-transactions.csv)。
2. 确认 UI 显示 `CSV real-user-scenario-transactions.csv · Ready`。
3. 提交“读取刚上传文件、使用 Sandbox Python 分析、生成并提交两个 Artifact”的请求。

**实际结果**

- Agent 在回答中显示真实数据集路径：`datasets/01M0Q5G1DSVQ61AT61FV1RVV6P/real-user-scenario-transactions.csv`。
- 10 笔、7,256.69 USD、3 笔超过 1000 USD、1 组/2 笔 5 分钟内重复交易均与 fixture 预期一致。
- 运行步骤 `find`、`read`、`python`、两次 `write`、两次 `submit_artifact` 均显示 Completed。
- Artifact：`uploaded_risk_report.md`（artifact `01M0Q5H0VGY0N0WCVFD7BEF30D`）和 `uploaded_risk_summary.csv`（artifact `01M0Q5H0Y1RW9PKJGNXWPFD1YD`）。
- 该 Run 在 UI 显示 `Succeeded`。

**判定：通过。**

### RT-04：同会话追问

**步骤**

在同一会话发送“基于刚才上传文件的复核结果给出 3 条人工复核优先级，不重新上传或修改文件”。

**实际结果**

回答正确地将 TX-1004/TX-1005 列为最高优先级，将 TX-1008 列为高优先级，并给出 CUST-004 的账户级聚合风险。该 Run 显示 `Succeeded`，没有重新上传文件。

**判定：通过。**

### RT-05：刷新恢复

**步骤**

在追问成功后刷新 Chat 页面，检查会话、附件引用、回答、Artifact 和 Session 是否恢复。

**实际结果**

刷新后仍显示同一 Session `01M0Q5DBTYGYBQK7GAVDAZ8282`、上传文件引用、4 个交付物和历史回答，最新追问仍可见。

**判定：通过。**

### RT-06：Details、Trace、Dataset、Artifact

**步骤**

打开 `Toggle context inspector`，依次查看 Overview、Tools、Processes、Files、Artifacts、Datasets 和 Trace。

**实际结果**

- Trace 面板显示 Trace ID `5389a69bd24dbb67579e12ed5d8b60a6`、组织、用户、Run span、队列和模型 span，状态为 ok。
- Dataset 面板显示 `Ready · 742 B · agent visible`，并显示文件上传时间和 SHA-256 前缀。
- Deliverables 面板显示 4 个 Artifact 下载链接，包含原始内联分析产物和上传文件分析产物。
- 当前追问 Run 本身没有新 Artifact，因此其 Details → Artifacts 显示 `No submitted artifacts yet`；这与“交付物属于前一轮 Run”一致，不判为缺失。

**判定：通过。**

### RT-07：Artifact 交付入口

**实际观察**

页面提供 4 个 `/api/files/artifact-download` 链接，文件名、类型和大小均可见。尝试用浏览器下载事件捕获时未收到 download event；这不足以证明下载 API 失败，但本次没有把“浏览器实际落盘”作为已确认事实。

**判定：部分通过。**

后续应在独立浏览器下载验收中确认响应状态、Content-Disposition 和本地文件落盘结果。

### RT-08：后台进程、控制台日志与取消信号

**步骤**

在 Chat 请求 Agent 使用 `process_start` 启动仅输出 heartbeat 的短进程；打开 Processes 和 Open Console，观察日志，再用 Cancel process 结束测试进程。

**实际结果**

- Agent 创建进程 `01M0Q5SK127C9TYF2FM9X4VHHF`，Runs 页面对应 Run `01M0Q5SG7M0H…` 显示 `Succeeded`，工具为 `process_start`。
- Details → Processes 能看到命令、运行时长、`running` 状态和 Open Console。
- Process Console 显示 `No log output yet — waiting for stdout/stderr…`，没有看到预期 heartbeat 回显；进程在超过预期时长后仍显示 running。
- 点击 Cancel process 会弹出确认框；确认后 Chrome 页面控制失去响应，需要新标签页才能继续查看其他页面。

**判定：部分通过，进程控制链路存在缺陷迹象。**

已确认的是 UI 进程实体和 `process_start` Run 成功；尚不能把“Sandbox 进程一定未退出”作为后端事实，因为当前证据来自前端状态。应补充后端 process status/read 与 stdout offset 的回归测试。

### RT-09：Capabilities 与扩展诊断

通过 Settings 页面真实点击查看：

- Skills：共享 skill 列表可见且标记 configured/enabled。
- MCP Servers：`exa` 显示 connected、2 tools、host-injected authorization。
- Tools：Sandbox 的 `read`、`ls`、`find`、`grep`、`write`、`edit`、`bash`、`python`、进程工具和 `submit_artifact` 显示 enabled/allow；Exa 两个工具显示 high risk/require_approval。
- Models：`deepseek-v4-flash`、`deepseek-v4-pro`、`gemini-3.5-flash`、`gpt-5.5`、`mimo-v2.5` 等 enabled，`disabled-test-model` 显示 disabled。
- Extension diagnostics：显示 `pi-enterprise-agent@4.0.0`、13 个 Allowed Tools、Audit built-in，以及 sandbox-bridge、enterprise-policy、observability、user-interaction、skill-lifecycle、subagent-spawn、task-state 等扩展。

**判定：通过（只读验证）。**

### RT-10：A2A 管理页面

A2A 页面显示 default Agent、Agent ID、Agent Version、Streaming Enabled、Bearer API credential、Agent Card URL、Endpoint、Scopes 和 JSON-RPC 示例；Active Credentials 显示 `No credentials issued for this Agent`。

**判定：通过（只读验证）。**

没有点击 Issue Credential，因为这会创建持久 API 凭证，不能在没有明确的凭证创建授权时擅自执行。

### RT-11：审批中心

Approvals 页面真实打开，Pending 过滤器显示 `No approvals found` 和 `No pending approvals. High-risk tools will show up here when they require a human decision.`

**判定：未执行业务触发。**

本次没有调用 Exa 外部 MCP，也没有安装 Skill ZIP，因此没有构造一个安全、无外部副作用的高风险审批样本。审批 UI 的空状态已确认，审批创建、批准、拒绝和过期链路仍需专门案例。

### RT-12：计划任务页面

Schedules 页面真实打开，显示 Cron/一次性任务类型、Timezone、Execution Prompt、Cron Expression、Missed Schedule Policy、Concurrency Policy、Agent ID 和 Create Schedule 表单；当前 `No scheduled runs`。

**判定：通过（只读验证）。**

没有创建计划任务，因为这会产生持久的后台自动运行副作用；创建/执行/删除应作为单独的带清理确认的测试。

### RT-13：跨租户隔离

**判定：未执行。**

当前没有创建第二个测试租户，也没有把另一个用户的资源暴露到当前会话。本报告不能宣称跨租户 404 已通过；该项应使用两个明确的合成账号验证“不可见资源返回 404 而非 403”。

## 6. 缺陷与风险清单

### 高优先级：Run 终态与工具账本不一致

现象：首轮 Run 的所有可见工具步骤和两个 Artifact 都完成，但最终状态为 Failed；错误为 `trace span optimistic upsert did not converge`。

影响：用户会看到失败状态，可能重复执行任务；而 Sandbox 工作区和 Artifact 已经产生副作用，可能造成重复交付或重复处理。

建议：先用失败 Run 的 sequence、trace span upsert 和终态写入路径补充回归测试，再定位 optimistic upsert 重试/并发收敛问题；修复前不要把该案例标为全链路通过。

### 中高优先级：进程控制台没有 stdout，取消动作会使页面失去响应

现象：process_start Run 成功且进程实体出现，但 Console 没有 heartbeat，进程时长超过预期；取消确认后页面控制无法继续。

影响：用户无法可靠判断进程是否仍运行，也无法稳定使用 signal/cancel 运维入口。

建议：核对进程 stdout/stderr 管道、历史日志 offset、SSE 断线恢复和取消确认后的 UI 状态机；增加 process start/read/status/signal 的真实链路回归。

### 部署前提：admin 账号未预置

现象：首次用用户提供的 admin 凭据登录失败，注册后才可继续。

影响：部署验收脚本若假设 admin 已存在，会在第一步失败。

建议：在开发/验收部署文档中明确“首次注册”还是提供一次性种子账号；不要把密码写入仓库文档或日志。

### 安全边界：本次不是生产隔离验收

当前环境的 Sandbox 网络模式为 `unrestricted`。因此本报告验证的是开发部署的用户旅程，不覆盖生产网络限制、密钥运维和跨租户隔离的最终结论。

## 7. 未覆盖项与下一轮建议

1. 修复或先回归验证 trace span optimistic upsert 收敛问题，然后重复 RT-02 至少 5 次，确认没有“工具成功但 Run Failed”。
2. 用两个合成租户完成跨租户 404 验证，覆盖会话、Run、Artifact、Dataset 和 A2A 资源。
3. 构造无外部网络副作用的审批测试夹具，验证 Pending → Approved/Rejected/Expired/Cancelled 全状态。
4. 创建一个短期计划任务并在执行后清理，验证 Cron、一次性任务、错过策略、并发策略和删除确认。
5. 使用真实下载响应验证 Artifact 下载，而不是只验证页面链接存在。
6. 在 Linux/生产等价配置中重新执行 Sandbox 网络与 Bubblewrap 隔离测试；当前开发 `unrestricted` 结果不能替代该验证。

## 8. 最终结论

这套产品已经能完成主要的“上传—分析—交付—追问—恢复”用户旅程，且后续上传文件 Run 与追问 Run 成功。但本次真实测试不能给出全绿结论：首轮 Run 的终态错误是明确的高优先级缺陷，进程控制是部分通过，审批业务、计划任务创建和跨租户隔离仍未完成真实验证。
