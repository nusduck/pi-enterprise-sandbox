# 2026-10-03 全仓代码质量盘点

**目的**：项目全程由 AI 编写，经历 Pi → DSH、Python 执行面 → TypeScript exec、自建 MCP adapter → 出厂客户端、
Redis replay 退役、网络模式删除、前端重设计等多次重建，留下了死代码、兼容残留、重复实现和文档漂移。
本次在 `main @ a1d8fe3f` 上做只读盘点，再分批清理。

**方法**：7 个只读 worker 并行盘点（dsh：agent ×3、exec+contract、api-server；agy：frontend、文档一致性），
统一简报要求每条发现带「命令 → 结果」证据，安全护栏一律归「需确认」。主代理抽查证据、去重、定批次。
**原始报告是 worker 的结论，不是已验证事实**：每个批次执行前由执行者对本批条目重新取证，证据不成立的条目跳过并记录。

| 报告 | 范围 | 发现 | 确定可删（报告自估） |
|---|---|---|---|
| [audit-agent-application-domain.md](audit-agent-application-domain.md) | agent application / domain / lib / config / skills | 24 | ~190 行（含需确认 ~450） |
| [audit-agent-infra-presentation.md](audit-agent-infra-presentation.md) | agent infrastructure / presentation / bootstrap | 31 | 含两个零引用整仓储 |
| [audit-agent-runtime-tests.md](audit-agent-runtime-tests.md) | agent runtime（DSH 组合层）+ 全部测试残留 | ~20 | 26 行（组合层基本干净） |
| [audit-exec-contract.md](audit-exec-contract.md) | exec + contract | 23 | ~630 行（含需确认 ~1000） |
| [audit-api-server.md](audit-api-server.md) | BFF | 27 | ~230 行（另需确认 ~320） |
| [audit-frontend.md](audit-frontend.md) | frontend | — | ~234 行 + 三个超长文件拆分 |
| [audit-docs-drift.md](audit-docs-drift.md) | 活跃文档 vs 代码 | 31 处漂移 | — |

## 主代理复核结论（抽查）

- **exec F4 不是清理项，是缺陷**：单实例 fail-closed 护栏 `assertSingleInstance` 已实现，但 `exec/src/main.ts` 从未调用；
  `deploy/vm/dsh-exec.service` 注释却声称「exec 也会以 EXEC_CONCURRENCY 拒绝多实例」。转入缺陷批次 B-exec：接线 + 测试。
- **BFF A1 与已知缺陷同源**：agent 400 响应带 `reason_code`（具体诊断码），BFF `agent-client.ts` 21 处错误映射只抄 `code`，
  诊断码到不了浏览器（`review-deferred-items.md` 已登记）。收敛错误映射时一并透传。
- **`appendEventInTxn` 有 4 份重复实现**（approval-decision / interaction-response / parked-approval-cancel / parked-interaction-cancel）；
  `fix/agent-ledger-and-errors` 已把 parked-approval-cancel 那份挪成 `application/run-event-append.ts`，其余三份在 C2 合并。
- 文档报告中「`AGENT_RUN_STREAM_MAXLEN` 已废弃」与 `tests/test_redis_topology_config.py` 的断言矛盾，按不成立处理；文档批次逐条复核。

## 处理原则

| 类别 | 处理 |
|---|---|
| 零引用的生产代码、只为已删机制存在的测试 | 删除（执行前重新 grep 取证） |
| 重复实现 | 合并为一处，行为不变；有分叉的先补测试钉住期望行为 |
| 注释 / 命名漂移（Python 路径、Pi 引擎、计划阶段编号） | 改写为现状，不改行为 |
| 安全护栏、denylist、脱敏兜底里的历史路径 | **保留**（防绕过），只改注释 |
| 已入库数据的升级路径（无 `schemaVersion` 的旧 Agent 配置、未过期的无 sid JWT） | **已删除（开发阶段无存量数据，见本 PR）**：8 个 `agent_version` 的 `config_json` 全部带 `schemaVersion`；sid 引入（#74，2026-10-02）已过 24h JWT TTL，不存在未过期的无 sid JWT |
| 前端不调用、但 `api.md` 记为公开接口的 BFF 路由 | 待产品确认是否有前端以外的客户端，确认前不删 |
| `type Loose = any` 的大面积收紧 | 本轮不做（收益低、牵涉面大），只收敛重复声明 |
| 行数棘轮里的「单调用方小模块」 | 不并回（是为满足棘轮的有意拆分） |

## 执行批次（每批一个 PR，按顺序合并）

功能与缺陷批次先合并（Wave 1/2），清理批次最后进行，避免在同一批文件上冲突。

| 批次 | 内容 | 来源条目 | 验证 |
|---|---|---|---|
| **C1 agent 死代码** | sdk-adapter 壳与测试、text-redaction 两个零引用导出、零引用仓储方法与两个整仓储（task-state、process-execution）、runtime 零引用 fixture、redis/outbox 常量残留 | app A01/A02/T01/T02；infra PR-A/PR-C；runtime RT-T-01 | agent 全套 + typecheck；删生产代码 → 重建容器跑真实链路 |
| **C2 agent 重复收敛** | `appendEventInTxn` ×3、`requireAuth`、`assertDomainRunId`、会话标题派生、`create-http-server.ts` 鉴权空值检查（热点文件，只减不增）、信封/脱敏 helper 搬到独立模块 | app B02/C01/C02/C03/C05；infra PR-D | agent 全套 + typecheck + 真实链路；鉴权合并逐路由正反例 |
| **C3 agent 注释与命名** | Pi / legacy / 计划编号注释、durable-subagent-port 历史叙事、interaction-requester 同名消歧、runtime 注释三处 | app B05/D01–D03/E04；runtime RT-C-06–08 | 单测 + `tests/runtime/plugins.test.ts`（patch 逐字节） |
| **C4 exec + contract** | DB barrel 与只被测试引用的仓储、只被测试引用的 AttachmentService（先确认上传路由的期望行为）、contract 根 barrel 与无消费者的 RPC 类型、公共路由 `actingFrom` / 文件名编码 / 错误映射 / `extensionOf` 合并、65 处 Python 路径注释、parity 测试命名、`@deepseek-ai/cordis` 补为直接依赖 | exec F1–F3/F5–F7/F14–F21 | exec + contract + agent 全套；重建 sandbox / sandbox-mcp 跑真实链路 |
| **C5 BFF** | 错误映射收敛为一个辅助函数并透传 `reason_code`、`X-Acting-*` 剥离名单单一来源、`reviews.ts` 的 body 读取、query 白名单工具、上传上限常量、恒为 true 的参数、不可达分支、只被测试引用的导出、只有前端以外形状的请求体兼容（`messages[]` 之外的写法、SSE 续传三种键名）、注释 | api A1–A11、A17–A26 | api-server 全套 + typecheck + 前端 + 真实链路（含错误码透传的浏览器验证） |
| **C6 frontend** | 死代码与失效 CSS、别名（`reducePlatformEventBatch`、`MeResponseSchema`、`ConversationDetailSchema`）、24 处错误抛出样板、状态 → 色调映射统一到 `StatusBadge`、硬编码色号、三个超长文件按职责拆分（各一个 PR） | frontend PR-1–PR-4 | frontend test + build + 浏览器走查 |
| **C7 文档** | 31 处文档漂移逐条复核后修正：`api.md` 端点双向、`.env.example` 与代码读取的变量双向、退役机制叙事、幻影路径、`docs/README.md` ADR 表、`delegation.md` §6 | docs-drift 全部 | `uv run pytest -q`；链接与路径核对 |

## 缺陷批次（Wave 2，先于清理）

| 批次 | 内容 | 状态 |
|---|---|---|
| B-agent-1 | 无活 Worker 时取消 Run，工具账本行随终态收尾 | 已修，分支 `fix/agent-ledger-and-errors` |
| B-exec | 单实例护栏接入 `main.ts`（本盘点 F4） | 待做 |
| B-agent-2 | ADR 0015 org 名占用检查移进名字锁；Skill 排除原因进 `run.started`；委派 callId 重启重放测试 + 人工处置 runbook | 待做 |
| B-bff | `POST /api/processes/{id}/kill` 默认改为 SIGKILL（用户 2026-10-03 决定） | 待做 |
| B-frontend | 审批原因输入框；中文产物内部路径（先定是否支持，再用测试钉住） | 待做 |
| B-browser | 协作 tab 双标签页并发、进程取消后界面收敛、Run 中途刷新看到终态 | 待做（浏览器走查） |
| B-dev | `development.md`：Compose 与 K8s `dsh-dev` 共用库与队列，二者只能开一套 | 待做 |
