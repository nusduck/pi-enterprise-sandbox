# UPDRDB / DBPM 与双集群部署设计

| 项 | 内容 |
|---|---|
| 日期 / 基线 | 2026-09-12；`refactor/updrdb-dbpm`，`57b9b6a1` |
| 状态 | **设计修订，未实施、未完成目标环境验收** |
| 范围 | UPDRDB / UPRedis / DBPM 接入；双 K8s 集群 + 单 VM；共享 Skill 存储；浏览器 HTTPS 入口 |
| 决策依据 | [ADR 0011](../adr/0011-updrdb-upredis-dbpm-migration.md)、[复审 R1–R7](../reviews/2026-09-12-dbpm-topology-review/README.md) |
| 文档角色 | 后续实施的统一设计入口；取代旧 review 目录中的迁移步骤与拓扑建议。不是当前运行状态说明 |

## 1. 目标、事实与边界

目标是在保留 Agent 账本权威、exec 字节与执行权威、租户隔离和审批语义的前提下，适配公司现有基础设施。不将 DSH 升级并入本次任务。

| 条件 | 证据等级 / 本轮处理 |
|---|---|
| 三边可提供共享文件存储 | **用户于 2026-09-12 确认**；具体 export、CSI、权限与文件语义仍需联调 |
| 浏览器入口 HTTPS | **用户确认按此设计，资源待确认**；域名、证书与现有 LB/网关终止点是上线条件 |
| 双 K8s 集群 + 单裸装 VM | 既有部署约束；VM 的 bwrap 可用性尚无目标机器运行证据 |
| UPDRDB 透传、双 Proxy、UPRedis 两套实例、DBPM 启动取密 | 沿用 ADR 0011；目标地址、权限与运维配置上线前复核 |
| 5.7 / Redis 5.0.14 兼容性 | 既往探针支持部分语法/场景，不能外推整条生产链路兼容 |
| Skill 共享字节、生产 Secure Cookie、Cron 事务 | 已核对本分支代码；复审列出具体接线，不以注释代替运行证据 |
| 无生产存量数据 | 既有范围假设；切换前再次核对。开发数据不据此删除 |

不变的边界：BFF 不做编排、不连数据库；Agent 是 Run / ToolExecution / Conversation / 审批唯一账本；exec 管工作区、临时目录、产物和进程；MCP facade 只持窄桥凭据。跨租户 404、常量时间令牌比较、出站超时、缺配 fail-closed、非 root 和 bwrap 隔离均保留。

本设计细化 ADR 0011 的 D3/D5/D6/D7/D9，没有引入分库、动态口令轮换或新数据库代理服务。原拓扑的“全 HTTP”“Agent 完全无文件状态”结论废止。冻结的 `plan.md` 不修改；出现超出 ADR 的新需求时另行记录决策。

## 2. 目标拓扑与网络

```text
浏览器 --HTTPS--> 现有入口 LB/网关（TLS 终止）
                          |
                 frontend A / frontend B
                          |
                     LB(api-server)
                          |
                api-server A / api-server B
                          |
                       LB(agent)
                          |
                   agent A / agent B

外部 MCP --> LB(sandbox-mcp) --> facade A / facade B --窄桥--> LB(exec)
外部 A2A --> 受限 A2A 入口 --> agent A / agent B              |
agent / agent-worker / BFF ------------------------------> 单 VM exec

agent / agent-worker --> UPDRDB 双 Proxy；服务 UPRedis
facade               --> 服务 UPRedis
VM exec              --> UPDRDB 双 Proxy；独立 replay UPRedis
上述取密进程          --> DBPM 双端点（只在启动）

agent A/B、worker A/B、VM exec --> 同一共享 Skill export
VM exec                         --> 本地 workspace / tmp / artifact / control
```

### 2.1 部署单元

| 单元 | 部署 / 状态依赖 | 运行权限 |
|---|---|---|
| frontend | 每集群一个 Deployment；静态文件，可替换 | 沿用镜像入口；nginx 临时目录显式配置 |
| api-server | 每集群一个 Deployment；请求级 `/tmp` 用有容量限制的 emptyDir | 非 root；不挂 Skill 或执行面数据 |
| agent | 每集群一个 Deployment；依赖 MySQL、Redis、共享 Skill 文件 | `node` 用户；Skill 权限见 §3 |
| agent-worker | 每集群一个 Deployment；同 Agent 镜像；共享队列与文件，不是同容器内第二进程 | `node` 用户；不发布业务 HTTP 面 |
| sandbox-mcp | 每集群一个 Deployment；新增 slim 镜像目标；Redis 存映射 | uid 10001；零数据卷；无完整 HMAC/Agent 内部凭据 |
| sandbox / exec | **单 VM、单实例、systemd 托管**；本地执行字节与进程有状态 | 专用非 root 账号，宿主 UID 可与容器不同；隔离内 UID/GID 另验 |

> **2026-09-15 实施细化（S2e）**：slim facade 是 `exec/Dockerfile` 的 `facade` 阶段（`node:22-slim` + facade import 图的 dist + `npm ci --omit=dev` 后移除 `mysql2` 与 `@deepseek-ai/dsh-*`），开发栈实测 302MB（执行面镜像 2.84GB），uid 10001，发布文件只读，无 bwrap / Python / curl / 模型工具链。facade 入口原先经 `startup-credentials.ts` 间接加载 `db/client.ts` 与 `mysql2`，已拆出 `mcp/startup-credentials.ts`；`exec/test/mcp-import-boundary.test.ts` 同时核对 import 图允许清单与 Dockerfile 复制清单。基础镜像自带的 `apt-get`、`setpriv` 未删除；是否换 distroless 等更小基础镜像未定。

初始按**每集群每个 Deployment 1 个 Pod**编制资源清单，两集群合计 2 个；这是设计默认值，不是已分配容量。扩容前计算连接池总数、Worker 并发和单 VM 执行上限，不能只提高 Worker 副本数。

“可替换 Pod”不等于“没有文件依赖”。Agent/Worker 必须先挂对共享 Skill 存储。单 VM 与共享存储仍是共同故障依赖；本方案不宣称整栈双活容灾。

### 2.2 LB、入口与访问范围

保留 frontend、api-server、agent、sandbox-mcp、exec 五类逻辑地址。双集群经平台可达的 LB 后端注册方式接入；不能假设外部 LB 可直接访问 ClusterIP，NodePort/平台 Service 暴露方式由平台确认。

| 地址 | 来源 | 要求 |
|---|---|---|
| frontend 公共域名 | 浏览器 | HTTPS；保留生产 Secure / HttpOnly / SameSite Cookie；80 仅重定向到 HTTPS |
| api-server 内部 LB | frontend | 不对浏览器或办公网开放直连 |
| agent 内部 LB | BFF、明确授权的内部服务 | 允许内部 API；仍需服务端鉴权 |
| A2A 外部入口 | 指定 A2A 客户端 | 只开放 Agent Card 与 `/a2a/*`；不得把无关 `/internal/*` 顺带开放 |
| sandbox-mcp LB | 指定 MCP 客户端 | facade 鉴权和 Host/Origin 校验保留 |
| exec LB | BFF、Agent、Worker、facade | 8081 不对办公网/公网开放；不同路径仍各验自己的凭据 |

A2A 与内部 Agent 后端可复用，但外部入口必须有路径过滤或独立 listener。优先用现有平台 L7 入口，不新增代理服务；若平台只能提供整端口 L4，该入口未满足要求，不能自动扩大 `/internal/*` 的可达范围。实际 listener 数以平台能力清单为准，不强行保证恰好五个监听器。

浏览器 HTTPS 与内部链路加密分别处理：本次不强制将所有东西向链路同时改成 TLS，但保留当前认证和来源约束；HTTP 内部链路仍是明确的传输风险，不写成“内网所以没有风险”。

TLS 由现有入口终止，frontend 仍可监听 80。入口及 nginx 禁止 SSE 响应缓冲，保留流式上传、55MB 请求上限和 300s 读写超时，LB idle timeout 应大于心跳间隔并实测长连接。L7 本身不等于不支持 SSE。生产 Cookie 不能通过关闭 Secure 或设置开发环境适配 HTTP，依据 [MDN Cookie 协议](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。

frontend 将上游模板化为 `API_UPSTREAM`；使用 nginx envsubst 时仅替换明确允许的变量，保留 `$host`、`$remote_addr` 等 nginx 变量。平台重写而非透传客户端自报的转发头；BFF 的 `X-Acting-*` 仍由认证结果生成。VM CIDR 校验按实测的 LB SNAT/源地址保留方式配置，不能盲目填 Pod CIDR 或信任任意 `X-Forwarded-For`。

> **2026-09-15 实施细化（S2d）**：用官方 nginx 镜像自带的 `/etc/nginx/templates` + `NGINX_ENVSUBST_FILTER=^API_UPSTREAM$`，不自写模板引擎。暂只接受 `http://host[:port]`（内部 LB 按 HTTP；https 上游需另配 SNI 与证书校验，出现需求时再定）。官方渲染脚本在 `conf.d` 不可写时只记日志继续启动，因此加了渲染前校验与渲染后核对两个钩子并删除官方 `default.conf`，二者失败都拒启。frontend 模板仍透传 `$proxy_add_x_forwarded_for`：BFF 当前不读取 `X-Forwarded-For` / `X-Real-IP`（静态核对），客户端 IP 不参与鉴权；若将来 BFF 使用客户端 IP，需要先按平台 LB 行为改为覆盖。生产 Compose 的边缘 `nginx/` 镜像是另一套配置，未改。只读根文件系统所需的 nginx 临时目录（§2.1）只写进部署文档，未在目标环境验证。

## 3. 共享 Skill 文件设计（R1）

### 3.1 数据布局与挂载

使用用户已确认可提供的共享 POSIX 文件存储，不引入文件同步服务。**共享的是 Skill 字节，不是整台 VM 的文件系统**。

| export 子树 | Agent | Worker | VM exec | 模型侧 |
|---|---|---|---|---|
| `system/<release-id>/` | `/home/sandbox/skill` RO | 同左 RO | 配为 `SANDBOX_SKILLS_ROOT`，RO | `/home/sandbox/skill` RO |
| `draft/` | `/home/sandbox/skill-draft` RW（上传/管理） | 同路径；若运行期无写消费则 RO，否则仅所需 RW | 配为 `SANDBOX_SKILL_DRAFT_ROOT`，RW | 仅本 owner 的 `/home/sandbox/skill-draft` RW |
| `published/` | `/home/sandbox/skill-user` RW（启用/停用） | 同左 RO；删除残留的非必要写依赖 | 配为 `SANDBOX_USER_SKILLS_ROOT`，RO | 仅本 owner 已启用包逐包 RO |

draft/published 下保留 `<orgId>/<userId>/<skillName>` 的现有布局；Agent 配置校验要求的两个规范发现根不改变。绝不把 draft 加入发现目录。VM 的物理挂载路径通过现有配置进入 resolver，不向模型暴露物理路径。

系统 Skill 由发布流程写入不可变 `release-id` 目录，三个消费面使用同一发布清单与文件 hash；现有 Agent 镜像不能被假设已经包含 `skills/`。一次发布不原地改写正在被消费的系统包，Agent 镜像、VM 工具链与 Skill release 作为同一 release manifest 交付。

K8s 用两集群各自的 PVC/CSI 挂载**同一后端 export**；RWX 声明或相同目录名本身不能证明三边数据相同。存储联调必须验证 create/close/read、rename、chmod、崩溃后可见性及超时行为。

### 3.2 权限、挂载失败与发布一致性

- Agent `node`、VM 专用账号的数字 UID/GID 不同；通过存储 ACL 或专用共享组授予必要权限，验证 root-squash、父目录遍历和原子替换，禁止用 0777 解决权限问题。
- Worker/exec 对 published 的只读属性必须由挂载层落实，不只靠 0444。用户子进程仅 bind 本 owner 目录，不能遍历整个 export。
- 挂载失败不能退回容器/VM 同名空目录。启动验证挂载标记、发布 ID、根路径与只读属性；不可访问返回不可用，不能被 `readdir` 异常吞成“用户没有 Skill”。这要求修正 exec 当前吞掉目录错误的 resolver，以及 Agent 相应诊断。
- 共享文件系统不是 MySQL 事务。现有 `mutateSkillWithLedger()` 是先改文件再写账本，当前目录扫描也不等于读取账本；不能声称加了 NAS 就解决了并发发布与失败恢复。

**本次保持既有发布布局和 UI 语义，不另造分发协议；多副本上线须通过以下发布一致性门槛。** 同 owner/name 的启用、停用、重新启用必须串行化，采用 MySQL 事务锁定该 owner 的既有身份行，避免首次发布没有 enablement 行可锁。文件 staging 不得被发现；只有文件发布与账本写入均成功才返回成功。不同 owner 不使用全局锁。

若任一步失败/进程退出，下一次发现或执行必须核对本 owner 的账本摘要与发布字节：缺行、缺包或不一致拒绝该包并报告待修复，不能自动启用或改写账本。读取失败不能等价于空能力集。Agent 是启用语义的权威；exec 获取由 Agent 鉴权输出的 owner-scoped 启用清单，不扩大为直接读写 Agent 账本。

**这部分需要一个前置接口设计检查点（S1）**：现有 exec 生产 resolver 仅扫目录，不能直接宣称上述核对已经存在。S1 必须提交启用清单的认证载体、摘要与文件绑定、与运行中重新发布的竞争处理、失败恢复的具体接口及回归测试，再允许 S2 的多副本上线。优先复用现有 Agent→exec 认证契约，不授予 facade 完整凭据、不引入新服务。若需要改发布布局或新增 RPC，先补本文接口表及兼容约定，不能在实施时各端自行猜测。

R1 的**存储落点已确定**，发布一致性子项仍是实施前检查点，不能以本文完成就关闭。最少实测：VM 写草稿 → 集群 A 上传/启用 → 集群 B Worker 发现 → VM 执行；随后替换 Pod、并发启停、注入 DB/存储失败、跨 owner 拒绝。

### 3.3 S1 接口检查点（2026-09-14；用户已确认按推荐方案实施）

#### 现状（基线 `ecda592e`，只读核对）

| 位置 | 事实 | 与 §3.2 的差距 |
|---|---|---|
| `agent/src/application/skill-enablement-service.ts` | 启用 = 先 `copyFile` + `atomicReplaceDir` 改发布字节，再 upsert `user_skill_enablements`；失败时删字节。停用 = 先删字节再删行 | 无锁、非事务；两步之间崩溃会留下「有字节无行」或「有行无字节」 |
| `user_skill_enablements` | **只有写入方**：全仓无读取；`createEnabledSkillsProvider` / `EnabledSkillStore` 只有内存实现且未接线 | 账本不是发现的依据，目录才是 |
| Worker（`dsh-run-executor.ts:679` → `runtime-factory.ts:423`） | `FileSystemSkillProvider` 在 Agent 本地扫 system 根 + `skill-user/<org>/<user>` | 发现 = 扫目录 |
| exec `enabledSkillPackagesFromRoot`（`exec/src/http/app.ts:42`） | 同步扫 owner 目录，**任何异常 `catch {}` 返回 `[]`** | 挂载失败被当成「没有 Skill」 |
| exec 内部面 fs / shell / artifact | 按信封 owner 调上面的解析器，逐包 `ro_bind` 到 `/home/sandbox/skill-user/<name>` | 挂载内容与账本无绑定 |
| exec 公共面（BFF 转发） | 同一解析器只用于拼 `physicalRoots` 做**路径脱敏**，不读 Skill 字节 | 公共面不需要启用清单 |
| sandbox-mcp 窄桥 | `enabledSkillPackages: []` | 保持不变 |
| Agent → exec | 信封五字段 + payload，整个 body 受 HMAC `body_sha256` 覆盖；exec 没有回调 Agent 的客户端 | payload 可以承载经 Agent 鉴权的清单 |
| Worker 发现（**已复现并修复**） | `createDshRunExecutorFactory` 漏转发 `skillRootsForRun`，Run 的 provider 只有系统根，已启用用户 Skill 在 `skill` 工具中报 unknown | 2026-09-14 修复，见 CHANGELOG |
| 模型可见路径（**已复现，未修**） | `skill` 工具给出的基础目录是 Agent 本地 `/home/sandbox/skill-user/<org>/<user>/<name>`；exec 把第一段当包名，`read` 返回 `FS_SANDBOX_DENIED`，bash 报不存在；实际挂载在 `/home/sandbox/skill-user/<name>` | 由下文第 6 条修正 |

#### 提议的接口

1. **权威与载体**：`user_skill_enablements` 是唯一启用权威。Worker 在 Run 开始时按 owner 读账本得到清单 `[{ name, contentDigest }]`，随该 Run 的 exec RPC 配置下发；内部面 fs / shell / artifact 的 **payload** 增加 `enabledSkills` 字段（受 `body_sha256` 签名），不改信封五字段，不让 exec 直读 Agent 账本，不新增 exec→Agent 回调。一次 Run 内清单固定，运行中重新发布只影响下一次 Run。
2. **摘要与字节绑定（推荐：按摘要分版本目录）**：发布路径由 `published/<org>/<user>/<name>/` 改为 `published/<org>/<user>/<name>/.v/<contentDigest>/`，同级写只读侧车 `<contentDigest>.json`（name、digest、fileCount、totalBytes）。模型侧挂载目标仍是 `/home/sandbox/skill-user/<name>`，UI 语义不变。exec 只绑定清单点名的版本目录；目录或侧车缺失、侧车 digest 不符 → 该包拒绝并以 `SKILL_PACKAGE_UNAVAILABLE` 报出，不静默丢弃。完整重算摘要只在发布时和核对 CLI 中做，不在每次请求中做。
   - 备选：保留原地替换布局，每次挂载前重算摘要。实现改动小，但 50MB / 512 文件的包每个请求都要全量读，且原地替换仍与正在运行的 Run 竞争。
3. **存储不可用 fail-closed**：owner 根不可读（挂载掉线、权限、超时）→ 内部请求失败，返回 `SKILL_STORE_UNAVAILABLE`，不返回空集；公共面脱敏改用 owner 根前缀，不再依赖目录扫描结果。
4. **并发串行化**：启用 / 停用在一个 MySQL 事务内完成：`SELECT … FROM users WHERE user_id=? FOR UPDATE`（锁 owner 既有身份行，不用全局锁）→ 读当前行 → 复制到 `.staging-*`（不在任何发现路径上）→ 写侧车并 `rename` 为 `.v/<digest>`（同 digest 已存在且侧车一致则复用）→ upsert / delete 账本行 → commit。文件复制计入锁等待预算。
5. **失败恢复与回收**：commit 前崩溃 → 只留未被引用的版本目录；commit 后崩溃 → 已一致。停用只删账本行，字节保留；同一 owner/name 下次启停时，在同一把锁内回收「未被账本引用且超过宽限期」的版本目录，不新增后台定时器。「有行无字节」由发现/执行报告为待修复，不自动改写账本；从草稿重新启用即修复。
6. **Agent 侧发现**：Worker 与 UI 投影改为「账本 ∩ 校验通过的版本目录」，不再扫 owner 目录。Run 内注册一个按账本构造的 provider：列出时 `path` / `resourceBase` 给模型逻辑路径 `/home/sandbox/skill-user/<name>`（与 exec 挂载目标一致），加载时按本 Run 的 name → 版本目录映射回物理路径读取；映射外的名字一律不可见。
7. **存量兼容**：~~提供一次性迁移 CLI~~。用户 2026-09-14 决定历史开发数据直接清理、无生产存量（§1），因此不实施迁移；旧的平铺 `<name>/SKILL.md` 发布不再被识别，需重新启用。

#### 决策（用户 2026-09-14 确认按推荐方案）

| 编号 | 问题 | 决定 |
|---|---|---|
| S1-Q1 | 字节绑定方式 | 按摘要分版本目录（第 2 条） |
| S1-Q2 | 版本回收宽限期 | 新增配置，默认 24 小时：需覆盖单个 Run 截止时间（默认 30 分钟）之外的后台进程与等待审批后续跑 |
| S1-Q3 | 草稿根是否仍由 Agent 与 VM 共写 | 保持 §3.1：共享 `draft/` RW |

> **2026-09-14 实施细化（S1 接口）**：第 1–6 条已实现并在开发栈验证，见
> [证据](../evidence/s1-skill-ledger-2026-09-14.md)。实现与草案的差异：
> - 清单作为请求体顶层 `enabledSkills` 字段（与 `envelope`、`payload` 并列，同受 `body_sha256` 覆盖），不塞进各端点 payload；GET（`fs/stream-text`）放进 query，签名改为覆盖规范化 query——此前 GET 的 query 整体不在签名内，一并修正。
> - 版本目录内层再套一层包名（`.v/<digest>/<name>/`），使 `.v/<digest>` 本身是只含一个包的发现根，Run 内 provider 可复用出厂 `FileSystemSkillProvider` 解析。
> - 摘要按复制后的暂存字节计算，堵住草稿在校验与复制之间被模型改写的窗口。
> - 锁的是 `organization_memberships` 行（主键即 owner），首次启用同样有行可锁。
> - 多副本、共享存储挂载与 VM 上的验收（§3.2 最少实测）仍未做，属 S2 / 目标环境。

#### 回归测试（实施时先写，修复前应失败）

- exec：owner 根不可读返回 `SKILL_STORE_UNAVAILABLE` 而非空集；清单点名的版本缺失 / 侧车不符被拒；清单外的包不挂载；跨 owner 的清单被拒（对照：本 owner 合法清单可挂载）。
- Agent：两个真实事务并发启用 / 停用同一 owner/name 时串行，不同 owner 不互相阻塞；commit 前注入失败不留账本行；「有行无字节」被报告而非启用。
- 链路：Run 进行中重新发布，当前 Run 仍用旧版本，下一次 Run 用新版本；替换 Pod 后仍可发现。

## 4. UPDRDB 接入与连接生命周期

### 4.1 基线与职责

UPDRDB 使用透传模式，保留外键、唯一键和四个 append-only 触发器。不新写分库 DDL。DSH 仍按当前 `runtime-versions.json`，本次不升级。

开发/CI 兼容基线为 MySQL 5.7 + Redis 5.0.14；UPSQL 目标隔离级别既往为 READ COMMITTED，兼容测试也显式设 READ COMMITTED，并另外保留必要的锁等待/死锁用例。MySQL 全局时区在兼容环境设 +08:00，用于暴露 UTC 接线漏项。版本钉、镜像、lockfile 与 CI 由 `runtime-versions.json` 统一约束，不把短测记录里的驱动版本当作当前依赖版本。

连接点仍为 Agent Knex、Agent DSH 裸 mysql2 池、exec 裸 mysql2 池。每个进程只创建自己的池；事务从 acquire 到 commit/rollback 使用同一连接，不跨 Proxy 拼接事务。

### 4.2 多 Proxy 与错误边界

共享纯 endpoint 选择器放 `contract/`；mysql2/Knex 驱动接线留在各自基础设施模块，不把数据库驱动、业务仓储或连接池依赖塞入 RPC 契约包。

每次 acquire 的流程：选择当前主用端点 → 建连 → 初始化会话 → 返回可用连接。建连网络故障将该端点拉黑 180s，尝试另一个；成功后粘住，不因拉黑过期主动回切。全黑时只允许一次受限探测轮次，不能无限清表循环。

设计预算：单次 TCP/握手最长 3s，一次 acquire 的所有端点尝试及初始化总预算 10s；池排队也在该预算内。超时销毁未交付连接。错误分类区别网络不可达、认证失败、配置错误、UTC 初始化失败；后几类拒绝启动/操作，不伪装成可无限重试的网络故障。

| 接入点 | 必须落实的接线 |
|---|---|
| Knex | 每实例的 raw connection acquisition 适配器负责捕获握手失败、反馈选择器并在未交付连接前重试；只提供函数式 `connection` / `expirationChecker` 不足以完成故障切换 |
| 裸 mysql2 | 每端点一个池；先显式 acquire，再在该连接执行完整操作/事务；选择器不在 `.query()` 之后重发操作，不销毁仍有 in-flight 使用的整池 |

Knex 接入必须在仓库实际锁定的版本上验证扩展点与销毁逻辑；禁止全局 monkey-patch 或并发修改共享 `connectionSettings`，造成选中 A 却连接 B。阶段 D2 先提交生产工厂接线测试，再复用到三处。

**扩展点已在锁定版本（knex 3.3.0 / mysql2 3.15.3）上验证**（2026-09-12 spike，未进仓库）：

- `config.client` 接受构造函数，可按实例继承 `knex/lib/dialects/mysql2` 并覆写
  `acquireRawConnection()`——这是每个 Knex 实例私有的方法，不需要全局 patch。
- 端点必须在 `acquireRawConnection()` 内组装成局部 settings 传给
  `driver.createConnection()`，**不要写 `this.connectionSettings`**：那是实例共享字段，
  内置的 `connectionConfigProvider` 路径正是靠改它工作的，并发建连会串端点。
- 陷阱：knex 用 `setHiddenProperty()` 把 `password` 设为**不可枚举**，
  `{...this.connectionSettings}` 会静默丢掉口令，现象是认证失败
  （`using password: NO`）而不是编码错误。派生 settings 后要用同样方式补回，
  以免口令进入可枚举快照。
- 池的 `create` 是 `updatePoolConnectionSettingsFromProvider → acquireRawConnection →
  await promisify(afterCreate)`：`afterCreate` 确实被等待，回调传错即建连失败、
  连接不进池。会话初始化放在 `acquireRawConnection()` 内或 `afterCreate` 均可，
  但必须二选一且覆盖新建/扩容/重连/切端点四条路径。
- 覆写时保留上游对 `checkVersion()` 的调用（或显式 `config.version`），
  否则方言的版本探测不再发生。
- 已验证行为：首端点故障切备并粘住、死端点拉黑、并发建连不串端点、
  会话初始化失败不交付连接、全端点故障在预算内有界失败。

**业务 SQL 一旦发出不自动重试。** 包括 commit 响应丢失：可能已经提交，回到原有幂等键/事务回读与恢复流程判定；不能将未知结果当确定失败后换端点重放写入。只记录角色、端点代号、错误码、阶段，不输出含口令配置。

### 4.3 UTC 初始化与连接状态

每条物理连接在交付前完成 `SET SESSION time_zone = '+00:00'`。继续固定驱动 `timezone=Z`、`dateStrings=true`、JSON 字符串边界；初始化失败丢弃连接并失败，不能只挂一个不处理回调错误的 `connection` 事件监听器。

初始化与连接成功视为一个操作；Knex `afterCreate` 必须等待回调，裸池包装器必须等待初始化 promise，再让使用者执行 SQL。所有新建、扩容、重连及切 Proxy 后的连接都经过同一路径。业务代码不得修改连接时区/隔离级别后直接归还池。

## 5. Outbox 与 Cron 抢占事务（R3）

两者都移除 SKIP LOCKED，但不承诺变成非阻塞锁。MySQL 5.7 的条件 UPDATE 仍可能等待；短事务、正确索引和显式锁等待上限共同控制影响。兼容测试建议 `innodb_lock_wait_timeout=3`，生产值经压测锁定并计入操作超时预算。

### 5.1 Outbox

保留 `claimBatch()` 的事务、eligibility 过滤、stale reclaim、attempts 和发布 CAS。每批使用唯一 ULID claim token，增加非唯一 `claim_token` 回读索引；所有后续状态更新仍同时匹配 outbox ID 与 token，不能仅按共享批 token 更新单条结果。

```sql
-- 同一事务；先执行现有带 eligibility 的 stale reclaim。
UPDATE domain_outbox
SET status = 'PUBLISHING', claim_token = ?, claimed_at = ?,
    attempts = attempts + 1, next_attempt_at = NULL
WHERE status = 'PENDING'
  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  /* 这里必须带原有 eligibility 的参数化过滤 */
ORDER BY created_at, outbox_id
LIMIT ?;
SELECT * FROM domain_outbox WHERE claim_token = ? AND status = 'PUBLISHING'
ORDER BY created_at, outbox_id;
-- COMMIT 成功后才向 Redis 发布。
```

每次新抢占生成新 token，过期发布者不得确认新 claim。commit 前退出由数据库回滚；commit 后发布前退出由已有 stale reclaim 回收；发布后确认前退出允许至少一次投递，由现有 Run 幂等处理兜底。不把两条 SQL 称为“一次往返、天然幂等”。

### 5.2 Cron

新增迁移为 `cron_jobs` 增加可空 `claim_token CHAR(26)` 与非唯一回读索引。它是**事务内批次标记**，不是新的持久租约：该事务结束前清空，不新增定时回收器。

1. `claimDue()` 开启事务，生成唯一批 token；按 `enabled / deleted_at / next_run_at` 原有条件做 `UPDATE ... SET claim_token=? ... ORDER BY next_run_at, cron_job_id LIMIT ?`，仅命中 `claim_token IS NULL` 的行。
2. 同连接按 token 回读，行锁一直保留。依次按现有服务计算 scheduledAt、下一次时间、misfire、`concurrencyPolicy=forbid`。
3. 插入 `cron_job_runs`，保留 `(cron_job_id, scheduled_at)` 和 idempotency 唯一键；推进 next/last/enabled，并将每行 claim_token 清空，包括 SKIPPED 分支。
4. 校验本批无残留 token 后 commit，commit 后才走现有 `executeClaim()` 创建 Run。

事务内崩溃回滚 token、执行记录和时间推进；提交后崩溃由已有 `recoverClaims()` 及执行幂等键恢复。提交结果未知时查询原 execution 键，不能重算一个新的 scheduledAt 来重试。异常残留 token 被诊断为数据不一致，不静默忽略。

手动运行继续锁同一 `cron_jobs` 行，再检查开放 execution。并发定时/手动触发仍遵循 forbid。正常原子流程不应留下“已有相同 execution、next_run_at 却未推进”的状态；遇到此类冲突回滚并诊断，不能盲目推进或死循环重试。

**门槛**：两个真实事务同步进入竞争区，A 持锁时 B 已执行；覆盖不同批次、相同时间戳排序、锁等待超时、事务回滚、commit 后进程退出、重试/去重、allow/forbid、once、misfire skip/fire_once。既往顺序探针只保留为条件更新测试。

## 6. 手工 DDL 导出、验证与恢复（R4）

### 6.1 单一权威与发布产物

Agent 的 Knex migrations 仍为唯一 schema 权威。实施新增 `migrate:sql` 与 `migrate:verify`；前者只在有 DDL 权限的隔离影子库运行，后者为纯读。移除生产自动 `agent-migrate` 和依赖，但保留开发 CLI、部分迁移恢复与触发器权限预检。

每个发布包包含：起止 migration ID、migration 文件 hash、schema manifest、按 migration 分段的 SQL、产物 hash、验证/恢复说明。manifest 从指定版本的真实影子 schema 生成，不手工维护另一套表定义，也不使用不完整的 `schema-tables.ts` 充当全集。生成物属于构建产物，源码只提交生成器、规范和必要 fixture。

`knex.on('query')` 只能作为采集机制：必须关联 migration 边界与 bindings，按驱动规则生成 SQL 字面量，不做字符串拼接替换。区分业务 DDL/DML、会话初始化、Knex 自身查询/锁/记账，不能把全部事件原样回放。基于数据的分支迁移必须明确表达适用于目标数据的 SQL，不能把空影子库走过的一条分支冒充通用增量脚本。

首装从空库导出；增量从已声明的基线重建影子库后只导出新增段。同一脚本在第二个空白/基线库执行并比较 schema manifest，才可交付 DBA。触发器以完整语句执行，CLI 脚本包含正确 delimiter；不得把 `DELIMITER` 直接发给服务端驱动。

### 6.2 执行顺序与验证范围

DBA 使用发布脚本逐段执行，首次错误停止，禁止 `--force`。MySQL DDL 不能靠外层事务自动撤销；每段成功并完成对象核对后才写其 migration 记账。失败段保留现场，由 [部分迁移恢复 runbook](../runbooks/mysql-partial-migration-recovery.md) 确定继续或清理范围；禁止补记版本掩盖失败或重跑全量脚本碰已有表。

schema manifest 覆盖实际 migrations 的全部表，包括后续 DSH/exec/cron/Skill 表：

- 列名、类型、长度、unsigned、nullability、默认值、生成表达式和 on-update。
- 主键、唯一键、必要索引、外键及其动作、引擎与字符集/排序规则。
- 四个 append-only 触发器的目标表、事件、时机及规范化正文；合法的 DBA definer 差异单独处理，不跳过正文比较。
- migrations 顺序、版本/hash；允许的额外兼容对象明确列在发布包，未知漂移拒绝。

**Agent、Worker、exec 均在提供服务/消费任务/孤儿回收前验证**；exec 只运行通用只读 checker，生成权威仍在 Agent。可将无驱动的 manifest/check 逻辑共享到 `contract/`，driver 查询留在本包。各进程至少验证自身消费对象与必须的安全约束；新 schema manifest 随各镜像/VM 产物同版交付。

应用账号能否读取完整元数据，特别是触发器正文，必须由 DBA 确认。不可见不能视为没有差异；若现有最小权限不足，需 DBA 提供只读元数据视图或等价受控查询，验证工具仍要读真实对象。不能为此给应用账户 DDL 权限，也不能只信版本表或一份人工“通过”标记。

验收故意保留完整版本记录、分别移除后续表/列/唯一键/触发器，三个进程应在相关能力启用前拒绝；再恢复正确 schema，证明合法写入成功、append-only 非法写入被拒。

> **2026-09-14 实施细化（D3）**：用户决定开发 Compose 也去掉自动迁移，与生产同一流程（`scripts/dev/schema-apply.sh`）。
> - 清单 `contract/schema/schema-manifest.json` **提交进仓库**，作为随镜像分发、运行时核对的规范文件；它仍由 `schema:manifest` 从空影子库真实迁移生成，不手写，并由 `schema-manifest.integration` 测试防漂移（改迁移不重新生成即红）。这修正了上文「生成物不提交」的表述：发布包 SQL 是构建产物不提交，清单是规范要提交。
> - 核对器的比较规则放在 contract（纯函数），Agent（Knex）与 exec（mysql2）各自执行元数据查询。只抹平已实测的 5.7 / 8.0 表示差异：整数显示宽度、`DEFAULT_GENERATED`、外键 `NO ACTION`≡`RESTRICT`；触发器不比 definer / sql_mode。Knex 记账表 `knex_migrations(_lock)` 只核对存在——其列定义随 `explicit_defaults_for_timestamp` 变化，迁移是否齐全由迁移记录逐条核对。
> - 导出器实测 Knex 事件形状后按迁移分段：丢弃 `knex_migrations*`、`information_schema` 探测与 `BEGIN/COMMIT`；首装单列 `0000` 记账段；增量用 `--from`。当前迁移中只有 `auth_credentials` 的 `hasTable` 按状态分支，导出结果仅适用于首装或声明的基线。
> - 元数据可见性：本地应用账号（库级 ALL）能读四个触发器正文；生产最小权限下是否可见仍需 DBA 确认，读不到按缺失处理（拒启），不是放行。

## 7. DBPM 取密与配置契约

取密顺序：校验配置 → 按角色取所需凭据 → 创建/验证连接 → schema/文件/隔离预检 → 就绪。配置中的 DB/Redis URL 不带密码；不写 process.env，不落盘、不打印 DBPM 响应或拼出的 DSN。应用无环境变量密码回退路径。

| 凭据 | 取密进程 |
|---|---|
| UPDRDB | Agent、Worker、VM exec |
| 服务 UPRedis | Agent、Worker、sandbox-mcp |
| replay UPRedis | 仅 VM exec |

> **2026-09-14 实施细化（D2c）**：按「逐项追到实际工厂」核对后，`SANDBOX_INTERNAL_REDIS_URL` 在 `exec/src` 与 `agent/src` 中**没有任何读取方**（ADR 0008 D8 已去掉 jti 防重放实例），因此 replay UPRedis 这一行**不实施取密**，只保留 UPDRDB 与服务 Redis 两类；该实例与 Compose 配置的去留另行处理。用户确认「全部强制」：开发 Compose、CI smoke、release-gate 测试都经（假）DBPM 取密，生产 overlay 要求真实 `DBPM_URL`。`agent-migrate` 作为 DBA 工具保留带口令 DSN（单独变量 `AGENT_MIGRATE_DATABASE_URL`），不进应用容器。

DBPM 纯 TCP 客户端可共享在 `contract/`，按既有协议发送请求并收至换行；拒绝名称中的空白、换行/控制字符，校验响应前缀，限制单帧大小（设计值 4KiB）。连接超时 3s，每端点请求 5s，两端点一轮总预算 10s；EOF、半帧超时、过大帧和错误响应均失败并销毁 socket。返回类型只含口令，不包含整个原始响应。

保留启动只取一次；认证错误不触发运行期重取。生产口令变更前确认重启顺序与双口令重叠窗口是否存在。没有重叠窗口时采用维护窗口，不能承诺零中断；单 VM 重启必需 drain/停止执行，不能称“所有服务都可滚动重启”。

开发使用真协议假 DBPM 服务端，映射只含开发凭据且不对外发布；生产构建/部署不得选择开发挡板。测试同时证明主失败备成功、两端失败拒启、正常取密建连及任何错误不泄密。各角色只配置需要的条目，facade 不得取 UPDRDB/replay 凭据。

拟新增配置（实施时在 `.env.example`、部署文档、启动校验及消费者同步）：

| 字段 | 语义 |
|---|---|
| `DBPM_URL` | 两个 DBPM `host:port`，逗号分隔；无默认公网目标 |
| `DBPM_DB_NAME` / `DBPM_DB_USER_NAME` | UPDRDB 条目 |
| `DBPM_REDIS_DB_NAME` / `DBPM_REDIS_DB_USER_NAME` | 服务 Redis 条目 |
| `DBPM_REPLAY_REDIS_DB_NAME` / `DBPM_REPLAY_REDIS_DB_USER_NAME` | replay Redis 条目 |
| `UPDRDB_ENDPOINTS` | 两个数据库 Proxy `host:port`；DSN 提供 user/database/options；用户名须与 DBPM 角色匹配，不静默覆盖 |
| `AGENT_RUN_QUEUE_PREFIX` | 已实现（D4）：HTTP 的 Queue 与 Worker 共用，空值取 `{bull}`，不含非空 hash tag 拒绝启动；当前代码没有 QueueEvents 与独立清理消费者；值见 §8 |
| `API_UPSTREAM` | frontend nginx 上游地址 |

既有 `AGENT_DATABASE_URL`、exec 数据库 URL、`AGENT_REDIS_URL`、`SANDBOX_MCP_REDIS_URL`、replay URL 仍按各进程配置解析，实施必须逐项追到实际工厂；上述新名字不能只出现在 YAML 中。迁移 CLI 的 DBA凭据单独受控输入，不复用生产应用账户。

K8s 以 NetworkPolicy/平台出口规则限制 DBPM、DB Proxy、两套 Redis、exec 和批准的 LLM/MCP；`dbpm_egress` 仅为 Compose 的网络命名，名字本身不提供目的地址过滤。所有实际端口来自运维清单，不凭示例猜测。

## 8. UPRedis、队列切换与放行探针（R7）

保持服务 Redis 与 replay Redis 的实例和凭据隔离。BullMQ 同一环境的全部消费者使用相同 prefix：独占环境实例用 `{bull}`；如果服务 Redis 还被不同部署环境复用，则必须先选择环境独立 prefix（如 `{pi-test-bull}`）并统一配置。hash tag 解决槽位，不提供租户/环境权限隔离。

所有后端节点和故障切换候选配置 `noeviction` 并持久生效。两套 Redis 分别核验；replay 键也不能因淘汰而提前消失。按 [BullMQ 生产建议](https://docs.bullmq.io/guide/going-to-production) 做内存与队列容量告警，满内存的拒写作为依赖故障处理，不能放松 replay 或丢弃账本事件。

改 prefix/Redis 目标前，停止新 Run/cron 准入与 outbox 发布，drain 活跃 Worker，盘点待执行、延迟、失败重试和等待交互的 Run。不能清空 MySQL 中已发布的 outbox 状态来盲目重放全部任务。根据 Run 账本与执行 claim 恢复应投递的非终态引用，保留原幂等键；旧 Worker 完全退出后才启动新 prefix 的消费者，禁止两个 key 空间同时驱动同一批 Run。

历史队列和旧数据库先保留，不立即删除；恢复/重投脚本必须有 dry-run、目标清单与去重验证。若实例经确认为空仍记录空检查结果，不能省略切换步骤的前置判断。

探针分两种结果，不再混用：

1. **能力探测**：旧无 tag 多 key 的预期拒绝、零 key EVAL 限制、缺 LPOS 的版本降级等作为信息/负对照，不自动判产品不可用。
2. **放行测试**：参数化生产 prefix，跑真实 Queue/Worker 的立即/延迟任务、重试、stalled 恢复、取消和状态查询；另验单 key CAS/replay。清理按同 slot 或单 key，逐项核对没有遗留，清理失败不吞掉。

本地 Redis 5.0.14 测试不替代 UPRedis Proxy 测试；版本门槛通过不等于所有命令/阻塞/故障场景可用。压测记录 p95/p99 和任务数，不从单次 20 任务短测推出“性能完全无差异”。

## 9. VM 裸装与健康检查（R6）

### 9.1 发布清单

VM 使用不可变 release 目录，包含 `exec/dist`、`contract/dist`、对应 package/lockfile 和目标 Linux 架构的依赖。原生模块不得从 macOS 搬入。运行用户对发布目录只读，数据目录另设；systemd `WorkingDirectory` 和启动入口指向同一 release。

| 工具面 | 必需落点/验证 |
|---|---|
| Node | 版本遵循 `runtime-versions.json`；服务和 bwrap 内都能运行同版 Node。装到 `/opt` 时必须处理真实二进制 bind 和沙箱 PATH，不能只创建指向不可见目录的软链接 |
| Python | `/opt/pi-python/venv`；Python 3.11 与 `exec/requirements.txt`，显式安装 uv 或提供锁定的等效离线安装流程 |
| JS 办公包 | `/usr/local/lib/node_modules`；按版本钉安装 docx/pptxgenjs，NODE_PATH 与隔离内实际路径一致 |
| Bun / BaoYu | `/usr/local/bin/bun`、两个 BaoYu wrapper、`/usr/local/lib/pi-skill-runtime/` 的脚本及锁定依赖；不是仅全局装 autocorrect 就完成 |
| Chromium | `/usr/local/bin/baoyu-chromium` 保持工具入口稳定；wrapper 指向麒麟真实二进制及依赖。不能照抄 Debian `/usr/lib/chromium/chromium` 假设 |
| 系统工具 | 对照 `exec/Dockerfile` 安装 bash、git、curl、jq、zip/unzip、file、less、rg/fd、pandoc、poppler、qpdf、OCR 中文/英文包、LibreOffice、CJK 字体及 CA |
| 隔离 | bwrap、namespace 与权限；进程有 capabilities 时 setpriv 仍是 fail-closed 必需项；不因裸机而删掉检测 |

完整工具 smoke 必须通过 exec 的生产入口进入 bwrap，生成并打开/渲染 xlsx/docx/pdf/pptx，检查两个 BaoYu wrapper 与浏览器启动。不以宿主 `command -v` 或独立 namespace 脚本代替。

`vm_preflight.sh` 是初筛，实际 profile 以 `buildIsolationProfile()`/`render()` 为准。核验 KySec/SELinux、UID 映射、mount、netns、capabilities、跨 owner 隔离，以及 systemd cgroup 资源上限/子进程清理。失败阻塞 VM 发布，不改 root、不关闭隔离。

### 9.2 启动、停止与探针

统一启动链：取密 → 连接与 UTC → schema 验证 → 必需存储/工具/隔离预检 → exec 孤儿回收（仅 exec）→ 对外就绪。任何失败不得先消费任务或执行孤儿账本修改。

| 进程 | Liveness | Readiness / startup |
|---|---|---|
| frontend | HTTP `/` | 静态内容和配置加载；后端可达性独立观测 |
| BFF | 现有 `/health/live` | 现有 `/health/ready`，确认实际依赖接线 |
| Agent | 现有 `/health` | **现有 `/ready`**；补齐 schema/Skill 预检，不用 `/health` 代替就绪 |
| Worker | 新增仅探针可达的内部 listener；事件循环活性 | DB/Redis/Skill 就绪及 Worker lease/消费循环状态；无任务时仍能健康，不以“最近完成任务时间”判断 |
| facade | 现有 `/health` 的活性语义 | 独立核验 Redis/窄桥就绪；缺少独立 endpoint 时在本阶段补上 |
| VM exec | systemd 进程活性 | LB 用 `/ready` 或同等已接预检状态；同时监控磁盘、挂载、进程与孤儿回收 |

数据库临时不可用影响 readiness，不直接让 liveness 把所有 Pod 同时重启；startup probe 给有限启动预算。Worker readiness=false 本身不会停止 BullMQ，应用还必须暂停取得新任务，失去 lease 时按现有 fence 停止推进。依据 [Kubernetes 探针语义](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)。

> **2026-09-15 实施细化（S2a / S2b）**：
> - Worker：`AGENT_WORKER_PROBE_PORT`（默认 4101）上只有 `/health`、`/ready`，listener 先于容器启动；`/ready` 看启动完成、BullMQ `isRunning()`、未关停，及 MySQL `SELECT 1` / Redis `PING`（各 2s）。SIGTERM 时先置未就绪。「readiness=false 时暂停取新任务」由用户 2026-09-15 决定实施：依赖守卫按 `AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS`（默认 5s）复用 `/ready` 的 ping，连续 2 次失败 `worker.pause(true)`（不等待在跑任务，BullMQ 的 pause 只改本地标志、不依赖 Redis），连续 2 次成功 `resume()`；`/ready` 报 `consumer: paused`。开发栈实测 `pause(true)` 不打断在途的阻塞取任务（暂停后入队的作业仍被执行并以 `needs reconciliation` 失败），因此处理器执行前再检查暂停状态，暂停中 `moveToDelayed` + `DelayedError` 放回队列。Cron / outbox / 恢复扫描不暂停。
> - facade：新增 `/ready` = 服务 Redis `PING` + 执行面 `GET /ready`（不带桥 token）。窄桥没有无副作用探测路由，本次不新增，因此 readiness 不证明桥 token 有效。
> - **已复现的偏差**：执行面 `/ready` 与 `/health` 是同一个恒返回 `{"status":"ok"}` 的处理器（开发栈实测 200），`deployment.md` 所述的 workspace / 数据库 / bwrap 预检 503 并不存在，可追溯到删除 Python 执行面（`f49a5226`）。facade 与 LB 对执行面的就绪判断在修复前都只等于进程可达；修复归入 S2c。
>
> **2026-09-15 实施细化（S2c）**：执行面启动链改为 取密 → 建池 → schema 核对 → **存储根建出 + bwrap 探针（失败拒启）** → 孤儿回收 → listen。`/ready` 每次实时检查数据库 `SELECT 1` 与 workspaces / tmp / artifacts / control 四个根（各 2s），隔离只读启动期结果、不在每次探针中 spawn bwrap；SIGTERM 先置未就绪。共享 Skill 挂载的就绪核对不在本次：用户 Skill 根按清单逐请求核对（S1），挂载标记 / 发布 ID 的启动验证要等 §3.1 共享存储落地后再定。存储检查在挂起的 NFS 上靠超时返回，但 libuv 线程仍可能被占住，目标环境需实测。

Worker SIGTERM：先停止新 claim/调度/消费，再 drain 或按既有可恢复边界中止，最后释放 lease 与连接；宽限时间经真机测试确定。VM 升级先维护窗口、停准入、drain/停止进程再切 release；单 VM 不运行两个 exec 同时争夺本地字节和孤儿回收。

> **2026-09-15 实施细化（S2f，exec release 与 systemd；工具链安装未做）**：
> - release 由 `scripts/vm/build-exec-release.sh` 在目标架构 Linux 容器内构建（依赖含 koffi 原生模块）；布局 `contract/{dist,schema,node_modules}`、`exec/{dist,node_modules}`、`vm/`、`release-manifest.json`、`SHA256SUMS`。安装到 `/opt/pi-exec/releases/<id>`（root 所有、运行用户只读），`current` 符号链接原子切换；数据在 `/var/lib/pi-exec/*`（0700），配置 `/etc/pi-exec/exec.env`。
> - Node 固定 `/usr/local/bin/node`：exec 的 bwrap 静态只读挂载只有 `/usr /bin /sbin /lib /lib64`，子进程 PATH / NODE_PATH 也指向 `/usr/local`。本节表格中「装到 /opt 时处理真实二进制 bind」因此改为不支持 /opt。
> - unit：ExecStartPre 部署检查 → exec 自身启动链；`KillMode=mixed`，停止后 cgroup 内 bwrap 子进程被清理、账本由下次启动孤儿回收收口（容器演练实测）。加固项逐项实测：`RestrictNamespaces`、`ProcSubset=pid` 使 bwrap 失败、exec 拒启；`ProtectKernelTunables`、`ProtectKernelLogs` 在 Debian systemd 252 上兼容，但 openEuler 24.03 systemd 255 上任一项单独开启即让 bwrap 挂不上 procfs、exec 拒启（S2f-2 实测，已从 unit 移除）；`ProtectProc=invisible` 两者均兼容并启用。结果来自特权容器，麒麟上需复测。
> - **发现与决定**：exec 曾在 `EXEC_INTERNAL_ALLOW_CIDR` 为空时不限制内部面来源，而开发 Compose 传入的 `SANDBOX_ALLOWED_CLIENT_CIDRS` 是 Python 执行面时代的变量、TS exec 不读，内部面实际只靠 HMAC。用户 2026-09-15 决定改为空值拒绝：非法 CIDR 拒启，IPv4-mapped IPv6 按 IPv4 匹配，开发 Compose 给默认私网白名单，生产 overlay 必填（见 CHANGELOG）。
> - **工具链（S2f-2）**：`vm/toolchain/install-toolchain.sh` + `toolchain-sources.json`。openEuler 24.03 LTS 官方源（OS / everything / EPOL / update，`repoquery --whatprovides` 核对）没有 ripgrep、fd、pandoc、LibreOffice、Chromium；用户 2026-09-15 决定用上游官方包钉版本 + SHA256（LibreOffice 验 TDF 签名后钉、Chromium 用 Playwright 分发的 Chrome for Testing 并按下载钉）。本节表格「Chromium wrapper 指向麒麟真实二进制」改为指向脚本安装的 `/usr/local/lib/pi-chromium/chrome/chrome`；LibreOffice 官方 RPM 默认 `/opt` 在沙箱中不可见，解包搬到 `/usr/local/lib`。既有问题：`exec/requirements.txt` 未钉版本（镜像同样），VM 安装记录实际版本但不可复现。openEuler 仓库只有 nodejs 20，Node 用官方 tarball。修正 unit 后的 exec 在 openEuler 24.03 容器中启动就绪，Bubblewrap 内工具 smoke 通过（Chromium 按 `baoyu-chrome-cdp` 的 CDP 路径验收；Chrome for Testing 一次性 `--screenshot` 模式在 bwrap 外同样挂起，非产品路径）；沙箱 `/etc` 白名单原不含 `/etc/fonts` 与 RHEL 系 CA 信任库路径（镜像与 VM 均报 fontconfig 缺配置，openEuler 上沙箱内 CA 证书不可读），2026-09-15 已补 `/etc/fonts` 与 `/etc/pki/tls/certs`、`/etc/pki/tls/cert.pem`、`/etc/pki/tls/openssl.cnf`、`/etc/pki/ca-trust/extracted` 五条可缺省只读挂载，不整体挂 `/etc/pki`（证据 `s2f2-openeuler-toolchain-smoke-2026-09-15`、`sandbox-etc-allowlist-fonts-ca-2026-09-15`）。
> - 未做（S2f 当时）：VM 工具链（Python venv、办公 JS、bun / BaoYu、麒麟 Chromium wrapper）安装与完整工具 smoke、麒麟 / KySec / SELinux 实机、release 在 x86_64 上实际运行（本机只验证了 amd64 产物的清单与原生模块架构）、sandbox-mcp 与 Agent / BFF 指向 VM exec 的真实链路。其中完整工具 smoke 与真实链路（登录 → 建会话 → 带工具 Run → 进程 logs/signal → 跨租户 404）已于 2026-09-15 在 openEuler 24.03 容器中补做通过（证据 `s2f2-openeuler-toolchain-smoke-2026-09-15`、`s2f2-vm-exec-real-chain-2026-09-15`）；麒麟 / KySec / x86_64 / 目标 VM 仍未做。

## 10. 开发切换、部署与回退（R5）

MySQL 5.7 使用新命名数据卷，例如 `mysql57_dev_data`，不复用 `mysql_dev_data`。部署前解析实际 `MYSQL_DATA_VOLUME` 并核对旧实例/卷归属；旧 8.0 卷和镜像保留。MySQL 官方不支持 [8.0 降级到 5.7](https://dev.mysql.com/doc/refman/8.0/en/downgrading.html)，因此不做原地换镜像，不执行 `down -v`。

本轮不是业务存量迁移：若切换前发现必须保留的业务数据，停止该切换阶段并补充迁移/对账设计，不宣称新空库初始化完成了迁移。开发数据可由用户选定导出/导入范围，不能替用户清空。

发布前冻结 release manifest：代码 SHA、全部镜像 digest、VM release、Skill release、schema 起止版本、队列 prefix、脱敏配置指纹。DDL 先执行且验证通过，再部署兼容版本的服务；不得一边补表一边开放流量。

回退区分两类：

- **兼容代码回退**：仅在旧代码可运行于新 schema、新队列配置且契约兼容时回退镜像/VM release；不自动执行 migration down，不丢弃新事实。
- **回到旧数据平面**：新环境已有写入时不是简单改 URL。必须停写、确认增量事实/文件/任务如何恢复及可接受数据损失，才能执行。无数据转换方案时阻塞回退，不让旧空库接流量。

单 VM 本地数据、共享 Skill 文件与 MySQL 需有一致的备份/恢复检查点。RPO/RTO、备份位置及恢复演练由运维给出；未确认前不得宣传故障自动无损切换。

## 11. 实施阶段与文档交付

| 阶段 | 实施内容 | 阶段退出条件 |
|---|---|---|
| S0 环境契约 | 共享 export/权限、HTTPS 终止点、LB 注册方式、DB 权限、两套 Redis 参数、VM 体检 | 资源清单与阻塞项有负责人；不能用假环境消掉上线阻塞 |
| D1 数据库兼容 | 新 5.7 数据卷、UTC、outbox/Cron claim、迁移与索引、版本钉/CI | 旧失败先复现，适配后全部相关集成绿；不要单独合入必红的基线降级 PR |
| D2 连接与取密 | 三处生产工厂、Proxy 故障切换、DBPM、角色配置 | 真工厂主故障切备成功、全部失败拒启、无已发送 SQL 重放、无凭据泄漏 |
| D3 手工 schema | 导出/二次重放、manifest、三进程启动验证、DBA 操作步骤 | 首装/增量正确，缺安全对象拒启，合法写入成功，部分失败可定位恢复 |
| S1 Skill 接口与存储 | 共享挂载、系统 release、owner 权限、启用清单/发布一致性接口检查点 | §3.2 接口明确；跨机发现/执行与并发失败测试通过，不能只完成 PVC |
| S2 拓扑落地 | HTTPS、nginx 参数化、slim facade、Worker 探针、VM release/systemd、网络限制 | 实际域名登录、跨 Pod、SSE、上传、完整隔离工具链及新进程健康通过 |
| D4 UPRedis 放行 | prefix 全消费点、noeviction、正负探针、切换/drain/恢复流程 | 真实 Proxy 上队列故障恢复和 replay 校验通过；无遗留 probe key |
| G 最终验收 | 重建开发容器 + 真实双集群/VM 部署验收 | 下表所有相关门槛有新证据，剩余环境阻塞明确列出 |

每阶段按一件事组织 PR，相关文档随行为变更同步，不把文档更新拖到最后才做。新增/变更路由同步 `api.md`；配置、启动与拓扑同步 `deployment.md`/`development.md`/runbooks；用户行为同步 `webui.md` 与 CHANGELOG。`STATUS.md` 只随实际实现/证据改变，不因 design 完成翻绿。

## 12. 验收矩阵与未决项

| 门槛 | 必须提供的运行证据 | 关联复审 / STATUS |
|---|---|---|
| T1 Skill 跨机 | VM→A启用→B发现→VM执行、换 Pod、存储断开、并发启停、摘要/账本不一致拒绝、跨 owner 404 | R1；A2、H1/H3 |
| T2 浏览器入口 | 实际 HTTPS 域名登录、刷新、登出，Cookie/SSE/上传；代理重连到另一集群 | R2；D1/D4、G1 |
| T3 抢占 | 真正重叠事务、超时/死锁、claim/commit 崩溃、重复投递、cron 策略与手动竞争 | R3；B1/B2、G2/G4 |
| T4 Schema | 导出二次重放、正确库正对照、版本完整但缺对象拒启、DDL 中断恢复、最小权限 | R4；B1/B4 |
| T5 数据面切换 | 新卷与旧卷隔离、任务 drain/恢复、旧消费者退出、回退预检 | R5；G3/G4 |
| T6 VM | 真生产入口的 bwrap/办公工具/浏览器、进程 logs/signal、SIGKILL 后孤儿回收、磁盘/权限拒绝 | R6；C4/C6/C7、G7、H4 |
| T7 UPRedis | 正确 prefix 真 Queue/Worker、延迟/重试/stalled、单 key CAS、防重放拒绝与合法调用对照 | R7；B2、G2/G3 |
| T8 DBPM/Proxy | 三角色正常启动、第一端故障、全故障、半帧/超时、池扩容UTC、commit响应丢失无写重放、错误脱敏 | H5、G2/G4 |

代码最终交付仍按 AGENTS.md §4：六套测试、各包类型检查、前端 build、Compose 校验；同时设置 `TEST_MYSQL_URL` / `TEST_REDIS_URL`，CI release gate 对应集成用例缺配置应失败而非 skip。容器代码变更须重建所有共享镜像消费者；VM 单独安装目标 release，不能以重建 Docker 证明裸机已更新。

真实链路包括登录 → 建会话 → 带工具 Run → 进程 logs/signal → 跨租户 404；追加上述专项。记录代码/dirty 状态、runtime、命令、实际结果、镜像/VM/Skill release、替身边界及跳过原因。只新增日期证据，不改写历史探针输出。

| 待落实项 | 当前状态 / 负责人 | 阻塞范围 |
|---|---|---|
| 共享存储 export/CSI/ACL 与 POSIX 语义 | 可提供已确认；存储/平台团队落实参数 | S1 实际联调及多副本上线 |
| HTTPS 域名/证书/终止点 | 用户同意按 HTTPS 设计；平台团队待配置 | S2 浏览器生产验收 |
| A2A 路径隔离与 LB 后端注册 | 平台/安全团队确认现有能力 | A2A 外部开放 |
| VM 到位、隔离、规格、软件源与 systemd 权限 | 运维；尚无新体检输出 | VM 上线与 T6 |
| 生产 DB 元数据可见性/DDL 执行权限分离 | DBA；特别确认触发器正文验证 | D3 目标验收 |
| 两 Redis 的 noeviction/持久化/路由与 DBPM 条目 | Redis/DBPM 运维 | D2/D4 目标验收 |
| LLM 内网地址、认证、MCP 清单 | 应用/平台；无默认公网回退 | 模型真实链路 |
| 维护窗口、密码变更通知、备份恢复 RPO/RTO | 应用/运维协作确认 | 首次生产切换 |

本次文档修订完成不等于这些资源与接口检查点已完成。可以先做不依赖目标环境的设计/兼容实现，但不能把未决事项统一标为“均不阻塞”。
