# 2026-09-19 全功能回归增量证据（Jev Browser follow-up）

本文件是同日继续执行的增量记录，承接 [首轮证据](full-regression-2026-09-19-jev-browser.md)。不改写首轮结论，也不把以下合成探针扩大解释为 R/W、管理员、多租户或目标部署验收。

## 新增真实浏览器证据

### INPUT-01：等待输入、刷新、重开与回答

- 新建合成会话，要求模型用 `ask_user_question` 询问受众（管理层/研发）和年份（2021-2023/2024-2026）。
- 首轮真实状态：`Waiting input · 1 tool`，AX 显示受众选项“管理层”“研发”。
- 刷新当前 Chat 后，页面回到 `New Conversation`，等待卡片不自动显示；点击 Recent 中同一会话后，等待状态和选项恢复。这证明权威状态可重新读取，但不满足“刷新后当前画面自动恢复”的强断言。
- 点击“管理层”后 Run 收敛为 `Succeeded · 1 tool`，模型报告受众为管理层，但明确报告年份没有收到选择结果。没有把未出现的年份选项算作成功。
- Run：`01M2WT040BDXFNWGCVXSQNTSF2`，trace 前缀 `0f688b1a`，conversation `01M2WT03ZXCV02RF62RJSK4AP1`。
- 判定：`INPUT-01` 仍为 `PARTIAL`；交互卡/持久状态/合法回答有证据，双问题和最终分析口径未完成。

### CHAT-07：运行中 follow-up 排队

- 新建合成会话，执行前台命令 `for i in 1 2 3 4 5 6 7 8; do echo QUEUE_BASE_$i; sleep 1; done`。
- 基础 Run 运行时提交 follow-up：“当前前台任务完成后，只回答 `QUEUE_FOLLOWUP_OK`”。Composer 明确切换为 `Follow-up`，消息先进入队列。
- 基础 Run 先返回 `QUEUE_BASE_DONE`，随后排队消息返回 `QUEUE_FOLLOWUP_OK`；没有出现 `session lock busy`，也没有调用额外工具或产生文件副作用。
- 相关 Run：`01M2WT2KMPACGPNX1PCR673HHP`（trace `2c7d1ac68a28faeb`）和 `01M2WT2WJ42D8BFSBKGPDCABB9`（trace `2c79a2271e636948`），conversation `01M2WT2KMCBEATATHE2Y51QP6B`。
- 判定：`CHAT-07`、`RUN-02` 各增加部分正向证据，但仍未覆盖取消排队项、WAITING_INPUT/APPROVAL、Worker 重启、单/多 Worker 矩阵。

### RUN-02：Steer 输入路径

- 新建合成会话，执行前台 `sleep 20`。
- Run 运行时点击 `Steer`，输入 `Steer now: stop the sleep command and instead only answer STEER_OK` 并提交；UI 接收消息，随后模型返回 `STEER_OK`。
- 但最终模型思考明确显示 `sleep already finished`，Run 为 `Succeeded · 1 tool · 22s`，不是被 Steer 中断的终态。因此只能证明 Steer 指令入口和后续响应链路，不证明取消/中止正在运行的工具。
- Run：`01M2WT3QB9YSZS1258ESM3KYVT`，trace 前缀 `aee61edbf17e3e85`，conversation `01M2WT3QB20XW8HEASV89R6CV6`。
- Details → Tools 显示 `sleep 20 completed · sandbox`；Details → Processes 显示 `No managed processes in this session`。

### UI-01 / UI-02：详情页和键盘草稿

- 打开真实 Run Details，独立看到 Overview、Tools、Processes、Files、Artifacts、Datasets 等 tab；Tools 显示 1 个已完成 bash，Processes 显示当前会话无 managed process，Overview 显示 trace、workspace、conversation 等标识。
- 在空 Composer 中输入 `UI_LINE_1`，使用 `Shift+Enter` 换行，再输入 `UI_LINE_2`；AX Value 保留真实换行。使用 `Meta+A` + Backspace 清空，Send 回到 disabled，没有发送草稿。
- 判定：UI-01/02 仍为 `PARTIAL`；长内容、窄屏、IME、上传/拖放、键盘审批/下载等仍未执行。

## 当前状态调整

相对于首轮 95 条矩阵：

- `CHAT-07`：`NOT EXECUTED` → `PARTIAL`。
- `RUN-02`：`NOT EXECUTED` → `PARTIAL`；Steer 的“工具尚未完成时中止”仍未证明。
- `UI-02`：`NOT EXECUTED` → `PARTIAL`；仅证明多行草稿与清空。
- `INPUT-01`：保持 `PARTIAL`，但新增了刷新/重开和年份缺失的直接失败边界。
- `CHAT-06`、`UI-01`、`MGMT-01`、`TRACE-01`：保持 `PARTIAL`，新增详情/刷新观察，不升级为 PASS。

## 未改变的阻塞边界

当前仍缺管理员身份、第二组织/第二用户、R/W/X 上传 fixture、外部 MCP 客户端、A2A 凭据、故障注入环境、Worker/exec/Redis/DBPM/Proxy 重启演练和目标 K8s/VM。当前没有删除合成会话或 Artifact；CLEAN-01 未执行。

