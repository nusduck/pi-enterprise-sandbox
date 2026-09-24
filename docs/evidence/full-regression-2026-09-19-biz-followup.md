# 2026-09-19 业务回归增量证据（Jev Browser）

本文件只追加同日真实浏览器 Run 的证据，不改写首轮或其它历史证据。两条业务分支均明确标注为合成演练；没有读取、上传或修改私有资料，没有调用 MCP、外部网络、邮件发送或邀请他人能力。

## BIZ-01：合成订单退款对账

- 输入只包含四条内联合成订单：原价合计 `550.00`，退款合计 `130.00`，净额 `420.00`，退款率 `23.64%`。
- 真实 Run：`Succeeded · 16 tools · 1m 38s`；Details → Overview 显示 Run ID 前缀 `01M2WTJPVE05J7…`、Started `2026-09-19T12:34:39.214Z`、Workspace 前缀 `01M2WTJPV5CFS1…`、Conversation 前缀 `01M2WTJPV3YPEH…`、Trace 前缀 `970727b56c4103…`。
- 模型独立复核四条记录：订单数 4，原价 `550.00`，退款 `130.00`，净额 `420.00`；状态计数为已退款 2、部分退款 1、已完成 1。
- 真实异常被保留：`ORD-001` 标记“已退款”，但退款 `20.00` 不等于原价 `100.00`。未发现负数退款、超额退款、重复订单或合计不一致；没有把异常擅自改成“正常”。
- 交付物通过浏览器 Details → Artifacts 独立核对为 2 件：
  - `jev-synthetic-reconciliation-20260919.xlsx`，显示 `8.7 KB`，Artifact URL 中的 id 为 `01M2WTNH5MTNGMN6A59JQPJ1NJ`。
  - `jev-synthetic-reconciliation-20260919.docx`，显示 `38.6 KB`，Artifact URL 中的 id 为 `01M2WTNH7NP60W345628AJWGJC`。
- `submit_artifact` 的真实返回为 `Submitted artifact ... (8905 bytes)` 与 `Submitted artifact ... (39514 bytes)`；模型记录的本地 SHA-256 分别为 `1a079fe403f26a9cf34c9370319fd7b53b03fc7e7df49e4d4b7485594e7569b1` 与 `64dcd16a4266b25caa654006fbebc4bcf2b0ac9680cb4c4da7edded82317900f`。
- 验证边界：这是合成数据的对账、公式/结构和 Artifact 提交流程证据；没有覆盖 S1 官方订单包、X 副本的重复/缺失/孤立退款、跨会话导入修订。因此 `BIZ-01` 不能判定为完整通过，保持 `PARTIAL`。

## BIZ-02：合成会议纪要 → 周报

- 首轮真实状态进入 `Waiting input`，三个澄清项以 ask-user 工具调用出现；随后逐项收到 tester 预定答案：
  1. PDF 终审负责人：`陈禾（合成参与者）`；
  2. PDF 截止日：`2026-09-14`；
  3. 自动发送：`暂不批准，仅生成邮件草稿`。
- 在答案到达前没有创建文件、todo 或 Artifact；第三项回答后才继续执行。这证明澄清问题没有被模型跳过。
- 真实 Run：`Succeeded · 12 tools · 1m 34s`；Details → Overview 显示 Run ID 前缀 `01M2WTVAPZJZ55…`、Started `2026-09-19T12:39:21.602Z`、Workspace 前缀 `01M2WTVAPV7YS3…`、Conversation 前缀 `01M2WTVAPSTZFB…`、Trace 前缀 `a11944ba6eea6f…`。
- Details → Tools 显示 3 次 ask-user Reply、计划卡从 `0/5 done` 到 `4/5 done` 再到 `5/5 done`；最终五项计划全部完成，包含会议整理、待办卡、Word、PPT 和两件 Artifact 提交。
- Details → Artifacts 与 Deliverables 均显示恰好 2 件：
  - 工作区文件 `jev-synthetic-meeting-weekly-20260919.docx`，本地实测 `39,617 bytes`；Artifact 展示名带有 `项目周报（合成演练）` 前缀，显示 `38.7 KB`，Artifact id `01M2WTY29G2D3DN2M6DJ7KA83Z`。
  - 工作区文件 `jev-synthetic-meeting-weekly-20260919.pptx`，本地实测 `34,916 bytes`；Artifact 展示名带有 `项目周报（合成演练）` 前缀，显示 `34.1 KB`，Artifact id `01M2WTY2AKNWEQA1S4RGFKT388`。
- `submit_artifact` 的真实返回分别为 `Submitted artifact 项目周报（合成演练）jev-synthetic-meeting-weekly-20260919.docx (39617 bytes)` 与 `Submitted artifact 项目周报（合成演练）jev-synthetic-meeting-weekly-20260919.pptx (34916 bytes)`；返回文本没有独立 status 字段，未猜测额外字段。
- 内容自检由 Run 内 bash/python 工具完成：PPT 读取页数为 5；Word 命中“合成演练”、陈禾、`2026-09-14`、林乔、`2026-09-10`、修订前 `2026-09-09`、`2026-09-08`、冻结资料、不对外公布、仅生成邮件草稿、未批准等关键事实。决定、提议、会后修订与待确认项分开表达，未把未知项编成真实姓名或日期。
- 验证边界：已经覆盖 S2 的澄清、修订同步、Word/PPT/待办一致性和无邮件副作用的合成分支；没有重新打开会话后只更新变更项的第二轮修订。因此 `BIZ-02` 仍记为 `PARTIAL`，不能把合成分支等同于完整 S2 全流程通过。

## 本增量对矩阵的影响

- `BIZ-01`：保持 `PARTIAL`；新增真实对账计算、两件 Artifact、详情页独立核对和异常保留证据。
- `BIZ-02`：`NOT EXECUTED`/未闭环 → `PARTIAL`；新增真实 Waiting input、三次回答、五步 todo 完成、五页 PPT、Word/PPT 两件 Artifact 和无邮件副作用证据。
- 本增量没有修改生产代码、测试规范或 `test-cases.md`，也没有删除任何会话、文件或 Artifact。
