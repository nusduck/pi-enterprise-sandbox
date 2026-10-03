# Skill 目录与 Agent 绑定（设计稿）

> 状态：**已实施**（P0–P4，2026-09-30）。决策记录见 [ADR 0015](../adr/0015-skill-catalog-and-agent-binding.md)（Accepted），
> 真机验收记录见 [`evidence/adr-0015-skill-binding-real-chain-2026-09-30.md`](../evidence/adr-0015-skill-binding-real-chain-2026-09-30.md)。
> 本文描述「应当怎样实现」；「现在实现了什么」以代码与 §10 的验证记录为准。

本设计解决两个使用中暴露的问题：

1. 不同 AgentVersion 看到的系统 Skill 完全相同，Agent 没有区分度；系统 Skill 更新要走 release + 重启。
2. 用户开发好的 Skill 无法由管理员纳入 Agent 自带能力，只能每个用户各装一遍。

---

## 0. 一句话

把 Skill 拆成**目录**（system / org / user 三层，谁背书）与**绑定**（AgentVersion 的 `skillPolicy`，
哪个 Agent 带什么）。每个 Run 由绑定与调用者身份算出一份**有效清单**，Agent 侧的 prompt 目录与
exec 的只读挂载都只认这份清单。新增的 org 层复用 S1 的按摘要分版本发布存储，由「作者申请 +
管理员批准」或管理员直接上传进入；AgentVersion 钉摘要，升级 = 新版本激活，下一个 Run 即生效。

---

## 1. 已核实的事实（请复现）

```bash
# Run 的 Skill 只由身份决定：系统根 + 该 owner 账本核对过的已发布版本；没有 AgentVersion 参与
sed -n 114,147p agent/src/bootstrap/container-env.ts
sed -n 674,682p agent/src/application/dsh-run-executor.ts

# 系统根整目录扫描（per-Run 新建 provider，watch:false）；用户层按版本清单
sed -n 416,450p agent/src/infrastructure/dsh/runtime-factory.ts

# AgentVersion 的 skills：绑定层解析了但运行路径无读取方；v1 契约写入即 CONFIG_UNKNOWN_FIELD
sed -n 500,502p agent/src/infrastructure/dsh/agent-version-bindings.ts
sed -n 59,67p agent/src/application/agent-config-validator.ts   # TOP_LEVEL_V1_KEYS 无 skills
grep -n "| \`skills\`" docs/api.md

# legacy skills 唯一消费方：A2A Agent Card 展示
sed -n 476,486p agent/src/bootstrap/http-main.ts

# exec：系统层整树 ro_bind；用户层按清单逐包 ro_bind 到 /home/sandbox/skill-user/<name>
sed -n 176,200p exec/src/isolation/build.ts
sed -n 94,125p exec/src/http/app.ts          # enabledSkillPackagesFromManifest：只核对清单，不扫目录

# Worker 绑定阶段不检查未知顶层键（legacy 记录本就带 skills/extensions 等键）
sed -n 476,511p agent/src/infrastructure/dsh/agent-version-bindings.ts

# 清单契约：{name, contentDigest}，≤256 条，进 HMAC 覆盖的请求体 / 规范化 query
sed -n 1,75p contract/src/skill-manifest.ts

# 启用账本只有 (org, user) 作用域
grep -n "unique\|org_id\|user_id" agent/src/infrastructure/mysql/migrations/20260831000001_user_skill_enablement.js

# 管理员判定：部署级用户名集合 → role=admin，作用域是其当前 org
grep -n "roleFor\|adminUsernames.has" agent/src/application/browser-auth-service.ts

# 出厂插件树里还有一个全局 skill-filesystem provider（默认根：DSH home、~/.agents、cwd 项目根、DSH_BUNDLED_SKILL_DIR）
grep -n -A2 "id: skill-filesystem" agent/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml
sed -n 76,86p agent/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js

# 系统 Skill 中有依赖 exec 镜像工具链的
sed -n 150,165p exec/Dockerfile
```

推论：

- 「按 Agent 区分」必须同时改 Agent 侧发现与 exec 挂载，只改一侧就是配置不代表行为。
- exec 已经有「只挂清单点名的包」的机制和 HMAC 覆盖的清单载体，扩展它比新开通道便宜。
- 开发 compose 下系统根是宿主机 bind mount 且每个 Run 重新扫描，改文件后下一个 Run 就能看到；
  目标部署的 `system/<release-id>/` 按设计不可变。「系统 Skill 不能热更新」在目标环境成立。
- **待验证**：全局 `skill-filesystem` provider 在 Agent 容器里扫到的默认根是否为空。若不为空，
  它是绕过绑定的发现面（§6.5）。

---

## 2. 目标与非目标

**目标**

- G1 AgentVersion 能选择系统 Skill（全部 / 白名单 / 无），能决定是否带用户自己的 Skill。
- G2 组织内共享：一份 Skill 字节发布一次，由多个 AgentVersion 绑定，所有使用该 Agent 的用户可用。
- G3 共享 Skill 更新不需要重启：发布新版本 → 生成新 AgentVersion → 下一个 Run 生效。
- G4 发现与挂载同构：模型能看到的、能 `ls`/`read`/执行的，恰好是本 Run 的有效清单。
- G5 保持既有纪律：跨租户 404、fail-closed、草稿不进发现、启用即复制字节、清单受 HMAC 覆盖。

**非目标**

- 跨 org 的全局共享（走系统层 release）。
- 系统层热更新（依赖工具链，按 release 交付；需要热更新的能力放 org 层）。
- org 层「跟随最新」（ADR 0015 D3 已拒绝）。
- 改变用户草稿 → 启用的流程（ADR 0009 D7）。
- Skill 市场、评分、跨部署分发。

---

## 3. 概念模型

| 层 | 背书人 | 字节来源 | 版本语义 | 模型侧路径 | Agent 如何选 |
|---|---|---|---|---|---|
| `system` | 平台发布 | release 目录（compose：`./skills`） | 随 release，按名选择 | `/home/sandbox/skill/<name>` | `skillPolicy.system` |
| `org`（新增） | 本 org 管理员 | 发布存储 `<base>/<orgId>/_org/` | 按摘要分版本，AgentVersion 钉摘要 | `/home/sandbox/skill-org/<name>` | `skillPolicy.org[]` |
| `user` | 本人 | 发布存储 `<base>/<orgId>/<userId>/` | 按摘要分版本，账本指向当前版本 | `/home/sandbox/skill-user/<name>` | `skillPolicy.user` 开关 |

**有效清单**（每个 Run 计算一次，Run 内固定）：

```
system_set = release 中的系统包名 ∩ policy.system（all / allowlist / none）
org_set    = policy.org 中每个 {name, digest}，要求 org 账本中该版本存在且未 revoked，字节与侧车核对通过
user_set   = policy.user == allow ? 调用者 user 启用账本（既有 S1 核对） : ∅
按名去重，优先级 system > org > user；落败与被排除项写诊断
```

---

## 4. AgentVersion 配置契约

### 4.1 字段

```json
{
  "schemaVersion": 1,
  "skillPolicy": {
    "system": { "mode": "allowlist", "names": ["pdf", "xlsx", "docx"] },
    "org": [{ "name": "sales-weekly", "contentDigest": "9f2c…(64 hex)" }],
    "user": "allow"
  }
}
```

| 路径 | 类型 | 缺省 | 规则 |
|---|---|---|---|
| `skillPolicy` | object | 省略 = `{system:{mode:"all"}, org:[], user:"allow"}` | 只接收下列三个键，其余 `CONFIG_UNKNOWN_FIELD` |
| `skillPolicy.system.mode` | `all` \| `allowlist` \| `none` | `all` | `names` 仅在 `allowlist` 时允许且必填（≤64，去重，符合 `SKILL_NAME_PATTERN`） |
| `skillPolicy.system.names[i]` | string | — | 必须存在于当前 release，否则 `SKILL_SYSTEM_UNKNOWN` |
| `skillPolicy.org` | array | `[]` | ≤64 条，名字不重复；条目只接收 `name`、`contentDigest` |
| `skillPolicy.org[i]` | object | — | 本 org 该版本不存在或已 revoked → `SKILL_ORG_VERSION_UNKNOWN`；`deprecated` → `SKILL_ORG_VERSION_DEPRECATED`（错误，不是警告：不能新绑定） |
| `skillPolicy.user` | `allow` \| `deny` | `allow` | — |
| 跨层 | — | — | system 选中名与 org 名重复 → `SKILL_NAME_CONFLICT`（org 发布时已禁止，这里防历史数据） |

有效 Skill 总数上限与清单契约 `ENABLED_SKILLS_MAX = 256` 一致；超出 `SKILL_POLICY_TOO_LARGE`。

### 4.2 配置面接口

- `GET /api/agents/config/options` 的 `platformConstraints` 增加：
  ```json
  "skills": {
    "system": [{ "name": "pdf", "description": "…" }],
    "org":    [{ "name": "sales-weekly", "description": "…", "currentDigest": "…",
                 "versions": [{ "contentDigest": "…", "status": "active", "publishedAt": "…" }] }]
  }
  ```
  只返回本 org 的 org 层；**不返回**任何用户的个人 Skill、物理路径、文件内容。
  `capabilityRevision` 纳入系统包名集合与 org 层 (name, digest, status) 集合。
- `POST /api/agents/config/validate` 的 `effectiveSummary` 增加 `skills: { system: [...], org: [...], user: "allow"|"deny" }`，
  `system` 为展开后的名单（`all` 展开成当前 release 的全部名字）。
- 创建/发布版本时服务端重新校验（既有规则），并在同一事务写 `tbl_agsvc_agent_version_skill_refs`（§5.3）。

### 4.3 与 legacy `skills` 的关系

- 无 `schemaVersion` 的记录在校验面直接失败（`CONFIG_SCHEMA_VERSION_MISSING`），
  其 `skills` 按未知字段返回 `CONFIG_UNKNOWN_FIELD`，不自动转换成 `skillPolicy`：
  旧值是展示用的描述，不能推断出绑定意图。
- Agent Card：有 `skillPolicy` 的版本从有效绑定（system 展开名单 + org 条目的 name/description）生成；
  无 `skillPolicy` 的 legacy 版本维持现状（旧值或系统根扫描）。`user` 层**不进** Agent Card——
  它随调用者变化，不是 Agent 的对外能力。

---

## 5. 存储与账本

### 5.1 字节布局

复用 `contract/src/skill-manifest.ts` 的版本目录规则，只是 owner 根不同：

```
<published-base>/<orgId>/<userId>/<name>/.v/<digest>/<name>/SKILL.md     用户层（既有）
<published-base>/<orgId>/_org/<name>/.v/<digest>/<name>/SKILL.md         org 层（新增）
<published-base>/<orgId>/_org/<name>/.v/<digest>.json                    侧车
```

- `_org` 首字符是 `_`，不满足身份段正则 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，与任何 `userId` 目录不冲突。
- 不新增共享存储 export 与挂载：Agent（RW）、Worker（RO）、exec（RO）已挂载 `published/`。
- 权限：`_org` 目录由 Agent 创建，与用户 owner 目录同属主与模式（`ensureTraversableUserSkillRoot` 的同一套）。
- staging、原子发布、侧车后写的顺序完全沿用 `skills/enablement.ts` 的实现，抽出共享函数而不是复制一份。

### 5.2 新表（ADR 0013 命名；DDL 进 DBA 发布包，同步 `contract/schema/schema-manifest.json`）

`tbl_agsvc_org_skill_versions` —— 每个已发布摘要一行，不可变：

| 列 | 类型 | 说明 |
|---|---|---|
| `version_id` | CHAR(26) PK | ULID |
| `org_id` | CHAR(26) | |
| `skill_name` | VARCHAR(191) | |
| `content_digest` | CHAR(64) | 按复制后的暂存字节计算 |
| `file_count` / `total_bytes` | INT / BIGINT | |
| `description` | VARCHAR(1024) | 发布时从 frontmatter 取，供配置面展示，不必读字节 |
| `origin_kind` | CHAR(16) | `share_request` \| `admin_upload` |
| `origin_user_id` | CHAR(26) | 作者（admin_upload 时为管理员） |
| `origin_request_id` | CHAR(26) 默认 `''` | 来自申请时填写 |
| `status` | CHAR(16) | `active` \| `deprecated` \| `revoked` |
| `published_by_user_id` / `published_at` | CHAR(26) / DATETIME(3) | |
| `status_changed_by_user_id` / `status_changed_at` / `status_reason` | | 吊销/弃用留痕 |

唯一键 `(org_id, skill_name, content_digest)`。

`tbl_agsvc_org_skills` —— 每名一行，「当前推荐版本」指针（配置面默认选中它，不影响已钉版本）：
`org_id`、`skill_name`、`current_digest`、`updated_by_user_id`、`updated_at`；唯一键 `(org_id, skill_name)`。

`tbl_agsvc_skill_share_requests` —— 用户申请：
`request_id`、`org_id`、`requester_user_id`、`skill_name`、`content_digest`、`note`、
`status`（`pending` \| `approved` \| `rejected` \| `withdrawn` \| `superseded`）、`decided_by_user_id`、`decided_at`、
`decision_note`、`created_at`。同一 `(org, requester, name)` 至多一条 `pending`（应用层在事务内保证）。

`tbl_agsvc_agent_version_skill_refs` —— AgentVersion 创建时同事务写入：
`agent_version_id`、`org_id`、`scope`（`system` \| `org`）、`skill_name`、`content_digest`（system 为 `''`）。
用途：GC 判定、「哪些 Agent 在用这个 Skill」、吊销影响面。AgentVersion 不可变，此表只增不改。

### 5.3 事务与并发

- org 层发布、弃用、吊销、当前指针变更：事务内 `SELECT … FOR UPDATE` 锁 `tbl_agsvc_org_skills` 该名行
  （首次发布先 `INSERT … ON DUPLICATE KEY` 占位再锁），同 org 同名串行，不同名不互锁。
- 顺序与既有启用一致：文件 staging → 校验 → 发布版本目录 → 写侧车 → 写账本 → 提交；
  任何一步失败，账本不出现该版本，孤立版本目录由 GC 回收。「读取失败 ≠ 空能力集」。
- 审批申请：事务内锁申请行，校验 `pending`，读作者的**已发布版本**（不是草稿）核对摘要，复制并重算摘要，
  二者不等 → 拒绝并保持 `pending`，返回两个摘要。

### 5.4 回收

org 版本可被回收当且仅当：不被任何 `agent_version_skill_refs` 引用、不是 `current_digest`、
账本状态不是 `active`、超过宽限期（沿用 `SKILL_VERSION_GC_GRACE_MS`）。`active` 版本随时可被新 AgentVersion
绑定，「可绑定」必须蕴含「字节在盘上」；要回收旧版本先弃用它。没有账本行的目录（写账本失败的孤儿）照常回收。`revoked` 版本的**字节**保留到满足上述条件，
便于事后审计；是否可被加载只由账本状态决定。

---

## 6. 每 Run 解析与执行面

### 6.1 Agent 侧解析

`resolveRunSkillPaths(env, identity, deps)` 扩展为 `resolveRunSkills(env, identity, boundVersion, deps)`，返回：

```ts
{
  system: string[];                          // 选中的系统包名（已与 release 求交）
  published: PublishedSkillVersion[];        // 每项增加 scope: 'org' | 'user'
  diagnostics: SkillResolutionDiagnostic[];  // 排除项：revoked、missing、mismatch、name_conflict、policy_denied
}
```

- `dsh-run-executor.ts` 在已有 `boundVersion` 之后调用，传入 `boundVersion.skillPolicy`。
- org 条目：读 `tbl_agsvc_org_skill_versions` 核对状态，再用既有 `readPublishedVersion` 核对字节与侧车。
  账本读失败 → Run 失败（fail-closed），不降级成空。
- system 名单与 release 求交时，release 中缺失的名字写诊断（配置保存后 release 变了）。
- 诊断写进 Run 的可观测面：结构化日志 + Run 起始元数据（具体落点实现时定，优先复用 `run.started` 事件 payload，
  若改事件形状须同步 `api.md` SSE 事件族，见 ADR 0014）。

### 6.2 Agent 侧 provider

- 系统层：保留 `FileSystemSkillProvider` 扫系统根，外包一层**名单过滤**（list 与 get 都过滤，
  与 `published-skills-provider.ts` 的做法一致）。`mode: all` 时不包装。
- org 层：复用 `createPublishedSkillsProvider`，logical root 参数化为 `/home/sandbox/skill-org`，
  providerName `run-org-published`。
- user 层：不变，`policy.user == deny` 时不注册。

### 6.3 清单契约扩展（`contract/`）

`EnabledSkillRef` 增加可选 `scope: 'user' | 'org'`，缺省 `user`（旧 Agent 发出的清单语义不变）。
请求体顶层新增可选 `systemSkills: string[]`（≤256，名字模式同上，不重复）：

- 缺省（旧 Agent）→ exec 系统层整树挂载（滚动升级兼容）。
- 存在（含空数组）→ 只挂名单中的系统包。
- 同一名字在 `systemSkills` 与 `enabledSkills` 中同时出现 → `ENVELOPE_INVALID`（Agent 侧已去重，出现即是错误）。

两者都在 HMAC 覆盖范围内（POST 体 / GET 规范化 query），与 S1 相同。

### 6.4 exec 挂载与围栏

| 项 | 改动 |
|---|---|
| `isolation/profile.ts` | 新增 `AGENT_ORG_SKILL_PATH = '/home/sandbox/skill-org'` |
| `isolation/build.ts` | 系统层：`systemSkills` 存在时逐包 `ro_bind <systemRoot>/<name> → /home/sandbox/skill/<name>`（必需挂载，缺包 → `SKILL_PACKAGE_UNAVAILABLE`）；org 层逐包 `ro_bind` 到 `skill-org/<name>` |
| `http/app.ts` | `enabledSkillPackagesFromManifest` 按 `scope` 选 owner 根（`<orgId>/<userId>` 或 `<orgId>/_org`），其余核对不变 |
| `fs/path-policy.ts`、`fs/workspace-fs.ts`、`fs/writable-roots.ts` | 识别 `skill-org` 逻辑根；只读；`ls` 的行为与用户层一致。**带系统名单时 `skill` 作用域同样逐包**：`read` / `glob` / `grep` 走 fs RPC、不经 bwrap，只改挂载会留下这条绕过（2026-09-30 复审复现） |
| `http/public/ownership.ts` | 公共面不带清单：不挂 org/user 包（既有）；系统根只读访问保持不变 |
| `internal-mcp.ts` | MCP 窄桥不带清单：不挂 org/user 包；系统根**整树只读**（既有行为，本设计不改变；是否收窄是对外行为变化，另行决定） |

`isolation/preflight.ts` 的探针不变（它本就不带清单）。

### 6.5 其他发现面

- **全局 `skill-filesystem` provider**（dsh-base 出厂）：先在运行中的 Agent 容器里确认其默认根为空；
  若不为空或无法保证，在 `agent/src/runtime/bundle/cordis.patch.yml` 中禁用它，并跑
  `agent/tests/runtime/boot.test.ts` 证明 patch 生效（AGENTS.md §4：patch 装不上时不报错）。
- `agent/src/skills/paths.ts` 的 `isReadonlySkillExecution` / `isUnderSkillRoot` 与
  `agent/src/lib/text-redaction.ts` 的 `LOGICAL_SKILL_ROOTS` 加入 `skill-org`（最长前缀优先）。
- `tests/test_builtin_skills.py` 的 `RUNTIME_SKILL_PATH_FILES` 按新增路径同步。

### 6.6 其他 Run 形态

| 形态 | 绑定来源 | user 层身份 |
|---|---|---|
| 浏览器会话 | 会话绑定的 AgentVersion | 登录用户 |
| Cron | 任务绑定的 AgentVersion | 任务所有者（既有身份） |
| A2A 入站 | 目标 Agent 的 active 版本 | 入站调用解析出的身份（既有）；无用户身份时 user 层为空（既有行为） |
| `delegate_to_agent` 子 Run | **子 Agent** 的版本（不继承父 Agent 的绑定） | 与父 Run 相同 |
| DSH `subagent`（进程内） | **待验证**：agent scope 注册的 provider 是否被子 agent 继承；需要在实施阶段用测试钉住 | 同父 |

---

## 7. 共享流程与 API

### 7.1 状态机

```
用户已启用版本 ──申请共享──▶ pending ──批准──▶ approved ──▶ org 版本 active（可选：设为 current）
                             │        └─驳回──▶ rejected
                             ├─撤回──▶ withdrawn
                             └─同名再次申请──▶ 旧申请 superseded

org 版本： active ──弃用──▶ deprecated ──吊销──▶ revoked
             └────────────吊销──────────────▶ revoked        （revoked 不可恢复；需要时重新发布同摘要会被拒绝）
```

- 批准后作者之后改草稿、重新启用，**不影响** org 版本（字节已复制）。作者需再发申请。
- 管理员审阅接口只暴露**被申请的那一个版本**的文件清单与 `SKILL.md`，不开放浏览作者的其他 Skill。
- 一个名字在 org 层首次发布后，其后续版本必须来自同一作者的申请或管理员上传；其他用户申请同名 → `SKILL_ORG_NAME_TAKEN`。
- `revoked` 摘要不允许再次发布（防止撤销后原样回流），返回 `SKILL_ORG_VERSION_REVOKED`。

### 7.2 API（BFF 只代理与投影身份；Agent 为语义权威）

用户侧：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/capabilities/skills/{name}/share-requests` | 以当前**已启用**版本发起申请，body `{ note? }`；未启用 → 409 `SKILL_NOT_ENABLED` |
| `GET` | `/api/capabilities/skills/share-requests` | 本人申请列表 |
| `POST` | `/api/capabilities/skills/share-requests/{id}/withdraw` | 撤回本人 `pending` 申请 |
| `GET` | `/api/capabilities/skills` | 既有；新增 `source: 'org-skill-root'` 项（本 org 的 active 版本） |

管理员侧（`role === 'admin'`，作用域为当前 org；非 admin 403，跨 org 资源 404）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/skills/share-requests?status=` | 本 org 申请列表 |
| `GET` | `/api/admin/skills/share-requests/{id}/manifest` | 被申请版本的文件清单（路径、大小）、截断的 `SKILL.md`、摘要 |
| `POST` | `/api/admin/skills/share-requests/{id}/approve` | body `{ setCurrent?: boolean, note? }` |
| `POST` | `/api/admin/skills/share-requests/{id}/reject` | body `{ note }` |
| `POST` | `/api/admin/skills/org` | 管理员直接上传 `.zip`/`.skill`（与草稿上传同一套流式校验与 50MB 上限） |
| `GET` | `/api/admin/skills/org` | org 层列表（每名的版本、状态、引用它的 AgentVersion 数） |
| `GET` | `/api/admin/skills/org/{name}/versions/{digest}/manifest` | 同上格式 |
| `POST` | `/api/admin/skills/org/{name}/current` | body `{ contentDigest }` |
| `POST` | `/api/admin/skills/org/{name}/versions/{digest}/deprecate` \| `revoke` | body `{ reason }`；响应带受影响 AgentVersion 列表 |

内部面对应 `/internal/skills/org/*`、`/internal/skills/share-requests/*`，沿用 `skill-routes.ts` 的鉴权与身份投影。

### 7.3 用户启用的名字约束（新增）

`POST /api/capabilities/skills/{name}/enable` 增加：与本 org **任一非 revoked 的 org 名**冲突 → 409 `SKILL_NAME_RESERVED_BY_ORG`。
作者本人对自己已被提升的 Skill 重新启用新版本**不受此限**（否则作者无法继续迭代草稿）；
Run 解析时 org 版本优先，作者自己的同名 user 版本被排除并写诊断——作者要试新版本需发申请或用不同名字的草稿。

### 7.4 审计

发布、当前指针、弃用、吊销、申请的每次状态转换写 `skills/audit.ts` 的审计日志，字段：操作者、org、名字、摘要、前后状态、原因。
`GET /api/admin/skill-usage` 增加 `scope` 维度（取自 `skill` 工具调用参数中的名字 + Run 有效清单）。

---

## 8. 兼容、迁移与滚动升级

- **既有 AgentVersion**：无 `skillPolicy` = 当前行为（全部系统 + 用户启用），`config_hash` 不变，不迁移。
- **既有用户 Skill**：不动。与未来 org 名冲突的由 §7.3 与 §3 优先级处理。
- **部署顺序**（必须）：
  1. DDL（DBA 发布包）。
  2. exec（识别 `systemSkills`、`scope`；未收到时维持旧行为）。
  3. Agent Worker（解析 `skillPolicy`、发送新清单）。
  4. Agent HTTP（配置面开放 `skillPolicy` 写入、org 层管理 API）与 BFF、前端。

  反过来会出现旧 Worker 把带 `skillPolicy` 的版本当作「省略」运行，**绑定静默失效**。
  已核实：`bindAgentVersionConfig` 目前不检查未知顶层键。不能简单地「未知键一律拒绝」——
  legacy 记录（无 `schemaVersion`）本来就带 `skills` / `extensions` / `sandboxPolicy` 等键。
  因此前置改动是：**`schemaVersion: 1` 的记录**出现本进程不认识的顶层键时，绑定 fail-closed
  （`DSH_CONFIG_UNSUPPORTED`）；legacy 记录维持现状。v1 记录在写入时已按白名单校验，
  出现未知键只可能是「更新的写入方 + 更旧的 Worker」。这一条作为 P0 单独先发布并部署到全部 Worker。
- **收紧**：全部 Agent 版本均已发送 `systemSkills` 后，exec 把它改为内部面必需字段
  （缺失 → `ENVELOPE_INVALID`），去掉整树挂载的兼容分支。以运行日志中「缺省清单」计数为 0 作为收紧前提。
- 目标部署 §3 的共享存储：本设计不新增 export；`_org` 目录随 `published/` 一起备份。

---

## 9. 分阶段实施

每阶段一个 PR，阶段内按 AGENTS.md §3 先写失败测试，阶段结束跑相关回归与类型检查；
触及 `agent/`、`exec/` 运行路径的阶段按 §4 重建容器跑真实链路。

| 阶段 | 内容 | 解决 | 验收（可观察） |
|---|---|---|---|
| P0 前置 | v1 记录的未知顶层键在 Worker 绑定时 fail-closed（legacy 不变）；确认/禁用全局 `skill-filesystem` provider（boot.test） | 防静默失效 | 带未知键的 v1 版本起 Run 被拒、legacy 版本照常；Agent 容器内全局 provider 候选为空 |
| P1 系统层绑定 | `skillPolicy.system` + `skillPolicy.user`；配置面 options/validate；Agent 侧名单过滤；`systemSkills` 清单；exec 逐包系统挂载；Agent Card 取有效绑定；前端 Agent 配置页 Skill 区 | 问题 1（区分度） | 两个 Agent 分别白名单 `pdf` 与 `xlsx`：prompt 目录不同；在 A 的 Run 中 `ls /home/sandbox/skill` 只见 `pdf`，`read .../xlsx/SKILL.md` 失败；`user: deny` 时用户已启用包不可见；legacy 版本行为不变 |
| P2 org 层 | 表、`_org` 发布、管理员上传、current/deprecate/revoke、`skillPolicy.org`、`skill-org` 挂载与围栏、refs 表、GC | 问题 1（热更新）、问题 2（管理员侧） | 管理员上传 v1 → 绑定到 Agent → 用户 B（从未安装）的 Run 可用；发布 v2 → 「升级」生成新版本 → 下一个 Run 用 v2、进行中的 Run 仍用 v1；revoke 后新 Run 排除并有诊断；跨 org 404 |
| P3 共享申请 | 申请/撤回/审阅/批准/驳回；名字保留规则；审计 | 问题 2（用户侧） | 用户 A 申请 → 管理员审阅清单 → 批准 → 绑定 → 用户 B 可用；A 之后改草稿不影响 org 版本；摘要不一致时拒绝；非 admin 403 |
| P4 收紧与可观测 | skill-usage 分层；Capabilities 页 org 层展示；exec `systemSkills` 必需（**单独发布**，前提是兼容期告警在全部 exec 上归零） | 债务清理 | 兼容分支删除后六套测试与真实链路通过 |

---

## 10. 测试与验证计划

- 单元：`skillPolicy` 解析与每个错误码（含合法对照）；有效清单计算（优先级、排除、诊断）；
  清单契约的 `scope` / `systemSkills` 解析（旧形状兼容 + 非法形状拒绝）；exec 逐包挂载构建。
- 权限：非 admin 访问管理 API 403 且有 admin 成功对照；跨 org 的申请/版本/AgentVersion 引用一律 404；
  用户不能引用他人个人 Skill（配置面不存在该入口，内部清单构造不接受）。
- 持久化：真实 MySQL 下的发布事务、并发同名发布串行、失败回滚后账本无残留；GC 不回收被引用版本。
- 运行链路（重建 `agent agent-worker api-server sandbox sandbox-mcp`）：登录 → 两个不同绑定的 Agent 各跑一轮带工具的 Run →
  exec 内 `ls` 与 `read` 验证挂载同构 → org 发布/升级/吊销 → 跨租户 404。记录代码版本、命令、结果与跳过原因。
- 前端（阶段 P1/P2/P3）：浏览器实际操作 Agent 配置页的 Skill 区（加载失败、字段错误定位、版本过期提示、
  并发激活冲突）、管理员审阅页、用户申请入口。

---

## 11. 文档同步清单（随各阶段 PR）

- `api.md`：`config` 字段表增加 `skillPolicy` 行（`skills` 行保持「已移除」并指向新字段）；
  `platformConstraints.skills`；新增端点；新错误码；清单契约的 `systemSkills` / `scope`。
- `architecture.md`：Skill 三层与有效清单。
- `deployment.md`：部署顺序、`_org` 目录与备份、DDL。
- `webui.md`：Agent 配置页 Skill 区、管理员 Skill 页、申请入口。
- `skills/README.md`：三层说明。
- `CHANGELOG.md` `[Unreleased]`：各阶段用户可感知变化。
- 本 ADR 在 P3 真实链路验收后改为 Accepted；`docs/README.md` ADR 索引同步。

---

## 12. 风险与待决项

| 项 | 说明 | 处理 |
|---|---|---|
| DSH 进程内 `subagent` 是否继承 agent scope 的 skill provider | 未验证 | P1 用测试钉住；若继承，子 agent 与父同清单（与 exec 挂载一致）；若不继承，记录为已知行为 |
| 全局 `skill-filesystem` provider 的默认根 | 未验证是否为空 | P0 |
| Run 诊断落点 | 可能需要改 `run.started` payload | P1 定；改事件形状同步 `api.md`（ADR 0014） |
| 管理员作用域 | 现有 admin 是部署级用户名集合，按当前 org 操作 | 本设计沿用；若将来引入 org 级角色，管理 API 的判定点只有一处 |
| 系统层 release 中删除某包 | 已绑定该名的 AgentVersion | Run 解析排除并写诊断；配置面对该版本给出 warning，提示升级 |
| 作者被移出 org | org 版本是复制的字节，不受影响；其 pending 申请 | 成员移除时将其 pending 申请置 `withdrawn` |
| 共享存储一致性 | org 层与用户层同一存储，继承 design `updrdb-dbpm-deployment.md` §3.2 的全部约束 | 不另立；目标环境跨机实测覆盖 org 层 |
