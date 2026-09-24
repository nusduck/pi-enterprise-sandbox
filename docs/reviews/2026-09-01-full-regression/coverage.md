# 当前功能全量覆盖矩阵

核对日期 2026-09-19；分支 `refactor/updrdb-dbpm`，HEAD `480bf65d5bae8bf674599755e7469991c2ac0c38` 及已有未提交改动。本表是 **95 个案例的设计覆盖**，不记录通过状态、不替代 [STATUS.md](../../STATUS.md)。运行清单见 [test-cases.md](test-cases.md) §3，选例与分组账见 [case-selection.md](case-selection.md)。所有模型执行仅 `deepseek-flash`；全量不包含其它模型兼容性声明。

## 1. 页面与用户能力

| 当前能力 | 案例 | 代码核对入口 |
|---|---|---|
| 环境/认证恢复/注册/登录/登出 | ENV-01、ENV-02、AUTH-01、AUTH-02、AUTH-03、AUTH-04、SEC-05 | [auth routes](../../../api-server/src/routes/auth.ts)、[browser auth](../../../agent/src/application/browser-auth-service.ts)、[fake LLM policy](../../../agent/src/config/fake-llm-policy.ts) |
| Chat 文本/多轮/重新生成/模型选择 | CHAT-01、CHAT-02、CHAT-03、DOC-01 | [chat features](../../../frontend/src/features/chat) |
| 会话删除、后台执行、重连、追问排队 | CHAT-04、CHAT-05、CHAT-06、CHAT-07、RUN-01、RUN-02 | [conversation routes](../../../api-server/src/routes/conversations.ts)、[run routes](../../../api-server/src/routes/runs.ts)、[turn gate](../../../agent/src/application/session-turn-gate.ts) |
| 附件草稿、Dataset、图片、多文件 | TOOL-02、TOOL-04、DATA-01、DATA-02、FAIL-02、UI-02、LOAD-01 | [dataset routes](../../../api-server/src/routes/datasets.ts)、[attachment service](../../../exec/src/attachment/service.ts) |
| 文件处理、对账/会议周报与办公交付 | TOOL-01、TOOL-03、ART-01、ART-02、ART-03、BIZ-01、BIZ-02 | [bundled Skills](../../../skills)、[artifact service](../../../exec/src/artifact/service.ts)、[artifact proxy](../../../api-server/src/routes/artifacts.ts) |
| 任务清单、子任务、人机交互 | TODO-01、SUB-01、SUB-02、INPUT-01、INPUT-02 | [runtime providers](../../../agent/src/runtime/providers)、[queue topology](../../../agent/src/infrastructure/redis/run-queue-topology.ts) |
| Runs、Approvals、Trace、Process Console | MGMT-01、MGMT-02、APPROVAL-01、TRACE-01、PROC-01、JOB-01 | [management pages](../../../frontend/src/pages)、[ProcessConsole](../../../frontend/src/widgets/process-console/ProcessConsole.tsx) |
| Capabilities、Skill 生命周期/跨 Pod 发布 | CAP-01、SKILL-01、SKILL-02、SKILL-03、SKILL-04、SKILL-05、SKILL-06 | [CapabilitiesPage](../../../frontend/src/pages/settings/CapabilitiesPage.tsx)、[skillHelpers](../../../frontend/src/pages/settings/skillHelpers.ts)、[skills validator](../../../agent/src/skills/validator.ts) |
| Agent 目录/选择/配置/版本/回滚/迁移 | AGENT-01、AGENT-02、AGENT-03、AGENT-04、AGENT-05、AGENT-06、AGENT-07 | [AgentsPage](../../../frontend/src/pages/settings/AgentsPage.tsx)、[AgentPicker](../../../frontend/src/widgets/composer/AgentPicker.tsx)、[agent routes](../../../agent/src/presentation/http/agents-routes.ts) |
| 外部 MCP 查询、低代码会话与下载 | MCP-01、MCP-02、MCP-03、MCP-04、MCP-05 | [MCP facade](../../../exec/src/mcp)、[MCP plugins](../../../agent/src/runtime/plugins/mcp-entries.ts) |
| Schedules 与执行历史 | CRON-01、CRON-02、CRON-03 | [SchedulesPage](../../../frontend/src/pages/schedules/SchedulesPage.tsx)、[cron routes](../../../agent/src/presentation/http/cron-routes.ts) |
| A2A 页面与外部协议 | A2A-01、A2A-02、A2A-03 | [A2aPage](../../../frontend/src/pages/settings/A2aPage.tsx)、[JSON-RPC mapping](../../../agent/src/application/a2a/json-rpc.ts) |
| 多用户、多会话、资源隔离 | USER-01、USER-02、SEC-01、SEC-02、LOAD-02 | [ownership](../../../agent/src/infrastructure/mysql/ownership.ts)、[run access](../../../api-server/src/application/run-access-service.ts) |
| 导航、详情、主题、键盘/输入法、窄屏 | NAV-01、UI-01、UI-02 | [frontend source](../../../frontend/src)、[WebUI guide](../../webui.md) |
| 上下文与预算 | CTX-01、BUDGET-01、BUDGET-02 | [event projector](../../../agent/src/infrastructure/dsh/event-projector.ts)、[run budget](../../../agent/src/runtime/policy/run-budget.ts)、[BudgetBar](../../../frontend/src/widgets/budget-bar/BudgetBar.tsx) |
| 模型/MCP/服务失败与恢复 | FAIL-01、FAIL-02、MCP-04、REC-01、REC-02、REC-03 | [runtime](../../../agent/src/runtime)、[exec startup](../../../exec/src/main.ts) |
| 隔离/资源/凭据保护/清理 | SEC-03、SEC-03B、SEC-04、ISO-01、ISO-02、CLEAN-01 | [exec source](../../../exec/src)、[production compose](../../../docker-compose.prod.yml) |
| 就绪/DBPM/双 Proxy/schema/队列/排空/VM/切换 | DEPLOY-01、DEPLOY-02、DEPLOY-03、DEPLOY-04、DEPLOY-05、DEPLOY-06、DEPLOY-07、DEPLOY-08 | 下方 §6 逐项追踪；本地模拟与目标部署证据分开 |

## 2. 工具全集

模型工具以 [tool-names.ts](../../../agent/src/runtime/policy/tool-names.ts) 加**本轮真实注册的 MCP 工具**为准。每个工具必须至少有一次实际执行记录；策略/参数等负向分支按对应案例另验。子 Agent 可用工具子集与父任务分别核对。

| 工具 | 真实任务与案例 |
|---|---|
| `read` / `write` / `edit` / `glob` / `grep` | R 交接资料的查找、引用与修订，TOOL-01；路径边界 SEC-03 |
| `read_image` | V 图表/截图与底层数据对照，TOOL-04 |
| `bash` | R/W 校验、Python 多行与文件生成，TOOL-01、TOOL-03、TOOL-04 |
| `job_list` / `job_output` / `job_kill` | 真实后台批处理，JOB-01；PROC-01/REC-02 交叉核对 |
| `todo_write` | 多文件报告步骤完成情况，TODO-01 |
| `skill` | 办公四格式与自定义数据规则，TOOL-03、SKILL-01/02/04/05 |
| `subagent` | R API/前端变化核对，SUB-01 |
| `submit_artifact` | 四格式正式交付、不可变与错误分支，ART-01/02/03 |
| `ask_user_question` | W 受众/年份的用户决策，INPUT-01/02 |
| `mcp__<server>__<tool>` | MCP-01/04；逐 server 列出本轮实际工具与 policy，每个配置工具登记正向/拒绝/不可用情况 |
| `sandbox_file_write/read/list` | 外部客户端保存与核查 W 输入，MCP-02/03 |
| `sandbox_python_execute` / `sandbox_shell_execute` | 外部客户端计算与工作区复用，MCP-02/03 |
| `sandbox_artifact_submit` | 外部报告快照与签名下载，MCP-02/03 |

`python`、`process_*`、`skill_create/install`、`memory_*` 不作为新调用验收入口；别名/退役规则由既有自动化补测。MCP 注册表为空、某个工具只有 schema 没有调用，均不能宣称该集成全量通过。会产生业务写入的外部工具需专用测试目标；没有目标就明确阻塞，不能借“全量”操作真实业务资源。

## 3. 浏览器 API 与外部入口

核对 [BFF 路由源码](../../../api-server/src/routes) 与 [API 路由表](../../api.md)。下表中的多个方法/别名需**分别执行记录**，不能只做一条然后替代同组。按接口适用性再验缺必填、无效 ID、分页/limit、重复请求、未认证、跨 owner/org、依赖超时；用真实可见请求和脱敏参数复现，不直接填数据库造响应。

| 路由族/方法 | 案例 |
|---|---|
| POST auth/register、login、logout；GET auth/me | AUTH-01/02/03、SEC-01 |
| GET/POST conversations；GET/DELETE conversations/{id} | CHAT-01/02/04、AGENT-03、USER-01/02、SEC-02 |
| GET conversations/{id}/events；POST conversations/{id}/runs、follow-ups | CHAT-05/06/07、RUN-02、LOAD-02、SEC-02 |
| POST sessions/ensure | TOOL-02、AGENT-03、ART-02、SEC-02 |
| GET/POST conversations/{id}/datasets；GET datasets | TOOL-02、DATA-02、LOAD-01、SEC-02 |
| POST conversations/{id}/artifact-imports；GET artifacts | ART-01/02/03、SEC-02、ISO-02 |
| GET/POST runs；GET runs/{id} | CHAT-01、MGMT-01、LOAD-02、SEC-02 |
| GET runs/{id}/events、trace、tools | CHAT-06、TRACE-01、MGMT-01、LOAD-02、SEC-02 |
| POST runs/{id}/cancel、steer、resume-approval | RUN-01/02、APPROVAL-01、SEC-02 |
| POST runs/{id}/interactions/{iid}/respond | INPUT-01/02、REC-01、SEC-02 |
| GET approvals、approvals/{id}；POST approvals/{id}/decide | APPROVAL-01、MGMT-02、REC-01、SEC-02 |
| GET processes、processes/{id}、processes/{id}/logs 与 /read | PROC-01、JOB-01、REC-02、SEC-02 |
| POST processes/{id}/stdin、signal、cancel、kill | PROC-01、JOB-01、SEC-02；kill 兼容别名按当前语义验证，不假定默认 SIGKILL |
| GET/POST agents；GET/POST agents/{id}/versions；POST agents/{id}/active-version | AGENT-01/02/03/04、SEC-01/02 |
| GET agents/config/options；POST agents/config/validate | AGENT-05、AGENT-06、AGENT-07、SEC-01/02；200 + valid:false 是无效配置，预览不写库 |
| GET/POST cron-jobs；GET/PATCH/DELETE cron-jobs/{id} | CRON-01/02/03、SEC-02、CLEAN-01 |
| GET cron-jobs/{id}/runs；POST cron-jobs/{id}/run | CRON-01/02/03、SEC-02 |
| GET capabilities/skills、mcp、tools、models；GET extensions/diagnostics | CAP-01、MCP-01/04、SEC-01 |
| POST capabilities/skills/drafts；POST capabilities/skills/{name}/enable、disable | SKILL-01/02/03/04、SEC-02 |
| GET a2a/config；POST a2a/credentials、credentials/{id}/rotate、revoke | A2A-01、SEC-01、CLEAN-01 |
| POST files/upload；GET files/download、files/artifact-download | TOOL-02、ART-01/02/03、LOAD-01、SEC-02/03；分别核对路径下载与正式 Artifact 下载权限 |
| GET /health/live、/health/ready；Agent/Worker/exec 探针 | ENV-01/02、REC-03、DEPLOY-01、DEPLOY-06 |
| Agent Card；A2A message/send、message/stream、tasks/get、tasks/cancel、tasks/resubscribe | A2A-01/02/03 |
| sandbox-mcp /mcp、/health、/ready、签名 Artifact 下载 | MCP-02/03、SEC-04、DEPLOY-01 |
| exec /internal/v1/*、/internal/mcp/v1/* 与公共会话适配层 | SEC-04、ISO-01；正常工具链与浏览器运维链分别验 |

没有 UI 的协议分支记为“真实 HTTP/MCP/A2A 辅助验证”，不包装成浏览器点击通过。新发现未列出的生产路由/注册工具，先补案例再决定整轮是否完成。

## 4. §32 风险面与验收看板映射

此处只映射，不改变任何现有 STATUS 行。涉及源码结构/版本钉的断言仍需自动化或只读代码核对，不宜用一个用户任务假装验证全部内部结构。

| STATUS IDs | 本轮取证对象 | 案例/补充 |
|---|---|---|
| A1–A5 | 当前 DSH runtime、策略、MCP、上下文与 Agent 版本 | ENV-01、TOOL-01、APPROVAL-01、MCP-01/04、CTX-01、REC-01、AGENT-02/04；版本钉/boot 自动化 |
| B1–B6 | MySQL 权威、Redis 临时协调、消息与有序事件、无第二份 Run 账本 | LOAD-02、REC-01/02/03、MGMT-01；补做结构/仓储自动化与残留 Map 只读盘点，不直接用浏览器证明 B3/B4 |
| C1–C8 | session/workspace、稳定路径、并发隔离、Python、进程、Dataset | TOOL-01/02/04、DATA-02、USER-01/02、PROC-01、JOB-01、LOAD-01/02、REC-02、ISO-01/02 |
| D1–D8 | 刷新恢复、Run 取消、上传、Process、审批、Trace、A2A UI | CHAT-06、RUN-01/02、TOOL-02、PROC-01、APPROVAL-01、MGMT-01/02、TRACE-01、A2A-01、UI-01/02 |
| E1–E3 | 显式交付、快照、owner-scoped 下载 | ART-01/02/03、SEC-02、ISO-02 |
| F1–F6 | Card、流式、任务控制、Run 映射、断线与审计 | A2A-01/02/03、SEC-01/02 |
| G1–G7 | 断线、Worker 重启、Redis、幂等、创建查询、交互、孤儿回收 | CHAT-06、LOAD-02、INPUT-01/02、REC-01/02/03；现有 G7 gate 只补充 REC-02 对应断言 |
| H1–H6 | 租户/路径/Skill/非 root、敏感信息与受控数据访问 | SEC-01/02/03/03B/04、SKILL-04、ISO-01/02、MCP-04；H5 真实敏感负载采样/H6 部署清单另取证，canary 不替代全部生产审计 |
| 额外用户面 | 四格式可用性、普通用户并发、导航、Skill 上传、Agent 管理、定时任务、预算、清理 | TOOL-03、USER-01/02、NAV-01、SKILL-03、AGENT-01/02/03/04、CRON-01/02/03、BUDGET-01/02、CLEAN-01 |

## 5. 本次修正的错误前提与范围

- 旧文档用固定回显代表业务可用；现在要求来源冻结、独立验算和打开真实交付件。X 边界夹具与 S 日常合成数据均明确标注，不能把合成夹具等同于造假证据，也不强迫用户提供真实客户数据。
- 旧清单遗漏多 Agent 与版本管理；现在区分 definition/version、新会话选择/旧会话绑定、生效配置/保留字段。
- 旧案例仍写 Composer Skill 拼图按钮、发布后 Drafts 重复卡；当前源码与 WebUI 已删除/调整，按新展示验。
- §8 历史 Artifact 内存 store 结论不适用于当前连接数据库的启动路径；[app.ts](../../../exec/src/http/app.ts) 已注入 MySQL Artifact/Dataset/Quota store。配置缺失的开发 fallback 与正常 Compose 路径不可混算；ART-03/DATA-02 实测重启后使用。
- 旧 REC-02 用“进程消失”判回收不充分；[当前 G7 gate](../../../scripts/release-gates/exec-orphan-recovery-gate.mjs) 针对账本终态和额度，测试需验证这一层。
- `docs/artifact-module.md` 仍包含旧 Python 布局及与当前 exec 不一致的导入路径说明；本清单依据现有 TypeScript 执行路径取证。导入同名覆盖/回滚等要求保留为待实测风险，不声称已实现。
- 本轮只修改回归设计文档；没有新增生产能力，没有重跑历史测试，没有关闭 STATUS 行。全量报告必须同时列出完成、失败、阻塞与未执行项目。
- 当前 Agent 配置已有运行接线与诊断，不能沿用“thinkingLevel/toolPolicy/mcpServers 全部未生效”；flash 不支持的参数与平台未接能力分别判断。
- facade 使用 uid 1000 的独立 slim 镜像；replay Redis 退役、schema 启动只核验。SEC-04 不要求不存在的 jti 去重机制，仍保留执行幂等/fence 的真实验证。

## 6. 本分支变化 → 入口 → 应用服务 → 权威执行/存储

以下为代码接线核对；没有把提交说明或旧演练报告当作本轮通过证据。带“dirty”的行涵盖任务开始时已有在途实现，执行前须冻结其实际版本。

| 变化与案例 | 入口与实际消费路径 | 附加验收面 |
|---|---|---|
| 默认助手并发首建：AUTH-04 | [catalog service](../../../agent/src/application/agent-catalog-service.ts) → [catalog repository](../../../agent/src/infrastructure/mysql/repositories/agent-catalog-repository.ts) | 两普通用户成功 + 无重复 definition |
| 追问顺序：CHAT-07 | [follow-up service](../../../agent/src/application/follow-up-service.ts) → [turn gate](../../../agent/src/application/session-turn-gate.ts) → [Worker](../../../agent/src/bootstrap/worker-main.ts) | Run 账本、session 锁、输出依赖 |
| 配置编辑/预览/并发/迁移：AGENT-05、AGENT-06、AGENT-07 | [editor](../../../frontend/src/pages/settings/AgentConfigEditor.tsx) → [BFF](../../../api-server/src/routes/agents.ts) → [validator](../../../agent/src/application/agent-config-validator.ts) → [bindings](../../../agent/src/infrastructure/dsh/agent-version-bindings.ts) → [runtime](../../../agent/src/infrastructure/dsh/runtime-factory.ts) | 字段错误、草稿、过期响应、最终请求与工具权限 |
| 跨机 Skill：SKILL-06 | [enablement service](../../../agent/src/application/skill-enablement-service.ts) → [publisher](../../../agent/src/skills/enablement.ts) → [manifest contract](../../../contract/src/skill-manifest.ts) → exec | 对应部署 T1；摘要、持久账本、只读挂载 |
| 分层子任务：SUB-02 | [durable subagent](../../../agent/src/runtime/providers/durable-subagent.ts) → [queue topology](../../../agent/src/infrastructure/redis/run-queue-topology.ts) → Worker/Run 账本 | 根层饱和、深层保留槽、缩深拒启 |
| MCP 实时目录：MCP-05（dirty） | [MCP entries](../../../agent/src/runtime/plugins/mcp-entries.ts) → [discovery projection](../../../agent/src/bootstrap/container-mcp.ts) → 配置/探针消费者 | 启用但断连不伪装为空配置 |
| 真实 readiness：DEPLOY-01（dirty） | [BFF status](../../../api-server/src/routes/status.ts) → [Agent health](../../../agent/src/presentation/http/health-routes.ts) → [exec readiness](../../../exec/src/http/readiness.ts) | T2/T6；下游活着但不可用的对照 |
| 启动取密：DEPLOY-02 | [DBPM contract](../../../contract/src/dbpm.ts) → [Agent startup](../../../agent/src/bootstrap/startup-credentials.ts)、[exec startup](../../../exec/src/startup-credentials.ts)、[facade startup](../../../exec/src/mcp/startup-credentials.ts) | T8；角色最小化、失败拒启、错误脱敏 |
| Proxy/UTC：DEPLOY-03 | [Agent failover](../../../agent/src/infrastructure/mysql/failover.ts)、[exec failover](../../../exec/src/db/failover-pool.ts) → DB/事务 | T8；建连切换不等于事务盲重放 |
| Schema：DEPLOY-04 | [release/apply](../../../scripts/dev/schema-apply.sh) → [Agent verify](../../../agent/src/infrastructure/mysql/schema-verify.ts)、[exec verify](../../../exec/src/db/schema-verify.ts) | T4；空库、正确对象、对象缺失、恢复 |
| 抢占与 Redis：DEPLOY-05 | [run queue](../../../agent/src/infrastructure/redis/run-queue.ts) → [Worker](../../../agent/src/bootstrap/worker-main.ts) → MySQL/Redis | T3/T7；真实事务、锁/租约、跨副本取消 |
| 排空与恢复：DEPLOY-06（dirty） | [worker drain](../../../agent/src/bootstrap/worker-drain.ts) → [run recovery](../../../agent/src/application/run-recovery-service.ts) → Run/ToolExecution | T3/T5；期限内/超期/不确定工具分开 |
| VM/入口：DEPLOY-07 | [VM assets](../../../scripts) 与 [deployment](../../deployment.md) → [exec main](../../../exec/src/main.ts)/systemd → bwrap/办公产物 | T2/T6；目标 VM 单独证据 |
| 切换/回退：DEPLOY-08 | [K8s launcher](../../../scripts/dev/k8s/up.sh) → [manifests](../../../scripts/dev/k8s/manifests.yaml) → 队列/库/卷实际消费者 | T5；imageID/EndpointSlice/唯一消费组 |
| 浏览器入口安全：SEC-05 | [auth routes](../../../api-server/src/routes/auth.ts) → BFF Cookie/来源校验 → Agent 身份 | T2/H1/H5；HTTP/HTTPS 按实际模式 |

T1–T8 关联 [部署设计 §12](../../design/updrdb-dbpm-deployment.md#12-验收矩阵与未决项)，按本分支现状校正：HTTP 内网模式不能套 HTTPS 必须通过；replay Redis 旧条目不能作为当前组件。目标依赖未到位保留阻塞；不更新 STATUS 的现有状态。
