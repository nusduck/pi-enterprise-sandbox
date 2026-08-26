# 2026-08-26 全库整体审查（Full Repo Review）

## 概要

对四个服务（agent / api-server / sandbox / frontend）做的全库两轴审查：

- **Standards 轴**：AGENTS.md 分层边界与安全不变量 + Fowler 坏味道基线。
- **Spec 轴**：`docs/plan.md` §32 最终验收标准逐条对照代码现实，并核对 STATUS.md 一致性。

方法：6 个并行只读子代理（4 服务 Standards + 2 组 Spec），全部结论带 file:line 证据。

## 文件

| 文件 | 内容 |
|------|------|
| [standards.md](standards.md) | 规范符合性：硬违规、坏味道、正面合规证据 |
| [spec.md](spec.md) | §32 验收标准逐条核验结果与 P2 保留意见 |

## 结论速览

- **Standards**：4 个硬发现，最严重为 **sandbox 出站调用链整体缺超时**（agent `sandbox-client.js` 公开面 + BFF `routes/files.js` 三处代理 fetch + `checkHealth()`），违反 AGENTS.md §2「所有出站调用有超时」；frontend 千行文件不在棘轮覆盖内。
- **Spec**：0 个 P0/P1 缺口，STATUS.md 未发现虚假 done 行；主要保留意见是 release-gate 类验收项离线不可复验。

## 后续动作

- P1 出站超时缺口 → 建议随下个 PR 统一修复（两侧 sandbox client 设全局默认 timeoutMs）。
- 死代码/冗余代码专项审查 → 见 [dead-code-review.md](dead-code-review.md)（同日补充）。

---

## 归档说明（2026-08-26 落地）

本报告的行动项已处理完毕，报告本身归档，**结论是当时的快照，不代表当前实现**。

| 发现 | 处理 |
|------|------|
| #1/#2/#3 Sandbox 出站调用链缺超时（agent `sandbox-client.js` 公开面、BFF `routes/files.js` 三处代理 fetch、两侧 `checkHealth`） | **已修**。两侧都有默认 deadline；字节流只约束到响应头，拿到 header 后清定时器。顺带修了审查未列出的 `routes/datasets.js` 两处同类裸 fetch。回归：`agent/tests/sandbox-client-timeout.unit.test.js`、`api-server/tests/sandbox-proxy-timeout.test.js`；重建容器后实测了两侧 `/health` 探针、文件上传/下载代理与运维进程面，见 `docs/evidence/2026-08-26-review-fixes-live-chain.md` |
| #4 frontend 千行约束突破且不在棘轮内 | **棘轮已扩**。`tests/test_repository_layout.py` 现在覆盖 `frontend/src` 与 `api-server/src`；四个越线的前端文件钉在当前行数，只能减不能增。**拆分本身未做**，见 `review-deferred-items.md` |
| 死代码：agent 16 个模块级封装 + `_testHelpers`、frontend 死函数与死转出口、sandbox 14 处未用 import + `sanitize_for_log`、`config/agent/settings.json` | **已删**。`config/agent/settings.json` 的决策依据：pi SDK 找的是 agent home（`/app/pi-agent-home`），而 `config/agent` 挂在 `/app/config/agent` |
| 坏味道（重复代码、Divergent Change、Data Clumps）、仅生产死导出、垫片链、`@earendil-works/pi-ai` 版本钉、`container_bwrap_smoke.py` | **未做，已转 `review-deferred-items.md`**，每条带证据、风险与需要的决策 |
| Spec 轴 P2 保留意见（release-gate 离线不可复验、B3 白名单棘轮、STATUS E1/E2 证据栏、D1 浏览器 harness、F5 真实链路 gate） | 保留。前四条仍是 live-gate 或文档细化；F5 相关的流式终态问题由同日的真实场景报告独立发现并修复 |
