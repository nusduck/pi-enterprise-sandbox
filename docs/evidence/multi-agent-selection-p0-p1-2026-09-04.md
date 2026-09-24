# 多 Agent 选择 P0/P1 真实链路验证（2026-09-04）

**Location:** `docs/evidence/`（带日期的验收证据，不是进度看板）。
**设计文档:** [`../design/multi-agent-selection.md`](../design/multi-agent-selection.md)。
**验收状态:** 见 [`../STATUS.md`](../STATUS.md)（本次没有 §32 行状态改变）。

本记录只覆盖当天在运行中的开发栈上跑通的链路，不代表设计文档的 P2（SSO 租户
收口与版本可观测）已完成。

## 环境

- 宿主日期/时区：2026-09-04，Asia/Shanghai。
- Docker Engine `29.4.0`。
- 分支 `refactor/dsh-rebuild`，基线提交 `e5c400c6`。
- 按 AGENTS.md §4 重建后启动：
  `docker compose build agent api-server sandbox sandbox-mcp && docker compose up -d`。
  九个服务全部 running，带健康检查的全部 healthy。
- `AUTH_ENABLED=true`。为了拿到一个干净的 admin 账号，本次验证期间临时把
  `SANDBOX_AUTH_ADMIN_USERNAMES` 追加了一个一次性用户名（只作为进程环境传入
  `docker compose up -d agent api-server`，**没有写进 `.env` 或任何提交的文件**），
  验证结束后重新以原环境启动，恢复为 `admin` 一个名字。
- 凭据只存在于验证脚本的进程内，未写入本文件或任何输出。

## 覆盖到的链路（AGENTS.md §4 的最小集）

登录 → 建 Agent（admin）→ 建会话并**指定该 Agent** → 一轮带工具的 run →
进程 logs/signal → 跨租户 404。

| # | 断言 | 结果 |
|---|------|------|
| 1 | 登录后 `role=admin` | PASS |
| 2 | `POST /api/agents` 建出 definition + v1，且 `active_version_id` 指向 v1 | PASS |
| 3 | org 的可选 Agent 数 +1（并列，不是新版本） | PASS |
| 4 | 建会话带 `agent_id` → `conversations.agent_id` 为该 Agent | PASS |
| 5 | 不带 `agent_id` 建会话 → 仍是租户默认 Agent | PASS |
| 6 | 该会话下的一轮 run 到达终态 `SUCCEEDED`，且执行了 1 个工具 | PASS |
| 7 | `runs.agent_version_id` = 所选 Agent 的 v1 | PASS |
| 8 | 后台进程 `GET /api/processes/{id}/logs` 200 | PASS |
| 9 | `POST /api/processes/{id}/signal` 200 | PASS |
| 10 | 换一个 `session_id` 读同一个进程 → 404 | PASS |
| 11 | 未知 / 非本 org 的 `agent_id` 建会话 → 404，响应体不回显该 id | PASS |
| 12 | 同上：`GET /api/agents/{id}/versions`、`POST .../active-version` → 404 | PASS |
| 13 | 改配置产生 v2 并激活 | PASS |
| 14 | **版本不漂移**：已有会话的下一轮 run 仍是 v1 | PASS |
| 15 | **新**会话的 run 是 v2 | PASS |
| 16 | 非法 config（`toolPolicy` 为数组）建版本时 400 | PASS |
| 17 | 非 admin 成员可读目录（200） | PASS |
| 18 | 非 admin 成员写目录 → 403 `ADMIN_REQUIRED` | PASS |

第 7/14/15 条直接查 `runs.agent_version_id` 账本，而不是读 API 响应：Run 详情
目前**还没有**把绑定的 Agent 名与 `version_no` 投影出来，那是设计文档 P2 的第 2 项，
本轮未做。

## 六套单测 + 类型检查

同日在宿主机上全绿：

```
uv run pytest -q                                  98 passed
npm test --prefix exec                            326 pass / 0 fail
npm test --prefix contract                        29 pass / 0 fail
npm test --prefix agent                           1224 pass / 0 fail
npm test --prefix api-server                      154 pass / 0 fail
npm test --prefix frontend                        350 pass / 0 fail
npx tsc --noEmit -p exec/tsconfig.json            clean
npx tsc --noEmit -p contract/tsconfig.json        clean
npx tsc --noEmit -p frontend/tsconfig.json        clean
npm --prefix api-server run typecheck             clean
npm --prefix agent run typecheck                  clean（主程序 + src/runtime strict）
```

## 未覆盖

- **真正的跨 org 隔离**：所有浏览器用户目前共用 `BOOTSTRAP_ORG_ID`
  （`browser-auth-service.ts`），浏览器面上造不出第二个租户。第 11/12 条用的是
  本 org 不存在的 `agent_id`——它与"属于别的 org"走同一个分支、返回同一个响应。
  跨 org 的分支判定由 `agent/tests/run-services/agent-catalog-service.unit.test.js`
  的「跨租户的 agentId 一律 404」用两个真实 org 覆盖。P2 接上 SSO 后应在真实栈上补。
- 设计文档 P2 的三项（SSO org claim、Run 详情展示 Agent 名与版本号、
  `BFF_DEV_ACTING_ORGANIZATION_ID` 复核）本轮未做。
