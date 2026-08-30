# Agent 模块整理与 TypeScript 重写

**写于 2026-08-30。** 承接 [ADR 0007](../adr/0007-agent-runtime-rebuild-on-dsh.md) 的
未竟部分。DSH 重建把执行面换掉了，但 `agent/` 内部只做了"接线"，没有整理——
留下了重复实现、失效的目录、以及一个半 JS 半 TS 的结构。

本文件是**方案与任务分解**，不是决策记录：目标形态与三条硬规则来自决策所有者
给出的架构图，这里只负责把它拆成可执行、可验证、每步结束仓库都能跑的任务。

---

## 0. 目标形态

```
agent 进程

application/   MySQL 账本、审批、SSE            ← 不是 plugin，不认识 cordis
      │
      ▼
runtime/       唯一的 Cordis ctx 装配点
  ├── 出厂插件   tool-fs / tool-bash / llm / session / …
  ├── 自建插件   remote-fs / remote-shell / remote-jobs
  │              env-credentials / durable-subagent
  └── 关掉       sandbox-local / approval / jsonl / search
                        │  HMAC RPC
                        ▼
exec 进程      不是 plugin，是 ctx.fs / ctx.shell / ctx.jobs 的**后端**
               WorkspaceFileSystem + bwrap
```

### 三条硬规则

1. **`application/` 不认识 cordis。** 它拿到的是普通的领域接口，不是 `ctx`。
   一旦 application 里出现 `ctx.` 或 `@deepseek-ai/cordis` 的 import，这条就破了。
2. **`runtime/` 是唯一的装配点。** 插件只有三类去处——出厂启用、自建、明确关掉，
   全部在一份清单里表达。**新增 plugin 只改这一处**，不再往 `bootstrap/` 里塞
   `await import`。
3. **`exec` 是后端不是插件。** agent 进程里不存在"本机执行"这条路径；
   `ctx.fs/shell/jobs` 的实现一律是 RPC 代理。

---

## 1. 现状问题（逐条核实过，不是印象）

### P1 — 两套通往 exec 的实现同时存在

| | 文件数 | 状态 |
|---|---|---|
| `agent/src/infrastructure/sandbox/internal-*-http.js` | 17 | **仍在跑**：`container-run-executor.js` 用 `await import` 装配 files-read / files-write / execution / search / process 五个传输 |
| `agent/runtime/src/providers/remote-{fs,shell,jobs}.ts` | 3 | **也在跑**：`runtime-factory.js` 经 `@pi/runtime` 的 `createRemoteProviders` 装配 |

[ADR 0008 D6](../adr/0008-sandbox-isolation-and-fs-seam-redesign.md) 写明这些
`internal-*-http.js` "全部在 ADR 0007 的重写范围内"。W6-A 声称删除了
`infrastructure/pi/` 与 `extensions/`，**没有提及也没有删除 `infrastructure/sandbox/`**。
这是验收时漏掉的一层。

外部引用统计（`internal-files-read-constants` / `-image` / `-payload` / `-result` /
`internal-hmac` / `internal-sandbox-transport-error` / `sandbox-bridge-http-transport`
七个文件的外部引用数为 **0**，已经是死代码）。

### P2 — `pi-agent-home` 是死目录，却仍被三处配置维护着

`agentDir` 在 `container.js` → `container-run-executor.js` → `runtime-factory.js`
之间传递，**终点不消费它**；`@pi/runtime` 里对 `agentDir` 零引用。也就是说
Pi 的资源根随 Pi 一起失效了，但：

- `agent/Dockerfile` 仍 `mkdir` / `chmod` / `chown` 它，并设 `AGENT_PI_AGENT_DIR`
  与 `PI_CODING_AGENT_DIR` 两个环境变量
- `docker-compose.yml` 在 agent 与 agent-worker 两处各设一遍，
  `docker-compose.prod.yml` 再设一遍
- 本地默认值 `{cwd}/.runtime/agent/pi-agent-home` 会在开发机上真的建出目录

于是 `agent/` 下多出 `pi-agent-home/` 与 `.runtime/` 两个空目录。两者都在
`.gitignore` 里（不会被提交），但它们**出现在编辑器的文件树里**，让人以为是
有意义的结构。

### P3 — `runtime/` 与 `src/` 平级

`agent/runtime/` 是一个带自己 `package.json`/`tsconfig.json`/`dist/` 的 TS 包，
`agent/src/` 是 JS 源码树。两者平级，看起来像"两套 src"。

**这不是布局品味问题，是 agent 还没转 TS 的症状。** agent 是纯 JS、由 node 直接
跑、没有构建步骤，所以 TS 的 runtime 只能作为一个独立包存在。等 agent 本身是 TS、
有统一的 `tsc -b`，runtime 就是 `agent/src/runtime/` 的一个普通子目录，这个异常
**由构造消失**，不需要专门去"摆正"。

因此本方案不单独做"把 runtime 挪个位置"这件事——它是第 3 阶段的自然结果。

### P4 — 装配散落在 46 处动态 import

`grep -rn "await import(" agent/src` → 46 处。新增一个 plugin 现在要动
`container.js`、`container-run-executor.js` 等多个文件，与规则 2 直接冲突。

### P5 — `cordis.patch.yml` 里两个自建插件指向不存在的文件

```yaml
- id: credentials
  name: '../src/providers/env-credentials.js'      # 源码是 .ts，此文件不存在
- id: subagent-spawn-in-process
  name: '../src/providers/durable-subagent.js'     # 同上
```

而三个 remote-* 指的是 `'../dist/providers/*.js'`（正确）。**`env-credentials` 与
`durable-subagent` 这两个自建插件目前装不上。**

这条是本次核实中新发现的，优先级高于结构整理：它意味着凭据 provider 与 durable
子 Agent 在生产里是失效的。

### P6 — 6 个文件仍以 `pi-` 命名

`pi-run-input.js` / `pi-run-executor.js` / `pi-run-resume.js` /
`pi-run-tool-budget.js` / `pi-mcp-adapter-factory.js` /
`pi-session-journal-repository.js`。纯命名问题，但会持续误导读者。

### 规模

`agent/src`：**222 个文件 / 约 61,000 行 JS**。作为参照，整个 `exec/` 是约 13,000 行。

| 目录 | 文件 | 行数 |
|---|---|---|
| `application/` | 59 | 21,773 |
| `infrastructure/` | 117 | 28,413 |
| `bootstrap/` | 9 | 4,530 |
| `skills/` | 7 | 2,199 |
| `domain/` | 20 | 1,889 |
| `presentation/` | 7 | 1,768 |
| `lib/` + `config/` | 3 | 451 |

---

## 2. 分阶段方案

原则：**每个阶段结束时仓库都是可跑的、测试全绿的**。不允许出现"重写到一半"的
中间态——那比现状更糟。

### 阶段 0：修 P5（先做，与结构无关）

`cordis.patch.yml` 的两条 `../src/*.js` 改成 `../dist/*.js`，并加一条**启动期断言**：
patch 里引用的每个 `name` 路径必须真实存在，否则 boot 失败。

> 为什么要断言而不只是改字符串：这个错误之所以能活到现在，是因为插件装不上时
> 没有任何人报错。改完字符串，下一次有人动 patch 仍会犯同样的错。

**验收**：`agent/runtime/test/boot.test.ts` 断言 patch 里所有 `name` 可解析；
把任一条改坏，测试必须红。

### 阶段 A：删掉重复的那一套（减法）

1. 工具路径改走 runtime provider：`container-run-executor.js` 不再 `await import`
   `internal-files-read-http` / `-write-http` / `internal-execution-http` /
   `internal-search-http` / `internal-process-http`
2. 删除已确认零外部引用的 7 个文件
3. 保留 `sandbox-client.js`（4 处引用）与 `trace-context.js`（3 处引用）——
   它们服务的是**公共面**（数据集下载、Skill 归档下载），不是工具路径，
   不在 ADR 0008 D6 的重写范围内
4. `pi-*` 六个文件改名（P6）

**验收**：
- `agent/src/infrastructure/sandbox/` 只剩公共面所需文件
- 全链路实测：带工具的 Run 走通（读、写、bash、搜索、进程），
  结果与阶段 A 之前逐字段一致
- **不能只靠单测**：这一步换的是运行时装配路径，单测可能两条路径都不覆盖

**风险**：runtime provider 与旧 JS transport 的行为差异（截断、错误码、
image 读取的 payload 形状）。落地前先写一组**对照测试**：同一输入分别走两条路径，
断言输出一致；对不齐的地方以旧行为为准修 provider，再删旧路径。

### 阶段 B：装配收进 `runtime/`（P4 + 规则 2）

把插件装配从 `bootstrap/` 的动态 import 收成 `agent/runtime/src/plugins/` 下的
**一份显式清单**，三类分开：

```
runtime/src/plugins/
  factory.ts     出厂启用：tool-fs / tool-bash / llm / session / …
  own.ts         自建：remote-fs / remote-shell / remote-jobs /
                       env-credentials / durable-subagent / enabled-skills / memory
  disabled.ts    明确关掉：sandbox-local / approval / jsonl / tool-fs-search / …
  index.ts       合成 cordis patch，**唯一**出口
```

`cordis.patch.yml` 由这份清单生成或校验（二选一，落地时定），保证 YAML 与代码
不会各说各话。

**验收**：
- 新增一个 plugin 只需要改 `own.ts` 一个文件——用一个真实的小 plugin 验证
- `bootstrap/` 里与插件装配相关的 `await import` 归零
- 组合断言（ADR 0007 验证要求 #2）：遥测、出网、凭据、本机 fs/shell/sandbox
  各行**实际未挂载**——断言组合结果，不是断言配置意图

### 阶段 C：`bootstrap/` + `presentation/` 转 TS（约 6,300 行）

从这里开始 agent 有构建步骤。选一次性切换还是 `allowJs` 渐进，落地时定；
倾向**逐目录切换 + `allowJs` 过渡**，因为 61k 行不可能一次切干净。

**验收**：`tsc -b` 0 error；`server.js` / `worker.js` 变成 `dist/` 产物入口；
Dockerfile 增加构建阶段。

### 阶段 D：`application/` 转 TS（21,773 行，多轮）

**规则 1 在这一步落地**：转换过程中逐文件确认 application 里没有 cordis 依赖。
如果发现有，那是需要单独修的架构违规，不是顺手改的类型问题。

按子域分批：Run 执行 → 会话与恢复 → 审批与治理 → A2A → SSE 投影。

### 阶段 E：`infrastructure/` 转 TS（28,413 行，多轮）

按子目录：`mysql/` → `redis/` → `outbox/` → `mcp/` → `dsh/` → 其余。
`dsh/` 这一层在阶段 B 之后应当已经很薄（装配搬进 runtime 了）。

### 阶段 F：`runtime/` 并入 `agent/src/runtime/`（P3 自然消解）

agent 全 TS、单一 `tsc -b` 之后，`@pi/runtime` 不再需要是独立 npm 包：
`agent/runtime/` → `agent/src/runtime/`，删掉那份 `package.json` /
`tsconfig.json` / `dist/`，`agent/` 下只剩 `src/ tests/ Dockerfile package.json
tsconfig.json` 与两个入口。

**这一步不能提前做**：agent 还是 JS 的时候，TS 的 runtime 必须是独立包。

### 阶段 G：清理死配置（P2，可以随时做，建议跟在阶段 A 后）

- 删 `AGENT_PI_AGENT_DIR` / `PI_CODING_AGENT_DIR` 两个环境变量（compose ×3、
  prod overlay ×1、Dockerfile）
- 删 `container-env.js` 的 `ensureAgentPiAgentDir` 与沿途传递的 `agentDir` 形参
- Dockerfile 不再创建 `/app/pi-agent-home`
- 本地不再生成 `.runtime/agent/pi-agent-home`

**验收**：`grep -rn "pi-agent-home\|PI_AGENT_DIR" .` 只在 CHANGELOG/ADR 的历史
记述里出现；容器重建后 `/app` 下没有该目录。

---

## 3. 阶段依赖与建议顺序

```
阶段 0（修 P5）──┐
                 ├─→ 阶段 A（删重复）──→ 阶段 G（清死配置）
                 │           │
                 │           ▼
                 └─────→ 阶段 B（装配收口）
                             │
                             ▼
                         阶段 C ──→ 阶段 D ──→ 阶段 E ──→ 阶段 F
```

- **0 / A / B / G 是"你现在抱怨的那些问题"**：重复实现、到处引用、无用目录。
  做完这四步，`agent/` 就符合架构图了，且新增 plugin 只改一处。
- **C–F 是语言迁移**：价值在类型安全与 `runtime` 归位，不改变结构，可以按模块
  滚动推进，随时可停。

---

## 4. 每个阶段都必须守的验收纪律

来自 [gap-audit](waves/gap-audit.md) 的教训，逐条适用于本方案：

1. **断言语义，不断言形状。** 写完用例先问：空实现能不能让它通过？
2. **改运行时装配路径的阶段（A、B、C），单测不算验收**，必须起栈实测。
   这条不是保险起见——DSH 重建里两个最严重的 bug（共享 cordis Context、
   DNS 允许列表）都是 299 个绿测试没抓到、`docker compose up` 后五分钟暴露的。
3. **删除任何东西之前，先证明它没有消费者**，并把证明写进 commit message。
4. **反向验证护栏**：新加的断言要故意改坏实现确认它变红。

---

## 5. 明确不做的

- **不换 DSH**，不重开选型。
- **不动 `exec/`**：本方案范围仅限 agent 进程内部。
- **不动公共面契约**：`api-server/` 与 `frontend/` 零改动这条继续成立。
- **不做"把 runtime 挪个位置"的独立任务**：它是阶段 F 的结果，提前做只会制造
  一个既不是包也不是子目录的中间态。
