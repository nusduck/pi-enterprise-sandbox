# ADR 0015（Skill 目录与 Agent 绑定）P0–P4 真实链路验收 — 2026-09-30

代码版本：工作树（`main` @ `c559d64b` + ADR 0015 未提交改动），runtime 版本见 `runtime-versions.json`。
验收对象是**重建后的容器**，不是单测替身：

```bash
docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend
docker compose up -d
docker compose ps        # 全部 healthy
```

数据库：开发栈 MySQL，按 `docs/runbooks/development-reset.md` 的口径只应用了两条**新增**迁移
（`20260930000001_org_skills.js`、`20260930000002_agent_version_skill_refs.js`，都只建表）：

```bash
docker compose run --rm --no-deps \
  -e AGENT_DATABASE_URL='mysql://sandbox:…@mysql:3306/sandbox' \
  --entrypoint npx agent tsx src/infrastructure/mysql/cli-migrate.ts latest
```

驱动方式：全部经浏览器用的 BFF 面（`/api/*`）+ 真实模型 Run，脚本 `/tmp/e2e.mjs`（登录、建 Agent、
起 Run、读 `/api/admin/runs/{id}/events` 的工具台账）。**没有使用内部 HMAC 面**。

## 结论一览

| 阶段 | 验收项 | 结果 |
|---|---|---|
| P0 | v1 记录带未知顶层键 → 绑定 fail-closed | ✅ Run `FAILED`，`status_reason` 说明「a newer writer produced this record」 |
| P0 | legacy 记录（无 `schemaVersion`）带同样的键 → 照常 | ✅ Run `SUCCEEDED` |
| P0 | 全局 `skill-filesystem` provider 关闭 | ✅ `boot.test.ts`（子进程真插件树）断言全局层无 skill provider |
| P1 | 两个 Agent 白名单 `pdf` / `xlsx` → 发现与挂载都不同 | ✅ 见下 |
| P1 | `user: deny` 时用户已启用包不可见 | ✅ 见下 |
| P1 | legacy 版本行为不变（全部系统 + 用户） | ✅ `ls /home/sandbox/skill \| wc -l` = 13，`skill-user` 有 `mine` |
| P2 | 管理员上传 → 绑定 → 从未安装过的用户 B 可用 | ✅ `ls /home/sandbox/skill-org` = `b-skill`；userb 的 Run 读到内容 |
| P2 | revoke → 新 Run 排除并写诊断 | ✅ `affectedAgentVersionIds` 非空；挂载消失且日志有 `revoked` 诊断 |
| P2 | org 版本回收的三条保留规则 | ✅ 见下（引用的保留、超期无引用且非 current 的回收、current 保留） |
| P3 | 用户申请 → 管理员审阅清单 → 批准 → 他人可用 | ✅ 见下 |
| P4 | exec `systemSkills` 必需、逐包挂载 | ✅ `system: none` 时 `/home/sandbox/skill` 不存在；白名单时只挂点名的包 |
| P4 | skill-usage 分层 | ✅ `system pdf 1` / `org org-probe 2` / `user mine 1` |
| P4 | 能力页展示 org 层 | ✅ userb 的 `/api/capabilities/skills` 出现 `org-skill-root \| org-probe` |
| 通用 | 登录 → 建会话 → 带工具的 Run → 进程 logs/signal | ✅ `sleep 90` 后台作业：列表 → logs → `SIGTERM` → `killed` |
| 通用 | 跨用户/跨租户 404 | ✅ 见下 |

## P1：发现与挂载同构（`ls` 的原文）

PDF 助手（`system.allowlist = [pdf]`, `user: allow`）：

```text
$ ls -1 /home/sandbox/skill
pdf
$ head -3 /home/sandbox/skill/pdf/SKILL.md
---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. …
$ ls -1 /home/sandbox/skill/xlsx
ls: cannot access '/home/sandbox/skill/xlsx': No such file or directory
```

XLSX 助手（`system.allowlist = [xlsx]`, `user: deny`），同一个模型提示：

```text
$ ls -1 /home/sandbox/skill; ls -1 /home/sandbox/skill-user; cat /home/sandbox/skill-user/mine/SKILL.md
xlsx
=== user ===
ls: cannot access '/home/sandbox/skill-user': No such file or directory
=== read ===
cat: /home/sandbox/skill-user/mine/SKILL.md: No such file or directory
```

未绑定 `skillPolicy` 的 Agent（= legacy 行为）：`ls -1 /home/sandbox/skill | wc -l` → `13`，
`ls -1 /home/sandbox/skill-user` → `mine`。**省略 = 当前行为**这条 ADR 承诺成立。

## P2：org 层（管理员上传）

```text
POST /api/admin/skills/org?filename=org-probe.zip&set_current=true   → 201
GET  /api/admin/skills/org                                            → org-probe / currentDigest / active
```

账本落库（`tbl_agsvc_org_skills`）：`org_id = 01M3RJZH4PQMR0K0Y38QHQFXCB`（内部 ULID，带外键的那一列）。

以 **userb**（从未安装过任何东西）建会话并绑定到该 Agent：

```text
$ ls -1 /home/sandbox/skill          # system: none
ls: cannot access '/home/sandbox/skill': No such file or directory
$ ls -1 /home/sandbox/skill-org
org-probe
$ read /home/sandbox/skill-org/org-probe/SKILL.md   → 成功（provider = run-org-published）
```

吊销后：`POST …/versions/<digest>/revoke` 返回 `affectedAgentVersionIds: ["01M3RMBZH5PRXGHYS459P2823Y"]`
（来自 `tbl_agsvc_agent_version_skill_refs`）；下一个 Run 里 `/home/sandbox/skill-org` 不存在，
worker 日志出现：

```text
[skills] excluded org skill "org-probe" (revoked): org skill "org-probe" version 0801fcb0… is revoked
```

## P3：共享申请与审批

```text
POST /api/capabilities/skills/b-skill/share-requests   (userb)      → 201 pending
GET  /api/admin/skills/share-requests?status=pending   (admin)      → 队列可见
GET  /api/admin/skills/share-requests/{id}/manifest    (admin)      → files + 截断 SKILL.md
POST /api/admin/skills/share-requests/{id}/approve {setCurrent:true} → 200 approved
GET  /api/admin/skills/org                                          → b-skill active originKind=share_request
```

批准后的摘要与作者申请时钉住的一致；随后由 **admin**（另一个身份）绑定该版本运行：

```text
$ ls -1 /home/sandbox/skill; ls -1 /home/sandbox/skill-org; cat /home/sandbox/skill-org/b-skill/SKILL.md
pdf
== org ==
b-skill
== body ==
---
name: b-skill
description: e2e user B skill for the share flow
---

B SKILL BODY.
```

## P4：skill-usage 分层（真实 MySQL）

```text
GET /api/admin/skill-usage?days=7
{ "usage": [
  { "name": "org-probe", "scope": "org",    "calls": 2 },
  { "name": "mine",      "scope": "user",   "calls": 1 },
  { "name": "pdf",       "scope": "system", "calls": 1 } ] }
```

层归属来自那次 Run 的 AgentVersion 引用账本：`pdf` 被 PDF 助手钉在系统层、`org-probe` 被
组织共享助手钉在 org 层、`mine` 不在账本里 → 用户层。

### 真实 MySQL 集成测试（⚠️ 必须用**独立**库）

```text
tests/mysql/mysql.integration.test.js            # tests 10, pass 10, fail 0
tests/mysql/schema-manifest.integration.test.js  # tests 5,  pass 5,  fail 0
```

两条运行方式的注意事项，都是这次踩到的：

1. **不要指向开发栈的库。** `mysql.integration.test.js` 会 `migrateRollbackAll` + `migrateLatest`
   + `TRUNCATE` 一长串表（含 `organizations` / `users` / `runs`）。本次验收先误把它们指向了
   开发库 `sandbox`，**该库被清空并重建**。验收开始时该库是空的（0 用户 / 0 会话 / 0 Run，
   只有本次验收自己造的夹具），所以没有丢失既有工作，但正确做法是先建一个 scratch 库
   （`dsh_gate_dev` 之类）再跑。之后复核：`information_schema` 47 张表齐全、栈全部 healthy、
   2 个本次注册的账号可登录。
2. **逐文件跑。** 一次并行加载多个 `*.integration.test.js` 会在 knex 迁移表上互锁
   （`Migration table is already locked`），16 条被取消；逐文件执行全绿。
3. 开发机的宿主 3306 被本机 mysqld 占用，容器发布端口不生效：宿主侧 `TEST_MYSQL_URL=127.0.0.1:3306`
   连的是**另一个** MySQL。集成测试要在 compose 网络内跑（`docker compose run … mysql:3306`）。

### org 层版本回收（design §5.4）

用一份 `SKILL_VERSION_GC_GRACE_MS=0` 的临时 override（`COMPOSE_FILE=docker-compose.yml:/tmp/gc-override.yml`，
不改仓库文件），依次发布同名版本，验证三条保留规则：

| 版本 | 状态 | 结果 |
|---|---|---|
| v1 `0801fcb0…` | 被一个 AgentVersion 引用（`agent_version_skill_refs`）、**非** current | **字节保留** |
| v2 `cf3e1fd6…` | 无引用、非 current、超过宽限期(0) | **字节被回收**（账本行保留供审计） |
| v4 `5f90baac…` | current | 保留 |

即「被任何 AgentVersion 引用的 org 版本不回收」与「current 不回收」两条都成立；
把 v2 的同一份归档重新以 `set_current=true` 发布后，字节被重新落盘、指针指过去——
没有出现「账本指向不存在字节」。验收后恢复了默认 `SKILL_VERSION_GC_GRACE_MS`（24 小时）。

## 通用：进程与跨租户

```text
GET  /api/processes?session_id=…        → bash-… / sleep 90 / running / pid 144
GET  /api/processes/{id}/logs           → stdout "" next_offset 0 completed false
POST /api/processes/{id}/signal SIGTERM → status killed, detail "killed: SIGTERM"
```

跨用户一律 404（owner-scoped 面）与跨角色 403（管理面）：

```text
userb → GET /api/runs/{admin 的 run}           404 NOT_FOUND
userb → GET /api/runs/{admin 的 run}/events    404 NOT_FOUND
userb → GET /api/processes?session_id={admin}  404 NOT_FOUND
userb → GET /api/admin/skills/org              403 ADMIN_REQUIRED
userb → GET /api/admin/skills/share-requests   403 ADMIN_REQUIRED
```

## 真实链路抓到的两个缺陷（已在同一变更集修掉）

1. **org 层账本写外部主体**：三个新账本的 `org_id` 是 `CHAR(26)` + 外键到 `organizations.org_id`，
   而管理员上传把 `X-Acting-Organization-Id`（`org_bootstrap`）直接写进去 →
   `Cannot add or update a child row: a foreign key constraint fails`。更隐蔽的一面是**读**：
   Run 期按内部 ULID 查，会静默命中零行。修法：两个服务要求注入 `resolveOwner`（外部 → 内部 ULID），
   先鉴权再解析；`http-main.ts` 一处完成解析；新增 3 条回归用例。
2. **exec 没给 org 包标 `kind`**：`enabledSkillPackagesFromManifest()` 漏了 `kind: 'org'`，
   org 包混进用户层挂到 `/home/sandbox/skill-user/<name>`，而 Agent 侧发现报的是
   `/home/sandbox/skill-org/<name>`——挂载与发现不同构且**不报错**。修法：按 `ref.scope` 显式标 `kind`，
   并把 exec 的断言从「只有 sourcePath」改成「带 kind」，让漏标直接红。

## 未覆盖 / 已知限制

- **浏览器操作**：前端改动经 `npm run build` + 重建 `frontend` 镜像验证（路由 `/admin/skills`
  返回 200，产物里含「Skill 共享」「申请共享」「组织共享层」「分层：」等文案），
  **没有做真实的鼠标操作**（本次会话没有浏览器自动化）。加载失败/字段错误/并发冲突这几条
  由 `frontend/test/skill-sharing.test.ts`、`capabilities-page.test.ts` 与 BFF 的
  `admin-skills-proxy.test.js` 覆盖，但要按 AGENTS.md §4 补一次人工点击。
- **跨 org 404**：本地只有一个 bootstrap org，跨 org 的 404 由 agent 侧单测覆盖
  （`org-skill-admin.unit.test.js` / `skill-share-service.unit.test.js` 的 `OTHER_ORG` 用例），
  本次真实链路只验证了跨用户 404 与非 admin 403。
- **系统层 release 内删除某包**：未在本轮真机验证（需要改 release 目录）。
- P4 的「收紧前提是运行日志里缺省清单计数为 0」在开发栈无法度量（没有旧版 Agent 在生产跑）；
  按 design §8 的部署顺序执行（exec → Worker → API/Frontend），旧 Worker 会被新 exec 显式拒绝。
