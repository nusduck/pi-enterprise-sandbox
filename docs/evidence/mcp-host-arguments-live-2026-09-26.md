# 同一 MCP 按智能体注入宿主参数：真实链路验证（2026-09-26）

对应设计：[design/mcp-per-agent-arguments.md](../design/mcp-per-agent-arguments.md)。

## 验证对象

- 分支 `feat/frontend-redesign`：后端 `1f19ab71`；前端「平台参数」输入框与文档为本次提交（验证时为未提交改动，
  与提交内容一致）。
- 运行时：`runtime-versions.json`（Node 22）；单测在 `node:22-slim` 容器内、完整仓库布局下执行。
- 栈：本机 Docker Compose。**已重建** `agent` / `agent-worker`（同镜像）与 `frontend` 镜像并重建容器。
  `api-server`、`sandbox`、`sandbox-mcp` 未改动、未重建。
- 临时配置：`agent` / `agent-worker` 以 shell 环境覆盖 `MCP_SERVERS_JSON`，在原有 `exa` 之外登记测试 Server
  `qa`（镜像内的 `agent/tests/runtime/fixtures/mcp-host-args-server.mjs`，stdio，回显收到的参数），
  声明 `hostArguments: { kb_id }`。结束后不带覆盖重建容器，清单恢复为只有 `exa`。
- 模型：本地配置的真实模型网关（`deepseek-flash`）。

## 环境发现

首轮两个 Run 均回答 `NO_TOOL`，但**不是**本功能所致：K8s 开发栈（命名空间 `dsh-dev`）的 `agent-worker`
与 Compose 栈共用同一套 MySQL / Redis 队列，抢走了这两个 Run（其日志里有对应的 `dsh session create`），
而它跑的是旧镜像、没有 `qa`。经用户同意临时 `kubectl -n dsh-dev scale deploy/agent-worker --replicas=0`，
验证结束后恢复为 1。两套栈共用队列是既有环境问题，与本次改动无关。

## 单测与检查

| 命令 | 结果 |
|---|---|
| `npm test --prefix agent`（含 `mcp-host-args-live.test.ts` 真实 MCP Server、`boot.test.ts`） | 1534 pass / 0 fail |
| `npm --prefix agent run typecheck`（主程序 + runtime strict） | 通过 |
| `npm test --prefix frontend` + `npm run build --prefix frontend` | 416 pass；构建成功 |
| `uv run pytest -q` | 226 passed |
| `exec` / `contract` / `api-server` 测试 | **未重跑**：本次未改动这三个包 |

`mcp-host-args-live.test.ts` 的反向对照：把运行期声明置空后该测试失败，恢复后通过。

## 真实链路（BFF `:3000` → agent → agent-worker → 真实模型 → MCP Server）

测试智能体 `qa-hr`、`qa-finance`：系统提示要求调用 `mcp__qa__ask` 并原样返回结果，工具不可用时回答 `NO_TOOL`。
`qa-finance` 经 API 建（`toolArguments.kb_id=finance`）；`qa-hr` 经 API 建（不带值），在设置页 MCP 分类的
「平台参数」里填 `hr` 后「仅保存为 v2」，之后在版本历史里启用 v2。

| 场景 | 结果 |
|---|---|
| `config/validate` 带未声明的 `toolArguments.app_id` → `valid:false`，`MCP_ARGUMENT_UNKNOWN`，path `mcpServers[0].toolArguments.app_id` | PASS |
| `config/options` 的 `platformConstraints.mcpServers` 中 `qa` 带 `hostArguments: [{name:"kb_id", description:"知识库 ID"}]`，无连接材料 | PASS |
| 设置页 MCP 分类渲染「平台参数」输入框；输入 `hr` 后「1 处未保存修改」「校验通过」；保存的 v2 配置为 `toolArguments: {kb_id:"hr"}` | PASS（浏览器操作） |
| `qa-hr` v1（未配 `kb_id`，而 `kb_id` 必填）→ Worker 日志 `[mcp-host-args] hidden tool=mcp__qa__ask missing=kb_id`；模型工具列表里没有该工具，回答 `NO_TOOL`，无工具调用 | PASS |
| `qa-finance`，用户消息要求 `kb_id=hr` → 模型只能把它写进 `question`；账本参数 `{"kb_id":"finance", ...}`，Run 进入 `WAITING_APPROVAL`；审批卡显示 `"kb_id": "finance"` | PASS |
| 批准后 Server 回显 `RECEIVED {"question":"… (kb_id=hr)","kb_id":"finance"}`；账本行 `SUCCEEDED`，参数与 Server 收到的一致 | PASS |
| 启用 `qa-hr` v2，用户消息要求 `kb_id=finance` → 待审批参数 `{"kb_id":"hr","question":"What is the leave policy?"}`；批准后 Server 回显 `kb_id:"hr"` | PASS |

## 未覆盖

- 跨租户 404：本次未改鉴权与 org 作用域，未重跑（浏览器用户共用一个 org，另一身份需要口令）。
- 进程 logs/signal：未改 exec，未重跑。
- 审批卡不标注哪些参数由平台填入：按设计 §9 的决定不做。
- 测试智能体 `qa-hr` / `qa-finance` 留在本地库中（目录没有删除接口）。
