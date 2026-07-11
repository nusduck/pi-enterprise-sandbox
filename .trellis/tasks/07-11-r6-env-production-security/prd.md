# R6 Env 配置面与生产安全

## Goal

建立四服务统一、类型化、可验证的 Env 配置面；研发 `.env` 可直接启用 Skill 编辑、Sandbox 外网和自定义产品 Prompt，production 对不安全组合 fail-fast。

## Requirements

- 所有部署相关可变项进入集中 catalog/schema，优先级为进程 env → env file → 安全默认值，支持 `*_FILE`。
- 研发 `.env`：development、Agent Skill RW/Sandbox RO、Skill development、Sandbox unrestricted outbound、模型/approval/system prompt 参数。
- System prompt = Env 产品/角色层 + 不可覆盖平台安全/工具/Artifact/secret 层。
- 网络收敛为 `disabled|allowlist|unrestricted` 单一模式，同时驱动命令策略和 iptables。
- Production 禁止 Skill RW/development、unrestricted、fake provider、空 secret、wildcard CORS 和公开自注册。
- 内置 HS256 使用强 secret、issuer/audience/expiry；管理员预置/邀请用户。
- Unknown env、类型/范围/组合、来源和脱敏 effective config 有测试。

## Acceptance Criteria

- [x] 完整 Env catalog 与 `.env.example` 自动一致，无 secret。
- [x] 研发 `.env` 启动后 Skill 可编辑、Sandbox 可出网、产品 Prompt 生效且平台层保留。
- [x] Production unsafe matrix 全部在监听端口前失败。
- [x] Effective config 不输出 token、secret、DSN 或完整 Prompt。
- [x] 安全 hard-deny 等不变量不能被 Env 关闭。
