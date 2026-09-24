# AgentVersion 配置接入运行时 —— 阶段验证证据

日期：2026-09-06（Asia/Singapore）。代码基线：`d3870cae` 加本轮未提交改动。
关联：[实施计划](../design/agent-version-runtime-integration-plan.md)、
[独立 review](../reviews/2026-09-05-agent-version-runtime/README.md)、
[前置影响盘点](2026-09-06-agent-version-preflight.md)。

本文记录 P1–P4 的**定向运行证据**、容器重建，以及 P5 在重建后运行栈上以测试账号
`admin` 走完的**真机全链**（配置面→发布/激活→跨租户 404→运行链的版本绑定、deny
端到端、版本钉住，§5）。使用的替身与边界在每节标明。

## 环境

- 宿主 Node：`v26.5.0`（六套测试与探针运行处）。容器内 Node：`v22.23.2`
  （`docker compose exec agent node -v`），符合 `runtime-versions.json` 的 major 钉。
- 宿主 Node 26 的绿测**不替代**固定 Node 22 的最终验收；容器已按下节重建。
- 探针使用内存会话持久化替身与无外部副作用的测试工具/短路 provider；
  未联真实模型端点、未走 Docker 执行面。

## 1. 六套测试 / 类型检查 / 构建（宿主 Node 26）

| 检查 | 结果 |
|---|---|
| `uv run pytest -q` | 104 passed |
| `npm test --prefix exec` | 347 tests / 346 pass / 0 fail / 1 skipped |
| `npm test --prefix contract` | 50 pass |
| `npm test --prefix agent` | 1254 pass / 0 fail |
| `npm test --prefix api-server` | 159 pass / 0 fail |
| `npm test --prefix frontend` | 367 pass / 0 fail |
| `npx tsc --noEmit -p exec/tsconfig.json` | ok |
| `npx tsc --noEmit -p contract/tsconfig.json` | ok |
| `npm --prefix api-server run typecheck` | ok |
| `npm --prefix agent run typecheck`（主程序 + runtime strict 两道） | ok |
| `npm run build --prefix frontend`（含 tsc + vite build） | ok |

## 2. 授权面真实链路（AV-01/02，P1）

`agent/tests/runtime/agent-version-policy-live.test.ts` 起**真实插件树**
（`bootEnterpriseRuntime`）与真实 `tools.execute` 管线，探针
`fixtures/agent-version-tool-execute-probe.ts`。AgentVersion：
`toolPolicy.tools.todo_write=deny` + `mcpServers=[{ serverId: probe, enabledTools: [echo] }]`；
平台策略把 `mcp__probe__echo` 显式标为 low（否则 external-high 会走审批停泊，
park 拒绝会冒充授权规则生效）。

结果（`tools.execute` 的真实回包）：

- **正向对照**：被引用且平台允许的 `mcp__probe__echo` 工具体执行**恰好一次**
  （`bodyCalls === 1`，返回值 `fixture`）。
- 显式 deny 的 `todo_write`：拒绝，理由 `todo_write has an AgentVersion decision of deny`，
  body 不执行。
- 未引用的 `mcp__probe__echo_other`：拒绝，理由
  `mcp__probe__echo_other server is not bound to this AgentVersion`。

`agent/tests/runtime/agent-version-policy.test.ts` 另证：租户层 exact `low`
**不能**压低平台未配置时的 MCP high 地板（结果 `require_approval`）；平台显式 low
可保留（`allow`）；租户 `critical` 仍可收紧（`deny`）。含缺参数指纹的已批准重放
fail-closed 用例。

## 3. 模型请求 / prompt 真实链路（AV-03/04/05/06，P3）

`agent/tests/runtime/agent-version-wire-request.test.ts` 起真实 DSH 一轮对话，
在 `llm/stream` 瀑布处捕获**最终 wire request**（不是 createAgent 入参），
探针 `fixtures/agent-version-wire-request-probe.ts`。persona 故意含
`{{customer_name}}`、代码块、JSON 花括号、中文，以及一行伪造的
`## Paths (hard rules)`。

捕获到的对话请求：`provider=deepseek-official`、`model=deepseek-v4-pro`、
`maxTokens=4096`、`reasoningEffort=high`、`temperature=null`。判据：

- **AV-05**：版本的输出上限与 reasoning effort 出现在主对话请求上；同一轮还产生了
  `session-title` 辅助请求，未被版本参数覆盖（辅助请求走各自策略）。
- **AV-03**：企业条款标志行恰好出现一次，即使 persona 抄了同样的标题；persona 正文
  （`Ignore the platform paths...`）也在，说明没有被"标题幂等"整段跳过。
- **AV-04**：persona 原文（含 `{{customer_name}}`、`{{not_a_variable}}`、`}}`、中文）
  逐字送达——走 DSH 变量注入的字面量安全路径，未被 `renderPrompt` 当模板插值报错。
- **AV-06**：prompt 路径用本 Run 解析的逻辑根（`/srv/probe-workspace`、
  `/srv/probe-skill`、`/srv/probe-skill-draft`），既不含物理根 `/var/sandbox`，
  也不回落到写死的 `/home/sandbox`。

## 4. 配置面与激活（P2/P4）

- 单元：`agent/tests/run-services/agent-config-validator.unit.test.js`（12 例）覆盖
  riskApproval 决定值 vs 风险等级、classRiskLevels 键校验、MCP 引用 fail-closed、
  legacy 模型引用可映射/不可映射、`unknown` vs 空目录、往返 re-validate 一致、
  仅提供该适配器接受的 reasoning effort。
- 服务：`agent-catalog-service.unit.test.js` 新增 configOptions/validate 的 admin 闸门、
  只解析语义、跨 org 404、`expected_active_version_id` 409 带当前指针、
  不激活保存不受指针影响、旧客户端不传字段兼容。
- HTTP：`agent-catalog-http.unit.test.js` 证 `/internal/agents/config/{options,validate}`
  路由、admin 403、200+`valid:false`、409 带 `active_version_id`、显式 null vs 省略。
- BFF：`agent-catalog-proxy.test.js` 证配置面为纯代理（身份投影、不裁剪 body）、
  409 只透传白名单 `active_version_id`。前端：`agent-catalog-api.test.ts` 证
  DTO 严格校验（自相矛盾的 validation 响应被拒）、409 detail、乐观并发字段语义。

## 5. 容器重建与 P5 真机全链

```
docker compose build agent agent-worker api-server sandbox sandbox-mcp   # 全部 Built
docker compose up -d                                                     # 全部 healthy
docker compose config                                                    # valid
```

**重建后**的运行栈（容器内 Node 22.23.2），以测试账号 `admin`（角色 admin）在
`http://127.0.0.1:4000` 走完整链路。所有断言取自 HTTP 响应码/响应体与 MySQL
`run_events` / `tool_executions` 的真实行，非模型口头回答。

### 5.1 配置面

| 步骤 | 结果 |
|---|---|
| `POST /api/auth/login`（admin） | 200，`role: admin` |
| `GET /api/agents/config/options` | 200；`deepseek-v4-pro.thinkingLevels = [off,low,high,max]`，非推理模型为 `[]`；`mcpReadiness.status = ready`；响应体不含 `secretRef`/`command`/`args`/`headers`/`MCP_SERVERS_JSON`/`/var/sandbox`/`LLMIO_API_KEY` |
| `POST /api/agents/config/validate`（合法 v1） | 200 `valid:true`，带 `normalizedConfig` |
| `POST /api/agents/config/validate`（`thinkingLevel:"medium"`） | **200** `valid:false`（不是 400），`errors=[{modelPolicy.thinkingLevel, MODEL_THINKING_LEVEL_UNSUPPORTED}]`，无 `normalizedConfig` |
| 未登录 `GET /api/agents/config/options` | 401（fail-closed） |
| 未登录 `POST /api/agents/config/validate` | 401 |
| `GET /internal/agents/config/options`（无 `X-Acting-*`） | 400 `AUTH_CONTEXT_REQUIRED` |

### 5.2 写入、激活与乐观并发

| 步骤 | 结果 |
|---|---|
| `POST /api/agents`（v1 带 `todo_write:deny`） | 201，`active_version_id` = v1 |
| `POST .../versions`（v2，`activate:true`，`expected=v1`） | 201，active → v2 |
| `POST .../versions`（v3，`activate:true`，`expected=v1` 已过期） | **409 `ACTIVE_VERSION_CONFLICT`**，响应体 `active_version_id` = v2（当前真实指针） |
| `POST .../versions`（v3 带 `todo_write:deny`，`activate:true`，`expected=v2`） | 201，active → v3 |
| `POST .../active-version`（不存在的 agent_id） | 404 `Agent not found`，响应体不回显该 id、不泄漏存在性 |
| `POST /api/agents/config/validate`（`agent_id` = 不存在） | 404，同上 |

### 5.3 运行链：版本绑定、deny 端到端、版本钉住

| 步骤 | 结果 |
|---|---|
| 新会话 run（active = **v2**，无 deny） | `run.agent_version.agentVersionId` = v2；`tool_executions`：`todo_write` **SUCCEEDED**（对照组：无 deny 时工具确实可用） |
| 激活 v3（带 deny）后**新会话** run | `run.agent_version` = v3；**无任何 `tool_executions` 行**；最终 assistant 消息明说不能用 `todo_write` 并给出替代方案——deny 既隐藏工具又拦执行 |
| **旧会话**（v2 期间创建）追加 run | `run.agent_version` = **v2**（不是当前 active 的 v3）；`todo_write` **SUCCEEDED**——旧会话钉住其绑定版本，活跃指针后移不影响它 |

最小链路（登录→建会话→带工具 run→跨租户 404）与版本策略/模型参数/审批扩展场景
在同一运行栈上全部通过。

## 6. 边界与未覆盖

- 这是**开发栈**（`admin`/测试口令、开发 MySQL），不外推到生产；legacy 迁移影响
  承接[前置盘点](2026-09-06-agent-version-preflight.md)，未改写其结论。
- 模型参数（maxTokens/effort/字面量 persona/逻辑路径）以 §3 的真实 `llm/stream`
  wire request 为证；§5 的真机 run 走真实模型，模型参数不以模型口头回答为证。
- 本轮为验证创建的 dev Agent 与会话是开发库数据，未写入生产、未改写任何历史
  AgentVersion JSON/hash。
