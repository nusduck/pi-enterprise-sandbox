# 交接说明

**写于 2026-08-30。第三次交接。** 给接手 DSH 重建的下一个 agent。

先读这三份，它们是权威，本文件只讲"现在到哪了 / 怎么接"：

1. [`../dsh-rebuild.md`](../dsh-rebuild.md) —— 详细设计方案
2. [`gap-audit.md`](gap-audit.md) —— **逐函数移植对照**，这一轮最重要的产出
3. [`README.md`](README.md) —— 任务进度表与已定决策

分支：`refactor/dsh-rebuild`（**未合并**，`main` 未动）。

---

## 一句话背景

Agent 引擎 `@earendil-works/pi-coding-agent` 不可用，换成 DeepSeek 开源
`@deepseek-ai/dsh`，执行面 Python→TypeScript 重写。研发阶段，无历史迁移、无回退目标。

---

## 接手第一步

```bash
npx tsc --noEmit -p exec/tsconfig.json && npm test --prefix exec        # 期望 299 tests 全过
npx tsc --noEmit -p contract/tsconfig.json && npm test --prefix contract # 29 pass
npx tsc --noEmit -p agent/runtime/tsconfig.json                          # 0 error
exec/node_modules/.bin/tsc -p agent/tsconfig.json                        # 0 error
npm test --prefix agent                                                  # 1082 pass
uv run pytest -q                                                         # 96 passed
```

`agent/runtime` 的用例要**逐文件**跑，四个并行跑全量会超时：

```bash
for f in agent/runtime/test/*.test.ts; do
  (cd agent/runtime && npx tsx --test "test/$(basename "$f")")
done
```

---

## ⚠️ 这一轮最该记住的一件事

**Wave 3 曾经标着 ✅、231 个用例全绿，而搜索、产物、数据集三个子系统是占位实现。**

不是没写完——是**写了假的**：`find`/`grep` 忽略参数返回 `listDir()`；产物 submit
编造 `sha256: '0'.repeat(64)` 并回 201；数据集上传只校验头就回 201，字节根本没落盘。
测试没抓到，因为它们断言的是**响应形状**，而占位实现形状恰好是对的。

由此定下的规矩，写在 [README.md](README.md) 里，请继续守：

> 新增路由的验收用例必须断言**语义**。写完先问一句：
> **空实现能不能让这条用例通过？** 能就重写。

这一轮里我自己就踩了三次同样的坑（都已修）：

- 断言"二进制文件不在 grep 结果里"——空数组天然满足
- 断言"同一幂等键返回同一 id"——占位用 `ds_${Date.now()}`，同毫秒天然相等
- 断言"连续提交多次都成功"——却把已建好的 `fs` 实例传进服务，永远不会重复构造

---

## 已完成

| 子系统 | 状态 |
|---|---|
| `contract/` · `agent/runtime/` · `exec/` 三包 | ✅ |
| 隔离、文件、命令/作业、工作区/配额 | ✅ |
| **搜索**（`exec/src/search/`） | ✅ 2026-08-29 补齐 |
| **产物**（控制面快照） | ✅ 2026-08-29 补齐 |
| **数据集**（三段式流式） | ✅ 2026-08-29 补齐 |
| **MCP facade + 窄桥八条路由** | ✅ 2026-08-30 补齐并端到端验证 |
| `sandbox/` Python 面 | ✅ 整个删除 |
| 镜像工具链 | ✅ 构建通过，容器内逐项验过 |
| 文档（AGENTS/README/architecture/module-layout/api/development/deployment） | ✅ |
| ADR 0007 / 0008 | ✅ 转 Accepted，实施偏差记在文末 |

### 结构上与原设计的两处偏离（已记进 ADR）

1. `runtime/` → `agent/runtime/`：只有 agent 一个消费者，不是独立服务
2. `sandbox/mcp/` 从"本次不动"改为一并 TS 重写进 `exec/src/mcp/`：exec 镜像没有
   Python，"不动"实际等于"删掉它"

---

## 剩下什么

### 1. 真实链路的两半（都不在 macOS 上可做）

- **Bubblewrap 真实执行** —— macOS 的 Docker Desktop 不允许容器内创建非特权
  user namespace，`bwrap` 直接报 `No permissions to create new namespace`。
  链路的其余部分（facade → 窄桥 → exec → 调起 bwrap）已在 macOS 上验过。
  **需要 Linux 宿主。**
- **Agent 半段** —— 登录 → 建会话 → 带工具 Run → Worker 重启恢复 → logs/signal
  → 跨租户 404。**需要可用的 LLM 网关配置。**

### 2. 生产网关冒烟（上线准入项）

[ADR 0007 D6](../../adr/0007-agent-runtime-rebuild-on-dsh.md)。目前
`scripts/llmio-smoke.mjs` 只跑过 `api.deepseek.com`，没覆盖自有网关。
要看：剥离未知头、`include_usage`、缓存命中。

### 3. STATUS.md 的重新取证

[STATUS.md](../../STATUS.md) 已做过逐行重审，标出了哪些行的证据随代码一起消失了。
重新取证依赖上面第 1 项。

### 4. CI 还没纳入新包

`.github/workflows/test.yml` 只有 python / node-bff / node-agent / frontend /
compose / cross-service-smoke，**没有 exec 与 contract 的 job**。
依赖断言（`@earendil-works/*` 不得出现）已经在 `tests/test_runtime_versions.py`
里，随 pytest job 跑到了。

### 5. 零碎

- `agent/src/application/pi-run-executor.js` 等 `pi-` 前缀文件名未改（纯改名）
- `exec/src/search/` 未移植 Skill 根搜索（Python 的 `SkillSearchRoots`），
  要与 ADR 0006 的启用集闸门对齐后再做
- 产物的 `source_execution_id` 溯源、`delete_by_session` 未移植（当前无调用方）

---

## 已知的坑（都踩过，别再踩）

| 坑 | 说明 |
|---|---|
| **只重建一个镜像** | `sandbox` 与 `sandbox-mcp` 是**同一镜像的两个入口**。只 build 其中一个，另一个还在跑旧代码。2026-08-30 因此追了半天一个"第一次成功、之后全 500"的假象 |
| **共享 cordis Context** | `WorkspaceFileSystem` 构造时往 Context 注册 `fs` 服务，注册第二次即抛。**只能经 `exec/src/fs/make-workspace-fs.ts` 构造** |
| **两处各写一份路径** | Python venv 的挂载源与子进程 `PATH` 曾各写一份 `/app/.venv`，换基础镜像后同时失效，而挂载 `required:false` 静默宽恕 → 沙箱里 `python3` 退化成裸解释器且不报错。现收敛为 `AGENT_PYTHON_VENV` |
| **把 Python 的通配语法搬进 TS SDK** | MCP 的 DNS 重绑定允许列表，Python 支持 `localhost:*`，TS SDK 是精确匹配 → 所有带端口的 Host 全被 403。现自己实现 `matchesAllowList` |
| **500 不记日志** | 对外一句 "Sandbox operation failed"、对内什么都不写，等于让运维瞎着。窄桥的 500 分支现在会记脱敏后的原文 |
| macOS `/var`→`/private/var` | 临时目录先 `await fs.realpath()` |
| 控制面根在 macOS 不可写 | 测试要把 `roots` 指到 scratch 目录 |
| `agent/runtime` 全量并跑超时 | 逐文件跑 |
| 布局棘轮会咬人 | 生产文件 ≤1000 行；抬预算要在 commit message 说明理由 |
| 宿主机 `~/.pi/agent/mcp.json` | 存在时 `agent/tests/pi/mcp-seam` 必失败（企业运行时禁止 ambient MCP 配置），移开即绿 |

---

## 主控的核心职责：独立验证

**不要看 subagent 的自述就通过。** 这条在前两次交接里就写着，而这一轮证明了它还不够——
Wave 3 是"自述通过 + 测试全绿 + 实现是假的"。所以补一条：

**看到 ✅ 时，去看那条 ✅ 的用例断言的是什么。** 断言形状的用例不算验收。

有效手法：
1. 拿 Python 原版逐行对，找"少"而非"错"（`git show 4dda7a9b:sandbox/...`）
2. 反向验证断言——把实现改回坏的，确认用例真的变红
3. **跑起来**。这一轮两个最严重的 bug（共享 Context、DNS 允许列表）都是 299 个
   绿测试没抓到、`docker compose up` 之后五分钟内暴露的
