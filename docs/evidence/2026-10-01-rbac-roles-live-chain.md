# RBAC 一期（平台角色 admin / reviewer）真机验收证据

日期：2026-10-01。设计：[design/rbac-roles.md](../design/rbac-roles.md)（本次实施后状态改为**已实施**）。

## 1. 验收对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `feat/rbac-roles`，HEAD `ebf377f3`（未提交改动即本次实施内容，`git status --short` 60 项） |
| 运行栈 | 开发 K8s（OrbStack，命名空间 `dsh-dev`，各 1 副本）：`scripts/dev/k8s/up.sh dev` |
| 镜像 | `dsh-enterprise-agent:latest` / `dsh-enterprise-api:latest` / `dsh-enterprise-frontend:latest` **本次重建**（`docker compose build agent agent-worker api-server frontend`）；`exec`（sandbox / sandbox-mcp）未改，沿用既有镜像 |
| 数据库 | MySQL 5.7.44（`sandbox` 库，Compose `mysql` 服务）；迁移 `20261001000001_member_roles.js` 已按发布包路径应用 |
| 运行时 | 容器内 Node **v22.23.2**（`runtime-versions.json` 钉的 22.x）；宿主机 Node v26.5.0（仅用于跑单测，见 §5 的已知偏差） |
| 模型 | **真实模型**（`LLMIO_BASE_URL=https://api.deepseek.com`），不是 fake provider |

改动触及 `agent/`、`api-server/` 运行路径与前端页面，所以按 AGENTS.md §4 重建镜像并跑真实链路；
镜像不挂载源码，重建前后各一次 build（第一次漏掉了迁移改写，见 §5 的教训记录）。

## 2. 迁移与 schema（先于应用启动）

```bash
# 空影子库导出增量发布包（DBA 路径，与 scripts/dev/schema-apply.sh 同一机制）
docker compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
  -v "$PWD/.runtime/rbac-release:/release" \
  -e SCHEMA_SHADOW_DATABASE_URL=mysql://root@mysql:3306/dsh_schema_shadow \
  -e SCHEMA_SHADOW_PASSWORD=… --entrypoint node agent \
  dist/src/infrastructure/mysql/cli-schema.js sql --out /release \
  --from 20260930000002_agent_version_skill_refs.js
# → segments: 1, toMigration: 20261001000001_member_roles.js, statements: 11

docker compose exec -T mysql sh -c '… mysql -uroot sandbox' \
  < .runtime/rbac-release/0033_20261001000001_member_roles.sql
docker compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
  -e SCHEMA_VERIFY_DATABASE_URL=mysql://sandbox@mysql:3306/sandbox \
  -e SCHEMA_VERIFY_PASSWORD=… --entrypoint node agent \
  dist/src/infrastructure/mysql/cli-schema.js verify
# → {"ok": true, "drifts": []}
```

- 发布包**包含**历史 admin 回填（`INSERT IGNORE … SELECT`），在真实库上生效：
  `admin`（user `01M3S16QT1863MRBXRG8CF3QHE`）落成 `admin` 授予，`source = migration`。
- `contract/schema/schema-manifest.json` 已重新生成，`git diff` 只新增
  `tbl_agsvc_member_roles` / `tbl_agsvc_member_role_events` 两张表与迁移条目，无既有表漂移
  （`uv run pytest -q tests/test_schema_upspec_naming.py` 通过）。
- 未 provisioning 的账号不迁移、重跑幂等、不写审计：由集成用例在真表上证明（§3）。

## 3. 自动化测试（六套 + 类型检查）

| 套件 | 命令 | 结果 |
|---|---|---|
| 仓库卫生 | `uv run pytest -q` | **223 passed**（含 schema UPspec 命名、行数棘轮、compose 安全） |
| RPC 契约 | `npm test --prefix contract` | **151 passed / 0 fail** |
| 执行面 | `npm test --prefix exec` | **459 passed / 3 skipped / 0 fail** |
| Agent | `npm test --prefix agent` | **1784 passed / 8 fail**（8 项全部是 `tests/runtime/*` 的既存环境失败，见 §5） |
| BFF | `npm test --prefix api-server` | **231 passed / 0 fail** |
| 前端 | `npm test --prefix frontend` | **486 passed / 0 fail** |
| 前端构建 | `npm run build --prefix frontend` | 成功（`tsc --noEmit` + vite build，518 modules） |
| 类型检查 | `exec` / `contract` / `api-server` / `agent`（含 `src/runtime` strict） | 全部无输出（通过） |

新增/改写的针对性用例（都在上面各套件里跑过）：

- `agent/tests/mysql/member-role-service.integration.test.js`（**真实 MySQL**，`TEST_MYSQL_URL` 门禁）：
  授予/撤销幂等且每次真实变更只写一条审计、`admin,reviewer` 集合放行（正向对照）、
  `reviewer`/缺失角色一律 403、未知角色 422、跨 org 与不存在同一个 404、
  撤销最后一个 admin 409 `LAST_ADMIN`、部署锁定 409 `ROLE_PINNED_BY_DEPLOYMENT`、
  环境变量引导只授予不降级且不重复写库、成员列表带角色与锁定、
  **两个 admin 并发互相撤销 → 恰好一方 409 且最终剩 1 个 admin**、
  数据迁移回填只迁已 provisioning 且重跑幂等。12/12 通过。
- `agent/tests/domain/roles.unit.test.ts` 与 `api-server/tests/roles.test.js`：读**同一份**
  `tests/fixtures/contracts/platform-roles-v1.json`，锁定 agent 与 BFF 两份解析口径一致（37 + 38 项）。
- 6 处服务端 admin 判定各补「`admin,reviewer` 放行 / 纯 `reviewer` 拒绝 / 缺失拒绝」：
  `org-skill-admin`、`skill-share-service`、`admin-run-query-service`、`agent-catalog-service`、
  agent 的 A2A admin handler、BFF 的 `/api/a2a/*`（后者走生产身份路径：`me.roles` → `X-Acting-Role`
  集合 → 本地闸门，并断言下游收到的头就是 `admin,reviewer`）。
- 路由层：`agent/tests/http/member-role-http.unit.test.js`（身份头缺失 400、方法分发、
  错误码透传、未装配 503）、`api-server/tests/admin-members-proxy.test.js`（只转发白名单查询键、
  角色集合原样转发、403/404/409 透传）。

## 4. §9 验收清单（真实链路，非替身）

脚本对运行中的 BFF（`http://127.0.0.1:4000`）发真实请求；账号密码走真实注册/登录，
Cookie 会话由 BFF 签发。`admin,reviewer` 等结论取自响应体与数据库，不是推断。

| §9 条目 | 结果 | 证据 |
|---|---|---|
| 名单内账号首次登录后成为 admin，界面显示为锁定；撤销返回 409 | **PASS** | 注册后首个 `me` 即 `roles:["admin"]`；成员列表 `pinned_roles:["admin"]`；`DELETE …/roles/admin` → 409 `ROLE_PINNED_BY_DEPLOYMENT` |
| admin 授予 B `reviewer` + `admin`：B 下一个请求 `me.roles = ["admin","reviewer"]`，能进管理控制台，各 admin 面都能操作 | **PASS** | 同一 Cookie 会话（未重新登录）`me.roles` 变为 `["admin","reviewer"]`、兼容 `role=admin`；B 访问 `/api/admin/runs`、`/api/admin/skills/share-requests`、`/api/agents`、`/api/a2a/config`、`/api/admin/skill-usage` 全部 200，并**实际执行**了一次授予（给第三人 `reviewer` → 200）——这是防止 `admin,reviewer` 被旧判定误拒的正向对照 |
| 撤销 B 的 admin：B 在同一会话的下一个请求访问 `/api/admin/*` 得到 403，不需要重新登录 | **PASS** | 撤销后同一 Cookie 下一个 `/api/admin/users` → 403 `ADMIN_REQUIRED`；`me.roles` 只剩 `["reviewer"]` |
| 普通用户调用授予接口得到 403；跨 org 的 userId 得到 404 | **PASS** | 无角色账号 → 403 `ADMIN_REQUIRED`；只有 `reviewer` 的账号 → 403；**只属于另一个 org** 的成员 userId → 404 `NOT_FOUND`（其变更记录同样 404），不存在的 ULID → 同一个 404 |
| 两个 admin 并发互相撤销，最终至少剩一个 admin，另一方得到 409 | **PASS** | 收敛到恰好两个 admin 后 `Promise.all` 并发互相撤销 → `[200, 409]`，409 的 `code=LAST_ADMIN`；数据库复验 admin 授予行数 = 1 |
| 从环境变量名单移除某人并重启：此人仍是 admin，界面解除锁定，可以撤销 | **PASS** | 清空 `SANDBOX_AUTH_ADMIN_USERNAMES` 并滚动重启 agent 后：`me.roles` 仍 `["admin"]`（不降级）、`pinned_roles:[]`；`DELETE …/roles/admin` 由 409 变为 200 |
| 审计表里每次授予和撤销都有对应记录 | **PASS** | `tbl_agsvc_member_role_events` 17 行：`bootstrap grant 1` / `console grant 9` / `console revoke 7`，每行带 `role`、`action`、`source`、`actor_user_id`（join 出操作者用户名）与 `created_at` |

## 5. AGENTS.md §4 最少链路 + 已知偏差

同一栈上另外跑了一遍运行链路（真实模型）：登录（`me` 带 `roles`）→ 建会话 → 一轮**带工具的
Run**（模型真的调了 `bash`，工具台账含 `bash` 且输出里有 `echo` 的结果）→ 在同一会话起第二个
长进程 → `GET /api/processes?session_id=` 列出进程 → `GET /api/processes/{id}/logs` 读到输出 →
`POST /api/processes/{id}/signal` 发 `SIGTERM` 成功 → 用另一个账号读该 Run / 会话 / 工具台账
**全部 404**（跨租户）。13 项断言中 12 项通过；唯一未通过的是脚本自己把终态写成了 `COMPLETED`，
而该栈实际返回 `SUCCEEDED`——Run 本身成功，属于断言字面错误，不是链路缺陷。

**已知偏差（不影响本变更结论）**：

- `agent/tests/runtime/agent-version-wire-request.test.ts` 与 `prompt-assembly.test.ts` 共 8 个用例
  失败，原因是它们 `npx tsx` 起真实 cordis 插件树，而 HMR 插件要求 `--expose-internals`；
  宿主机是 Node v26.5.0（仓库钉 22.x）。**已在干净工作树（`git stash`）上复现同样的失败**，
  与本变更无关。容器内运行时是 v22.23.2。
  **复核（2026-10-01）**：在含本次改动的工作树上用 `node:22`（v22.23.3）容器跑
  `npm test --prefix agent`，**1799 passed / 0 fail**，上述 8 项全部通过，
  确认它们只是宿主机 Node v26 的环境偏差。
- 验收脚本放在 `.runtime/`（gitignored），不是仓库资产；它们对运行栈发真实请求，可重跑。
- 模型是真实模型，所以「模型是否调用工具」由工具台账证明，而不是由 fake provider 断言。

## 6. 这次踩到的两个坑（供后续迁移参考）

1. **镜像不挂载源码**：第一次重建后改写迁移文件，导出发布包用的仍是镜像里的旧 `dist/`——
   症状是发布包里少了回填语句（`statements: 10` 而非 11）。必须**改完再 build**。
2. **发布包抓不到读语句**：`schema-export.ts` 只保留 `create/alter/insert/update/delete…`，
   在**空影子库**上重放时，任何「先 SELECT 再逐行 INSERT」的数据迁移都抓不到——走发布包升级的
   部署会静默跳过回填。所以数据迁移必须写成 `INSERT IGNORE … SELECT`（空库零行、真库完整回填）。
   这一点已写进迁移头注释。

## 7. 未覆盖 / 留给后续

- 浏览器层面的实操（点击开关、二次确认、抽屉、乐观回滚的视觉表现）由前端单测与页面源码覆盖，
  本次真机验收走的是 HTTP 接口与数据库；未做 Playwright 级别的 UI 走查。
- `reviewer` 的任何能力（审核工作流）按设计留给后续 PR（ADR 0016 待写）。
- `auth_credentials.role` 列删除、`organization_memberships.role` 历史行清理按设计留给后续清理 PR。

## 8. 补充：路径段非法百分号编码（审阅后修复，2026-10-01）

审阅发现 agent 与 BFF 两侧路由对路径段直接 `decodeURIComponent`，非法编码（如 `%E0`）抛
`URIError`，落到兜底错误映射成为 **500**。修复为解码失败即 404 `NOT_FOUND`，且不调用服务、不转发。

- 回归用例：`agent/tests/http/member-role-http.unit.test.js`（真实 HTTP 服务器）、
  `api-server/tests/admin-members-route.test.js`（走生产身份路径），修复前均复现 500，修复后通过。
- 修复后重跑：`npm test --prefix api-server` 233 passed；`node:22` 容器内 `npm test --prefix agent`
  1800 passed / 0 fail；agent / api-server 类型检查通过；`uv run pytest -q` 223 passed。
- 真机：`docker compose build agent api-server` 后对 `dsh-dev` 的 `agent`、`agent-worker`、`api-server`
  执行 `kubectl rollout restart`，确认新 Pod 的镜像 ID 与新构建一致。用新注册的普通账号请求运行中的 BFF：

  | 请求 | 结果 |
  |---|---|
  | `PUT /api/admin/users/%E0/roles/admin` | 404 `NOT_FOUND` |
  | `DELETE /api/admin/users/{ULID}/roles/%E0` | 404 `NOT_FOUND` |
  | `GET /api/admin/users/%/role-events` | 404 `NOT_FOUND` |
  | `GET /api/admin/users`（对照） | 403 `ADMIN_REQUIRED` |
  | `PUT /api/admin/users/{ULID}/roles/admin`（对照） | 403 `ADMIN_REQUIRED` |

  agent 侧的修复经 BFF 触达不到（BFF 转发时会重新编码路径段），由上面的真实 HTTP 服务器用例覆盖。
  临时账号 `uri404-*` 留在开发库中，未清理。
