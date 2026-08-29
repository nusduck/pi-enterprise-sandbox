# ADR 0008: 执行面用 TypeScript 重建，隔离层建模为数据

| 字段 | 值 |
|---|---|
| 状态 | Proposed |
| 日期 | 2026-08-29 |
| 决策所有者 | Sandbox isolation maintainers |
| 适用范围 | 新增 `exec/` 包（TS）；`sandbox/` Python 包收敛后删除 |
| 关联决策 | [ADR 0004](0004-session-persistent-tmp.md)（不变，本 ADR 为其提供更强的验证形态）、[ADR 0006](0006-user-skill-enablement-gate.md)（P1 (A) 的落点）、[ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)（同批交付、同批部署） |
| 详细设计 | **[docs/design/dsh-rebuild.md §5](../design/dsh-rebuild.md)** |
| 不变量 | **隔离机制仍是 Bubblewrap。** 本 ADR 不更换隔离技术 |

## 本 ADR 相对早期草案的变化

早期草案是"在 Python 里补齐 `ctx.fs` 的 12 个基础操作，并自己实现文件版本"。
[ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) D1 决定全栈统一 TypeScript 后，
**这份草案的主体工作消失了**。

`dsh-fs-local` 是 `ctx.fs` 的本机实现，逐条核实它**已经提供**：

| 早期草案要自己写的 | 上游现状 |
|---|---|
| 文件版本（决策 4，"本 ADR 最大的新概念"） | `dev:ino:size:mtimeNs:ctimeNs` 的不透明编码，已实现 |
| 原子写 | 写进同目录下随机命名私有暂存目录（`0o700`）里的独占临时文件（`wx`, `0o600`），fsync 后发布，保留原权限位 |
| `createIfAbsent` 的抢占语义 | 硬链接发布，抢先创建者被保留 |
| `editText` 的版本守卫与临界区 | 按目标加锁，版本在字面匹配**之前**校验 |
| `FS_*` 结构化错误码 | 全套已有 |
| `lstat` / `streamText` / `resolve` / `contains` | 全部已有 |

**因此早期草案的决策 3（路径解析收敛）、决策 4（文件版本）、决策 5（内部面重写）
大部分从"要写"降级为"要包一层"。** 本 ADR 只保留真正还需要我们做的部分。

## 决策

### D1：`WorkspaceFileSystem extends LocalFileSystem`

继承全部 12 个基础操作与上述机制；**只覆盖**租户根解析与写入前的 containment 复查。

上游明确的两条限制正是我们要补的：

1. **`config.cwd` 不是沙箱** —— 绝对路径和 `..` 能逃出去，containment 要自己加。
   做法上游也给了：`dsh-fs-sandbox` 就是同样 `extends LocalFileSystem` 再加模式围栏。
2. **按目标的互斥锁只在进程内有效** —— 见 D5。

保留的既有安全性质**逐条不减**：拒绝 `..`、拒绝 home 展开、拒绝盘符、拒绝其它绝对根、
符号链接解析后的越界检查、错误文本里物理根一律 `<workspace>`。

**不宣称消除 TOCTOU**（今天 `enforce_path_within_workspace` 的 docstring 已明写接受该竞态），
但"写入前紧邻再规范化校验"定为写路径的必须动作——与 `dsh-fs-sandbox` 的同名做法一致。

### D2：可写根是单一事实源

新增 `writableRoots(ctx)`。`MountPlan` 的可写 bind **由它派生**，文件 API 的围栏
**也由它派生**，两者不得各算一遍。

这条直接抄自上游 `dsh-fs-sandbox`，理由原文是 "so the fs fence and the bash runner
cannot drift"。**这条纪律我们今天没有**——`preflight()` 手抄了 `prepare()` 的一个子集，
两者的 `--dir` 列表已经不同（`preflight` 没有 `/run`、`/var`、`/etc`、`/app`）。

### D3：隔离配置建模为数据，单一渲染函数

```
IsolationProfile
├── NamespacePlan  namespaces / uid,gid / as_pid_1 / die_with_parent / cap_drop
├── MountPlan      有序 Mount[]：kind ∈ {ro_bind, bind, dir, proc, dev, tmpfs}
│                  required=true  → 源缺失即失败（今天的 --ro-bind）
│                  required=false → 仅 ENOENT 可恕（今天的 --ro-bind-try）
├── EnvPlan        clearenv + 键值
└── LaunchPlan     argv / cwd / nproc 包装
```

`render(profile) → argv` 是**唯一**把 profile 变成 bwrap 参数的函数。由此得到三条
今天没有的性质：

- **`preflight()` 渲染同一个 profile**，只替换 argv 为探针命令并剔除会话特定挂载。
  探测与执行的分叉**由构造消除**，不再靠人同步两份列表
- **可断言**：测试直接对 `MountPlan` 断言，不再字符串匹配 argv
- **`required` 的语义进类型**：今天 `--ro-bind-try`"只宽恕 ENOENT、不宽恕 EACCES"
  这条重要且易错的性质靠注释解释，现在变成可测的类型

**采用 DSH 的模式词汇**（`read-only` / `workspace-write` / `danger-full-access`），
**不采用它的实现**——`dsh-sandbox-local` 是单用户同世界，我们要多租户绑定 + 断网 fail-closed。

Bubblewrap 的既有安全性质一条不减：`--unshare-user/pid/ipc/uts`、私有 procfs、
`--cap-drop ALL`、`setpriv` 能力剥离、netns fail-closed、in-namespace nproc。

### D4：Skill 绑定从"整目录"改为"启用集的函数"

`_skill_binds()` 今天把调用者的整个 `<org>/<user>` 目录 `--ro-bind-try` 进去。
[ADR 0006](0006-user-skill-enablement-gate.md) P1 的分水岭条款 (A) 要求"启用态必须
控制**绑定**，不能只控制 prompt 列表"——未启用的包躺在挂载里就照样能被
`python <skill>/<pkg>/scripts/x.py` 执行，而 `bash` 不审批。

改为逐包 `ro_bind`，未启用的包**根本不在挂载里**，(A) 由构造成立。

保留今天那条来之不易的健壮性：**单个包挂载失败不得让整个 bwrap 起不来**，
否则一个坏包会让用户连 `pwd` 都用不了。

**本 ADR 只提供机制，不代替 ADR 0006 P1 做决策。** 落地前实参传"该用户已安装的全部包"，
行为与今天等价。

### D5：前期单实例，多实例扩展点现在就预留

`dsh-fs-local` 明说按目标的互斥锁只在进程内有效。今天 Python 版有
`SANDBOX_UVICORN_WORKERS`，多进程下这个锁不成立。

**决策：`exec/` 单进程 + `worker_threads`，不开多进程 HTTP worker。**
进程内锁因此完整有效。跨实例的兜底本来就在：`createIfAbsent` 用硬链接发布、
`replaceIfVersion` 靠版本守卫，两者都不依赖进程内锁。

**预留（现在就写进代码，不是以后再说）**：

1. 所有内部端点的请求信封**必带 `workspace_id`**，将来加一致性哈希路由不用改接口
2. 加锁抽象成 `WorkspaceLock` 接口，进程内实现是默认；换 MySQL 咨询锁只换实现
3. **启动时断言进程数为 1**，多实例部署必须显式开开关——防止有人悄悄加副本导致静默丢写

### D6：内部面按接缝重写，不做并存过渡

内部 fs / exec 面的**唯一消费者**是 `agent/src/infrastructure/sandbox/` 里的
`internal-files-read/write-http.js`、`internal-execution-http.js`、`internal-process-http.js`、
`internal-search-http.js`——**这些文件全部在 [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)
的重写范围内**。`api-server/` 完全不接触内部面。

> **口径收紧**：早期草案写的是"内部面唯一消费者"，太宽。内部面下还有
> `sessions` 与 `artifacts` 两组，以及走另一条 bridge 的 `sandbox/mcp/`，
> **它们不在本次重写范围内**。准确的说法是"**fs / exec / search 面**的唯一消费者"。

因此内部面的向后兼容**没有受益人**，并存过渡是纯成本。因为两侧同为 TS，
端点与 `ctx.fs` 的方法一一对应，请求/响应类型直接来自 `contract/` 包。

**公共面**（upload / download / preview / dataset / 会话进程）**对 BFF 的契约逐字节不变**，
只换实现语言——这是 `api-server/` 与 `frontend/` 零改动的依据。

### D7：作业管理自建，不用 `dsh-jobs-local`

`dsh-jobs-local` 全部记录在内存里，重启即丢，不满足"Worker 重启后仍能查到进程"。
自建 `MySqlJobRegistry` 实现 `dsh-jobs` 的登记契约。

保留今天已有且正确的部分：增量读游标（连续读不重复返回，丢数据时标记——形状与上游
`ShellProcess.readOutput()` 完全一致）、孤儿进程检测、归属校验、stdin 写入、信号发送。

### D8：内部认证简化

保留 HMAC 签名 + 请求体摘要与入站 CIDR 白名单；
**去掉防重放 jti 及其专用的 `sandbox-replay-redis` 实例**——内部网络不对外，
一个独立 Redis 实例换不来相应收益。

### D9：[ADR 0004](0004-session-persistent-tmp.md) 不变，且获得更强的验证形态

Session 私有、跨 Run 持久的 `/tmp` **语义一字不改**。区别只是它从 `prepare()` 里的
一对 `--bind` 参数变成 `MountPlan` 里一条可断言的 `Mount`。
`_persistent_home_binds()` 的 XDG 三个子目录同理。

### D10：`skill-runtime/` 是运行时资产，原样保留

`sandbox/skill-runtime/` 不是空目录，是三个 shell 启动垫片
（`baoyu-chromium`、`baoyu-format-markdown`、`baoyu-markdown-to-html`，提交 `c4923703`）。
它们存在的原因写在自己的注释里：Bubblewrap 子进程只暴露一个很小的 `/etc` 白名单，
而 Chromium 的 Debian 启动器要读 `/etc/chromium.d/*`。

**跟着 `exec/` 的镜像走，Dockerfile 里对应的安装步骤一并迁移。**

## 取舍

- **接受**：`version` 是乐观锁，不是完整性凭证。它防并发编辑与 stale write，不防篡改
- **接受**：不消除 TOCTOU（与上游同一判断；内核级紧密边界需要 `openat2` 类原语，
  可移植性代价不值）
- **接受**：内部契约一次性断裂，两个 P0 必须同批部署。**研发阶段，无回退目标**
- **接受**：用 TS 重写 36k 行 Python 的等价性风险。缓解：逐 Wave 把现有 pytest 用例
  改写成 TS 用例做对照，**隔离与路径安全的用例一条不减**
- **拒绝**：更换隔离技术。Bubblewrap 的既有安全性质一条不减，只改表达方式
- **拒绝**：把 `version` 做成内容哈希。读大文件只为取版本的成本不可接受
- **拒绝**：动公共面。它有真实的外部消费者（BFF → 浏览器），与内部面的"零受益人"
  情况完全不同

## 验证要求

1. **plan 断言**：`MountPlan` 中可写挂载恰为 `writableRoots()` 的结果；skill 层全部
   `ro_bind`；`/tmp` 恰好绑定当前 Session 的物理 temp
2. **preflight 同源**：断言 `preflight` 与 `prepare` 渲染自同一 profile
3. **`targetKey` 稳定性**：同一文件经相对路径、绝对路径、含 `.` 的拼写、经符号链接
   抵达，必须产出同一 `targetKey`
4. **版本守卫**：`createIfAbsent` 竞态下抢先创建者被保留；版本不匹配返回
   `FS_STALE_VERSION`；`editText` 在**匹配之前**校验版本；并发编辑同一文件不丢写
5. **单实例断言**：进程数 > 1 时启动失败（D5）
6. **既有安全不回归**：`tests/test_path_validation.py`、`test_bubblewrap_isolation.py`、
   `test_child_workspace_quota.py`、`test_workspace_manager.py` 全部改写为 TS 用例并通过，
   **一条不减**，补 `lstat` 的符号链接拒绝用例
7. **错误面不泄漏**：所有 `FS_*` 错误消息经 `redact()`，断言无物理根残留
8. **skill 绑定**：未启用（或未安装）的包不在挂载中；单包挂载失败不影响其余工具可用
9. **公共面契约不变**：BFF 侧用例零改动通过
10. **真实链路**（AGENTS.md §4）：重建镜像后跑通
    [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) 的验证要求

## 影响

- [ADR 0004](0004-session-persistent-tmp.md) **不变**，验证形态增强（D9）
- [ADR 0006](0006-user-skill-enablement-gate.md) **不变**；D4 提供其 P1 (A) 所需的挂载机制
- [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)：本 ADR 与其**同批交付、同批部署**
- **`api-server/`、`frontend/` 无改动**
- `sandbox/` Python 包整个删除（35,958 行）；`sandbox/skill-runtime/` 的三个垫片迁入 `exec/`
- `sandbox/mcp/`（1,192 行）**本次不动**，Wave 6 之后单独补齐
- 需更新：`docs/architecture.md`、`docs/api.md`、`docs/module-layout.md`、`docs/sandbox-mcp.md`
