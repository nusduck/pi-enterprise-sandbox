# Agent 模块整理与 TypeScript 重写

**写于 2026-08-30，同日更新执行结果。** 承接 [ADR 0007](../adr/0007-agent-runtime-rebuild-on-dsh.md) 的
未竟部分。

> ## 执行进度
>
> | 阶段 | 状态 |
> |---|---|
> | 0 修 patch 路径 + 启动期断言 | ✅ 完成，但**真因不是路径**（见下） |
> | **A′ 装配企业策略/提示词/会话后端** | ✅ 完成（计划里原本没有，追查阶段 A 时发现） |
> | A″ 删重复 transport | ✅ 完成，-4866 行 |
> | B 装配收进 runtime | ✅ 完成，清单改为类型化单一事实源 |
> | G 清 pi-agent-home 死配置 | ✅ 完成 |
> | **C bootstrap/ + presentation/ 转 TS** | ✅ 完成，两个目录已无 `.js` |
> | **D application/ 转 TS**（21,769 行，5 轮） | ✅ 完成，规则 1 已验证 |
> | **E infrastructure/ + 其余 转 TS**（约 29k 行，6 轮） | ✅ 完成，仅 migrations 保留 `.js` |
> | **F runtime 并入 src/runtime** | ✅ 完成，P3 按构造消解 |
>
> **`agent/src/` 现在只有 21 个文件是 JavaScript**：`mysql/migrations/`（knex
> 运行时按目录扫描加载的纯 DDL）。`strict` 仍关着，是**已知待办**：实测
> `strict: true` 964 error（隐式 any 形参 646），只开 `strictNullChecks`
> 290 error。`src/runtime/**` 已单独用 `tsconfig.runtime.json` 保住 strict。
>
> **阶段 0 的真因比预想严重**：不是路径拼错，是 `dsh-app-boot` 把 patch 的
> `name` 当**断言**——在已有行上改 `name` 会让整条 patch 被静默跳过。后果是
> `ctx.credentials` 一直是出厂的 `LocalCredentialProvider`，正是 ADR 0007
> 「必须移除的行」点名不得组合的那个。
>
> **阶段 A 追查时发现更大的洞**：`runtime-factory.create()` 里
> `void promptText; void sessionStore;`——企业系统提示词与 MySQL 会话后端算完
> 丢弃，DSH 的四个策略挂载点一个没接。Wave 5 的 `policy/` 全套有单测且全绿，
> 因为测的是纯函数。审批、租户 guard、每 Run 预算、脱敏、账本在那之前**全部
> 不生效**。这成了阶段 A′，优先级高于所有结构整理。

DSH 重建把执行面换掉了，但 `agent/` 内部只做了"接线"，没有整理——
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

### 阶段 0：修 P5（先做，与结构无关）—— ✅ 完成

`cordis.patch.yml` 的两条 `../src/*.js` 改成 `../dist/*.js`，并加一条**启动期断言**：
patch 里引用的每个 `name` 路径必须真实存在，否则 boot 失败。

> 为什么要断言而不只是改字符串：这个错误之所以能活到现在，是因为插件装不上时
> 没有任何人报错。改完字符串，下一次有人动 patch 仍会犯同样的错。

**验收**：`agent/runtime/test/boot.test.ts` 断言 patch 里所有 `name` 可解析；
把任一条改坏，测试必须红。

### 阶段 A：删掉重复的那一套（减法）—— ✅ 完成（实际拆成 A′ + A″）

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

### 阶段 B：装配收进 `runtime/`（P4 + 规则 2）—— ✅ 完成

> **落地时改了做法。** 原计划是"把 46 处 `await import` 收进清单"，但插件清单
> 本来就在一处（`bundle/cordis.patch.yml`）；那 46 处大多是启动开销的懒加载，
> 与插件装配无关。真正的缺陷是**那份 YAML 能静默写错**（本轮踩到两种）。
> 所以实际做的是：`src/plugins/manifest.ts` 成为类型化的唯一事实源，YAML 由
> `npm run gen:patch` 生成，`plugins.test.ts` 断言两者逐字节一致。
> 替换出厂插件只有 `replaceFactory()` 一个入口，"改 name"那种写法写不出来。

原计划（保留作对照）：把插件装配收成 `agent/runtime/src/plugins/` 下的
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

### 阶段 C：`bootstrap/` + `presentation/` 转 TS（约 6,300 行）—— ✅ 完成

走的是**逐目录切换 + `allowJs` 过渡**：`tsconfig.json` 只做检查
（`noEmit` + `allowJs` + `checkJs`），`tsconfig.build.json` 出 `dist/`。
`allowJs` 让未转换的 `.js` 也被搬进 `dist/`，所以迁移期间不存在"哪些从 src
跑、哪些从 dist 跑"的分叉。

**验收（已达成）**：checkJs 0 error；`server.js` / `worker.js` 入口指向
`dist/`；Dockerfile / compose / 生产 overlay 同步；agent 1043 测试全绿。

转换中消除的 `@ts-expect-error` 共 27 处，**没有一处是搬走或重新压住的**。
根因高度一致：**JSDoc 描述的是"我用到了什么"，而代码实际收下的比这多**。
典型三类——端口声明漏了参数（`runQueue.enqueue` 的 `options`）、返回形状
没写（`checkHealth()`）、容器传了服务根本不读的依赖（A2aTaskService 的
`steerRunService` / `followUpService`，删的是接线不是能力）。

#### ⚠️ 过渡期配置的两个洞（阶段 D–F 继续踩）

`strict: false` 关掉的不只是"烦人的报错"，它同时关掉了 `strictNullChecks`：

- **`return;` 落在声明为 `Promise<boolean>` 的函数里，tsc 收下**。抽
  `health-routes.ts` 时原样搬出的两个 `return;` 就是这样通过检查的——真跑
  起来 `/health` 返回 `undefined`，调用方判定"不是我的路由"继续往下匹配。
  测试也没覆盖到（没有用例断言 `/health` 之后不再匹配）。
- 结论：**搬运代码时的控制流必须人来看**。宽松配置不是安全网，它只是让
  转换不至于一次红几千行。

另一个洞已修：`tests/test_repository_layout.py` 的行数棘轮原本只扫
`agent/src/**/*.js`，**一个文件转成 TS 就静悄悄退出棘轮**。
`presentation/a2a/http-handler` 正是这样在转换里从 993 长到 1009 无人发现。
现在 `.js` / `.ts` 都扫——阶段 D/E 转换时不会再有文件借转换偷偷变长。

#### 守住 1000 行：拆分而不是抬预算

| 文件 | 拆出 | 行数 |
|---|---|---|
| `bootstrap/container.ts` | `bootstrap/container-mcp.ts`（`McpDiscoveryState`） | 1178 → 1065 |
| `bootstrap/create-http-server.ts` | `presentation/http/health-routes.ts` | 1439 → 1399 |
| `presentation/a2a/http-handler.ts` | `presentation/a2a/http-handler-mapping.ts` | 1009 → 938 |

三次拆分的判据相同：**这组代码有没有只属于它自己的状态或职责**。
`McpDiscoveryState` 的四个可变字段只被那三个方法读写；health/ready 只读探针
拼运维快照；mapping 是不闭包 `deps` 的纯查表。

### 阶段 D：`application/` 转 TS（21,769 行，5 轮）—— ✅ 完成

**规则 1 已验证**：`application/` 里没有任何 cordis / `@pi/runtime` / dsh 依赖，
唯一命中的 "runtime/" 是 `pi-run-executor` 里一句英文注释。这条约束目前成立。

没有按子域分批，而是按**内部依赖分层**（脚本算出 6 层 + 一个 4 文件的环），
叶子优先。好处是每一轮结束后，已转的部分不再被未转的部分引用。

发现的问题几乎都是同一形状——**同一件事被描述了两遍，然后对不上**：

| 发现 | 两边的说法 |
|---|---|
| `PiRunExecutor` 的 deps | 构造器一份、工厂一份，工厂那份已退化成 `any`，`toolBudget` 少了 `runDeadlineMs` |
| `skillRootsForRun` | container 声明返回 `unknown`，实际必须返回 `string[]` |
| `auth` | 六个服务写成 `object`，解析器要三个具体字段 |
| `RecoveryAction` | run-recovery 又抄了一遍字面量联合，D2 时已经因此对不上过一次 |
| `CancelRunService` 的仓储包 | 声明五个，实际透传出去要七个 |
| outbox 的 `bindings` | 声明 `unknown[]`，实际只 push string——三处 `@ts-expect-error` 的共同根因 |

#### 三条翻译陷阱（写下来，因为每一轮都会遇到）

1. **`@param {object} x` 不能直译成 TS 的 `object`。** JSDoc 里它是「某个
   对象」，TS 里它禁止一切属性访问——直译会让每个 `x.foo` 报 TS2339，看起来
   像发现了几十个 bug，其实一个都不是。映射成 `Record<string, any>`。
2. **`new Map(any)` / `new Set(any)` 会塌成 `Map<unknown, unknown>`。**
   上游是 any 时元素类型不会传播，必须显式给类型参数。
3. **对象字面量的可选字段不会被推断出来。** `const body = {a, b}` 之后
   `body.c = x` 直接报错——这不是错误，是字面量类型确实没有 c。

### 阶段 E：`infrastructure/` + 其余 转 TS（约 29k 行，6 轮）—— ✅ 完成

按子目录推进：核心 + `mysql/` → `mysql/repositories/` → `outbox/` + `redis/`
→ `sandbox/` + `mcp/` → `dsh/`，最后补上计划里没写的 `domain/` `skills/`
`lib/` `config/` 与三个入口——留着它们迁移就不算完成。

**`mysql/migrations/` 刻意保持 `.js`**：knex 在运行时按目录扫描加载它们，
且它们是纯 DDL，转 TS 拿不到任何类型收益。连带的约束是 migrate CLI 也不能
用 plain node 跑源码——开发期走 tsx，容器里走 `dist/`。

两个值得单独记的发现：

- **一处 `never` 消掉了 internal-hmac 的全部 7 个错误。** `fail()` 永远抛出，
  JSDoc 也写了 `@returns {never}`，但那行没搬过去。TS 于是认为它可能正常
  返回，所有「校验失败就 fail(...)」的守卫一个都不收窄。
- **企业系统提示里的 skill 路径是错的。** `workspaceRoot` / `skillRoot` 从
  container 穿过三层调用传到 `resolveEnterpriseSystemPrompt`，然后被丢掉——
  条款里的路径写死在常量里，其中 `/home/sandbox/skills` 与实际挂载的
  `/home/sandbox/skill`（单数）对不上，模型照着去列 skill 会扑空。修法是把
  **已经存在的管道接上**，不是删掉死参数。

### 阶段 F：`runtime/` 并入 `agent/src/runtime/`（P3 消解）—— ✅ 完成

`agent/runtime/` 这个独立 npm 包没有了，agent/ 顶层只剩一棵源码树。

两处不明显但必须处理的：

- **cordis patch 的路径语义跟着布局变了。** 插件 `name` 相对 patch 文件所在
  目录解析；patch 与 provider 现在同在 `<out>/runtime/` 下，所以是
  `../providers/`。build 因此多一步把 `bundle/*.yml` 拷进 dist——tsc 不搬
  非 TS 文件，而 patch 必须与编译后的 `boot.js` 同处一棵树。
- **并入主树会让组合层丢掉 strict。** runtime 原本有自己的严格 tsconfig，
  落到 agent 的宽松规则下当天就有一处联合收窄失效（布尔判别式的收窄依赖
  `strictNullChecks`）。用 `tsconfig.runtime.json` 单独保住，接进
  `npm run typecheck`。

**这一步按 ADR 0007 规则 2 做了实测**：从编译产物真启动插件树，确认挂上的是
自建实现（`EnvCredentialsProvider` / `RemoteFileSystem` / `RemoteShell` /
`RemoteJobs`）而不是出厂实现。

### 阶段 G：清理死配置（P2）—— ✅ 完成

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
5. **（阶段 C 补充）语言迁移中，`tsc` 通过不等于行为不变。** `strict: false`
   下 `undefined` 可赋给任何类型，搬运代码时的 `return` / 早退 / 空值分支要
   人工逐处核对。凡是"原样搬出去"的代码块，先读一遍它的所有出口。
6. **（阶段 E 补充）批量转换必须验字面量。** 转换脚本的块注释正则没要求
   `/**` 出现在行首，于是从字符串 `'redis://***'` 中间（含 `/**` 子串）开始
   匹配，一路吃到后面某个真 JSDoc 的 `*/`，把中间的代码改坏——**类型检查
   照过，1043 个测试照绿**，因为坏掉的只是脱敏结果里多了个换行。此后每轮都
   跑一道字面量不变性检查（剥注释后提取字符串，原文有的必须仍在树里，按整棵
   树比对以容纳有意的拆分）。静默、无报错、测试不覆盖——这是语言迁移最危险
   的一类损坏。

---

## 5. 明确不做的

- **不换 DSH**，不重开选型。
- **不动 `exec/`**：本方案范围仅限 agent 进程内部。
- **不动公共面契约**：`api-server/` 与 `frontend/` 零改动这条继续成立。
- **不做"把 runtime 挪个位置"的独立任务**：它是阶段 F 的结果，提前做只会制造
  一个既不是包也不是子目录的中间态。
