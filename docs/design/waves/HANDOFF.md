# 交接说明

**写于 2026-08-31。第四次交接（文档对账）。** 给接手 `refactor/dsh-rebuild` 的下一个 agent。

先读这四份，它们是权威，本文件只讲「现在到哪了 / 怎么接」：

1. [`../dsh-rebuild.md`](../dsh-rebuild.md) —— DSH 重建详细设计
2. [`../agent-ts-rebuild.md`](../agent-ts-rebuild.md) —— agent 内部整理与 JS→TS（**进度表以这份顶部为准**）
3. [`gap-audit.md`](gap-audit.md) —— 逐函数移植对照（Wave 3 占位期的审计；搜索/产物/数据集已在 Wave 7 补齐）
4. [`README.md`](README.md) —— 任务进度表与已定决策

分支：`refactor/dsh-rebuild`（**未合并**，无 PR，`main` 未动）。HEAD 在
`a1b58559` 时，相对 `main` 约 44 个 commit。

---

## 一句话背景

Agent 引擎 `@earendil-works/pi-coding-agent` 不可用，换成 DeepSeek 开源
`@deepseek-ai/dsh`，执行面 Python→TypeScript 重写。研发阶段，无历史迁移、无回退目标。
随后把 agent 内部 61k 行 JS 迁到 TS，并把一度独立的 `agent/runtime` 包并进
`agent/src/runtime/`。

---

## 接手第一步

```bash
npx tsc --noEmit -p exec/tsconfig.json && npm test --prefix exec
npx tsc --noEmit -p contract/tsconfig.json && npm test --prefix contract
npm --prefix agent run typecheck    # 主程序（宽松）+ src/runtime（strict）
npm test --prefix agent
uv run pytest -q
```

`agent/src/runtime/` 的用例已并入 `npm test --prefix agent`（`tests/runtime/**`）。
其中 `tests/runtime/boot.test.ts` 会**起真实插件树**（子进程）；改
`src/runtime/bundle/cordis.patch.yml` 或 provider 路径后必须跑它——
cordis 的 patch 装不上插件时不报错，只是出厂实现留在原位。

不要再跑 `agent/runtime/test/*.test.ts` 或 `tsc -p agent/runtime/tsconfig.json`：
那个独立包在阶段 F 已经消失。

---

## ⚠️ 这一轮最该记住的一件事

**Wave 3 曾经标着 ✅、231 个用例全绿，而搜索、产物、数据集三个子系统是占位实现。**

不是没写完——是**写了假的**：`find`/`grep` 忽略参数返回 `listDir()`；产物 submit
编造 `sha256: '0'.repeat(64)` 并回 201；数据集上传只校验头就回 201，字节根本没落盘。
测试没抓到，因为它们断言的是**响应形状**，而占位实现形状恰好是对的。

Wave 7 已按语义补齐。规矩仍在 [README.md](README.md) 里，请继续守：

> 新增路由的验收用例必须断言**语义**。写完先问一句：
> **空实现能不能让这条用例通过？** 能就重写。

曾经踩过、都已修：

- 断言「二进制文件不在 grep 结果里」——空数组天然满足
- 断言「同一幂等键返回同一 id」——占位用 `ds_${Date.now()}`，同毫秒天然相等
- 断言「连续提交多次都成功」——却把已建好的 `fs` 实例传进服务，永远不会重复构造

---

## 已完成

### DSH 重建（Wave 0–7）

| 子系统 | 状态 |
|---|---|
| `contract/` · `exec/` · agent 侧 DSH 组合层 | ✅ |
| 隔离、文件、命令/作业、工作区/配额 | ✅ |
| **搜索**（`exec/src/search/`） | ✅ 2026-08-29 补齐 |
| **产物**（控制面快照） | ✅ 2026-08-29 补齐 |
| **数据集**（三段式流式） | ✅ 2026-08-29 补齐 |
| **MCP facade + 窄桥八条路由** | ✅ 2026-08-30 补齐并端到端验证 |
| `sandbox/` Python 面 | ✅ 整个删除（compose 服务名仍叫 `sandbox`，镜像是 `exec/Dockerfile`） |
| 镜像工具链 | ✅ 构建通过，容器内逐项验过 |
| ADR 0007 / 0008 | ✅ 转 Accepted，实施偏差记在文末 |

### agent 内部整理（阶段 0 / A′–G）

方案与验收纪律见 [agent-ts-rebuild.md](../agent-ts-rebuild.md)。**进度表以那份顶部为准**，不要信过期的「C–F 未开始」。

| 阶段 | 状态 |
|---|---|
| 0 修 patch 路径 + 启动期断言 | ✅ 真因是 patch `name` 被当断言，静默跳过整条 |
| A′ 装配企业策略/提示词/会话后端 | ✅ Wave 5 的 policy 此前算完丢弃，四个挂载点现在接上了 |
| A″ 删重复 transport | ✅ `infrastructure/sandbox/` 只剩公共面 client |
| B 装配收进 runtime | ✅ 事实源是 `src/runtime/plugins/manifest.ts`，YAML 由 `npm run gen:patch` 生成 |
| C `bootstrap/` + `presentation/` 转 TS | ✅ |
| D `application/` 转 TS | ✅ 规则 1 已验证（application 无 cordis 依赖） |
| E `infrastructure/` + 其余转 TS | ✅ 仅 `mysql/migrations/` 21 个 DDL 保留 `.js` |
| F runtime 并入 `agent/src/runtime/` | ✅ 独立 `@pi/runtime` 包消失；`tsconfig.runtime.json` 保住 strict |
| G 清 `pi-agent-home` 死配置 | ✅ |

`agent/src/` 现在是 217 个 `.ts` + 21 个 knex migration `.js`。

### 结构上与原设计的偏离（已记进 ADR，后来又折了一层）

1. 顶层 `runtime/` → `agent/runtime/`（只有 agent 一个消费者）→ **阶段 F 再并进 `agent/src/runtime/`**。当前只有这一棵源码树。
2. `sandbox/mcp/` 从「本次不动」改为一并 TS 重写进 `exec/src/mcp/`：exec 镜像没有 Python，「不动」实际等于「删掉它」。

三个值得记住的发现（阶段 0 / A′ / B）：

1. **patch 的 `name` 是断言不是替换手段。** 在已有行上改 `name`，`dsh-app-boot` 会 `warn("name mismatch … skipping")` 并跳过整条。替换出厂插件只能「disable 出厂行 + insert 自建行」。此前 `ctx.credentials` 因此一直是出厂的 `LocalCredentialProvider`（ADR 0007 明令不得组合）。
2. **Wave 5 的策略层曾从未被装配。** `runtime-factory.create()` 里 `void promptText; void sessionStore;`，四个挂载点一个没接。审批、guard、预算、脱敏、账本全部不生效，而 `policy.test.ts` 全绿——它测纯函数。阶段 A′ 接上了。
3. **cordis 服务必须经 `ctx.inject([names], cb)` 取**，且名字是 `systemPrompt` 不是 `'system-prompt'`。直接取属性会**抛**，不是静默跳过。

---

## 剩下什么

循环与 `application/` 的下一步以
[ADR 0009](../../adr/0009-dsh-host-tools-and-application-steward.md) 为准：
出厂 tool 挂 host（不要为「挂上」去加 preset）；问人用 `dsh-user-approval`；
application 做停泊/SSE/租户，不再 registerTool。

### 1. 真实链路（Mac 上用 Docker 就能做）

- **`docker compose up` 在 Mac 上可以起执行面。** 容器里是 Linux；compose 已挂
  `seccomp=./exec/seccomp-bubblewrap.json`，服务 uid 是 10001。
  `No permissions to create new namespace` 曾经被写成「Docker Desktop 不支持」，
  实际是误诊：要么 seccomp 行被删掉，要么用 root `docker compose exec` 进了容器
  （`cap_drop: ALL` 下 root 建不了 namespace）。验 bwrap 用
  `docker compose exec --user 10001:10001 sandbox …`。
- **宿主机裸跑** `node exec/dist/main.js` 才是 Linux-only（macOS 内核没有
  user namespace）。日常开发走 compose，不要裸跑。
- **Agent 半段** —— 登录 → 建会话 → 带工具 Run → Worker 重启恢复 → logs/signal
  → 跨租户 404。网关用现有 `LLMIO_BASE_URL` / `LLMIO_API_KEY`。

### 2. 生产网关冒烟（上线准入项）

[ADR 0007 D6](../../adr/0007-agent-runtime-rebuild-on-dsh.md)。目前
`scripts/llmio-smoke.mjs` 只跑过 `api.deepseek.com`，没覆盖自有网关。
要看：剥离未知头、`include_usage`、缓存命中。

### 3. STATUS.md 的重新取证

[STATUS.md](../../STATUS.md) 已做过逐行重审。C8 / E2 / E3 的**实现**已在 Wave 7
补齐，行状态是 `partial`（缺 live 证据），不是「还在占位」。重新取证依赖上面第 1 项。
不要把 `done` 行里指向已删除 Pi / Python 路径的旧证据当仍然成立。

### 4. CI 还没纳入新包

`.github/workflows/test.yml` 只有 python / node-bff / node-agent / frontend /
compose / cross-service-smoke，**没有 exec 与 contract 的 job**。
`AGENTS.md` 已经要求六套测试。依赖断言（`@earendil-works/*` 不得出现）已经在
`tests/test_runtime_versions.py` 里，随 pytest job 跑到了。

### 5. 类型安全还没兑现

`agent/tsconfig.json` 的 `strict` 仍关着，是**已知待办，不是终点**。实测
（2026-08-31）：`strict: true` 964 error（隐式 any 形参 646），只开
`strictNullChecks` 290 error。`src/runtime/**` 已单独用 `tsconfig.runtime.json`
保住 strict。阶段 C 抽 health-routes 时，一个原样搬运的 `return;` 落在
`Promise<boolean>` 里，正是因为关着才通过——真跑起来 `/health` 返回 `undefined`。

agent 测试仍以 JS 为主（约 130 个 `.js` vs 14 个 `.ts`）。语言迁移没覆盖测试。

### 6. 零碎

- `agent/src/application/pi-run-executor.ts` 等 `pi-` 前缀文件名未改（纯改名）
- `exec/src/search/` 未移植 Skill 根搜索（Python 的 `SkillSearchRoots`），
  要与 ADR 0006 的启用集闸门对齐后再做
- 产物的 `source_execution_id` 溯源、`delete_by_session` 未移植（当前无调用方）
- `agent/package.json` 的 `dev` / `dev:worker` 仍写 `tsx watch server.js`，
  入口已经是 `server.ts` / `worker.ts`
- compose 服务名仍是 `sandbox`；`SANDBOX_DATABASE_URL` 的 compose 默认值还带着
  Python 的 `mysql+pymysql://` 方言——exec 用的是 Node / knex

`pi-mcp-adapter@2.11.0` **不是遗漏**：DSH 没有 MCP transport，Agent 侧
`tools/list` 还靠它。不要当死依赖删。

---

## 已知的坑（都踩过，别再踩）

| 坑 | 说明 |
|---|---|
| **只重建一个镜像** | `sandbox` 与 `sandbox-mcp` 是**同一镜像的两个入口**。只 build 其中一个，另一个还在跑旧代码。2026-08-30 因此追了半天一个「第一次成功、之后全 500」的假象 |
| **root 进容器跑 bwrap** | `docker compose exec` 默认是 root。`cap_drop: ALL` 下 root 建不了 user namespace，报 `No permissions to create new namespace`，看起来像宿主机不支持。服务是 uid 10001，用 `--user 10001:10001` |
| **共享 cordis Context** | `WorkspaceFileSystem` 构造时往 Context 注册 `fs` 服务，注册第二次即抛。**只能经 `exec/src/fs/make-workspace-fs.ts` 构造** |
| **两处各写一份路径** | Python venv 的挂载源与子进程 `PATH` 曾各写一份 `/app/.venv`，换基础镜像后同时失效，而挂载 `required:false` 静默宽恕 → 沙箱里 `python3` 退化成裸解释器且不报错。现收敛为 `AGENT_PYTHON_VENV` |
| **把 Python 的通配语法搬进 TS SDK** | MCP 的 DNS 重绑定允许列表，Python 支持 `localhost:*`，TS SDK 是精确匹配 → 所有带端口的 Host 全被 403。现自己实现 `matchesAllowList` |
| **500 不记日志** | 对外一句 "Sandbox operation failed"、对内什么都不写，等于让运维瞎着。窄桥的 500 分支现在会记脱敏后的原文 |
| macOS `/var`→`/private/var` | 临时目录先 `await fs.realpath()` |
| 控制面根在 macOS 不可写 | 测试要把 `roots` 指到 scratch 目录 |
| 布局棘轮会咬人 | 生产文件 ≤1000 行；抬预算要在 commit message 说明理由 |
| 宿主机 `~/.pi/agent/mcp.json` | 存在时 `agent/tests/pi/mcp-seam` 必失败（企业运行时禁止 ambient MCP 配置），移开即绿 |
| **`tsc` 通过不等于行为不变** | `strict: false` 下 `undefined` 可赋给任何类型。搬运代码时的 `return` / 早退 / 空值分支要人看 |
| **批量转换必须验字面量** | 转换脚本曾从字符串 `'redis://***'` 中间的 `/**` 开始吃注释，类型检查和整套测试都绿，只是脱敏结果多了个换行 |

---

## 主控的核心职责：独立验证

**不要看 subagent 的自述就通过。** 这条在前几次交接里就写着，而 Wave 3 证明了它还不够——
「自述通过 + 测试全绿 + 实现是假的」。所以补一条：

**看到 ✅ 时，去看那条 ✅ 的用例断言的是什么。** 断言形状的用例不算验收。

有效手法：
1. 拿 Python 原版逐行对，找「少」而非「错」（`git show 4dda7a9b:sandbox/...`）
2. 反向验证断言——把实现改回坏的，确认用例真的变红
3. **跑起来。** 两个最严重的 bug（共享 Context、DNS 允许列表）都是绿测试没抓到、
   `docker compose up` 之后五分钟内暴露的
