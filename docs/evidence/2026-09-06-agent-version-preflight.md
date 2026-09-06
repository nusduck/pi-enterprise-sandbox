# AgentVersion 接入前的本地影响盘点

日期：2026-09-06（Asia/Singapore）。代码基线：`d3870cae` 加实施中的未提交改动。
关联：[实施计划 P0](../design/agent-version-runtime-integration-plan.md)、
[独立 review](../reviews/2026-09-05-agent-version-runtime/README.md)。

这是本地开发栈的只读盘点，**不是生产数据统计，也不是 P5 通过结论**。
采样时 Agent/Worker/exec 仍运行 2026-09-04 创建的容器，本次实施尚未重建到运行栈。

## 采样方法与边界

2026-09-05 23:51:58 UTC，经运行中的 `agent` 容器使用既有 MySQL 连接与仓库
`createMysqlKnex`，只读查询 `agent_versions`、`agent_definitions`、`agent_sessions`。
只输出聚合数量；不输出版本配置原文、persona、连接配置、凭据或用户身份。
查询带 15 秒超时，没有更新、迁移或回写任何行。

`activeVersions` 按 definition 的活跃指针统计；`boundSessions` 包括本地所有历史
AgentSession，不能解释成活跃用户、正在运行的会话或受影响的生产用户数量。

## 结果

| 范围 | 版本数 | 活跃指针引用的版本数 | 绑定的历史 AgentSession 数 |
|---|---:|---:|---:|
| 全部版本 | 2 | 2 | 118 |
| 无 `schemaVersion` 的 legacy 版本 | 2 | 2 | 118 |
| MCP 引用省略或空数组 | 2 | 2 | 118 |
| 含自定义 persona | 1 | 1 | 1 |

本样本没有显式 MCP server/tool 引用，没有固定模型或生成参数，也没有非空
`skills/extensions/sandboxPolicy/a2a` 或工具策略。零计数只描述此开发库。

当前收紧规则会使这两个 legacy 版本均获得零 MCP 授权；这不等于证明已有会话调用过
MCP，也不能据此判断生产迁移无影响。需要 MCP 的管理员应发布带明确 server 与
`enabledTools` 的新版本，并新建会话使用它；历史会话继续钉住原版本。

采样时，按版本 ID 排序后对 `[id, config_hash, config_json]` 序列计算的 SHA-256 为
`644460a674e026fa51352c3e6447d3983fcb6c804f823eeb3376b8006c272981`。
它只作此次历史内容的整体校验记录；新增版本会改变全表摘要，不能将全表摘要变化
直接认定为历史配置遭到改写。

## 尚未关闭的验收

- A2/A3：真实 DSH 拒绝回归已有阶段结果，合法审批放行、一次性消费、持久账本收尾和
  重建后真实工具链仍须补齐。
- A5：版本身份绑定已有实现；配置保存、实际模型参数和旧/新会话版本行为仍须联调取证。
- H5/H6：本次未读取生产配置、未做生产日志/密钥抽样，原有部分完成状态保持。

后续验收另新增证据文件，不改写本次采样结论。
