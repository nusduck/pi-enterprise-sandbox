# 任务书与进度

DSH 重建的施工分解。设计依据见 [dsh-rebuild.md](../dsh-rebuild.md)、
[ADR 0007](../../adr/0007-agent-runtime-rebuild-on-dsh.md)、
[ADR 0008](../../adr/0008-sandbox-isolation-and-fs-seam-redesign.md)。

**2026-08-31：** Wave 0–7 与 agent 内部整理（阶段 0 / A′–G）都已落地。
当前进度与剩余项以 [HANDOFF.md](HANDOFF.md) 和
[agent-ts-rebuild.md](../agent-ts-rebuild.md) 顶部的表为准。下面这张波次表
保留施工记录；Wave 3 当年交回的是占位实现，真正补齐在 Wave 7。

**每份任务书都默认继承 [`_shared.md`](_shared.md) 的全部约束**，只写自己特有的部分。

## 怎么用

1. 主控写任务书到本目录
2. 派 subagent 执行，让它先读本目录的任务书 + `_shared.md`
3. 主控**独立验证**（不看 agent 自述），不合格退回
4. 通过后在下表更新状态

> **验证为什么必须独立做**：Wave 1 三个任务交回来时**测试全是绿的**，
> 但每个里面都有一处 fail-open 缺陷。测试绿证明不了移植没掉东西——
> 因为原来的测试压根没测到那几条，改写过来自然也测不到。
>
> **2026-08-29 复盘，同一个坑更深的一次**：Wave 3 交回时 231 个用例全绿，
> 进度表标成 ✅，但产物、数据集、搜索三块是**占位实现**——用例断言的是
> 响应形状，占位实现形状恰好是对的。逐函数对照见
> [gap-audit.md](gap-audit.md)，`exec/test/semantic-gaps.test.ts` 是把这些
> 缺口固定成红色的 9 条语义用例。
>
> **由此新增一条硬规矩**：新增路由的验收用例必须断言**语义**（grep 断言匹配到
> 的行、artifact 断言字节 round-trip、dataset 断言读得回来），断言形状的用例
> 不算验收。写完先问一句：**空实现能不能让这条用例通过？**能就重写。

## 进度

| 任务 | 内容 | 状态 |
|---|---|---|
| **Wave 0** | 地基（主控自做） | ✅ |
| | ADR 0005 转 Superseded、0007/0008 重写 | ✅ |
| | `contract/` `runtime/` `exec/` 三包骨架，版本逐个核实 | ✅ |
| | LLMIO 网关冒烟（四探针全过），`scripts/llmio-smoke.mjs` | ✅ |
| | `agent/tsconfig.json` 开 checkJs；布局测试纳入三个新包 | ✅ |
| **Wave 1** | 契约与文件面 | ✅ |
| [W1-A](w1-a.md) | `contract/`：RPC 信封、HMAC、错误码 | ✅ 29/29 |
| [W1-B](w1-b.md) | `exec/src/fs/`：`WorkspaceFileSystem` + 可写根 + 脱敏 | ✅ 62/62 |
| [W1-C](w1-c.md) | `exec/src/isolation/`：Profile 建模 + `render()` + preflight 同源 | ✅ |
| **Wave 2** | 执行与作业 | ✅ |
| [W2-A](w2-a.md) | `exec/src/shell/executor.ts` + 宿主 env 过滤 | ✅ |
| [W2-B](w2-b.md) | `exec/src/shell/job-registry.ts`（MySQL 支撑） | ✅ |
| [W2-C](w2-c.md) | `exec/src/workspace/`：工作区、持久 tmp、配额、锁抽象 | ✅ |
| [W2-D](w2-d.md) | `agent/` 的 220 个 checkJs 错误 | ✅ 0 error |
| **Wave 3** | 执行面其余（**W3-D 必须先单独跑**，接口定死再并行其余三个） | ✅ 经 Wave 7 补齐 |
| W3-A | `exec/src/http/internal-*` + HMAC 中间件 | ✅ Wave 7：find/grep/artifact 不再是占位 |
| W3-B | `exec/src/artifact/` + `dataset/` + `attachment/` | ✅ Wave 7：产物走控制面快照，数据集三段式流式 |
| W3-C | `exec/src/http/public/`：公共面，对 BFF 契约逐字节不变 | ✅ 语义用例在 `exec/test/semantic-gaps.test.ts` |
| W3-D | `exec/src/db/`：仓储层 | ✅ `exec_artifacts` / `exec_datasets` 已扩列 |
| **Wave 4** | Agent 侧 provider | ✅ 独立验收（不看 subagent 自述） |
| W4-A | `runtime/providers/remote-{fs,shell,jobs}.ts` | ✅ RPC 代理，本机零文件/进程 |
| W4-B | `runtime/providers/mysql-session-store.ts`（8 个方法） | ✅ 官方 chunk-rows + seq 校验 |
| W4-C | `runtime/providers/{durable-subagent,enabled-skills,memory}.ts` | ✅ 同进程契约对不上，自建队列面 |
| W4-D | `runtime/boot.ts` + `bundle/cordis.patch.yml` | ✅ 叠 dsh-base，本机执行族 disabled |
| **Wave 5** | 策略与投影 | ✅ |
| W5-A | `runtime/policy/`：四个挂载点 | ✅ |
| W5-B | `runtime/projection/`：SSE 契约逐字节不变 | ✅ `sse_events.json` |
| W5-C | `runtime/prompt/enterprise-clauses.ts` | ✅ |
| **Wave 6** | 接线与收敛 | ✅ |
| W6-A | `agent/` 接线；删除 `infrastructure/pi/` 与 `extensions/` | ✅ |
| W6-B | A2A 换 `@a2a-js/sdk` + 适配层 | ✅ |
| W6-C | 追踪：保留自建 span，挂 OTel 导出 | ✅ 既有 OTel 保留 |
| W6-D | 删除 `sandbox/` 执行面；文档与 `runtime-versions.json` 同步 | ✅ mcp 保留 |
| W6-E | 去掉 `agent/tsconfig` exclude、`@ts-nocheck`、W2-D 四条抬预算 | ✅ checkJs 0；四条预算已收回 |

## 已定的决策（施工时不要再问）

- **单实例部署**，多实例扩展点按设计文档 §5.4 预留（信封必带 `workspaceId`、锁抽象成接口、启动断言进程数为 1）
- **`danger-full-access` 已删除**：DSH 那个词汇是单用户本机场景的，多租户下"完全放开"不该存在
- **无历史数据迁移，无回退目标**：研发阶段，本次发布不可逆
- **能用 DSH 原生的一律用原生**，自建清单见 ADR 0007 D2
- ~~**`sandbox/mcp/`（1192 行）本次不动**~~ —— **2026-08-30 推翻**：exec 镜像是
  `node:22-slim`，没有 Python，"不动"实际等于"删掉它"。已按 ADR 0007 D1 一并用 TS
  重写进 `exec/src/mcp/`，作为同一镜像的第二入口
- **`sandbox/skill-runtime/` 是运行时资产**（三个 shell 启动垫片），原样迁入 `exec/`
- **`runtime/` 的位置折了两层**：先从顶层挪到 `agent/runtime/`（2026-08-30），
  再在阶段 F 并进 `agent/src/runtime/`（2026-08-31）。下表 W4/W5 行里的
  `runtime/...` 路径现读作 `agent/src/runtime/...`。独立 `@pi/runtime` 包已经没有了。

## 待办的跨任务事项（主控负责）

- ~~`AGENT_WORKSPACE_PATH` / `AGENT_TEMP_PATH` 两处重复定义~~ —— 已收口到
  `exec/src/isolation/profile.ts`；`AGENT_PYTHON_VENV` 同样是单一事实源
- ~~W2-B / W2-C 的持久化接口交给 W3-D~~ —— 已统一在 `exec/src/db/`
- ~~Wave 6 去掉 tsconfig exclude 与 `@ts-nocheck`~~ —— 已完成，checkJs 0

剩余待办见 [HANDOFF.md](HANDOFF.md) 的"剩下什么"。

## Wave 7 —— gap-audit 的补齐（2026-08-29 / 30）

Wave 3 标 ✅ 时，搜索、产物、数据集三块是占位实现。补齐记录：

| 任务 | 产出 | 状态 |
|---|---|---|
| W7-A | `exec/src/search/`：ls / find / grep，内部面与公共面共用 | ✅ |
| W7-B | 产物改控制面快照 + `control-plane-storage.ts`；`exec_artifacts` 扩列 | ✅ |
| W7-C | 数据集改三段式流式；`exec_datasets` 扩列 + 幂等键 | ✅ |
| W7-D | `exec/Dockerfile` 补模型工具链；`test_skill_runtime_dependencies.py` 重新写严 | ✅ |
| W7-E | MCP facade 移植进 `exec/src/mcp/` + 窄桥八条路由；`sandbox/` 删除 | ✅ |
| W7-F | 文档收口：AGENTS / README / architecture / module-layout / api / development；ADR 转 Accepted；STATUS 逐行重审 | ✅ |

> **Wave 7 之后的 agent 内部整理**另立方案
> [`../agent-ts-rebuild.md`](../agent-ts-rebuild.md)，阶段 0 / A′–G **已完成**。
> W6-A 当时漏掉的一层（`infrastructure/sandbox/` 的 17 个 `internal-*-http`
> 与 remote provider 双轨并行）已在阶段 A″ 删掉；工具路径只走
> `agent/src/runtime/providers/remote-*.ts`，公共面 client 仍留在
> `infrastructure/sandbox/`。
>
> 还没做的不在这张施工表里：Linux 真机、LLM 网关链路、CI 纳入 exec/contract、
> `strict`、以及 [HANDOFF.md](HANDOFF.md)「剩下什么」列出的零碎。

**起栈后才发现、299 个绿测试没抓到的两个 bug**（详见 [HANDOFF](HANDOFF.md) 的坑表）：
共享 cordis Context 导致每进程只有第一次产物提交成功；把 Python 的 `host:*` 通配
语法搬进只做精确匹配的 TS SDK，导致 MCP 面拒绝所有带端口的 Host。
