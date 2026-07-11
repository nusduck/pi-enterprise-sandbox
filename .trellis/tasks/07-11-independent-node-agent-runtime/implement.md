# Implementation Plan

1. 删除 Python Agent Runtime、开关、路由与死文档，跑完整回归。
2. 新建 `agent/` package、精确 SDK 依赖、配置/health/readiness。
3. 实现 versioned Run API、持久 SSE event log、租约与取消。
4. 迁移 SDK 初始化、model/resource loader、Extension 和 sandbox tools。
5. 将 `api-server` 收敛为薄 BFF/SSE relay，删除 SDK dependency。
6. 更新 Compose、生产 overlay、内部认证、网络与可观测性。
7. 实现停写/排空/迁移/冒烟/回滚 runbook。
8. 跑全栈 E2E 后删除旧内嵌 Agent 路径。

## Validation

```bash
node --test api-server/tests/*.test.js
npm test --prefix frontend
uv run pytest tests/ -q --tb=short
docker compose config -q
rg -n 'AGENT_RUNTIME|sandbox\.agent|/agent/chat' . --glob '!docs/archive/**'
```

## Rollback Point

切流前镜像、数据库备份和旧 BFF 配置是回滚点；切流后禁止同时恢复旧 Runtime 流量。

