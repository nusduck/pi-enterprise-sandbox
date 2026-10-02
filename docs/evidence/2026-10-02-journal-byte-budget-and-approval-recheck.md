# 2026-10-02 Journal 分页字节预算 + 审批续跑账本复查

**对象：** `main` @ `59dbf6af` + 未提交改动（`session-journal-repository.ts`、`execute-run-service.ts`、`run-worker.ts`、
`fake-knex.js`、两份文档）。`agent` / `agent-worker` / `api-server` 已按 AGENTS §4 重建；Compose 用
`AGENT_RUN_QUEUE_PREFIX={compose-verify}` 与 K8s `dsh-dev`（当时仍有 1 个 `agent-worker` 副本）隔离队列。
模型 `deepseek-flash`，经 LLMIO 网关。runtime：agent 测试在 `node:22` 容器内跑；宿主 Node 26 不用于验收。

## 一、Journal 分页字节预算

**改动：** `listBySession` 先用同一个 `FORCE INDEX` 只取 `(sequence_no, JSON_STORAGE_SIZE(content_json))` 探测本页，
按累计 16 MiB（`JOURNAL_PAGE_BYTE_BUDGET`）确定页尾，至少一行；再按 `sequence_no <= 页尾` 取整行。
`listAllBySession` 不再用「不足一页」判断到头，读到空页为止（页可能因预算提前截断）。

| 证据 | 结果 |
|---|---|
| 回归 `字节预算提前截页…`（`session-journal.unit.test.js`） | 旧实现失败、新实现通过：预算内截页、`maxBytes=1` 仍返回 1 行、逐页翻完 7 行不丢不乱序、默认预算整体加载完整 |
| 真实 MySQL 5.7 直跑探测 SQL（`FORCE INDEX` + `JSON_STORAGE_SIZE`） | 返回 `283` / `902` 等字节数，语法与索引可用 |
| 真机链路 | 重建后注册新账号、`gate-bash-approval` 发 Run → `WAITING_APPROVAL` → 批准 → `SUCCEEDED`；续跑会重读 Journal，agent / worker 日志无错误；该会话 journal 1 header + 5 entry |

**边界：** 没有构造真正 GB 级的图片条目做压力测试；预算只限制**单页**读入量，`loadPayload` 仍会累计整个会话。
`JSON_STORAGE_SIZE` 是 JSON 二进制存储大小，与传输字节同量级但不相等。

## 二、审批续跑后原账本行停 `RUNNING`（第三次复查）

同上链路：该 Run 的 `tbl_agsvc_tool_executions` 只有 1 行，`bash`、`SUCCEEDED`、`result_json` 非空，工具台账接口一致。
与 [2026-10-02 上午](2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md) 两次结果相同：**未复现**，仍只能说这个版本、`bash` 上不复现，
不能据此断言已修复。

## 三、顺带发现：已取消 Run 下的 `RUNNING` 台账行

全库有 2 行 `RUNNING`，所属 Run 都是 `CANCELLED`（2026-10-01 21:30 UTC，上午 Worker 强杀 gate 留下）：
`delegate_to_agent`（`01M3WP0MGSAPX28NSZBKCGE9J7`）与 `bash`（`01M3WP0PNWC8WS63WVJAKD7SJ4`）。
Run 终态后台账行不会被收尾，审计会看到永不结束的行。**未定位根因，未修复。**

## 四、其他验证

- `uv run pytest -q`：223 passed。
- `npm test --prefix agent`（`node:22` 容器）：1948 pass / 0 fail。
- `npm --prefix agent run typecheck`：通过。
- **未跑：** exec / contract / api-server / frontend 套件与 frontend build——本次没有改动这些包（`api-server` 仅重建镜像）。
