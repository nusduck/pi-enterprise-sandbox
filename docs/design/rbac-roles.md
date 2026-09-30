# 平台角色管理（RBAC 一期：admin / reviewer）

日期：2026-09-30。状态：**设计已确认，待实施**。

决策（2026-09-30，用户确认）：

- 角色由 admin 在前端配置，**不放进 SSO 改造**：SSO 方案
  （[sso-integration-reservation.md](sso-integration-reservation.md) §5、§5.2）已约定“角色以平台
  Membership 为准，不用 SSO claim 自动提权”，本设计正是它依赖的那份平台角色权威；SSO 卡在外部 P0 资料，
  本设计不依赖任何外部条件。
- 一期是**固定角色**，不做“自定义角色 + 权限点矩阵”。角色：`admin`、`reviewer`；普通用户是默认身份，
  不是一条授权。
- **一个人可以同时持有 `admin` 与 `reviewer`**。
- `reviewer` 本期只落账本与管理界面，不接任何能力；由后续“智能体结果人工审核”（ADR 0016，待写）消费。

未新增 ADR：不改 plan 冻结的状态机与服务边界；若评审认为 `X-Acting-Role` 线格式变更（§4）需要锁定，
再补 ADR。

---

## 0. 一句话

把角色从“登录时按环境变量用户名名单重算的单值 `auth_credentials.role`”改成“挂在组织成员关系上、
由 admin 授予/撤销的角色集合”，环境变量名单降级为**首个管理员的引导与锁定**。

## 1. 已核实的现状（2026-09-30，静态阅读，main @ 90e8dcee）

| # | 事实 | 位置 |
|---|------|------|
| F1 | 角色权威是 `tbl_agsvc_auth_credentials.role`（单值，默认 `user`）。 | `agent/src/infrastructure/mysql/migrations/20260719000006_auth_credentials.js` |
| F2 | **每次登录与每次 `me`** 都调用 `reconcileRole()`：按 `SANDBOX_AUTH_ADMIN_USERNAMES` 重算为 `admin`/`user` 并写回。任何在库里改的角色都会在下一次请求被覆盖——这是前端配置角色的直接阻碍。 | `agent/src/application/browser-auth-service.ts` `roleFor` / `reconcileRole` / `login` / `authenticated` |
| F3 | `tbl_agsvc_organization_memberships.role` 存在，但只在首次 provisioning 时写入当时的 credential 角色（之后从不更新）；run-parent 路径写 `member`。**没有任何代码读它做授权**，目前是陈旧快照。 | `browser-auth-service.ts` `ensureUserProvisioned`；`application/parent/run-parent-provisioner.ts` |
| F4 | BFF 经 Agent `me` 解析身份，`actingRole = user.role`，在服务端写 `X-Acting-Role`；浏览器带来的 `X-Acting-*` 被剥掉。Sandbox 跳转固定降为 `user`。 | `api-server/src/application/run-access-service.ts` |
| F5 | Agent 从 `X-Acting-Role` 解析出 `AuthSubjects.role`（单字符串）。 | `agent/src/presentation/http/request-response.ts` `authSubjectsFromRequest` |
| F6 | admin 判定散落在 6 处服务端 + 4 处前端，写法都是 `role === 'admin'` 字面比较。 | 服务端：`agent-catalog-service.ts`、`admin-run-query-service.ts`、`org-skill-admin-service.ts`、`skill-share-service.ts`、`presentation/a2a/admin-http-handler.ts`、`api-server/src/routes/a2a.ts`；前端：`AdminShell.tsx`、`SettingsDialog.tsx`、`ConversationSidebar.tsx`、`TurnStream.tsx` |
| F7 | exec 只解析 `x-acting-role` 做透传，不据此授权。 | `exec/src/http/public/ownership.ts`、`files.ts` |
| F8 | 开发模式 `BFF_DEV_ACTING_ROLE` 只接受 `admin`/`user`。 | `api-server/src/config.ts` |

## 2. 数据模型

### 2.1 角色授予表 `tbl_agsvc_member_roles`

挂在 `(org_id, user_id)` 上，即挂在组织成员关系上，与 SSO 方案的 Membership 权威一致。

| 列 | 类型 | 说明 |
|----|------|------|
| `org_id` | CHAR(26) | |
| `user_id` | CHAR(26) | |
| `role` | VARCHAR(32) | `admin` \| `reviewer`；应用层白名单校验，未知值拒绝写入 |
| `granted_by` | CHAR(26) NULL | 授予人 user_id；环境变量引导写 NULL |
| `source` | VARCHAR(16) | `console`（admin 授予）\| `bootstrap`（环境变量引导）\| `migration` |
| `created_at` | DATETIME(3) | |

- 主键 `(org_id, user_id, role)`：授予天然幂等。
- 撤销就是删行。审计见 §2.2。
- 索引 `(org_id, role)`：用于“本组织的 admin 数量”和“审核员列表”。
- 命名按 UPspec（ADR 0013），索引缩写待定（如 `mr`）。

### 2.2 变更审计表 `tbl_agsvc_member_role_events`（只追加）

`event_id, org_id, user_id, role, action(grant|revoke), actor_user_id, source, created_at`。
授予与撤销和它在**同一事务**里写入。只记身份 ID，不记用户名或邮箱明文。

### 2.3 旧列的去留

- `auth_credentials.role`：停止作为权威。本期保留列，写入 `me` 算出的兼容主角色，并标注 deprecated；
  删列放到后续清理 PR。
- `organization_memberships.role`：语义收窄为“成员类型”（`member`），不参与授权。文档里写明，本期不改数据。

### 2.4 迁移

- 对 `auth_credentials.role = 'admin'` 且已 provisioning 的账号，按 `external_*` → `users`/`memberships`
  映射，写入 `(org, user, 'admin', source='migration')`。
- 未 provisioning 的账号（没登录过）不迁移：它们登录时会走 §3 的引导。
- 迁移要幂等（`INSERT IGNORE` 语义）；`down` 只删表。

## 3. 环境变量 `SANDBOX_AUTH_ADMIN_USERNAMES` 的新语义

从“每次请求重算、会降级”改为“**只授予、不降级；名单内的 admin 锁定**”：

1. 登录或 `me` 时，用户名在名单内、且本 org 没有它的 `admin` 授予 → 插入一行（`source=bootstrap`）
   并写审计。已有授予时不再写库，以免现在的 `reconcileRole` 每个请求都写一次库。
2. 管理界面把名单内账号的 admin 显示为“部署锁定”，**不能在界面撤销**（撤销接口返回 409
   `ROLE_PINNED_BY_DEPLOYMENT`）。不这样做的话，界面撤销后下一个请求又会被引导回来，形成假成功。
3. 从名单里移除某人**不会**自动降级：他的授予还留在库里，由 admin 在界面撤销。部署文档要写清这一点。
4. 名单为空时不引导任何人；已有 admin 不受影响。

## 4. 鉴权链路

### 4.1 Agent `me` 的输出

`GET /internal/auth/me`（以及登录响应中的 user）新增 `roles: string[]`，按字典序输出，只含白名单值。
保留 `role` 字段作兼容主角色：含 `admin` 时为 `admin`，否则为 `user`。**前端改读 `roles`**。

### 4.2 `X-Acting-Role` 线格式

值由单值改为**逗号分隔的角色集合**，例如 `admin,reviewer`；没有授予时仍是 `user`。

- 头名称不变，现有各处剥离浏览器 `X-Acting-*` 的逻辑（`sandbox-client.ts` 按名删除等）无需改动，
  也不会漏剥新头。
- **fail-closed 性质**：任何漏改的旧判定 `role === 'admin'` 遇到 `admin,reviewer` 时只会**拒绝**，
  不会误放行。缺陷只会表现为可用性问题，不会变成越权。
- Sandbox 跳转仍固定为 `user`（F4），不变。

### 4.3 统一判定

新增一个共享的 `hasRole(auth, 'admin' | 'reviewer')`，解析逗号集合并做白名单校验，大小写不敏感，
空值或未知值视为无角色。F6 中服务端 6 处全部改用它，并各自补上 `admin,reviewer` 放行、
`reviewer` 拒绝、缺失拒绝三类用例。agent 与 api-server 不共享包，放在各自的 domain/lib 中，
两份实现由同形的测试夹具锁定一致。

前端 4 处改为 `authUser.roles.includes('admin')`。

### 4.4 生效时机

BFF 每个请求都经 `me` 读当前数据库状态（F4），所以授予或撤销在**下一个请求**生效，不必等 JWT 过期。
JWT 里的 `role` 只作展示，不作权威。这一点要在真实链路里验证：撤销 admin 后，同一个会话立即访问
`/api/admin/*` 应得到 403。

## 5. API

Agent（HMAC 内部面，与 `/internal/admin/runs` 同风格）→ BFF 透传：

| 方法 | BFF 路径 | 说明 |
|------|----------|------|
| GET | `/api/admin/users?q=&role=&cursor=&limit=` | **admin**：本 org 成员列表。返回 `user_id, username, display_name, email, roles[], pinned_roles[], last_login_at`。只列本 org；`q` 匹配用户名或显示名 |
| PUT | `/api/admin/users/{userId}/roles/{role}` | **admin**：授予，幂等（已有返回 200，内容相同） |
| DELETE | `/api/admin/users/{userId}/roles/{role}` | **admin**：撤销，幂等（不存在返回 200） |
| GET | `/api/admin/users/{userId}/role-events` | **admin**：该成员的角色变更记录 |

错误语义：

- 非 admin → 403 `ADMIN_REQUIRED`（与现有 admin 面一致）。
- 其他 org 的 userId 与不存在的 userId → 同一个 404。
- 未知 role → 422 `ROLE_UNKNOWN`。
- 撤销 org 的最后一个 admin（含撤销自己）→ 409 `LAST_ADMIN`。
- 撤销部署锁定的 admin → 409 `ROLE_PINNED_BY_DEPLOYMENT`。

**并发**：“最后一个 admin”的判定在事务里对该 org 的 admin 授予行加 `SELECT … FOR UPDATE` 后计数。
两个 admin 同时互相撤销时，后提交的一方必须得到 409，不能出现 0 个 admin。

不做批量接口：前端逐个切换，幂等的 PUT/DELETE 足够，也更好审计。

## 6. 前端

- 管理控制台“配置”分组新增“**成员与角色**”（`/admin/members`）。
  - 表格：成员、最近登录、admin 开关、reviewer 开关。部署锁定的开关置灰，并用 tooltip 说明原因。
  - 支持搜索与按角色筛选。
- 切换开关：先乐观更新；失败时回滚并显示服务端错误（如 `LAST_ADMIN` 的中文提示）。
  列表加载失败要显示错误态，**不能渲染成“无成员”**。
- 撤销自己的 admin 需要二次确认；成功后刷新 `me`，界面随即退出管理控制台。
- 角色变更记录用抽屉展示。

## 7. 本期不做

- 自定义角色、权限点、按智能体或部门授权（部门模型待定，见 SSO 方案）。
- 停用或删除成员、邀请成员。
- `reviewer` 的任何能力（留给审核工作流）。
- 删除 `auth_credentials.role` 列。

## 8. 实施阶段

1. **P1 账本**：迁移（两张表加数据迁移）、仓储、`RoleService`（授予、撤销、最后 admin 锁、审计），
   以及真实 MySQL 上的并发测试。
2. **P2 身份链路**：`me` 输出 `roles`；§3 的引导与锁定（替换 `reconcileRole`）；`X-Acting-Role`
   集合化；`hasRole` 替换 F6 服务端 6 处；`BFF_DEV_ACTING_ROLE` 接受逗号集合。
3. **P3 管理 API**：Agent 路由、BFF 转发、`api.md`。
4. **P4 前端**：成员与角色页，前端 4 处判定改读 `roles`，`webui.md`。
5. **P5 验收**：六套测试、类型检查、前端 build，重建 `agent agent-worker api-server frontend`，跑真实链路（§9）；
   同步 `deployment.md`（环境变量新语义）和 CHANGELOG。

## 9. 验收清单（真实链路）

- 名单内账号首次登录后成为 admin，界面显示为锁定；撤销返回 409。
- admin 在界面授予 B `reviewer` 和 `admin`：B 的下一个请求 `me.roles` 为 `["admin","reviewer"]`，
  能进管理控制台，且各 admin 面（运行、智能体、Skill 共享、A2A）都能正常操作——这是防止
  `admin,reviewer` 被旧判定误拒的正向对照。
- 撤销 B 的 admin：B 在同一会话的下一个请求访问 `/api/admin/*` 得到 403，不需要重新登录。
- 普通用户调用授予接口得到 403；跨 org 的 userId 得到 404。
- 两个 admin 并发互相撤销，最终至少剩一个 admin，另一方得到 409。
- 从环境变量名单移除某人并重启：此人仍是 admin，界面解除锁定，可以撤销。
- 审计表里每次授予和撤销都有对应记录。

## 10. 已确认的细节（2026-09-30）

- 管理员**可以**授予自己 `reviewer`。
- 成员列表只列本 org 中已 provisioning 的账号（至少登录过一次）；未登录账号不能预授角色，
  “邀请成员”不在本期。

## 11. 实施交接

- 分支：从最新 `main` 新开，一个 PR 完成 P1–P5；`reviewer` 的消费方（审核工作流）另开 PR 叠在其上。
- 动手前重新核对 §1 的文件与行为（本文是 2026-09-30 的静态阅读），发现偏差先修正本文。
- 触及 `agent/`、`api-server/` 运行路径，必须按 AGENTS.md §4 重建容器，跑 §9 的真实链路；只跑单测不算完成。
- 同步文档：`api.md`（§5 接口）、`deployment.md`（`SANDBOX_AUTH_ADMIN_USERNAMES` 新语义）、
  `webui.md`（成员与角色页）、`architecture.md`（角色权威改为 member_roles）、CHANGELOG `[Unreleased]`。
  实施完成后把本文“状态”改为已实施，并附上证据链接。
- `tests/test_repository_layout.py` 的行数棘轮：`browser-auth-service.ts` 等热点文件不能加行，
  新逻辑按职责拆到新模块（如 `role-service.ts`、`roles.ts`）。
