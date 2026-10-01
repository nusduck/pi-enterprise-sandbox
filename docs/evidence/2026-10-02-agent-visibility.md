# 智能体可见范围验证记录

日期：2026-10-02（Asia/Singapore）。设计：[agent-visibility.md](../design/agent-visibility.md)。
基线：`codex/sso-oidc` 本地提交 `de286cb2`（未推送）；验收对象为分支 `codex/agent-visibility` 的未提交工作区。
未推送、未查询远端 CI。

## Runtime

权威 `runtime-versions.json`：Node 22、Python 3.11。Agent 全套在 Agent 生产镜像内 Linux Node 22.23.2
（仓库根夹具含全部 `docker-compose*.yml` 只读挂载，`env -i`）；BFF 全套在 `node:22`（22.23.3）容器内
`npm ci` 后运行；其余在宿主 Node 22.19.0（P1 校验过的官方归档）。

## 检查结果

| 命令/对象 | 结果 |
|-----------|------|
| `uv run --python 3.11 pytest -q` | 223 passed |
| `npm test --prefix agent`（Linux 22.23.2） | 1947/1947 |
| `npm test --prefix api-server`（node:22 22.23.3） | 304/304 |
| `npm test --prefix exec` | 475 pass，3 skipped（真库/宿主 bwrap 条件门禁未启用） |
| `npm test --prefix contract` | 159/159 |
| `npm test --prefix frontend` | 614/614 |
| tsc exec / contract，agent / api-server typecheck，frontend build，`docker compose config -q`，`git diff --check` | 全部通过 |

新增测试：`agent/tests/run-services/agent-visibility.unit.test.js`（7 项，经真实 Catalog / Conversation /
CreateRun 服务）、`agent/tests/cron/cron-agent-visibility.unit.test.js`（4 项）、`frontend/test/agent-access.test.ts`（5 项）。
突变检查：去掉 `RunParentProvisioner` 里的可用性判定后，「显式选择」与「撤销后已绑定会话」两项失败；恢复后通过。

## Schema

空影子库全量重放：39 migrations / 57 tables / 4 triggers；manifest diff 只新增 `agent_definitions.visibility`
与 `tbl_agsvc_agent_user_grants`；UPspec 测试通过。增量包 `0039_20261002000003_agent_visibility.sql`
（加列 + 建表 + 2 索引 + 3 外键 + 记账）应用到开发库后 `cli-schema verify` 0 drift，未清空数据。

## 容器

重建 agent、api-server、frontend、sandbox、sandbox-mcp；重建前比对运行容器与 compose（含 SSO shell 覆盖）
配置一致，没有会丢失的覆盖。运行镜像均为最新构建：agent/agent-worker `d56d5ed55492`（uid 1000）、
api-server `b6bdd9e83697`（1000）、sandbox `aecbd315776b`（10001）、sandbox-mcp `d91e594a9783`（1000）、
frontend `c5a2404b1440`（1000）。

## 真实链路（`.runtime/agent-visibility/live-visibility.mjs`，27/27）

frontend nginx → BFF → Agent → MySQL；三个身份都经替身 IdP 真实 SSO 登录。管理员是其中一名员工，
用一条 SQL 写入 `member_roles` 授予 admin（验收者没有本地 admin 密码）；其余全部经公开 API。

- 新智能体默认全员可用；管理员按工号搜到员工（`/api/admin/users?q=`）并设为指定员工；授予落库。
- 被授权员工列表可见；未授权员工列表不可见、建绑定会话 404、直接发起 Run 404、建定时任务 400（与不存在同文案）。
- 被授权员工在受限智能体上的 bash 工具 Run `SUCCEEDED`，工具账本含标准输出；同 org 管理员读该 Run 仍 404（owner 隔离不变）。
- 撤销后：已绑定会话的下一轮 404、列表不可见。
- 普通员工读/改可见范围 403；默认智能体设受限 400；授权给不存在的成员 400 且不落库。
- 改回全员：名单清空，原会话恢复可用，其他员工也能看到。

首次运行脚本把成员搜索路径写成了 `/api/admin/members`（应为 `/api/admin/users`，产品代码用的是后者），
修正脚本后完整重跑。

## 浏览器（`.runtime/agent-visibility/browser-visibility.mjs`，8/8）

Playwright 1.55 真实 Chromium 操作部署版前端（无 API mock，身份经替身 IdP SSO 登录）：「可见范围」标签显示
全员可用 → 切到指定员工、按工号搜索添加 → 保存成功提示、左侧列表出现「指定」标记；默认智能体的「指定员工」
不可选；被授权员工的 Composer 智能体选择器里有它，未授权员工没有；最后改回全员可用。

## 未覆盖

- 协作委派（A 委派给受限的 B）不检查调用者对 B 的授权；A2A 外部调用不受员工授权影响（设计 §4 已说明）。
- 按部门授权、预先授权未登录员工、编辑权下放：本期不做。
- 并发编辑为后写覆盖，未做乐观锁。
