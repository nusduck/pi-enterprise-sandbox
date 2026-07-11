# 下一轮证据审计与决策记录

## 历史流程证据

| 发现 | 证据 | 对应需求 |
|---|---|---|
| 17 个归档 task 全为 completed，但仍有 72 个 PRD 未勾选项、11 个 implement 未勾选项 | `.trellis/tasks/archive/2026-07/07-11-*` | R4 |
| 7 个 `check.jsonl` 为空或保留 `_example` | archived task manifests | R4 |
| 三个 journal 曾默认写入 `Validation was not recorded` | `.trellis/workspace/nusduck/journal-1.md`、`.trellis/scripts/add_session.py:62` | R4 |
| archive 直接写 completed，未检查验收、暂停状态和验证证据 | `.trellis/scripts/common/task_store.py:435-520` | R4 |

## 代码与真实运行证据

| 发现 | 证据 | 对应需求 |
|---|---|---|
| 旧 SQLite ownership migration 顺序会在索引创建时先失败 | `sandbox/database.py:408-419` | R1；本轮选择清库而非迁移旧数据 |
| 公共逻辑路径与真实 cwd 不一致，API 文档泄露物理 workspace | `sandbox/security/safe_env.py:33-35`、`sandbox/services/execution_manager.py:209`、`docs/api.md:156-162` | R2 |
| Agent event 使用 `MAX(sequence)+1`，真实并发运行出现唯一键冲突和事件 append 500 | `sandbox/repositories.py:773-805` | R3 |
| draft cleanup 未接生产循环，audit cleanup 是 no-op | `sandbox/main.py:47`、`sandbox/services/ttl_cleanup.py:44-91` | R5 |
| trace 查询没有 actor/org 过滤 | `sandbox/routers/traces.py:13-26` | R5 |
| production 可使用空 service token/JWT，CORS wildcard + credentials | `docker-compose.yml`、`docker-compose.prod.yml`、`sandbox/main.py:127-128` | R6 |
| CI Node 20 与 Node 服务镜像 22 不一致，包级测试曾漏掉 BFF import 缺口 | `.github/workflows/test.yml`、`agent/Dockerfile`、`api-server/Dockerfile` | R7 |
| 活跃文档仍混有旧物理路径和已删除拓扑描述 | `docs/api.md`、`docs/architecture.md`、`.trellis/spec/` | R8 |
| 当前 `.env` 仅声明 8 个变量，Sandbox 未统一加载 env file；模型 context/max tokens/provider compat、workspace/system prompt 等仍有硬编码 | `.env` 变量名清单、`agent/config.js`、`agent/chat-runner.js`、`docker-compose.yml` | R6 |

## 已决范围

- R1-R8 全部属于同一轮发布阻断。
- 保持四服务拓扑，不新增 runner，不要求容器运行时或 Kubernetes 管理权限。
- PostgreSQL 是唯一生产数据库；SQLite 只从空库用于开发/测试。
- 当前研发数据、workspace、attachment 全部不可逆清空，不迁移、不备份。
- 取消 `/home/sandbox/workspace` 和 `workspace_path`，无兼容期；使用相对路径和 opaque `workspace_id`。
- 清空 `skills/` 下全部 Skill package，保留零 Skill 可运行的管理/加载框架。
- 内置认证保持简单：关闭生产自注册，管理员预置/邀请，单个高熵 JWT secret + issuer/audience/expiry。
- 留存采用 24h/90d/180d 硬删除，Legal Hold 优先，不做软删除/归档。
- Trellis 未完成项默认阻断；有证据延期使用 `completed_with_deferred`。
- 允许停机式全量切换，不做双写、滚动升级或混合版本兼容。
- 所有部署相关可变项进入统一 env catalog；研发 `.env` 启用 Skill 编辑、Sandbox unrestricted outbound 和 system prompt 配置，production 对不安全组合 fail-fast。
- System prompt 分为 Env 可配置产品/角色层与不可覆盖平台安全/工具层；安全边界继续由代码强制。

## 已完成且只需回归的修复

- BFF draft upload session resolution。
- 只读 Skill 脚本执行与 Skill 根写保护的区分。
- 网络命令 token 匹配，避免源码子串误判。

这些修复不得重复实现，但必须进入最终回归矩阵。
