# R4 Trellis 可信完成门禁

## Goal

让 Trellis 的 `completed` 可被证据证明：未完成验收、placeholder manifest、暂停状态或缺少验证记录时默认禁止归档；明确延期使用独立状态。

## Requirements

- Archive 前解析 PRD/implement checkbox、task status、parent integration、context manifests 和 validation evidence。
- 未完成项只有匹配结构化 deferred 记录才能归档；字段含 acceptance ID、原因、风险、后续 task、批准人和时间。
- 有延期时状态为 `completed_with_deferred`，父级分别统计 completed/deferred。
- Journal 必须记录 commit、命令、退出码、结果；不得以 `Validation was not recorded` 标 Completed。
- 不提供无证据 `--force`；Trellis update 后外层测试可检测门禁被覆盖。

## Acceptance Criteria

- [x] 未勾选 AC、placeholder/空/坏 JSONL、planning/blocked/paused、缺验证分别被 archive 拒绝。
- [x] 合法 deferred 可归档为 `completed_with_deferred`，缺任一字段被拒绝。
- [x] 完整任务归档为 `completed`，父任务进度不把 deferred 当完整完成。
- [x] Journal 缺测试证据时不能标 Completed。
- [x] 现有 task/archive 正常路径和 scoped auto-commit 不回归。
