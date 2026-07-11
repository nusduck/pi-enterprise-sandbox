# Sandbox CIDR 与代理信任

## Goal

明确监听地址、允许来源与可信代理的独立语义，使 Sandbox HTTP/MCP 默认只供本机/内部 Agent 使用，外部访问必须显式授权。

## Requirements

- `SANDBOX_BIND_HOST` 控制监听；`0.0.0.0` 不等于允许任意来源。
- `SANDBOX_ALLOWED_CLIENT_CIDRS` 控制 HTTP/MCP 来源；默认仅本机/内部服务网络。
- 外部 MCP 直连必须显式 CIDR 且仍需 API Token；BFF 不直接执行 Sandbox 工具。
- 默认忽略 Forwarded/X-Forwarded-For，只用 TCP peer。
- 仅直接 peer 属于 `SANDBOX_TRUSTED_PROXY_CIDRS` 时解析代理链，从右向左剥离可信代理。
- 非法 bind/CIDR/trusted proxy 配置导致启动失败；allowlist 在业务路由前执行。

## Acceptance Criteria

- [ ] allowlist 内可访问，外部来源在认证/业务路由前拒绝。
- [ ] 伪造代理头不能绕过；可信代理多跳算法有测试。
- [ ] `0.0.0.0` + allowlist + Token 双重保护有效。
- [ ] Compose、本机、反向代理和外部 MCP 有配置示例。
- [ ] IPv4/IPv6、非法 CIDR、空列表和代理配置测试通过。

