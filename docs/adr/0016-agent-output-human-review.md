# ADR 0016: 智能体交付物人工审核——exec 持有产物可见性，agent 持有审核账本

| 字段 | 值 |
|---|---|
| 状态 | **Accepted**（2026-10-01 实施并完成真实链路验收；证据见 [evidence/2026-10-01-agent-output-review-live-chain.md](../evidence/2026-10-01-agent-output-review-live-chain.md)） |
| 日期 | 2026-10-01 |
| 决策所有者 | Agent runtime / Sandbox isolation maintainers |
| 适用范围 | `agent/` 的 AgentVersion 配置契约、Run 终态处理与审核账本；`contract/` 的会话确保契约；`exec/` 的产物与工作区 owner 公共面、新增内部端点；`api-server/` 的审核代理路由；前端交付卡片与审核工作台 |
| 关联决策 | [ADR 0009](0009-dsh-host-tools-and-application-steward.md) D4（`submit_artifact` 保留）、[ADR 0013](0013-upspec-table-naming.md)（表/索引命名）、[ADR 0014](0014-sse-contract-is-the-platform-events.md)（SSE 契约即平台事件）、[RBAC 一期](../design/rbac-roles.md)（`reviewer` 角色） |
| 设计稿 | [`design/agent-output-review.md`](../design/agent-output-review.md) |

---

## 背景

部分智能体（例如案例分析）的**交付物**不能直接给发起人，要先由第三方审核员审阅、可以修订、确认后才能交付。
聊天文字不在审核范围内。正式交付只有 `submit_artifact` 一条路：文件被复制成 exec 里的不可变产物，
发起人经 exec 的会话产物接口和跨会话产物库获取。其中产物库路径不经过 agent；另外，发起人还能直接读工作区
里的源文件。

## 决策

**D1 — 可见性是 exec 的事实。** 产物新增 `visibility`（`released` | `held` | `withdrawn`）。在 review 工作区里提交的
产物一律为 `held`，只能单向变为 `released` 或 `withdrawn`。exec 在全部 owner 公共面执行：会话产物、产物库、
导入只认 `released`；review 工作区的源文件、进程日志、数据集读取一律 404，上传照常允许。查询失败时 fail-closed。
工作区的 review 策略由 agent 在会话确保时经 HMAC 内部面设置，只能设置、不能撤销。

**D2 — 审核账本在 agent，Run 状态机不变。** Run 照常结束（plan §10 不改）。Run 进入任意终态时，若本轮有 `held`
产物，就在同一事务里建审核任务（`PENDING → IN_REVIEW → APPROVED | REJECTED`）。修订生成新的 exec 产物
（`revision_of` 链），原件永不覆盖。没有产物的 Run 不建任务，所以追问的回答不审核。

**D3 — 策略随 AgentVersion 固定。** `deliveryPolicy.mode`（`direct` | `review`）是版本配置字段。会话绑定版本且
不可更换，策略由服务端推导，不接受请求参数。review 模式与委派、A2A 暴露互斥。

**D4 — 放行经 outbox 跨服务传递。** 审核决定在 agent 事务内落账；exec 的状态变更由 outbox 至少一次投递，exec 侧幂等，
不把跨服务调用放进数据库事务。会话里的结果消息使用 plan §8.7 冻结枚举内的 `message_type`。

**D5 — 审核员只看快照，不进工作区。** 审核员需要 `reviewer` 角色，作用域为本组织，跨组织 404；禁止审核自己发起的任务。
审核员能看到的是用户提问、附件的不可变快照和待审交付物的各个版本，不获得发起人工作区的访问权。
exec 为此新增的内部端点只接受 agent 的 HMAC 凭据。

## 后果

- 正面：交付物在审核前拿不到，而且没有绕行路径；审计能回答「智能体交付了什么、谁修订了什么、谁在何时放行」；
  聊天体验不变；direct 智能体行为完全不变。
- 代价：review 会话里发起人看不到工作区文件；聊天文字和工具输出不审核，交付物的内容可能经文字泄露
  （设计稿 §11），审核管的是「正式发布」，不是内容保密。
- admin 运行控制台仍能看到待审产物的事件（用户已确认可以接受）。

## 验证要求

合入前必须在重建的容器栈（含 `sandbox` 与 `sandbox-mcp`）上用真实模型跑完设计稿 §10：每一条获取交付物的途径都有
「review 会话拒绝」与「direct 会话成功」一对证据；exec 需要单独证明 fail-closed。
