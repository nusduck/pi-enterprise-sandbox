# 沙箱内连接业务数据库（数据源，设计稿）

本文档约束「数据源」能力：**模型在沙箱里写 Python/SQL 连接业务库做数据分析**，
库由运维登记、由管理员按智能体绑定；口令由 exec 从 DBPM 取；沙箱子进程**仍然没有网络**，
只通过 exec 转发的 unix socket 到达登记过的那几个库。

状态：一期已实施（2026-09-26，分支 `feat/sandbox-data-sources`）。真实链路记录见
[evidence/sandbox-data-sources-live-2026-09-26.md](../evidence/sandbox-data-sources-live-2026-09-26.md)。
与本稿初版的差异：§4.3 的目录端点没有做，改为 Agent 读同一份 `SANDBOX_DATA_SOURCES_JSON`（原因见 §4.3）。

---

## 0. 一句话

运维登记数据源目录（`SANDBOX_DATA_SOURCES_JSON`：库地址 + DBPM 条目，不含口令；exec 与 Agent 读同一份）；
管理员在 AgentVersion 的 `dataSources` 里勾选本智能体可用的数据源；Agent 随每个内部 shell 请求
把这份清单交给 exec（与 `enabledSkills` 同一条 HMAC 覆盖的通道）；exec 为这次执行建 unix socket、
bind-mount 进 bwrap，并把连接参数与口令注入子进程环境。子进程保留 `--unshare-net`。

---

## 1. 已核实的事实（请复现）

```bash
# 子进程默认空网络命名空间：disabled 时加 'net'，render 输出 --unshare-net
sed -n 259,290p exec/src/isolation/build.ts
grep -n "unshare-net" exec/src/isolation/render.ts

# SANDBOX_NETWORK_MODE 在 exec 的 TS 源码里没有读取方：networkMode 没有调用方传值，恒为 disabled
grep -rn "networkMode" exec/src --include='*.ts' | grep -v test

# 现有的 env 注入通道：SANDBOX_EXEC_ENV_<NAME> 透传；拒绝清单按子串 PASSWORD 等拦截，
# 但 .env.example 的示例用 *_DB_PWD，不含这些子串，明文口令可以直接进子进程
sed -n 55,80p exec/src/shell/safe-env.ts
sed -n 480,498p .env.example

# DBPM 协议没有客户端认证：发「库名 + 用户名」即回口令
sed -n 9,12p scripts/dev/fake-dbpm.mjs
grep -n "export async function fetchDbpmPassword" contract/src/dbpm.ts

# 按智能体下发给 exec 的现成通道：enabledSkills 随请求体进 body_sha256，受 HMAC 覆盖
sed -n 1,12p contract/src/skill-manifest.ts
grep -n "enabledSkills" agent/src/runtime/providers/exec-rpc.ts exec/src/http/internal-shell.ts
```

推论：

- **不能靠 VM iptables 白名单放行子进程。** 子进程要连库就得共用 exec 的网络命名空间；
  非特权 bwrap 把子进程映射回 exec 的真实 uid，iptables 的来源 IP 与 `--uid-owner` 都区分不了
  exec 与模型代码。白名单只能是「业务库 ∪ DBPM ∪ UPDRDB」，而 DBPM 没有客户端认证，
  模型代码可以直接取到 UPDRDB 口令，读写全部租户的账本（破坏 AGENTS.md §2 跨租户隔离）。
- 按路径的 unix socket 走文件系统，不受网络命名空间限制；bind-mount 进 bwrap 后，
  断网的子进程仍能 `connect()`。这是本设计的挂载点（实施第一步用测试复现，见 §8）。

---

## 2. 目标与非目标

目标：

- G1 模型在沙箱里用常见客户端（pymysql、SQLAlchemy、`mysql` CLI）连接业务库查询。
- G2 数据源**按智能体授权**，随 AgentVersion 版本化；运行中的 Run 使用它启动时的那一版。
- G3 口令只来自 DBPM，不出现在配置、日志、账本与文档里。
- G4 沙箱子进程的网络隔离不变：DBPM、UPDRDB、内网其他服务对子进程不可达。

非目标（一期）：

- 按用户的行级/库级授权。一期授权粒度是「智能体」：能用该智能体的人，都能让模型查它绑定的库。
- 口令不进沙箱（转发器代做认证）。需要实现 MySQL 认证握手，列为二期（§9）。
- sandbox-mcp 对外 MCP 入口使用数据源：外部 `context_id` 没有智能体身份，窄桥不接受该字段。
- PostgreSQL 等其他引擎：`engine` 字段预留，一期只做 `mysql`。

---

## 3. 数据模型

### 3.1 运维登记：数据源目录（exec 进程环境变量）

```jsonc
// SANDBOX_DATA_SOURCES_JSON —— 只含占位符的示例
[
  {
    "id": "employees",                 // ^[a-z][a-z0-9_]{0,31}$，也是环境变量名的一部分
    "label": "员工库（只读）",
    "description": "HR 员工主数据，按月快照",
    "engine": "mysql",
    "endpoint": "<db-host>:3306",      // 转发目标，写死；模型不可改
    "database": "<database>",
    "dbpmDbName": "<dbpm-entry-name>", // DBPM 条目
    "userName": "<readonly-user>"      // 必须与 DBPM 条目用户一致
  }
]
```

校验（启动期，任一失败拒绝启动）：

- `id` 唯一、格式合法；`endpoint` 可解析为 `host:port`；`engine` 在支持集合内。
- 出现 `password` / `pwd` / 任何含口令的键 → 拒绝（与 UPDRDB 同一 fail-closed 规则）。
- 配了数据源但缺 `DBPM_URL` → 拒绝。
- 生产环境下，`SANDBOX_EXEC_ENV_*` 里键名含 `PWD`/`PASSWD`/`PASSWORD` → 拒绝启动，
  堵住 §1 里明文口令的旧通道（开发环境告警）。

### 3.2 管理员绑定：AgentVersion `dataSources`

```jsonc
{ "dataSources": [{ "id": "employees" }] }
```

- 新增顶层键，进 `agent-config-validator.ts` 的白名单；条目只允许 `id`，
  禁止 `endpoint`/`userName`/`password` 等连接材料（与 MCP 条目禁连接材料同一原则）。
- 保存时校验 `id` 在目录里（`DATA_SOURCE_UNKNOWN`）；目录来源见 §4.3。
- 条目对象形式为后续按数据源的选项（例如只读语句限制）预留位置。

---

## 4. 运行链路

### 4.1 Agent → exec

Run 启动时由 AgentVersion 得到 `dataSources: ["employees"]`，与 `enabledSkills` 并列放进
每个 `/internal/v1/shell/*` 请求体（GET 走同样的 base64url query 规则）。只传 id，不传连接材料。
在 `contract/` 新增 `parseEnabledDataSources`（形状校验、条数上限、去重）。

### 4.2 exec 为一次执行挂载

1. 解析清单；任何 id 不在目录里 → 400 `DATA_SOURCE_UNKNOWN`，**不执行**（fail-closed，不静默忽略）。
2. 在控制面目录下为本次执行建 `<controlRoot>/db-sock/<executionId>/<id>/mysql.sock`（0700 目录），
   每个 socket 由 exec 进程内的转发器监听。
3. bwrap 追加 `--ro-bind <controlRoot>/db-sock/<executionId> /run/dsh-db`。其他挂载不变，
   仍然 `--unshare-net`。
4. 注入环境变量（在 safe-env 过滤之后由执行器合并，保留前缀 `DSH_DB_`；模型经 shell `env`
   参数传入的 `DSH_DB_*` 键一律拒绝）：

   ```
   DSH_DB_SOURCES=employees
   DSH_DB_EMPLOYEES_SOCKET=/run/dsh-db/employees/mysql.sock
   DSH_DB_EMPLOYEES_DATABASE=<database>
   DSH_DB_EMPLOYEES_USER=<readonly-user>
   DSH_DB_EMPLOYEES_PASSWORD=<来自 DBPM>
   ```

5. 进程树结束（前台返回、后台 job 结束/取消/超时、spawn 失败）时关闭监听、删除目录。
   每一条出口都要收口，复用 `guarded-execution.ts` 已有的结束钩子。

### 4.3 数据源目录（Agent 侧）

初版计划由 Agent 调 exec 的 `GET /internal/v1/data-sources`。实施时发现内部面的 HMAC 令牌与 Run 绑定
（`run_id` 与 fence 必填，只有 `session.ensure` 有预运行特例），为一个目录查询再开一个特例不值得。
改为：目录解析放在 `@dsh/contract/data-sources.js`，exec 与 Agent 读同一份 `SANDBOX_DATA_SOURCES_JSON`、
走同一套校验。Agent 只投影 `{ id, label, description, engine }`，进 config-options 的
`platformConstraints.dataSources`，并在配置面诊断与保存时核对 id。两侧配置漂移时，exec 在执行前拒绝
（`DATA_SOURCE_UNKNOWN`），不会放行。代价：Agent 看不到某个库「取密失败」这一运行态，只能在执行时由
exec 返回 `DATA_SOURCE_UNAVAILABLE`。

### 4.4 转发器

- 纯字节转发：socket 上每来一个连接，exec 向登记的 `endpoint` 建一条 TCP 连接，双向 pipe。
  不解析、不改写协议。
- 目标只来自目录；转发器没有「由客户端指定目标」的入口。
- 限额（均可配置，均有默认值）：建连超时、空闲超时、单次执行并发连接数、单数据源全局并发数。
- 审计日志（结构化，无内容）：Run / 会话 / 数据源 id / 开始结束时间 / 上下行字节数 / 关闭原因。
- VM iptables：只需放行 exec → 各数据源 `endpoint`，与子进程无关。

### 4.5 口令获取

- exec 启动时对目录里每个数据源调用 `fetchDbpmPassword`，口令只留在进程内存，
  与 UPDRDB 同一套规则（不写 `process.env`、不落盘、不打印）。
- 某个数据源取密失败：该数据源标记不可用，引用它的执行返回 503 `DATA_SOURCE_UNAVAILABLE`；
  不影响 exec 启动与其他数据源（平台本身不依赖业务库）。待评审：是否改为拒绝启动。
- 口令轮换：见 §10 待定项。

### 4.6 输出脱敏

子进程可以 `print(os.environ[...])`。一期措施：执行器对 stdout/stderr 及工具结果做
**已知口令的精确替换**（`***`），尽力而为，挡住误打印；不防刻意编码后外带。
根本措施是二期的「口令不进沙箱」。

---

## 5. 前端

智能体设置页新增「数据源」tab：从目录多选；目录加载失败显示错误而不是空列表；
保存沿用现有版本冲突处理。只显示 `label`/`description`，不显示地址与账号。

---

## 6. 安全论证

| 风险 | 处理 |
|---|---|
| 模型代码访问 DBPM / UPDRDB / 内网 | 子进程无网络；只有 `/run/dsh-db` 下的 socket |
| 模型改转发目标 | 目标写死在目录；socket 只有一个去向 |
| 伪造数据源清单 | 清单在 HMAC 覆盖的请求体里，只有持内部面凭据的 Agent 能发 |
| 未授权智能体使用数据源 | 清单来自该 Run 固定的 AgentVersion；exec 只挂清单里的 |
| 口令泄露 | 只读账号；输出精确脱敏；日志与账本不含口令；二期去掉口令 |
| 执行结束后 socket 残留 | 各出口统一回收；孤儿回收时清空 `db-sock/` |
| 数据量过大拖垮执行面 | 转发器并发/空闲限额 + 现有工作区配额与超时 |

保留的风险（一期接受，需评审确认）：拿到智能体使用权的用户，可以让模型读出该只读账号的口令。

---

## 7. 替代方案

- **A. 子进程共用网络 + VM iptables 白名单。** 代码最少，但 §1 推论：区分不了 exec 与子进程，
  模型可经 DBPM 取到 UPDRDB 口令。仅当 DBPM 能按来源 IP 限制可取条目、且 exec 不再从本机
  取 UPDRDB 口令时才成立。不采用。
- **B. 子进程使用独立内核 uid（subuid + newuidmap），iptables 按 `--uid-owner` 放行。**
  可行，但要改 bwrap 建命名空间的方式，工作区文件属主变化需要 ACL，需在目标 OS 上重新验证。
  改动面大于本方案。不采用。
- **C. 独立网络命名空间 + veth/slirp。** 需要 `CAP_NET_ADMIN` 或额外用户态网络栈，违背非 root 运行。不采用。
- **D. 以 MCP 工具提供查询（模型只发 SQL）。** 口令不进沙箱，但做不了「拉数据到 pandas 里分析」
  的主场景，可与本方案并存。

---

## 8. 实施顺序与验收

（1–6 已完成，见文首证据链接。）

1. **复现挂载点**：隔离层测试证明 `--unshare-net` 的子进程能连 bind-mount 进来的 unix socket，
   且连不上任何 TCP 地址（含 DBPM 与 UPDRDB 地址）。
2. contract：`parseEnabledDataSources` + 测试。
3. exec：目录解析与启动校验、DBPM 取密、转发器、挂载与 env 注入、回收、脱敏（目录解析放 contract，两侧共用）；
   `.env.example` / `deployment.md` / `api.md` 同步。
4. agent：`dataSources` 校验、Run 固定清单、`exec-rpc` 下发；读同一份目录做校验与 options 投影。
5. frontend：数据源 tab。
6. 真实链路（重建容器）：Compose 里起一台业务 MySQL + dbpm-fake 条目。
   - 绑定了数据源的智能体：模型用 pymysql 查到数据；
   - 未绑定的智能体：环境变量与 `/run/dsh-db` 都不存在；
   - 同一次执行里 `nc <dbpm> <port>`、连 UPDRDB 地址均失败；
   - 输出中的口令被替换为 `***`；
   - 后台 job 结束后 socket 目录已删除；
   - 跨租户 404 不变。

---

## 9. 二期

- 转发器代做 MySQL 认证（沙箱内用一次性令牌或免密连接），口令不进沙箱。
- 按用户/部门的数据源授权（依赖部门与角色模型的设计）。
- 只读语句限制（在代认证的基础上解析协议）、查询审计。

---

## 10. 待定项

- ~~业务库是否强制 TLS~~ —— 已定（2026-09-26）：不强制。转发器保持纯字节转发，不做出口 TLS。
- ~~DBPM 口令是否轮换~~ —— 已定（2026-09-26）：不轮换。exec 启动时取一次；万一人工改口令，重启 exec。
- 单个数据源取密失败时，exec 是继续启动（本稿默认）还是拒绝启动。
- `SANDBOX_NETWORK_MODE` 未接线（§1）属于文档与代码漂移，与本设计无关，另开 PR 处理：
  要么接线并按生产约束拒绝非 `disabled`，要么从文档与 Compose 中删除。
