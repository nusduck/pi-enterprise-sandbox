# ADR 0015: Skill 拆成「目录」与「绑定」两个维度，新增组织共享层

| 字段 | 值 |
|---|---|
| 状态 | **Accepted**（2026-09-30，P0–P4 容器栈真实链路验收通过；见 [`evidence/adr-0015-skill-binding-real-chain-2026-09-30.md`](../evidence/adr-0015-skill-binding-real-chain-2026-09-30.md)） |
| 日期 | 2026-09-30 |
| 决策所有者 | Agent runtime / Sandbox isolation maintainers |
| 适用范围 | `agent/` 的 AgentVersion 配置契约、Skill 发布存储与每 Run 解析；`contract/` 的启用清单；`exec/` 的 Skill 挂载；`api-server/` 的代理路由；前端 Agent 配置页与 Skill 管理面 |
| 关联决策 | [ADR 0006](0006-user-skill-enablement-gate.md)（闸门在「启用」）、[ADR 0009](0009-dsh-host-tools-and-application-steward.md) D7（草稿根 + 人工启用）、[ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) D4（逐包绑定）、[ADR 0013](0013-upspec-table-naming.md)（表/索引命名）、[`design/updrdb-dbpm-deployment.md`](../design/updrdb-dbpm-deployment.md) §3（共享 Skill 存储与 S1 清单） |
| 设计稿 | [`design/skill-catalog-and-agent-binding.md`](../design/skill-catalog-and-agent-binding.md) |

---

## 背景与问题

当前一次 Run 能看到的 Skill 只由**调用者身份**决定（`agent/src/bootstrap/container-env.ts`
`resolveRunSkillPaths`）：

- **系统层**：整个系统根目录，`FileSystemSkillProvider` 扫描；exec 整棵树 `ro_bind`。
- **用户层**：该 org/user 在 `tbl_agsvc_user_skill_enablements` 里启用的已发布版本，逐包挂载。

AgentVersion 在这条链路上**没有位置**：`configJson.skills` 在 v1 契约里已被移除
（`CONFIG_UNKNOWN_FIELD`），legacy 记录里的值只被 A2A Agent Card 拿去展示
（`agent/src/bootstrap/http-main.ts` `resolveAgentMeta`），不约束运行。
[`agent-version-runtime-integration-plan.md`](../design/agent-version-runtime-integration-plan.md) §「skills」
曾明确「本轮不新增按 AgentVersion 选择技能」。

使用中暴露两个问题：

1. **Agent 没有区分度，系统 Skill 不能热更新。** 每个 Agent 都看到全部系统 Skill（含
   `skill-creator`、`skill-vetter`、`mcp-builder` 等元技能）加用户自己启用的全部 Skill，
   prompt 目录一样长、误触发面一样大。系统层在目标部署里是不可变的 `release-id` 目录，
   与镜像、VM 工具链同一个 release manifest 交付，换内容 = 换 release + 重启三个消费面。
2. **用户开发的 Skill 无法被管理员纳入 Agent 自带能力。** 启用账本与发布目录都只有
   `(org, user)` 一个作用域；没有共享层，也没有「提升」路径。别人要用只能各自上传、各自启用，
   得到的是互不相干的拷贝。

两个问题同根：**Skill 只有「归属」一个维度，缺少「哪个 Agent 带哪些 Skill」的绑定维度。**

---

## 决策

### D1 目录与绑定正交

- **目录（Catalog）**回答「这份 Skill 字节归谁、谁为它背书」，分三层：
  `system`（平台 release）、`org`（**新增**，组织共享，管理员背书）、`user`（个人，本人启用）。
- **绑定（Binding）**回答「这个 Agent 的 Run 带哪些 Skill」，由 AgentVersion 的新字段
  `skillPolicy` 表达。
- 每个 Run 的**有效清单** = 绑定选中的 system ∪ 绑定钉住的 org 版本 ∪（绑定允许时）调用者的 user 启用集。
  Agent 侧发现（prompt 目录）与 exec 挂载**由同一份清单驱动**，保持 `enabled-skills.ts`
  已写明的「发现与挂载同构」。

### D2 AgentVersion 新增 `skillPolicy`，不复用 `skills`

`skills` 在 legacy 记录里有历史值且被 Agent Card 消费，复用同名键会让「旧值是展示用还是绑定用」
没有答案。新键：

```json
"skillPolicy": {
  "system": { "mode": "all" | "allowlist" | "none", "names": ["pdf", "xlsx"] },
  "org":    [{ "name": "sales-weekly", "contentDigest": "<sha256>" }],
  "user":   "allow" | "deny"
}
```

- **省略 `skillPolicy` 等价于 `{ system: all, org: [], user: allow }`**，即当前行为；
  既有 AgentVersion 不迁移、`config_hash` 不变。
- 保存时校验：system 名必须在当前 release 中；org 条目必须是本 org 已发布且未吊销的版本；
  三层之间名字冲突即报错。错误按字段路径返回（沿用 v1 `{ path, code, message }`）。
- 属于 v1 的**增量可选字段**，不升 `schemaVersion`。

### D3 org 层钉摘要，不跟随最新

AgentVersion 不可变、`config_hash` 可复现是既有纪律。org 条目钉 `contentDigest`；
共享 Skill 更新后，管理员在 UI 上「升级到新版本」即生成一个新 AgentVersion 并激活。
**新 Run 立刻用上新版本，不需要重启任何进程**——这就是本 ADR 提供的「热更新」。
「跟随最新」被拒绝：它会让同一个 AgentVersion 在不同时间行为不同，审计无法回答
「那次 Run 用的是哪版」。

### D4 系统层仍随 release 交付，但可被按 Agent 选择，并改为逐包挂载

- 系统 Skill 中有依赖镜像工具链的（`baoyu-*` 的 `node_modules`、Python 依赖），
  这类 Skill **不可能**脱离 release 热更新；系统层继续是 release 产物，本 ADR 不改变其交付方式。
- 系统层**按名选择、不钉摘要**：内容由平台 release 担保，与 release 一起演进。
- 需要频繁更新、不依赖新工具链的能力，**应当放在 org 层**，而不是塞进系统层。
- exec 内部面的系统层挂载由「整棵树」改为「按清单逐包」，否则模型仍能 `ls`/`read`
  未绑定的系统包，Agent 行为与配置不符。公共面（浏览器）的系统层只读访问不变。
- 请求未携带系统清单（旧版 Agent）时 exec 维持整树挂载作为**滚动升级兼容**；
  全部 Agent/Worker 升级后收紧为必需字段（见设计稿 §8）。

### D5 org 层复用按摘要分版本的发布存储

- 字节布局复用 S1 的 `<name>/.v/<digest>/<name>/` + 侧车；owner 根为
  `<published-base>/<orgId>/_org`。`_org` 不满足身份段正则（首字符须为字母数字），
  因此不可能与任何 `userId` 目录冲突，也无需新增共享存储 export 与挂载。
- 模型侧逻辑路径为 **`/home/sandbox/skill-org/<name>`**，与用户层 `/home/sandbox/skill-user/<name>`
  区分，审计与脱敏能分辨来源。
- 账本：`tbl_agsvc_org_skills`（每名一行，当前版本与状态）、`tbl_agsvc_org_skill_versions`
  （每个已发布摘要一行，含来源与发布人）、`tbl_agsvc_agent_version_skill_refs`
  （AgentVersion 创建时同事务写入的引用，用于 GC 与「哪些 Agent 在用」）。
- 被任何 AgentVersion 引用的、当前推荐的、以及仍为 `active`（可被新绑定）的 org 版本**不回收**。

### D6 提升需要作者同意 + 管理员批准

用户启用只让 Skill 进入**作者自己**的上下文；进入 org 层等于让它进入**他人**的 prompt 与执行环境，
是信任等级的提升，不能复用用户自己的「启用」。

- 用户对自己**已启用**的版本发起「申请共享」（钉住该摘要）；管理员审阅文件清单与 `SKILL.md` 后批准或驳回。
  批准时从作者的已发布版本**复制字节**并重算摘要，必须与申请摘要一致，否则拒绝。
- 管理员也可以直接上传归档包发布到 org 层（管理员即作者与背书人）。
- 所有发布、吊销、申请决定进审计。管理员不可浏览他人未申请共享的 Skill。
- 管理员沿用现有判定（`role === 'admin'`），操作作用域是其当前 org；跨 org 一律 404。

### D7 名字唯一与优先级

模型看到的 Skill 名在一个 Run 内必须唯一：

- 发布时：org 名不得与系统名冲突（沿用 `assertDoesNotShadowSystem` 的纪律）。
- 用户启用时：不得与系统名或本 org 的非吊销 org 名冲突；该 org Skill 的原作者除外，
  以便继续迭代自己的草稿（设计稿 §7.3）。
- 历史数据仍可能冲突（例如 org 名晚于用户启用出现）：Run 解析按 **system > org > user**
  取胜者，落败项排除并写诊断，不静默覆盖。

### D8 吊销是安全动作，立即生效

org 版本状态为 `active` / `deprecated` / `revoked`：

- `deprecated`：不可被新绑定，已钉的 AgentVersion 照常运行。
- `revoked`：任何 Run 解析时排除该版本并写诊断；UI 列出受影响的 AgentVersion。
  运行中的 Run 不被中途撤掉挂载（与 S1「清单固定到 Run」一致）。

---

## 拒绝的方案

| 方案 | 拒绝理由 |
|---|---|
| 只在 Agent 侧过滤 prompt 目录，exec 仍整树挂载 | 发现与挂载不同构，模型可 `ls` 到未绑定的包并执行，配置不代表行为 |
| 复用 `skills` 键 | 与 legacy 展示语义冲突，旧记录会被误读为绑定 |
| org 层「跟随最新」 | 破坏 AgentVersion 不可变与审计可复现 |
| 管理员直接把 Skill 写入系统 release 目录 | 系统层按 release 交付、跨三个消费面一致，运行期改写会破坏 release manifest |
| 管理员浏览并提升任意用户的 Skill | 越过作者同意；扩大管理员对他人私有内容的可见面 |
| 把 org 层做成全局（跨 org）共享 | 超出本次问题；跨 org 分发等同平台发布，走系统层 release |
| 为 org 层新开共享存储 export | `_org` owner 根已足够隔离，新 export 增加三处挂载与存储联调成本 |

---

## 后果

- 正面：同一部署可以配置出能力集不同的 Agent；prompt 目录变短；共享 Skill 一处发布、按 Agent 绑定，
  更新不需重启；Agent Card 可以如实展示绑定的技能。
- 代价：新增三张表（DBA 发布包）、一个逻辑挂载根、启用清单契约扩展、若干管理 API 与 UI。
- 滚动升级窗口：旧 Worker 不检查未知键，会把 `skillPolicy` 当作省略（全部系统 + 用户），
  即**绑定在旧 Worker 上静默失效**。因此先单独发布「v1 记录遇未知顶层键即 fail-closed」，
  且部署顺序必须是 exec、Worker 先于允许写入 `skillPolicy` 的 API（设计稿 §8）。
- 本 ADR 不改变：草稿根不进发现（ADR 0009 D7）、用户启用即复制字节、系统层只读、
  S1 清单进 HMAC 覆盖的请求体。

## 实施

分阶段见设计稿 §9。每阶段按 AGENTS.md §3/§4 验证，本 ADR 在最后阶段真实链路验收后改为 Accepted
（2026-09-30：P0–P4 已在重建后的容器栈上跑通发现/挂载同构、org 层发布与吊销、共享申请审批、
skill-usage 分层与跨用户 404；同时抓到并修掉了两个只有真实链路才会暴露的缺陷）。
