# 功能清单（换引擎前的现状盘点）

> **这不是当前状态。** 盘点基线是换引擎前的 `main` @ `4dda7a9b`（2026-08-29）。
> 路径里的 `extensions/`、`infrastructure/pi/`、`sandbox/` Python 面在
> `refactor/dsh-rebuild` 上已经不存在。当前结构见
> [`architecture.md`](./architecture.md)、[`module-layout.md`](./module-layout.md)，
> 进度见 [`design/waves/HANDOFF.md`](./design/waves/HANDOFF.md)。
> 保留这份清单是为了对照「换之前有什么」，不要当施工图。

**这份文档当时回答的问题：换引擎前这套系统会做哪些事？**

写它的原因：[ADR 0007](adr/0007-agent-runtime-rebuild-on-dsh.md) 要换掉 Agent 的引擎，
[ADR 0008](adr/0008-sandbox-isolation-and-fs-seam-redesign.md) 要跟着改沙箱的接口。
换之前必须先有一张"现在有什么"的单子，否则上线才发现少了东西。

盘点方式：直接读代码和路由表，不是抄旧文档。基线 `main` @ `4dda7a9b`，日期 2026-08-29。

**最后一栏的意思：**

- **不动** — 这次换引擎碰不到它
- **要改** — 逻辑保留，但代码要重写一遍
- **重做** — 现在的做法作废，要按新引擎的方式重来
- **待定** — ADR 里还没说清楚，见文末

---

## 一、Agent 服务：负责"想"

它是对话的大脑：收用户的话、调模型、决定用哪个工具、把结果吐回去。跑在 Node 上，
一个 HTTP 进程 + 一个后台 Worker 进程。

### 1. 对话与消息

| 功能 | 说明 | 影响 |
|---|---|---|
| 建对话 / 列对话 / 删对话 | 一个对话 = 一次持续的聊天，里面有多轮问答 | 不动 |
| 自动起标题 | 用第一句话生成对话名，最长 500 字 | 不动 |
| 消息落库 | 每一句话（用户的、模型的）都存 MySQL | 不动 |
| 子对话隐藏 | 子 Agent 产生的对话不出现在列表里，但按 id 还能查到 | 不动 |

代码：`application/conversation-service.js`、`conversation-title.js`

### 2. Run：一次回合

用户发一句话 = 一个 Run。这是整个系统最核心的对象。

| 状态 | 人话 |
|---|---|
| ACCEPTED | 收到了，还没排上队 |
| QUEUED | 在队列里等 Worker |
| STARTING / RUNNING | 正在跑 |
| WAITING_APPROVAL | 卡住了，等人批准某个危险操作 |
| WAITING_INPUT | 卡住了，模型在问用户问题 |
| CANCELLING | 用户按了取消，正在停 |
| RETRYING | 失败了，准备重试 |
| SUCCEEDED / FAILED / CANCELLED | 结束（三种结局） |

关键性质：**这些状态只认 MySQL**。Redis 只是加速，清空 Redis 不丢事实。

| 功能 | 说明 | 影响 |
|---|---|---|
| 创建 Run | 带幂等键，同一请求重发不会跑两遍 | 不动 |
| 查 Run / 查工具调用记录 / 查事件 | 三个只读接口 | 不动 |
| 取消 Run | 写一条"取消意图"到 MySQL，跑着的 Run 每步都检查它 | 要改（取消怎么传到新引擎里没定） |
| 中途插话（steer） | Run 跑着的时候用户补一句，Worker 重启也不丢 | 要改 |
| 追问（follow-up） | 在同一个对话里开一个新 Run，排在当前 Run 后面 | 不动 |

代码：`domain/run/`、`application/create-run-service.js`、`execute-run-service.js`、
`cancel-run-service.js`、`steer-run-service.js`、`durable-steer-controller.js`

### 3. 排队与后台执行

| 功能 | 说明 | 影响 |
|---|---|---|
| 任务队列 | BullMQ，队列名 `agent-runs`。HTTP 收请求，Worker 真跑 | 不动 |
| Worker 租约 | 一个 Run 同时只能被一个 Worker 拿着（30 秒租约，10 秒续一次） | 不动 |
| 会话锁 | 同一个对话的多个 Run 串行，不并发 | 不动 |
| 事件外发（Outbox） | 状态变更和事件写进同一个数据库事务，再异步推 Redis，保证不丢 | 不动 |

代码：`infrastructure/redis/`、`infrastructure/outbox/`

### 4. 崩溃恢复

这块是企业级要求里最重的一部分，也是最容易在重写时漏掉的。

| 功能 | 说明 | 影响 |
|---|---|---|
| Run 恢复 | Worker 崩了以后扫 MySQL 里没结束的 Run，按状态分别处理：能重排的重排，工具调用状态不明的**不敢重跑**，留人工处理 | 不动（但要接新引擎） |
| 会话恢复 | 重建模型的对话上下文。优先用快照，快照坏了就从消息流水重建，两个都不行就标记为需要人工介入 | **重做**（快照格式跟着引擎走） |
| 停泊 Run 的取消回收 | 卡在"等审批"和"等用户回答"的 Run，被取消时也要能回收 | 要改 |
| 执行栅栏（fence） | 防止旧 Worker 复活后写脏数据的版本号机制 | 不动 |

代码：`application/run-recovery-service.js`（983 行）、`session-recovery-service.js`（677 行）

### 5. 给模型用的工具

**沙箱工具，13 个**（全部转发给 Sandbox 服务执行）：

| 工具 | 干什么 | 能并行 |
|---|---|---|
| `read` `ls` `find` `grep` | 读文件、列目录、按名字找、按内容搜 | 是 |
| `write` `edit` | 写文件、改文件 | 否（同一工作区串行） |
| `bash` `python` | 跑命令、跑 Python | 否 |
| `process_start` `process_status` `process_read` `process_kill` | 起长时间进程、查状态、读输出、杀掉 | 部分 |
| `submit_artifact` | **唯一**能把文件交付给用户的工具 | 否 |

影响：**工具本身要重做**——ADR 0007 的方案是不再自己实现这 13 个工具，
改用新引擎自带的工具，我们只提供"文件怎么读写""命令怎么跑"的后端。
对模型可见的工具名和参数会变。

**其他工具：**

| 工具 | 干什么 | 影响 |
|---|---|---|
| `ask_user` | 模型向用户提问，Run 停在 WAITING_INPUT 等回答 | 要改 |
| `todo_write` `todo_read` | 会话内的待办清单 | 待定（用自建还是用新引擎自带） |
| `memory_write` `memory_search` | 跨会话的长期记忆，按用户隔离 | 待定 |
| `spawn_subagent` `check_subagent` | 开一个子 Agent 干活、查它的进度 | 要改 |
| `skill_install` `skill_create` `skill_edit` `skill_uninstall` `skill_list` | 管理用户自己的 Skill 包 | 要改（且首版可能先不上，见 ADR 0006） |
| `mcp__<服务器>__<工具>` | 外部 MCP 服务器提供的工具，启动时自动发现 | 待定 |

### 6. 审批：危险操作要人点头

| 功能 | 说明 | 影响 |
|---|---|---|
| 风险分级 | `config/agent/tool-risk.json` 给每个工具定风险等级 | 不动（配置照搬） |
| 三种模式 | `ask`（停下来等人）/ `deny`（直接拒）/ `auto_approve`（放行但记账） | 不动 |
| 硬拒绝 | `sudo`、`rm -rf /`、`dd`、`mkfs` 这类命令**任何模式都拒**，连审批都不给创建 | 不动 |
| 审批账本 | pending / approved / rejected 存 MySQL，Worker 重启不丢 | 不动 |
| 批准的粒度 | 批准一次只对**完全相同的那一次操作**有效，不是给通行证 | 不动 |
| 参数守卫 | 除了工具名，还检查参数（比如路径、命令内容） | 不动 |
| Skill 脚本白名单 | 只允许 `python <skill>/<包>/scripts/xxx.py` 这种形式，不允许管道、`&&`、`cat` 读 Skill 文件 | 不动 |

影响：策略逻辑**一行不改**，但挂载点从旧引擎的钩子换成新引擎的钩子。
ADR 0007 明确不启用新引擎自带的审批系统（会造成两套审批互相绕过）。

代码：`extensions/enterprise-policy/`

### 7. Skill：可复用的能力包

| 功能 | 说明 | 影响 |
|---|---|---|
| 系统 Skill | 全局共享，永远只读 | 不动 |
| 用户 Skill | 按 org/user 隔离，用户可以装、可以让 Agent 生成 | 要改 |
| 安装方式 | 只能来自本回合上传的 ZIP，或 Agent 结构化生成，都要走审批 | 不动 |
| 校验 | frontmatter 格式、目录结构、内容审计 | 不动 |
| 启用开关 | ADR 0006 要求"没启用的包不能被执行"——**现在还没做到**，沙箱把整个用户目录都挂进去了 | **ADR 0008 要修** |

代码：`skills/`、`extensions/skill-lifecycle/`

### 8. 子 Agent

| 功能 | 说明 | 影响 |
|---|---|---|
| 子 Run 就是普通 Run | 同一张表、同一个队列、同一套恢复逻辑，只多了"父子关系"字段 | 不动 |
| 独立会话 | 子 Run 有自己的对话和工作区（共用会因为锁死锁） | 不动 |
| 一次调用一个子 Run | 用工具调用 id 做幂等键，重试不会重复创建 | 要改（id 来源变了） |
| 深度和并发上限 | 默认最多套 2 层、同时 5 个，事务内加锁复查 | 不动 |
| 取消级联 | 取消父 Run，所有活着的后代都写取消意图 | 不动 |
| 子 Run 不给 `ask_user` | 它的提问没人看得到，给了就是永久卡死 | 不动 |

代码：`application/subagent-spawn-service.js`（503 行）

### 9. 定时任务（Cron）

| 功能 | 说明 | 影响 |
|---|---|---|
| 建/改/删/列定时任务 | 按 cron 表达式定时触发一个 Run | 不动 |
| 时区支持 | 每个任务带自己的时区 | 不动 |
| 幂等触发 | 同一个时间点只会触发一次，Worker 重启也不会补跑重复的 | 不动 |

代码：`application/cron-job-service.js`（479 行）、`presentation/http/cron-routes.js`

### 10. 对外 Agent 协议（A2A）

让外部系统把我们当成一个 Agent 来调用。

| 功能 | 说明 | 影响 |
|---|---|---|
| Agent 名片 | `/.well-known/agent-card.json`，声明自己能干什么 | 不动 |
| JSON-RPC 接口 | `/a2a`，建任务、查任务、订阅流 | 不动 |
| 凭据管理 | 外部调用方的认证凭据，存 MySQL | 不动 |
| 事件投影 | 把内部的 Run 事件翻译成 A2A 协议的事件 | 要改（源事件格式变了） |
| 审计 | 每次外部调用都记账 | 不动 |

代码：`application/a2a/`（12 个文件）、`presentation/a2a/`

### 11. 事件流（SSE）

浏览器实时看到模型在干什么，靠的就是这个。

| 事件 | 含义 |
|---|---|
| `session` | 会话建好了，工作区 id 是 xxx |
| `token` | 模型吐出的一小段文字 |
| `tool_start` / `tool_end` | 工具开始/结束 |
| `file_ready` | 有文件可以下载了（只有 `submit_artifact` 会发） |
| `done` | 这一回合结束 |
| `error` / `session_closed` | 出错 / 连接关闭 |

**影响：格式必须一字不变。** ADR 0007 把"SSE 契约逐字节不变"当成硬指标，
这样 BFF 和前端就完全不用改。测试基准是 `tests/fixtures/sse_events.json`。

### 12. 追踪、审计、多租户

| 功能 | 说明 | 影响 |
|---|---|---|
| 全链路 trace | W3C traceparent 贯穿四个服务，可以查单个 Run 的完整调用树 | 不动 |
| 工具审计 | 每次工具调用的参数、结果、耗时都记账 | 不动 |
| 脱敏 | 输出里的密钥、物理路径一律替换掉 | 不动 |
| 租户隔离 | 所有查询都带 `org_id` + `user_id` 条件，跨租户访问返回 404 | 不动（ADR 0007 原则 4 明确不改这套） |

### 13. Agent 版本

| 功能 | 说明 | 影响 |
|---|---|---|
| 版本绑定 | 每个 Agent 版本定义：用哪个模型、装哪些扩展、系统提示词、子 Agent 上限 | **重做** |
| 系统提示词分层 | 身份部分可被版本覆盖，但路径规则、Skill 入口规则、工具契约、工作纪律**不可覆盖** | 要改 |
| 工具段动态拼接 | `## Tools` 那段按本次实际绑定的工具现场生成，不写死 | 要改 |

代码：`infrastructure/pi/agent-version-bindings.js`（712 行）、`enterprise-system-prompt.js`

### 14. Agent 对外的 HTTP 接口

全部在 `/internal/*` 下，只有 BFF 能调（带内部 token）：

```
对话    GET/POST /internal/conversations，GET/DELETE /internal/conversations/{id}
会话    POST /internal/sessions/ensure，GET /internal/sessions/{id}
Run     POST/GET /internal/agent-runs
        GET  /internal/agent-runs/{id}          查详情
        GET  /internal/agent-runs/{id}/tools    查工具调用
        GET  /internal/agent-runs/{id}/events   SSE 事件流
        GET  /internal/agent-runs/{id}/trace    查调用链
        POST /internal/agent-runs/{id}/steer    中途插话
        POST /internal/agent-runs/{id}/cancel   取消
        POST /internal/agent-runs/rehydrate-waiting
审批    GET  /internal/approvals，GET /internal/approvals/{id}
        POST /internal/approvals/{id}/decide
进程    GET  /internal/processes
        GET  .../{id}/status|logs|read，POST .../{id}/cancel
诊断    GET  /internal/extensions/diagnostics
健康    GET  /health, /ready
A2A     /.well-known/agent-card.json, /a2a, /a2a/*
```

**影响：这些路径和返回格式都不能变**，否则 BFF 和前端要跟着改。

---

## 二、Sandbox 服务：负责"做"

它不思考，只执行。跑在 Python/FastAPI 上，被 Agent 通过 HMAC 签名的内部接口调用。
**浏览器永远不能直连它。**

### 1. 工作区

| 功能 | 说明 | 影响 |
|---|---|---|
| 一个会话一个工作区 | 用不透明的 `workspace_id` 标识，同一会话的多轮共用 | 不动 |
| 三个路径根 | 工作区（`/home/sandbox/workspace`）、会话私有的 `/tmp`、只读的 Skill 目录 | 不动 |
| 物理路径不外泄 | 真实磁盘路径只存在于服务内部，绝不出现在 API、日志、模型上下文里 | 不动 |
| 会话私有 /tmp | 跨多轮保留，不是每次执行都清空（见 ADR 0004） | 不动 |
| HOME 目录绑定 | `~/.config`、`~/.cache`、`~/.local/share` 绑到会话的持久目录，让 LibreOffice 这类程序能复用配置 | 不动 |

代码：`services/workspace_manager.py`、`paths.py`

### 2. 隔离：安全的唯一真正边界

| 功能 | 说明 | 影响 |
|---|---|---|
| Bubblewrap 沙箱 | 每次执行新建 mount / PID / IPC / user 命名空间 | 不动（ADR 0008 只改写法，不换技术） |
| 断网 | `--unshare-net`，生产环境网络模式固定 strict | 不动 |
| 权限剥离 | `--cap-drop ALL` + `setpriv`，非 root 用户执行 | 不动 |
| 资源上限 | CPU 300 秒、内存 512MB、进程数 20、单文件 50MB | 不动 |
| 输出上限 | stdout/stderr 各 50K 字符 | 不动 |
| 启动前自检（preflight） | 起容器前先探测沙箱能不能用 | **重做**（现在它手抄了一份配置，会和真实配置悄悄跑偏） |
| 配置表达方式 | 现在是 130 行顺序拼接参数，没法断言 | **重做**（改成数据结构 + 一个渲染函数） |

代码：`isolation/bubblewrap.py`（有个 `direct.py` 是开发用的不隔离后端）

### 3. 命令执行

| 功能 | 说明 | 影响 |
|---|---|---|
| bash / python / node | 短命令同步执行，等结果返回 | 要改（换成新引擎的 shell 接口形状） |
| Python 代码物化 | 短代码直接 `python3 -c`，长代码先落成临时文件再跑 | 不动 |
| 危险命令硬拒 | `sudo`/`rm -rf /`/`dd`/`mkfs`/`chmod 777` 等，进不了审批流程 | 不动 |
| 执行流 | 进程内的输出扇出，用于实时显示（不是恢复用的存储） | 不动 |

代码：`services/execution_manager.py`（638 行）、`python_materialize.py`、`policy_checker.py`

### 4. 长时间进程

| 功能 | 说明 | 影响 |
|---|---|---|
| 起进程 / 查状态 / 读输出 / 发信号 / 写 stdin / 杀掉 | 活得比一次 HTTP 请求长的进程 | 要改 |
| 增量读游标 | 连续读不会重复返回，丢数据时标记出来 | 不动（这个模型和新引擎完全对得上） |
| 孤儿检测 | 父进程没了的残留进程会被发现和清理 | 不动 |
| 归属校验 | 只有起这个进程的租户能操作它 | 不动 |

代码：`services/process_manager.py`（1733 行，全仓最大的单文件）、`process_cursor.py`

### 5. 文件读写

| 现在有 | 说明 | 影响 |
|---|---|---|
| `files/read` | 读文件，支持图片 | **全部重做** |
| `files/write` `files/edit` | 写、改 | **全部重做**（要加"文件版本"） |
| `files/ls` `files/find` `files/grep` | 列、找、搜 | 部分保留 |
| `skills/read` | 读 Skill 文件 | 删掉（合并进普通读） |

**新引擎要求 12 个基础操作**，我们现在只有一部分。差得最多的是：

- **文件版本** — 现在完全没有这个概念。有了它才能做到"改文件前必须先读过""两个人同时改同一个文件不会互相覆盖"
- `lstat` — 不跟随符号链接的查询，用来在跟进软链接之前就拒绝
- `streamText` — 流式读大文件
- `resolve` — 服务端统一算路径，保证"同一个文件不管怎么写路径都得到同一个标识"

这是 ADR 0008 的主体工作。

### 6. 路径安全

| 功能 | 说明 | 影响 |
|---|---|---|
| 拒绝 `..` | 防止跳出工作区 | 不动 |
| 拒绝 `~` 展开、拒绝盘符、拒绝其它绝对路径 | 同上 | 不动 |
| 软链接解析后再查一次边界 | 防止用软链接绕出去 | 不动 |
| 错误信息脱敏 | 物理路径一律显示成 `<workspace>` | 不动 |
| 三个重叠的解析入口 | 现在分散在三个文件，改一个逻辑要同时改三处 | **重做**（合并成一个） |

代码：`security/path_validation.py`、`paths.py`

### 7. 产物（Artifact）

| 功能 | 说明 | 影响 |
|---|---|---|
| 提交产物 | 模型调 `submit_artifact` 把文件交给用户 | 要改 |
| 下载 | 只能用 artifact_id 下载，不能用工作区路径 | 不动 |
| 跨会话导入 | 校验 org+user 后，把另一个会话的产物原子复制进来 | 不动 |
| 不可变快照 | 提交那一刻就固定，之后改工作区不影响它 | 不动 |

代码：`artifact/`（独立模块）

### 8. 数据集与上传

| 功能 | 说明 | 影响 |
|---|---|---|
| 数据集分片上传 | 先在控制面暂存，完成后原子发布进工作区 | 不动 |
| 中止上传 | 支持取消 | 不动 |
| 附件上传 | 每个附件独立目录，同名不覆盖；带幂等键 | 不动 |

### 9. 配额

| 功能 | 说明 | 影响 |
|---|---|---|
| 工作区配额账本 | 预留记录存在**工作区外面**，防止不可信进程删掉自己的账 | 不动 |
| 子进程磁盘监控 | 防止 bash/python 疯狂写文件把磁盘写满 | 不动 |

### 10. 内部接口的安全

| 功能 | 说明 | 影响 |
|---|---|---|
| HMAC 签名 | Agent 调 Sandbox 必须带短期签名 + 请求体摘要 | 不动 |
| 防重放 | 每个请求一个 jti，存独立的 Redis（和 Agent 的 Redis 凭据隔离） | 不动 |
| 入站 IP 白名单 | `SANDBOX_ALLOWED_CLIENT_CIDRS` | 不动 |
| 公共面 vs 内部面 | 公共面给 BFF 用，内部面给 Agent 用，两套认证 | 不动 |

### 11. MCP 门面

Sandbox 自己也对外提供一个 MCP 服务（单独部署），让外部 MCP 客户端能用沙箱的能力。
走的是另一条独立的 bridge，**不在这次重写范围内**。

代码：`sandbox/mcp/`

### 12. Sandbox 的 HTTP 接口

```
内部面（Agent 专用，HMAC 认证）—— 这次要重写的部分
  POST /internal/v1/files/{read,write,edit,ls,find,grep}
  POST /internal/v1/skills/read
  POST /internal/v1/executions/{bash,python}
  POST /internal/v1/processes/{start,status,read,kill}
  POST /internal/v1/sessions/ensure          ← 不改
  POST /internal/v1/artifacts/{submit,download}  ← 不改

公共面（BFF 用）—— 一个字都不动
  POST /api/files/upload、GET .../download、GET .../preview
  数据集：POST /imports, GET /{id}, /{id}/content, POST /{id}/abort
  会话进程：/{id}/logs, /read, /stdin, /signal, /cancel
  认证：/login, /register, /me
  健康：/health, /ready, /metrics
```

**ADR 0008 说内部面"唯一消费者是 Agent，所以可以直接重写"——这句话只对
files 和 executions/processes 成立。** sessions 和 artifacts 两组也在内部面下，
但不在重写范围里。ADR 的措辞应该收紧。

---

## 三、一张总表：这次要动多少

| 分类 | 内容 | 量级 |
|---|---|---|
| **完全不动** | 数据库表和迁移、Run 生命周期编排、队列/租约/锁、Outbox、对外 HTTP 接口、A2A、租户隔离、审批策略逻辑、Sandbox 的隔离性质/配额/产物/数据集/公共面 | 约 90% |
| **要重写** | Agent 的 13 个工具实现、引擎装配层、会话存储、系统提示词组装、Agent 版本绑定；Sandbox 的隔离配置表达、路径解析、内部文件接口 | 约 10% |
| **全新增加** | 文件版本机制、`lstat`、流式读、按启用集挂载 Skill | 新增 |
| **删掉** | `infrastructure/pi/` 整个目录（3315 行）、扩展注册表（669 行）、旧的工具实现和格式化代码 | 约 7000 行 |

---

## 四、还没想清楚的（写实施计划前必须先定）

1. **模型怎么接？** 整份 ADR 0007 只有一行"LLMIO 网关路由"。这是第一期最该跑通的东西，
   却既没排期也没验收标准。

2. **上下文压缩策略去哪了？** 现在有一套"对话太长了怎么裁剪"的逻辑
   （`context-policy-service.js`），新引擎里这归谁管、怎么迁，ADR 没写。

3. **取消怎么传下去？** Run 跑到一半用户按取消，这个信号怎么穿过新引擎、
   怎么让正在跑的沙箱进程停下来——没写。

4. **`todo`/`memory`/`ask_user` 用自建还是用新引擎自带的？**
   ADR 标了"待定"，但这决定了工作量差多少。

5. **第一期到底要多小？** 现在 ADR 0007 和 0008 的第一期绑死了必须一起上线，
   但 ADR 0008 那一半（文件版本、隔离层重做）不是"让服务活过来"的必需品。
   生产已经停摆的情况下，这个绑定值得重新掂量。

6. **Skill 启用开关**（ADR 0006）在第一期先按"用户装了什么就挂什么"处理，
   行为和今天一样。真正的启用开关排在第二期。
