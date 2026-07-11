# Implementation Plan

1. 定义工具 catalog、副作用类别、三层策略和审计事件 schema。
2. 实现 SDK extensionFactory 的 tool_call/tool_result/session hooks。
3. 实现 PostgreSQL prepared/approval/executing/terminal 台账与 workspace lease。
4. 实现 `APPROVAL_ENABLED` 配置和 bypass 审计。
5. 在 Sandbox 增加独立 request-context、policy、lease、idempotency 校验。
6. 将所有内置/自定义工具迁入 catalog，删除散落审批 wrapper。
7. 增加绕过、hook 异常、并发、重复、敏感字段与 trace 测试。

## Validation

```bash
node --test api-server/tests/*.test.js
uv run pytest tests/test_policy_approval.py tests/test_approval.py tests/test_persistence.py -q
uv run pytest tests/ -q --tb=short
```

## Rollback Point

Agent Extension 可回滚镜像；Sandbox hard policy 与执行台账保持前向兼容并继续强制。

