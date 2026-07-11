# R4 实施计划

- [x] 为 completion validator、checkbox ID、manifest、validation/deferred schema 写失败测试。
- [x] 实现纯函数 validator 和结构化 CLI 错误，不改动文件。
- [x] 在 `task.py archive` 修改 task/move 目录前调用 validator。
- [x] 扩展 task status/progress 支持 `completed_with_deferred`。
- [x] 扩展 journal/session 记录，Completed 必须有 validation evidence。
- [x] 添加仓库外层回归测试，覆盖 Trellis update 覆盖检测和 scoped auto-commit 不回归。
- [x] 对本子任务运行新 validator，记录真实 validation evidence。

## Validation

```bash
uv run pytest tests/test_trellis_completion_gates.py -q
uv run pytest tests/ -q --tb=short
python3 .trellis/scripts/task.py validate 07-11-r4-trellis-completion-gates
git diff --check
```

## Rollback

门禁逻辑保持纯校验并位于 archive 所有写操作之前；若兼容问题必须回滚，只回滚 validator 接入，不修改已存在归档 task。
