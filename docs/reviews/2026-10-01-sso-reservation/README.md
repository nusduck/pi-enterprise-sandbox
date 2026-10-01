# SSO 预留 P1：实施 review

日期：2026-10-01。基线 main `5bc21550`；工作分支 `codex/sso-reservation-main`。
本次结果为该基线上的未提交工作区，未创建 PR、未核对远端 CI/保护规则。

## 结论与范围

用户要求基于现有 main 优化设计，交给 DSH 实施，再由主代理 review。
已完成 [设计修订](../../design/sso-integration-reservation.md)、[任务交接](../../design/sso-reservation-tasks.md)
及 P1a/P1b 实施：可撤销 local 会话、当前 principal/RBAC 校验、登录能力投影、退出错误契约、
认证写请求防护、已有 SSE 重授权、浏览器身份代次与清理。

公司 OIDC/code/PKCE、身份关联/JIT/绑定、refresh、全局退出为 P2–P4，保持禁用。
这次不是公司 SSO 联调完成。冻结 plan 和原 §32 状态未改。

本轮 review 发现的问题已修正，真实链路与故障对照通过。
**全套验收不是全绿：Agent 有 1 项可在 main 复现的既有失败，合并前仍需处理或由维护方明确验收。**
详细命令、runtime、容器及限制见 [验证记录](../../evidence/2026-10-01-sso-reservation-p1.md)。

## 派发与验收责任

DSH CLI 分别承担 `agent/`、`api-server/`、`frontend/`，禁止互相覆盖、读密钥、操作共享 Docker/DB。
主代理负责设计/活跃文档、schema manifest、共享运行栈、review 与最终验收。
普通 DSH 子代理接口启动失败，没有产出；实际实现通过已安装的 `dsh headless --json -` 执行。

前端 DSH 最初越权收紧了 ChatContext 行数预算（1399→1369）；主代理核对后接纳该卫生变化，
没有提高预算，后续任务限制在指定文件内。

## Review 修正

| 项 | 问题与影响 | 最终修正与证据 |
|----|------------|----------------|
| R1 | local 登录在检查 active user/org/Membership 之前引导角色并签发 sid，停用身份可能获得新会话 | DSH 先增加 6 条失败回归，再把当前 principal 校验置于角色授予/签发前；同凭据组织变更须重新登录 |
| R2 | 内部 gate 的 401 若被当作退出成功，会掩盖 BFF↔Agent 配置故障 | 仅有明确 `INVALID_TOKEN` 的会话级 401 可归入无需撤销；内部 gate 401 是 503 未确认；生产入口代理测试覆盖 |
| R3 | 迟到的退出响应或 best-effort logout 可能覆盖新身份/清新 Cookie；me503 后错误恢复旧会话 | DSH 串行化 login/register/logout；清理推进身份代次；me401 仅清本机；仅确认 authenticated 后恢复目录/会话；丢弃旧代次响应 |
| R4 | Agent 断连/超时/成功响应无效 JSON 冒泡成通用 500 | 真实停止 Agent 复现；DSH 7 条回归修复前失败、修复后通过，另测真实有界黑洞超时；统一依赖 503，保留明确上游 401/422/存储503 |
| R5 | HTTP200 空 config 被宽松 schema/parseApi 当成“没有登录方式” | DSH 5 条 API 回归先失败；要求非空 mode 与至少一种已知方法；主代理使用现有 parseApiStrict 在 HTTP 边界校验，避免 schema transform 抛异常绕过 safeParse；BFF 同样拒绝空 methods，失败前 200、修复后503 |
| R6 | 若只在已结束 Run 上测 SSE，无法证明撤销关闭持续订阅 | 主代理用真实工具账本中的前台 sleep60 Run，先证明 SSE 仍开着再退出；13.811 秒后关闭，另一 sid 读取 Run 仍为 RUNNING |

主代理另核对了 JWT 常量时间比较、真实工厂/迁移/仓储接线、当前角色读取与 owner 绑定、
BFF acting 头权威路径、有限出站超时、容器运行用户。没有用内存仓储替代真实数据库验收。

## 未关闭的验收项

- Agent 全套 Linux Node22.23.2：1915/1916，通过真实插件 boot/MCP；失败为
  `agent-catalog-service.unit.test.js:449` 的 `options leaked headers`。
  main 原始 src/tests 在相同 Linux/Skills 夹具上同样失败（22/23）。
  实际匹配路径 `options.platformConstraints.skills.system.12.description`，来自 xlsx 描述中的
  “misplaced headers”。这是文本子串断言误报；没有在本 PR 顺手改测试。
- macOS Node22.19/22.23 的 Cordis HMR loader 问题在 main boot 也复现；Linux 插件链通过。
- exec 真数据库和宿主 bwrap 条件门禁未全部启用；Docker 真实工具/进程链已经通过，
  不能将该链路解释成 exec 所有条件门禁都通过。
- 公司侧协议与身份数据尚未提供/联调，生产 HTTPS/Secure Cookie 改造在后续 OIDC 阶段。
- 未查询远端 CI，也没有 CI/分支保护通过的结论。

## 派发期间的密钥事件

BFF DSH 首轮违反任务限制，读取 `.env`，其工具结果含 `SANDBOX_JWT_SECRET`。
主代理已将本轮本地派发日志中的对应结果替换为脱敏记录，没有将密钥写入源码/文档。
**DSH 自身历史是否仍保存该结果未确认，密钥尚未轮换。** 已向用户说明，需要轮换该 JWT 密钥；
后续 review 任务使用新 CLI 会话并再次明确禁止读取密钥。
本条只记录已确认事件和处理边界，不声明泄漏已完全清除。
