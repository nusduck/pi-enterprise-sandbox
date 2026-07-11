# pi-coding-agent 使用与升级 ADR

## Goal

确认直接使用官方 Node SDK而非 fork/复刻，并固定本项目依赖的行为契约、版本策略和退出条件。

## Confirmed Facts

- 本地 `@earendil-works/pi-coding-agent@0.80.3` 为 MIT、Node >=22.19 ESM 包，无 Python 入口。
- SDK 提供 Extension tool_call/tool_result、Session JSONL、Skill/resource loader 和 ls/find/grep built-ins；SDK 本身不是安全 Sandbox。

## Requirements

- 直接使用官方 SDK，不开发 Python binding、不维护 fork、不完整复刻。
- 精确锁定版本并提交 lockfile；升级必须使用独立任务/PR。
- 黑盒兼容套件覆盖多轮、工具事件、Extension fail-safe、Session JSONL/branch/custom entries、取消与恢复。
- 记录实际使用的 API、事件、schema、Extension hooks 和安全边界。
- SDK built-in 文件/执行工具不得在 Agent 主机本地运行，必须覆盖为 Sandbox 工具。
- 只有许可证/维护中断/关键能力无法通过 Extension 解决时才重新评估 fork/兼容实现。

## Acceptance Criteria

- [ ] ADR 明确选择、备选项、非目标、许可证和维护责任。
- [ ] package.json 使用精确版本，lockfile 一致。
- [ ] compatibility suite 可对当前与候选 SDK 版本运行并输出差异。
- [ ] 升级/灰度/Session migration/Agent 镜像回滚 runbook 完整。

