# Implementation Plan

1. 定义共享 tool schemas、响应和错误码。
2. 实现安全 ls/find 迭代器与预算控制。
3. 实现 literal/受限 regex grep、二进制检测和稳定排序。
4. 增加 Sandbox routes/services/policy/audit。
5. 在 Agent Extension 覆盖 SDK 内置同名工具并加入 allowlist。
6. 增加资源/逃逸/截断/并发测试与文档。

## Validation

```bash
uv run pytest tests/ -q -k 'file or path or grep or find or ls'
node --test api-server/tests/*.test.js
uv run pytest tests/ -q --tb=short
```

## Rollback Point

通过 Agent tool catalog 回滚暴露；Sandbox API 保持认证且默认不可由外部直接调用。

