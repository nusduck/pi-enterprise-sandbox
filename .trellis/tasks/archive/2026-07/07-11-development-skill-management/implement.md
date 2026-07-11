# Implementation Plan

1. 增加 SKILLS_MODE、来源 allowlist 与只读默认配置。
2. 实现 Skill registry/validator、原子本地安装和 HTTPS Git resolver。
3. 实现专用 Agent tools 与 Extension policy；阻止通用工具写 Skill 根。
4. 实现 loader reload/version 与审计。
5. 更新 Compose 开发/生产挂载模式和文档。
6. 增加成功、失败、路径逃逸、凭证泄露、原子回滚与 reload 测试。

## Validation

```bash
node --test api-server/tests/*.test.js
uv run pytest tests/test_agent_module.py tests/test_container_startup.py -q
docker compose config -q
```

## Rollback Point

切回 readonly 并恢复 Skill 目录快照；registry 元数据保留用于审计。

