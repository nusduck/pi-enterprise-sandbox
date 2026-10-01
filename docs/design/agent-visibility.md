# 智能体可见范围（按员工授权）

日期：2026-10-02。分支 `codex/agent-visibility`，叠在 `codex/sso-oidc` 之上。
验证记录：[evidence/2026-10-02-agent-visibility.md](../evidence/2026-10-02-agent-visibility.md)。

## 1. 背景与决定

公司 SSO（[sso-oidc-dev.md](sso-oidc-dev.md)）让所有员工落进同一个 org，而智能体原本只按 org 隔离，
所以任何员工都能用任何智能体。参照 HiAgent 一类平台「发布范围」的常见做法，本期只做最小的一层
（2026-10-01 用户确认）：

- 每个智能体的可见范围是 **全员可用**（`org`）或 **指定员工**（`restricted`）；
- 指定员工按成员授权，admin 在管理页按工号/姓名搜索后添加；
- 不做：按部门/组授权（等公司通讯录接口）、空间/项目层、预先给未登录员工授权、
  编辑权下放（创建与编辑仍只有 admin）。

## 2. 规则

1. admin 能用本 org 的全部智能体（需要配置、试用受限智能体）；
2. `org` 智能体本 org 全员可用——迁移前的行为，存量智能体不变；
3. `restricted` 智能体只有授权名单里的成员可用；
4. 默认智能体（`通用智能体`）不能设为受限：它是没选智能体时的兜底；
5. 不可用一律与「不存在」同形：API 404，定时任务 400 同一句文案——存在性不泄漏（AGENTS.md §2）。

## 3. 数据

迁移 `20261002000003_agent_visibility.js`：

- `tbl_agsvc_agent_definitions.visibility CHAR(16) NOT NULL DEFAULT 'org'`；
- `tbl_agsvc_agent_user_grants`（PK `(agent_id, user_id)`，冗余 `org_id`，`granted_by`，`created_at`；
  索引 `ind_agsvc_aug_i1 (org_id, user_id)`、`ind_agsvc_aug_i2 (user_id)`）。

授权键是内部 `user_id`（ULID），不是工号：工号可变，`(iss, sub)` → user_id 的映射才稳定。
改回 `org` 时清空名单，避免以后改回受限时旧名单悄悄复活。

## 4. 判定入口

判定在 Agent（`agent/src/application/agent-access-service.ts`），**每个使用入口**都做，不能只过滤列表：

| 入口 | 位置 | 未授权时 |
|------|------|---------|
| 智能体列表（选择器） | `AgentCatalogService.listAgents` | 不出现 |
| 建会话 / 发起 Run 时显式选择 | `RunParentProvisioner.provision` | 404 |
| 已绑定会话的后续轮次 | 同上（绑定的 agent 也检查） | 404：**撤销立即生效** |
| 定时任务创建 / 修改 | `CronJobService.#assertAgentForOwner` | 400（与不存在同文案） |
| 定时任务执行 | `CronJobService.executeClaim` | 记 FAILED，不建 Run |

定时任务后台执行没有 BFF 角色头：按任务 owner 当下的 `member_roles` 读角色，所以 admin 自建的
定时任务不受影响，被撤销的员工下一次执行就失败。

不在本期范围：协作委派（智能体 A 委派给受限的 B）按 A 的配置执行，不再检查调用者对 B 的授权；
A2A 外部调用走管理员签发的凭据，不受员工授权影响。

## 5. API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/agents` | 每项增加 `visibility`；非 admin 只返回自己可用的 |
| `GET` | `/api/agents/{id}/access` | admin：`{agent_id, visibility, grants:[{user_id, username, display_name, granted_at}]}` |
| `PUT` | `/api/agents/{id}/access` | admin：body `{visibility, user_ids}`，整体替换；名单须为本 org 活跃成员，≤500 人 |

非 admin 调 access → 403；跨租户/不存在 → 404；`visibility` 非法、名单含非成员、默认智能体受限 → 400。
内部镜像 `/internal/agents/{id}/access`。

## 6. 管理页

「管理控制台 → 智能体」新增「可见范围」标签（新建时不显示）。保存即生效，不生成新版本，
也不影响配置草稿。列表里受限的智能体带「指定」标记。选人复用成员页搜索（`/api/admin/users?q=`）。
加载失败显示错误与重试（不当成全员可见）；保存失败保留草稿；切换智能体丢弃迟到响应。
并发编辑是后写覆盖（与成员角色页一致），保存后以服务端返回为准。
