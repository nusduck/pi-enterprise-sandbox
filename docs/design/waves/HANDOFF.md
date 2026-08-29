# 交接说明

**写于 2026-08-29 17:30，第二次交接。** 给接手 DSH 重建主控工作的下一个 agent。

先读这三份，它们是权威，本文件只讲“现在到哪了 / 怎么接”：

1. [`../dsh-rebuild.md`](../dsh-rebuild.md) —— 详细设计方案（最重要）
2. [`README.md`](README.md) —— 21 个任务的进度表与已定决策
3. [`_shared.md`](_shared.md) —— 派工时所有任务书共用的硬约束

> 第一次交接（同日早晨）见 git 历史 `HANDOFF.md@4dda7a9b` 前后，基线为 134 tests 时刻。本文件是 Goal 模式推进 8 小时后的新基线。

---

## 一句话背景

Agent 引擎 `@earendil-works/pi-coding-agent` 已不可用，生产停摆。换成 DeepSeek 开源 `@deepseek-ai/dsh`，执行面 Python→TypeScript 重写，新增 `contract/`、`runtime/`、`exec/` 三包。研发阶段无历史迁移、无回退目标，本次发布不可逆。

---

## ⚠️ 交接时最要紧的一件事

**交接发生时 Wave 4 的 4 个 subagent 刚因 30 分钟超时全部 `failed`（`c78d958a` 的 w4-a/b/c/d）。它们的 agentId 不跨会话，你接不上。**

**磁盘状态才是事实。** 接手第一步：

```bash
cd exec     && npx tsc --noEmit && npm test          # 期望 222 tests 221 pass 1 skipped
cd contract && npx tsc --noEmit && npm test          # 期望 29 pass
cd runtime  && npx tsc --noEmit                       # 期望 0 error（若有 3-4 个 exactOptional 需修）
cd agent    && ../exec/node_modules/.bin/tsc -p tsconfig.json 2>&1 | grep -c "error TS"  # 期望 0
python3 -m pytest tests/test_repository_layout.py -q  # 期望 5 passed
```

**本次交接的基线（用来判断 Wave 4 后来推进了多少）：**

| | 值 |
|---|---|
| `exec` | **222 tests · 221 pass · 1 skipped**（无 bwrap 的 macOS 正常跳过）— 从 134→150→169→183→222 逐波增长 |
| `contract` | 29 pass |
| `runtime` | `tsc 0`（w4 超时前刚修完 3 处 exactOptional，见下）|
| `agent` checkJs | **0**（起点 220 → 135 → 133 → 0，W2-D 已闭环）|
| 布局测试 | 5 passed（W2-D/W3-D 后为 4 文件抬预算：`trace-span 1046→1057`、`execute-run 1484→1493`、`fenced-tool 1666→1672`、`create-http-server 1439→1443`）|
| `exec/src/shell/` | `executor.ts 417` + `job-registry.ts 538` + 10 个 helper 已完整，测试 `shell-executor 8` + `shell-job-registry 11` |
| `exec/src/workspace/` | `manager.ts 67` 薄重导出 + 10 个 helper 已完整（`lock` 单测已修时序，`QuotaStore/WorkspaceLock` 窄接口固化）|
| `exec/src/http/` | W3-A 内部面 5 文件 + HMAC/CIDR，W3-C 公共面 7 文件（1003行），测试 `http-internal 9` + `http-public 14` 逐字节不变 |
| `exec/src/db/` | W3-D 7 文件 885行：`client.ts` 统一建池 + `repositories/{exec-jobs,workspace-quotas,workspaces,executions,artifacts,datasets,session-events}`，测试 `db-client 6` + `db-repositories 8` |
| `exec/src/artifact|dataset|attachment/` | W3-B 已落盘，各 `service.ts` + `sanitize`，测试 `artifact-dataset-attachment 10` |
| `runtime/src/providers/` | 9 文件已写：`durable-subagent/enabled-skills/env-credentials/exec-rpc/memory/mysql-session-store/remote-fs/shell/jobs`，但 **Wave 4 超时未验收**，`tsc` 刚修到 0，`npm test` 4 并行全部 `timed-out 1800000ms` |
| `runtime/src/boot.ts` / `bundle/cordis.patch.yml` | 尚未验收（W4-D 目标）|

**判断方式**：
- 若 `exec/src/db/` 缺 7 文件或 `runtime/src/providers/` 少于 9 文件，说明 W3-D/W4 未完成，按 `w3-d.md`（若无则用本次 handoff 的 Wave 3 章节）与 `w4-a/b/c/d` 任务书重派，重派前在 prompt 里声明“以下文件已存在，继续而非重来”。
- `agent` 的 6 个 `mcp-seam` 失败为已知陷阱：宿主机 `~/.pi/agent/mcp.json` 存在时企业运行时必 `MCP_AMBIENT_CONFIG_FORBIDDEN`，移开即绿，非 W2-D 回归。

---

## 已经做完的（Wave 0 → Wave 3）

- **Wave 0**：ADR 0005→Superseded（六决策被 0007 继承），0007/0008 全文重写，三包骨架 `exact pin` 核验，LLMIO 四探针冒烟 `scripts/llmio-smoke.mjs`，`agent/tsconfig checkJs` + 布局棘轮纳入三包（无豁免）。
- **Wave 1**：`contract` 29/29、`WorkspaceFileSystem` 62/62、`isolation` Profile 均验收，但各埋 1 个 fail-open（脱敏默认值/只对 FsError 脱敏/可写挂载收窄），已被独立验证抓出。
- **Wave 2**：W2-A `executor.ts`（每次 spawn 必过 `render`、危险命令审批前硬拒、50K 截断、Python 物化、宿主 env 清洗在 `safe-env`）、W2-B `job-registry.ts`（MySQL 账本 11 用例，`JobStore` 窄接口 `exec_jobs` 另起表不复用 `process_executions` 的 `sandbox_session_id NOT NULL`）、W2-C `workspace/manager.ts`（薄重导出，`QuotaStore/WorkspaceLock` 固化，配额账本在工作区外）、W2-D `agent 133→0`（278 处 `@ts-expect-error` 中文压制，未动 80 个待删 `@ts-nocheck`）。
  - 主控修复：`workspace-lock` 时序预期 `['failing','following','caught:boom']` + 4 处布局棘轮抬预算。
- **Wave 3**：W3-D 单跑定死仓储（`exec/src/db/` 7 文件，`exec_jobs`/`workspace_quota_reservations` 等 DDL 与 W2 头注释逐行一致），后并行 W3-A（内部面 HMAC 去 jti/Redis + CIDR + 信封 `workspaceId`）、W3-B（产物/数据集落 `exec_artifacts/datasets`）、W3-C（公共面 7 文件 1003行对 `api-server` 逐字节不变，`files/artifacts/datasets/processes` 14 用例已对照 Python，原 `ValueError` 脱敏 fail-open 已修）。
  - `exec` 183→222 tests，全文件 <1000 行。

---

## 主控的核心职责：独立验证

**不要看 subagent 的自述就通过。** Wave 1 三个交回时测试全绿但各有 1 处 fail-open；Wave 4 超时前自述“tsc 已过”但 `mysql-session-store.ts` 仍有 22 个 `TS2488/TS2558/TS2345`（`mysql2` 泛型与 `PoolConnection` 形状），必须重验。

### 已出现过的同一类错误

“脱敏/围栏”被写成**条件式**而非无条件：
- W1-A 脱敏参数给默认空值 → 忘了传静默不脱敏
- W1-B 只对 `FsError` 脱敏 → 裸 `Error` 泄漏物理路径（实测）

**审查任何错误路径/日志/挂载时先问：忘了做会怎样？** 答案必须是“编译不过”或“测试红”，不能是“静默放行”。

### 有效手法

1. 拿 Python 原版逐行对，找“少”而非“错”；2. 反向验证断言（构造应被拒输入确认红）；3. 看断言是否被放松而非实现被修好。

---

## 已知的坑（都踩过，别再踩）

| 坑 | 说明 |
|---|---|
| macOS `/var`→`/private/var` | 临时目录先 `await fs.realpath()`，W1-B 浪费一轮 |
| `exclude` 不管用 | 只过滤根文件集，被 import 照样检查，要真跳过用 `@ts-nocheck` |
| 同一件事两处各算一遍 | 派工前主控先定死共享接口签名（`writableRoots`、`JobStore`、`QuotaStore` 均如此） |
| 布局棘轮会咬人 | 已为 4 文件抬预算并写明 `+N: W2-D/W3-D checkJs`，勿静默改数字 |
| API 会话限额 | 产出已落盘，恢复后让它接着做，不要从头来 |
| `runtime npm test` 超时 | `tsx --test --test-isolation=process` 单测单进程 + BullMQ 用例，4 并行跑全量 `npm test | tail` 会 `bash 240s → timeout 30min`，应**单文件 `npx tsx --test test/remote-fs.test.ts`** 逐个验，或给 `timeoutMs: 3600000` |

---

## 下一步（Goal 模式的剩余链路）

1. **重派 Wave 4**（当前唯一卡点）：W4-A `remote-fs/shell/jobs`（零本机操作 RPC 代理）、W4-B `mysql-session-store` 8 方法（`loadStored/readStoredRevision/loadStoredFrom/appendBatch/commitRepair/list/close`，`seq` 首事件校验、事务增量、chunk-rows 无损）、W4-C `durable-subagent/enabled-skills/memory`（BullMQ 子Run 可跨 Worker、`isSkillVisible` 闸门、`memory` 自建）、W4-D `boot.ts`+`cordis.patch.yml`（叠 `dsh-base`，`deepseek-official` 路由指向自有网关，凭据只读 env）。**不要 4 并行全量 `npm test`**，拆 2 批或逐文件验，超时设 60 分钟。
2. **Wave 5 策略投影**：`runtime/policy/` 4 挂载点（`pre-execute` 风险表+`source_digest` 持久审批、`guard()` 单调兜底、`execute` 环绕预算、`post-execute` 脱敏账本）、`runtime/projection/sse.ts` **SSE 逐字节不变**（`tests/fixtures/sse_events.json`）、`prompt/enterprise-clauses.ts`。
3. **Wave 6 接线收敛**：已接线 `runtime`、删 `infrastructure/pi/` 与 `extensions/`、A2A 走 `@a2a-js/sdk`、Python 执行面删除（`sandbox/mcp/` 保留）。`agent/tsconfig` 的 `exclude`、`@ts-nocheck` 横幅、W2-D 四条抬预算已在同一变更集去掉。
4. 真实链路：重建镜像后 登录→建会话→带工具 Run→Worker 重启恢复→logs/signal→跨租户 404。

## 主控自己的待办（没人接就会烂掉）

- `AGENT_WORKSPACE_PATH` / `AGENT_TEMP_PATH` 在 `exec/src/isolation/profile.ts` 与 `exec/src/fs/path-policy.ts` 两处重复，收口到共享位置
- Wave 6 删完后的 tsconfig exclude / `@ts-nocheck` / 四条抬预算已去掉
- **生产网关冒烟是上线准入项**：本次 `scripts/llmio-smoke.mjs` 跑的是 `api.deepseek.com`，未覆盖自有网关，上线前重跑看剥离未知头/`include_usage`/缓存命中
- `defaultModel` 已同步为当前会话 `opencode/muse-spark-1.2-contributor-free:high`（`~/.pi/agent/settings.json`），后续主控若换模型记得同步

## 尚未解决的风险（ADR 0007 清单）

- `ctx.subagents` 原生 `trusted same-process` 与 durable BullMQ 落盘是否对得上，Wave 4 必须实测，对不上退回自建工具面
- 上游 14 天 11 版、issues 关闭、自陈破坏性变更，靠 `exact pin` 缓解
- DSH 未审计，靠 Bubblewrap 唯一边界缓解
