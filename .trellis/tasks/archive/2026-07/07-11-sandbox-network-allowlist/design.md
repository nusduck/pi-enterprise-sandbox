# Design

启动时解析所有网络配置为不可变 network policy；失败终止进程。最外层 ASGI middleware 获取 peer，只有 peer trusted 才解析标准代理头，计算 effective client IP 后应用 allowlist，再进入认证与路由。

HTTP 与 MCP 复用同一 policy library；指标只记录聚合拒绝原因，不记录伪造 header 明文。iptables 出站策略与入站 client allowlist 分离。

回滚可恢复旧镜像/配置，但不得以空/解析失败代表 allow-all。

