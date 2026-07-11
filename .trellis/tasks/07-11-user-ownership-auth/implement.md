# Implementation Plan

1. 定义共享身份/request-context 契约与数据库迁移。
2. 在 BFF 实现认证、上下文生成和用户级 API 授权。
3. 在 Agent/Sandbox 验证服务身份与签名用户上下文。
4. 将 owner/org 写入 Conversation、workspace、Session、附件、Run、工具、审批、Artifact、审计。
5. 回填旧数据，加非空/外键/索引约束。
6. 增加同用户、跨用户、跨组织、伪造头与服务 Token 绕过测试。
7. 更新 API、部署和密钥轮换文档。

## Validation

```bash
uv run pytest tests/ -q --tb=short
node --test api-server/tests/*.test.js
npm test --prefix frontend
docker compose config -q
```

## Rollback Point

切换强制授权前保留数据库备份与 feature gate；回滚只关闭新鉴权入口，不删除归属列或回填结果。

