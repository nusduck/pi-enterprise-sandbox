# 一线问题与架构演进需求

> 记录日期：2026-07-11  
> 来源：一线使用反馈  
> 状态：待评审、待拆分 Trellis 任务  
> 说明：本文记录问题、目标和验收口径，不代表具体技术方案已经定稿。

## 1. 背景与目标

当前项目已具备基础的对话、文件、Sandbox 执行、审批和产物交付能力，但一线使用中仍存在交互中断、路径语义不一致、Agent 与 Sandbox 职责混杂、Session 恢复不完整，以及工具安全策略分散等问题。

本轮演进目标是：

- 改善文件上传和附件交互，消除上传内部错误。
- 建立唯一、稳定的 Agent 可见路径契约。
- 将 Agent Runtime 从 Sandbox 执行服务中解耦。
- 完成 Agent Session 的持久化与恢复。
- 提供可配置的 Skill 安装和 Sandbox 网络白名单。
- 补齐基础文件检索工具，并通过 SDK Extension 统一安全治理。
- 明确是否以及以何种方式复刻 `pi-coding-agent`。

## 2. 问题总览

| 编号 | 问题/需求 | 建议优先级 | 类型 | 主要依赖 |
|---|---|---:|---|---|
| F-01 | 上传文件后改为附件追加到输入框，并修复上传内部错误 | P0 | 缺陷 + UX | 前端状态、上传 API、对话协议 |
| A-01 | 统一逻辑 cwd 与物理 workspace 路径语义 | P0 | 架构缺陷 | Session/workspace 模型、Extension |
| A-02 | Agent Runtime 移出 Sandbox，并使用 `pi-coding-agent` SDK | P0 | 架构重构 | A-01、A-03、S-03 |
| A-03 | Agent Session 完整持久化与恢复 | P0 | 数据完整性 | 数据模型、SDK Session 能力 |
| S-03 | 用 SDK Extension 统一路径保护、工具审计和审批 | P0 | 安全架构 | A-01、A-02 |
| T-01 | 增加 `ls`、`find`、`grep` 三个 Sandbox 工具 | P1 | 能力补齐 | S-03、路径策略 |
| S-01 | 外部 Skill 的可配置安装机制 | P1 | 可扩展性 | Skill registry、部署配置 |
| S-02 | 增加 Sandbox 对接 IP/CIDR 白名单 | P1 | 网络安全 | 容器网络、iptables |
| R-01 | 评估并定义“复刻 pi-coding-agent”的范围 | P1（决策） | 战略/研发 | 许可证、兼容目标、维护预算 |

## 3. 详细问题与验收标准

### F-01 文件上传与附件输入体验

**现象**

- 当前选择文件后会立即上传，并自动发送一条分析提示，用户无法在发送前确认附件、补充问题或移除附件。
- 当前文件上传链路存在“内部错误”，上传不能稳定完成；具体错误位置仍需通过浏览器、API Server 和 Sandbox 的同一 `trace_id` 日志定位。

**期望行为**

1. 用户选择文件后，文件先作为待发送附件追加到输入框附近，不立即发起对话。
2. 输入区显示附件名称、大小、上传/待上传状态，并支持移除。
3. 用户点击发送时，文本和附件作为同一个用户回合提交。
4. 上传失败时保留用户输入和附件项，展示可重试的明确错误，不自动发送不完整消息。
5. 多附件、重复附件、超限文件和发送中取消应有确定行为。

**验收标准**

- 选择文件不会自动发送消息。
- 用户可以在发送前添加文本、移除附件。
- 上传成功后，Agent 在同一回合能获得附件的稳定 workspace 引用。
- API Server 不会无上限缓冲上传；超限返回 `413` 或明确的业务错误。
- 上传失败可重试，前端不丢失输入内容。
- 有覆盖成功、失败、超限、取消和多附件的自动化测试。

### A-01 统一 cwd 与 workspace 路径契约

**现象**

- Agent/文档使用 `/home/sandbox/workspace` 等逻辑路径。
- 实际执行、文件 API 和 Session metadata 又可能暴露 `/var/sandbox/workspaces/...` 等物理路径。
- 同一个“当前工作目录”在提示词、工具参数、日志和执行进程中含义不同，容易造成找不到文件、路径泄露或错误的边界判断。

**目标契约**

- Agent、模型、工具 schema、用户可见日志只使用一个逻辑 cwd，例如 `/home/sandbox/workspace`。
- 物理 workspace 路径只由基础设施层持有，不进入模型消息和普通 API 响应。
- 所有路径参数先相对逻辑 cwd 解析，再由统一映射层转换到该 Session 的物理根目录。
- 禁止依赖进程级全局 symlink 表达并发 Session 的 cwd。

**验收标准**

- Bash/Python/Node、文件、Artifact、MCP 和新增检索工具观察到相同 cwd。
- 任意并发 Session 不会因 cwd 映射互相串目录。
- API、SSE、提示词和审计日志不泄露宿主物理 workspace 路径。
- 路径逃逸、symlink、绝对路径、并发隔离均有测试。

### S-01 外部 Skill 安装配置

**现象**

研发环境只能依赖镜像内置或手工挂载 Skill，缺少统一、可复现、可关闭的外部 Skill 安装流程。

**期望能力**

- 增加显式配置开关，例如 `EXTERNAL_SKILLS_ENABLED=false`，默认关闭外部安装。
- 支持声明式 Skill 清单，至少包含来源、版本/commit、校验信息和启用状态。
- 安装发生在构建或受控初始化阶段，不允许 Agent 在普通回合中任意联网安装。
- 支持离线镜像、只读挂载、版本锁定、完整性校验和安装审计。
- 安装失败不应破坏已有内置 Skill；应提供清晰的启动诊断。

**验收标准**

- 关闭开关时不进行网络访问或外部安装。
- 开启后能按锁定版本安装允许来源的 Skill，并记录来源与校验结果。
- 未在允许列表中的来源、版本漂移或校验失败会被拒绝。
- 开发、CI 和生产部署方式可复现。

### S-02 Sandbox 对接 IP/CIDR 白名单

**现象**

Sandbox 的监听地址和允许访问方缺少一套容易理解的配置语义，一线希望能明确限制为本机或允许指定网络对接。

**需求澄清**

`127.0.0.1` 与 `0.0.0.0` 是**监听地址**，不是完整的访问白名单：

- `127.0.0.1`：服务仅监听容器/主机回环接口。
- `0.0.0.0`：服务监听所有接口，但不代表应允许任意来源访问。
- 来源访问控制应使用 IP/CIDR allowlist，例如 `127.0.0.1/32`、Docker 子网或指定服务地址，并配合 API Token/mTLS；不能用来源 IP 取代身份认证。

**期望配置**

- `SANDBOX_BIND_HOST`：控制监听接口。
- `SANDBOX_ALLOWED_CLIENT_CIDRS`：控制可访问 Sandbox HTTP/MCP 的来源网段。
- 默认采用最小暴露原则，仅允许明确的本地/容器服务网络。
- 支持多个 CIDR；非法配置启动失败而非静默放开。

**验收标准**

- 允许列表内来源可以访问，列表外来源在业务路由前被拒绝。
- `0.0.0.0` 监听时仍受 CIDR 和认证双重保护。
- 代理部署下明确信任哪些 proxy header，避免伪造客户端 IP。
- Docker Compose、本机开发和生产反向代理场景均有配置示例与测试。

### A-02 Agent Runtime 独立服务与 SDK 对齐

**现象**

- ~~Python Runtime 位于 `sandbox/agent/`，使 Agent 编排与不可信代码执行边界混在同一个服务中。~~ **已解决（2026-07-11）：** Python Agent Runtime 已删除；编排在独立 `agent/` Node 服务。
- ~~Python Runtime 没有以 `pi-coding-agent` SDK 为唯一编排核心，与 Node Runtime 存在能力和行为分叉。~~ **已解决：** 仅保留 Node SDK 路径。

**目标结构**

```text
frontend/      纯 UI
api-server/    BFF、认证、SSE 边缘协议
agent/         Agent Runtime、pi-coding-agent SDK、Session 恢复、Extension
sandbox/       受控执行、文件、Artifact、审批执行点、审计存储
```

**职责边界**

- `agent/` 决定模型交互、消息循环、工具注册、Session 恢复和 Extension 生命周期。
- `sandbox/` 不运行 Agent 主循环，只执行经策略允许的工具调用。
- Agent 与 Sandbox 使用经过认证、可追踪的协议通信。
- Node BFF 不再承载两套 Agent 编排逻辑。

**验收标准**

- Python Agent 使用选定的 `pi-coding-agent` SDK 接口完成多轮、工具、审批、Artifact、取消和错误恢复。
- Sandbox 可在 Agent 服务关闭时独立启动，不包含 Agent 主循环路由。
- Agent 和 Sandbox 可独立扩缩容、升级和回滚。
- Node/Python 双 Runtime 迁移结束后只保留一个生产实现。

### A-03 Agent Session 持久化

**现象**

当前持久化主要覆盖 Conversation 消息和 Sandbox Session 元数据，尚不能完整恢复 Agent SDK 的 Session 状态。进程重启后，模型上下文、工具状态、审批等待和 Session 映射可能丢失或不一致。

**需要持久化的最小状态**

- `agent_session_id`、`enterprise_session_id`、`sandbox_session_id` 和用户归属。
- SDK 所需的消息/事件历史、模型配置、system prompt 版本。
- workspace 绑定、启用的 Skill/Extension/工具版本。
- 进行中或终态的工具调用、审批和 Artifact 引用。
- Session 状态、创建/更新时间、TTL、关闭原因和恢复版本。

**验收标准**

- Agent 服务重启后可通过稳定 Session ID 恢复历史并继续下一轮。
- 恢复不会重复执行已完成的工具调用，也不会把未决审批默认为通过。
- Session 与 workspace 保持一对一映射；孤儿记录和孤儿目录可检测、可回收。
- 持久化 schema 具备版本迁移和向后兼容策略。
- 有重启恢复、崩溃中断、审批等待和 Session 过期测试。

### T-01 补充 `ls`、`find`、`grep` Sandbox 工具

**目标**

为 Agent 提供结构化、受限的文件发现与文本检索能力，减少通过任意 Bash 命令完成基础读取操作。

**工具边界**

- `ls(path=".", depth=1, include_hidden=false)`：列出 workspace 内目录项和基础元数据。
- `find(path=".", pattern, type?, max_depth?, limit?)`：按名称/类型查找，限制深度和结果数。
- `grep(path=".", query, glob?, case_sensitive?, context?, limit?)`：仅检索允许的普通文件，限制单文件大小、总扫描量、耗时和返回量。

**统一要求**

- 三个工具只能访问当前 Session workspace，且复用 A-01/S-03 的路径保护。
- 不跟随逃逸 workspace 的 symlink，不读取 Skill、密钥、系统目录或其他 Session。
- 返回结构化 JSON，并明确 `truncated`、跳过文件和错误原因。
- 每次调用写入统一审计记录；危险或超范围参数被策略拒绝。

**验收标准**

- 正常、空目录、隐藏文件、二进制、大文件、symlink 逃逸和结果截断均有测试。
- 三个工具的输出在 Node/Python Agent 表现一致。
- 基础文件查找不再要求放开通用 Bash 权限。

### S-03 使用 SDK Extension 统一安全治理

**现象**

路径保护、工具审计和审批目前分散在 Router、Service、工具 wrapper 和 Agent 流程中，新增工具容易漏接策略，Node/Python Runtime 也可能产生差异。

**目标**

通过 `pi-coding-agent` SDK Extension 建立 Agent 侧统一入口，同时保留 Sandbox 服务端的强制执行边界：

1. 工具调用前：规范化逻辑路径、绑定 Session、评估风险和审批要求。
2. 工具调用中：注入 `trace_id`、调用者、策略版本和超时/资源限制。
3. 工具调用后：记录结果摘要、状态、耗时、Artifact 和错误，不记录敏感明文。
4. 审批暂停/恢复：持久化待审批状态，明确批准者、决定和超时。

**安全原则**

- Extension 用于统一体验和早期拦截，不能成为唯一安全边界。
- Sandbox 必须独立重复验证 Session、路径、权限和审批凭证，防止绕过 Agent 直接调用。
- 所有工具默认拒绝；只有注册且具有策略定义的工具可执行。

**验收标准**

- 所有内置工具和新增 `ls/find/grep` 均经过同一 Extension 生命周期。
- 绕过 Agent 直接请求 Sandbox 时，服务端策略仍能阻止未授权操作。
- 每次工具调用能按 `trace_id` 串联 Agent、审批、Sandbox execution 和 Artifact。
- Extension 异常采用 fail-closed，不会静默放行。

### R-01 “复刻 pi-coding-agent”范围决策

**问题**

“复刻”可能代表完全不同的投入和风险，不能在未定义范围时直接进入实现：

1. **兼容层**：只复刻本项目依赖的公开 API/事件协议。
2. **维护 fork**：基于许可证允许的上游代码维护内部版本。
3. **独立重实现**：依据公开行为和文档实现兼容 Runtime。
4. **完整产品复刻**：覆盖 SDK、CLI、工具系统、Extension、Session、模型适配等全部能力。

**评审前置项**

- 明确业务动机：能力缺失、可控性、Python 支持、供应链风险，还是商业授权。
- 核对上游许可证、商标、第三方依赖及再分发约束。
- 列出本项目实际使用的 API、事件、Session 格式、Extension hooks 和测试向量。
- 比较“直接使用上游 + Extension”“维护 fork”“兼容实现”的成本。
- 定义兼容版本、非目标、升级策略和长期维护责任人。

**建议的第一阶段产物**

- 一份 ADR/可行性报告，而不是立即编码。
- 一套黑盒兼容测试，固定本项目依赖的行为契约。
- 一个最小 PoC，仅覆盖多轮消息、工具调用、Extension 和 Session 序列化。

**决策验收标准**

- 许可证和合规结论明确。
- 目标范围、非目标、兼容矩阵和维护成本得到确认。
- 只有当兼容层或 fork 无法满足需求时，才批准完整独立重实现。

## 4. 推荐实施顺序

```text
阶段 0：F-01 上传缺陷定位与交互修复
   ↓
阶段 1：A-01 路径契约 + S-03 Extension/服务端双重策略
   ↓
阶段 2：A-03 Session 持久化基础
   ↓
阶段 3：A-02 独立 agent/ 服务及 SDK 迁移
   ↓
阶段 4：T-01 ls/find/grep + S-01 Skill 安装 + S-02 网络白名单

R-01 作为独立决策流并行研究，结论会影响 A-02 的 SDK 选型，但不阻塞 F-01。
```

## 5. 拆分建议

这些事项不应合并为一个大改动，建议分别创建 Trellis 子任务：

1. 文件附件输入与上传错误修复。
2. 逻辑路径契约与物理 workspace 隔离。
3. Extension 安全治理框架。
4. Agent Session schema、持久化与恢复。
5. 独立 Python Agent Runtime 迁移。
6. `ls/find/grep` 结构化工具。
7. 外部 Skill 安装配置与供应链校验。
8. Sandbox bind host、CIDR 白名单与代理信任模型。
9. `pi-coding-agent` 兼容/fork/重实现可行性 ADR。

每个任务应独立提供 PRD、设计、迁移/回滚方案及验证命令；A-01、A-02、A-03、S-03 属于复杂架构任务，不宜直接内联修改。
