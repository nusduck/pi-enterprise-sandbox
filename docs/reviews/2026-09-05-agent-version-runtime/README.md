# AgentVersion 实施的独立 review

日期：2026-09-05。实现负责人：Luna（max）。Advisor/reviewer：主任务。

实施依据：[接入优化计划](../../design/agent-version-runtime-integration-plan.md)。
状态：实施中；本文不是上线验收结论。P0–P5 尚未完成独立验收。

## 审查点

| 阶段 | 独立审查重点 | 状态 |
|---|---|---|
| P0/P1 | 工具授权、跨具体性风险合并、MCP 精确引用、空列表、durable 审批消费 | **已实现并有运行证据**：真实插件树 `tools.execute`（含正向对照一次执行）、租户不能压低平台风险、缺指纹重放 fail-closed。续跑一次性消费拆到 `approved-replay-claim.ts`。见[接入证据 §2](../../evidence/2026-09-06-agent-version-runtime-integration.md) |
| P2/P3 | v1/legacy 契约、租户校验、普通 prompt 字面量、路径、模型最终请求与 resume | **已实现**：`agent-config-validator` + 配置面接口；prompt 拆企业/字面量 persona、逻辑根；maxTokens/effort 已在真实 wire request 验证。见[证据 §3/§4](../../evidence/2026-09-06-agent-version-runtime-integration.md) |
| P4 | 表单/JSON 无损往返、字段错误、异步竞态、激活冲突、会话真实版本 | **已实现**：拆出 `AgentConfigEditor`/`AgentValidationPanel`/`conversationProjection`；请求代次保护、409 乐观并发、目录不可达≠空清单、草稿态 MCP 工具行仍可报错。前端回归绿 |
| P5 | 六套测试/类型检查、固定 runtime、容器真实链路、浏览器与模型证据 | **已完成**（开发栈）：六套测试+类型检查+build 绿；容器重建后以 admin 走完配置面→发布/激活→乐观并发 409→跨租户 404→运行链（版本绑定、deny 端到端、旧会话版本钉住），见[证据 §5](../../evidence/2026-09-06-agent-version-runtime-integration.md)。dev 库结论不外推生产 |

## 实施前额外发现

以下补充原计划 AV-01/02，不是可延期的无关清理。

### RV-01：不同具体性规则之间可以放松平台风险

基线 `d3870cae` 的 `buildRunRiskResolver` 实际调用：平台
`tools: { "mcp__x__*": "high" }`，AgentVersion
`toolPolicy.riskLevels: { "mcp__x__t": "low" }`，结果为 `low`。

原因：按键合并风险表后再按具体性选择，跨层的 wildcard 和 exact 没有比较严格程度。
应验证分别解析平台/租户的有效约束后取最严格决定；不能只测同一个 key 的 maxRisk。

### RV-02：历史批准可以越过当前 critical 拒绝

基线实际调用 `evaluatePreExecute`：提供同工具/参数的 APPROVED 记录，当前
`riskOverrides: { bash: "critical" }`，仍返回 `allow / APPROVAL_GRANTED_ONCE`。

原因：批准分支先返回，前面已计算的 deny 和后面的重放指纹校验没有参与最终决定。
审批只能满足已授权操作的审批要求，不能增加工具权限或覆盖当前平台 deny。

### RV-03：durable 消费和指纹完整性需要从生产接线证明

静态核对：`GovernanceApprovalStore.consume` 仅调用可选依赖；executor 构造该 store
时未传 consume。生产 `findResolvedByDigest` 的 `_argsIntegrity` 缺失时也未拒绝。
这两项仍需失败测试和真实事务验证，不能将内存 store 的 consumed Set 当成 durable 证明。

## 独立验收原则

- 工具授权以工具 body 调用次数、稳定拒绝原因及持久记录为判据，不能只看工具是否出现在 schema。
- 模型配置以最终 wire request 为判据，不能只看工厂入参或模型口头回答。
- 不将“技能继承存在”未经验证地描述为技能启用绕过。
- 不改写历史 AgentVersion JSON/hash；兼容投影不能保留已复现的越权。
- 不覆盖其他任务已有的 `2026-09-01-full-regression` 在途文档。

后续阶段结论在本目录记录；阻塞项必须进入实施闭环，不转存为非阻塞债务。

## 第一批回归的 review（实现前）

`agent/tests/runtime/agent-version-policy.test.ts` 新增 5 条失败用例。第一轮独立阅读意见：

1. PolicyCtx 手动传入 authorization 可以证明挂载函数不消费它，但还需补 executor/factory
   从实际 AgentVersion 生成授权，再通过真实 DSH `tools.execute` 断言 body 调用次数为 0。
2. “缺指纹”用例目前模拟 PendingApproval，需补生产仓储查询层 `_argsIntegrity=null` 的
   场景和正确指纹可通过的对照，避免只测试一个新接口字段缺失。
3. MCP 允许工具触发 ask 会停泊该 scope；后续未授权工具用例应分开 scope 或核对准确拒绝原因，
   防止把 park guard 的拒绝当成授权规则已生效。
4. durable 消费失败不能放进会吞错的 toolLedger.started 通知里；允许工具前必须确认原子消费成功。

以上意见已发给实现负责人，尚未宣布 P0/P1 通过。

## 第一批实现的 review（中间稿）

实现负责人报告：真实 DSH 工厂 → scope → `tools.execute` 中，显式禁止的
`todo_write` 和未绑定的 `mcp__probe__echo` 均返回对应授权拒绝，测试工具 body
调用次数为 0。这是定向修复证据，尚不替代完整审批和容器链路验收。

静态审查已退回以下问题，等待修正与正向对照：

1. guard 将所有非 allow 决定直接拒绝，会连 `require_approval` 一并拦截。
   需证明选中的 MCP 工具经过有效审批后能执行一次，审批消费失败时不能执行。
2. 风险解析给所有 MCP 无条件加 high 下限，超出“未配置默认 high”的要求。
   需同时证明平台显式 low 可保留、版本 exact low 不能压低平台 wildcard high。
3. 授权解析保留 wildcard/`server::tool`，执行阶段却仅作 exact lookup。
   被接受的规则不能静默不生效：需规范化和匹配，或以字段诊断拒绝不支持的形状。
4. 前端 API 中间稿同时猜测 camel/snake 命名且多数成功字段可缺失。
   前后端 DTO 确认后须收敛；缺规范配置或自相矛盾的成功响应不能让 UI 进入可保存状态。

以上是正在实现中的审查反馈，并非最终缺陷清单或完成结论。

## 2026-09-06 续接审查

按用户要求先优化根 `AGENTS.md`：修正 HTTP/Worker 进程描述、ADR 编号及版本声明规则，
区分纯文档/阶段检查/代码最终验收，补充前后端契约、协作所有权与证据边界。
文档相对链接、章节兼容和 `git diff --check` 通过。卫生与版本检查 27 pass / 1 fail，
失败来自实施中的 executor（1528 > 1526）及 recorder（1663 > 1654）行数预算，已交回实现者。

另在 Node 22.19.0 复现中间稿的完整策略断线：平台
`{ tools: { todo_write: "high" }, riskApproval: { high: "allow" } }` 与空版本配置，
`buildRunPolicyResolver` 返回 allow，但 `evaluatePreExecute` 返回 require_approval。
原因是后者仍合并固定风险表，覆盖平台完整策略。修复需保留无 resolver 调用的兼容默认，
同时使生产完整策略成为风险决定入口，仍禁止租户降低平台约束。

前端中间稿已退回的具体反例：legacy flat 工具规则在组件内第二套投影中缺失；MCP 字段
错误使用目录索引而非草稿 enabledTools 索引；工具列表暂不可用时错误描述为零授权；
错误结构的 modelPolicy/toolPolicy/mcpServers 被表单写入时可能覆盖原文；差异函数将
object 键顺序变化当作配置改变。等待对应回归与修正，尚不认定 P4 通过。

前端首个检查点由主任务在 Node 22.19.0 独立执行：354 tests pass，typecheck pass。
新增用例目前覆盖 4 组 helper 行为，不能替代组件交互和真实 API 验收。
追加退回：StrictMode 的 effect 重放后 mountedRef 未恢复；旧 Agent 的 409 响应可能
触发 refresh 重新选中旧 Agent 并混入当前草稿。等待定向复现、修复和浏览器验证。

主任务随后在浏览器中复现并确认修正了目录 401 被当作空列表的问题：失败时现在明确
显示 HTTP 401 不可用，相关模型选择控件禁用。无效结构的 JSON 草稿保留及结构提示亦已实测。
这两项不替代已登录的创建/保存/切 Agent/409 联调。

后端首个检查点由主任务在 Node 22.19.0 独立复跑 7 个定向文件，76 tests / 6 suites 全部通过。
其中 recorder 的事务测试使用 fake Knex；真实 DSH fixture 此时仍只证明拒绝调用不运行 body，
尚未证明跨 scope 的有效审批放行一次。已要求补充正向与重复消费对照，P1 仍未独立验收通过。

主任务补充 P2 的三个可执行反例，均已交回实现者补 red/green 回归：合法
`riskApproval.high=require_approval` 被当成风险等级拒绝；空 MCP 目录反而允许未知
server/tool；legacy `modelRef` 被忽略后输出 v1，且非空 legacy skills 被带入该
validator 自己会拒绝的新格式。迁移差异与运行有效配置不能靠静默丢字段消除。

P1 新的静态接线疑点：批准消费使用原 toolCallId，而模型重发后的 started/ended
仍直用新 callId，可能使原批准账本留在 RUNNING。要求正向回归核对原 ToolExecution
终态、真实 body 一次执行及重复消费拒绝；此时尚未将疑点写为已复现缺陷。

P0 已补[本地 MySQL 只读影响盘点](../../evidence/2026-09-06-agent-version-preflight.md)：
2 个版本均为 legacy 且无 MCP 授权引用，共绑定 118 个历史 AgentSession。
这是开发库统计，不外推到生产；没有改写配置或历史 hash。STATUS A2/A3/A5 已标记
具体待验收缺口，H5/H6 的既有部分完成状态保持。


## 2026-09-06 收口

前面各轮退回的问题均已修复并有对应回归，主任务在宿主 Node 26 复跑并重建容器：

- **P1**：真实插件树 `tools.execute` 现在有正向对照——被引用且平台允许的 MCP 工具体
  执行恰好一次，deny/未引用各返回稳定拒绝理由；探针补了平台显式 low 用例，避免 park
  拒绝冒充授权。续跑的一次性消费（`consume`）与缺指纹 fail-closed 拆到
  `application/approved-replay-claim.ts` 并接进 executor；RUNNING/终态重复认领在
  recorder 里按 `approvalId` 拒绝。RV-01/RV-02/RV-03 均已闭合。
- **P2/P3**：`riskApproval` 决定值不再被当风险等级拒绝；空 MCP 目录不再放行未知
  server/tool（`unknown` 与空目录区分）；legacy `modelRef` 不可映射时阻止升级、
  非空 legacy `skills` 等按迁移阻断项返回而非静默丢弃。reasoning effort 目录纠正为
  按路由适配器投影（`off|low|high|max`），退役的 `medium` 不再出现在可选项。
- **P3 prompt**：正文标题幂等已移除，企业条款恰好一份；persona 走字面量变量，
  `{{...}}`/代码块/中文原样送达；真实 wire request 证 maxTokens/effort/逻辑路径。
- **P4 前端**：StrictMode `mountedRef` 复位、旧 Agent 409 不串草稿、MCP 字段错误用
  草稿 enabledTools 索引、结构非法不覆盖原文、差异比较忽略对象键顺序——均有前端回归；
  草稿里已启用但目录已无的 MCP 工具仍渲染成一行以承载其错误。

热点文件按职责拆分回到行数预算之下（executor/recorder/ChatContext），棘轮已收紧。
六套测试、全部类型检查、前端 build 绿。容器重建后以测试账号 admin 走完 P5 真机全链：
deny 版本使 `todo_write` 从模型侧消失且无 `tool_executions` 行、无 deny 的对照版本工具
执行成功、旧会话追加轮次仍钉在其绑定版本（active 指针已后移到 deny 版本也不受影响）、
激活乐观并发 409 回传当前指针、跨租户/不存在 agent_id 统一 404。完整证据见
[接入证据 §5](../../evidence/2026-09-06-agent-version-runtime-integration.md)（开发栈，不外推生产）。
