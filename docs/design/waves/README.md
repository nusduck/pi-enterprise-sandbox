# 任务书与进度

DSH 重建的施工分解。设计依据见 [dsh-rebuild.md](../dsh-rebuild.md)、
[ADR 0007](../../adr/0007-agent-runtime-rebuild-on-dsh.md)、
[ADR 0008](../../adr/0008-sandbox-isolation-and-fs-seam-redesign.md)。

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
| **Wave 3** | 执行面其余（**W3-D 必须先单独跑**，接口定死再并行其余三个） | ⚠️ 部分 |
| W3-A | `exec/src/http/internal-*` + HMAC 中间件 | ⚠️ fs/shell/jobs 真实；artifact 是占位，fs 的 find/grep 是占位 |
| W3-B | `exec/src/artifact/` + `dataset/` + `attachment/` | ❌ 仅 attachment 可用；artifact/dataset 见 [gap-audit](gap-audit.md) |
| W3-C | `exec/src/http/public/`：公共面，对 BFF 契约逐字节不变 | ⚠️ 形状一致、**语义不一致**：产物四条路由与数据集上传是占位 |
| W3-D | `exec/src/db/`：仓储层 | ⚠️ 表结构缺 `sha256`/`mime_type`，产物面补实现时要改 |
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
- **`sandbox/mcp/`（1192 行）本次不动**，Wave 6 之后补齐
- **`sandbox/skill-runtime/` 是运行时资产**（三个 shell 启动垫片），原样迁入 `exec/`

## 待办的跨任务事项（主控负责）

- `AGENT_WORKSPACE_PATH` / `AGENT_TEMP_PATH` 在 `exec/src/isolation/profile.ts` 与
  `exec/src/fs/path-policy.ts` 两处重复定义，收口时提到共享位置
- W2-B / W2-C 定义的持久化接口要交给 W3-D，避免各建一套仓储
- Wave 6 已去掉 `agent/tsconfig.json` 的 exclude 与 `@ts-nocheck` 横幅，W2-D 四条抬预算已收回
