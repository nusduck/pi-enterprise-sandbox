# Implementation Plan

1. 定义 bind/client/trusted-proxy 配置与启动校验。
2. 实现 effective client IP 解析库和 FastAPI middleware。
3. MCP 入口复用同一策略，保持 Token 校验。
4. 更新 Compose、生产 overlay、代理配置和 health 输出。
5. 增加 IPv4/IPv6、多跳、伪造、非法配置和路由前拒绝测试。

## Validation

```bash
uv run pytest tests/ -q -k 'auth or proxy or cidr or mcp'
uv run pytest tests/test_container_startup.py -q
docker compose config -q
```

## Rollback Point

保留旧配置备份；回滚镜像时同步恢复匹配配置，避免新变量被旧版本忽略而扩大暴露。

