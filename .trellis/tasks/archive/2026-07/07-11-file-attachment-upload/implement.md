# Implementation Plan

1. 增加 attachment schema、状态机、幂等约束与 TTL cleanup。
2. 将 BFF/Sandbox multipart 改为分块转发和临时文件原子提交；统一 413/业务码。
3. 实现白名单、MIME/扩展校验、单文件/单回合/workspace 限额。
4. 重构前端 state/render/main：附件列表、进度、移除、重试和发送门禁。
5. 扩展 user-message 协议与 Agent manifest 注入；视觉图片按模型能力内联。
6. 增加失败注入、取消、重复、同名、并发、压缩包和内存上限测试。
7. 用同一 trace_id 复现并定位原“内部错误”，将根因和回归用例写入 research。

## Validation

```bash
uv run pytest tests/test_isolation_and_delivery.py tests/test_file_manager.py -q
node --test api-server/tests/*.test.js
npm test --prefix frontend
npm run build --prefix frontend
```

## Rollback Point

前端切换前保留旧路由 feature gate；数据库/隔离路径为前向兼容，回滚不得恢复覆盖式文件写入。

