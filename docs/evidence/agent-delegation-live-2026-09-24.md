# Agent 间委派与远端 A2A 委派：真实链路验证（2026-09-24）

对应设计：[design/agent-delegation.md](../design/agent-delegation.md)、
[design/a2a-remote-delegation.md](../design/a2a-remote-delegation.md)。

## 验证对象

- 分支 `feat/multi-agent-delegation`：`cc15e2e7`（delegate_to_agent）、`2050dc77`（delegate_to_remote_agent）、
  `ff1a7d29`（history 回读修复，由本次真实链路发现）。验证时无未提交的生产代码改动。
- 运行时：`runtime-versions.json`（Node 22；测试在 `node:22-slim` 容器内执行）。
- 栈：OrbStack 单节点 K8s，`scripts/dev/k8s/up.sh dev`（命名空间 `dsh-dev`，真实模型网关）。
  **已重建** `agent`/`agent-worker`（同镜像）、`api-server`、`sandbox`、`sandbox-mcp`、`frontend` 镜像并
  rollout restart；`ff1a7d29` 之后再次重建 `agent` 并重启 `agent`/`agent-worker`。确认 Pod 内
  `dist/src/runtime/bundle/cordis.patch.yml` 含两个新插件条目。
- 测试期间对 `agent-env` / `agent-worker-env` Secret 做了临时覆盖（追加测试管理员用户名；
  `A2A_PUBLIC_BASE_URL=http://agent:4100` 使卡片端点可在集群内访问；`A2A_REMOTE_AGENTS_JSON` 与凭据变量）。
  结束后重新执行 `up.sh dev` 还原、删除额外的凭据键，并吊销测试签发的 A2A 凭据。

## 单测与检查

| 命令 | 结果 |
|---|---|
| `npm test --prefix agent`（含 build 与 `boot.test.ts` 真实插件树） | 1472 pass / 0 fail |
| `npm --prefix agent run typecheck`（主程序 + runtime strict） | 通过 |
| `npm test --prefix contract` + `tsc --noEmit -p contract` | 118 pass；通过 |
| `npm test --prefix frontend` + `npm run build --prefix frontend` | 369 pass；构建成功 |
| `uv run pytest -q` | 226 pass |
| `exec` / `api-server` 测试 | **未重跑**：本次改动未触及这两个包 |

## 真实链路（驱动脚本经 BFF `:4000`，真实模型）

| 场景 | 结果 |
|---|---|
| 保存期：`delegation.agents` 引用不存在的 Agent → validate `valid:false` + `DELEGATION_AGENT_UNKNOWN`；建版本 400 | PASS |
| `deleg-lead` 用 `delegate_to_agent` 委派给 `deleg-analyst`，父 Run SUCCEEDED，结果带目标人格标记 `ZEBRA-7731 17 * 23 = 391.` | PASS |
| 账本：子 Run `source=subagent`、`subagent_depth=1`，`agent_version_id` 为 `deleg-analyst` 活跃版本，子会话 `agent_id` 为 analyst；父 Run 仍绑 `deleg-lead` | PASS（MySQL 直查） |
| 另一用户读子 Run → 404 | PASS |
| 目标不在白名单 → 工具错误 `DELEGATION_AGENT_NOT_ALLOWED`，无子 Run | PASS |
| 子 Run RUNNING 时取消父 Run → 父 CANCELLED，子 Run 26 ms 内级联 CANCELLED | PASS |
| `delegate_to_remote_agent`（远端 = 本部署 `deleg-analyst` 的 A2A 面，v0.3 卡片）→ 先 WAITING_APPROVAL，批准前远端无新 A2A task | PASS |
| 批准后远端生成 A2A task，回答 `ZEBRA-7731 19 * 21 = 399.` 回到父 Run | PASS（修复后） |
| 拒绝审批 → 远端无新 A2A task | PASS |

## 发现

1. **（已修复，`ff1a7d29`）** 本仓库的 A2A 服务端 `GetTask` 只把回答放在 history 里，客户端首次实测
   拿到空文本。修复与回归测试见该提交。
2. **（未修复，与本次改动无关）** 审批恢复后，模型以新的 tool call id 重新发起调用并执行；原先被批准
   那次调用的 `tool_executions` 行停在 `RUNNING`、`result_json` 为空。对照组（普通 `bash` +
   `toolPolicy.tools.bash=require_approval`）同样复现，属审批恢复路径的既有行为，需单独跟进。
3. BFF 对 `ValidationError` 返回的 `code` 是 `VALIDATION_ERROR`，具体码（`DELEGATION_AGENT_UNKNOWN`）只在
   `error` 文本里，与既有的 `AGENT_NAME_CONFLICT` 一致。validate 端点的逐字段 `errors[].code` 不受影响。

## 未覆盖

- 浏览器实际操作：未执行（登录需在页面输入口令）。前端改动仅为时间线卡片显示委派目标，由单测与构建覆盖。
- 进程 logs/signal：本次未改 exec，未重跑。
- 跨 org：浏览器用户共用一个 org（`multi-agent-selection.md` §4.1），跨 org 仅由单测覆盖。
- Worker 重启后委派调用是否沿用同一 `callId`（设计 D5 待验证项）未测。
