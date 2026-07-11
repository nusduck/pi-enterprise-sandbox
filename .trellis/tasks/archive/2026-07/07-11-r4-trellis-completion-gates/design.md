# R4 技术设计

## Completion Validator

新增纯函数 validator，输入 task 目录和可选 completion mode，输出结构化 findings。检查顺序：task 状态 → PRD/implement checkbox → JSONL manifests → parent integration → validation evidence → deferred mapping。任何解析错误 fail-closed。

未完成项用稳定 acceptance ID 映射到 `deferred.jsonl`：

```json
{"acceptance_id":"AC-4","reason":"...","risk":"...","followup_task":"...","approved_by":"...","approved_at":"ISO-8601"}
```

仅当每个未完成项都有合法记录且 follow-up task 存在时，archive 才写 `completed_with_deferred`；否则拒绝且不修改 task.json、不移动目录、不提交。

## Validation Evidence

任务完成前要求 `validation.jsonl` 至少一条真实记录：

```json
{"command":"...","commit":"...","exit_code":0,"result":"...","recorded_at":"ISO-8601"}
```

不得记录 secret 或完整测试输出。Parent 还需显式 integration evidence。

## Journal 与 Parent Progress

`add_session.py` 在 Completed 模式下缺 validation evidence 时退出非零；planning session 可使用非 Completed 状态。Parent progress 分别计算 completed、completed_with_deferred、active，不把延期算作完整完成。

## 兼容和覆盖风险

旧归档 task 不回写；新门禁只约束此变更后的 archive。Trellis update 可能覆盖 `.trellis/scripts`，因此在仓库 `tests/` 增加黑盒 CLI 回归，覆盖后 CI 立即失败。
