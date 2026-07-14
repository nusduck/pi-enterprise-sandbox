# 多场景多轮对话测试报告

**日期**：2026-07-14  
**范围**：本地服务、应用内浏览器、临时 Sandbox 工作区、临时 MySQL 容器  
**测试账号**：已注册临时账号 e2e_20260714_050723；报告不记录密码或其他凭据。  
**执行约束**：未使用 Trellis。

## 结论摘要

注册、基础 Skill 创建、多轮工具调用和对话隔离均得到有效验证；复杂 MySQL 分析场景在修正网络拓扑并启用 Sandbox init/reaper 后完整通过。复核 .env 和 Compose 配置后，Sandbox 开发环境实际为 SANDBOX_NETWORK_MODE=unrestricted 且未启用 iptables；首轮失败的直接原因是临时 MySQL 只加入了 analysis-net，而 Agent/Sandbox 位于 Compose default 网络，容器名因此无法解析。随后发现无 init 时 bwrap zombie 会耗尽 RLIMIT_NPROC；启用 `init: true` 后，固定 IP 连接、Skill 创建、元数据、只读 SQL 和 Python/pandas 校验均成功。

## 场景结果

| 场景 | 结果 | 证据与问题 |
|---|---|---|
| 注册测试账号 | 通过 | 通过浏览器完成注册并进入应用；未将凭据写入报告。 |
| 创建 Skill：test-echo-analysis | 通过 | 生成单一 SKILL.md，内容为分析思路、安全边界和“不能代替执行 SQL/Python”的声明；未生成脚本或可执行文件。 |
| 多轮对话与工具调用 | 通过（含缺陷） | 第一轮 write 写入 JSON；第二轮读取后确认 marker=keep-context、values=[3,5,8]，计算总和 16、平均值 5.333…、最大值 8。相对路径 read("toolchain-test.json") 被错误解析为 Skill 目录，改用绝对路径 bash cat 才成功。 |
| 对话隔离 | 通过 | 新会话使用独立 conversation；运行显示 0 次工具调用、0/128000 上下文使用，未读取旧会话。隔离提示中出现的旧标记属于当前用户消息回显，不属于跨会话泄漏。 |
| 创建 MySQL 分析 Skill：mysql-analysis-plan | 未通过 | 目标要求只创建 Skill 元数据、分析方向，不提供脚本。Agent 未在 Skill 根目录创建目标 Skill，而是在失败尝试后写入普通工作区文件 SKILL.md；应修正创建工具的路径路由和失败回退。 |
| 外部 MySQL + 复杂分析（首轮） | 阻断/未通过 | 临时 MySQL 容器和只读分析账号创建成功，但 MySQL 与 Agent/Sandbox 未加入同一 Docker 网络，Agent 无法解析容器名 pi-e2e-mysql，停留在重复连接探测，未进入元数据、SQL 查询和 Python/pandas 分析阶段。 |
| 外部 MySQL + 复杂分析（init/reaper 修复后） | 通过 | 使用固定 IP `192.168.97.10`；`skill_edit`/`skill_reload` 成功；完成 5 表元数据、Q1 completed 只读 SQL、pandas 独立校验和业务洞察，运行成功且无进程堆积。 |
| 额外安全边界 | 部分通过 | 使用仅有 SELECT/SHOW VIEW 权限的分析账号，并在提示中禁止 DML/DDL；未验证到实际 SQL 执行，因此只能确认设计约束，不能确认运行时拦截效果。 |

## MySQL 测试数据

临时数据库为合成数据，包含 5 张表：

| 表 | 行数 | 关系/用途 |
|---|---:|---|
| customers | 8 | 客户、区域、客户分层 |
| products | 5 | 商品与品类 |
| orders | 12 | 订单、客户、订单状态、日期 |
| order_items | 18 | 订单明细、商品、数量、成交价 |
| campaigns | 5 | 营销活动曝光信息 |

原计划分析：2026 年第一季度已完成订单的区域/分层 GMV、订单数和 AOV；复购率；品类 GMV 贡献；营销曝光与未曝光的 GMV/AOV 对比。

## 修正网络后的复测

- 将临时 MySQL 加入 `pi-enterprise-sandbox_default`，使用固定 IP `192.168.97.10`，并在浏览器提示中只向 Agent 提供 IP，不提供容器名或 DNS 名称。
- Skill 创建：通过 `skill_edit` 两次成功写入 `/home/sandbox/skill/mysql-analysis-plan-r2/SKILL.md`，创建路径和工具调用均符合预期。
- 网络与数据库连接：通过 IP 连接成功；Agent 明确报告“连接成功”，并报告初始元数据读取成功。这证明首轮问题是 Docker 网络挂载方式，而不是 `.env` 中的 Sandbox 网络策略。
- 完整分析链：未通过。Agent 随后报告 bwrap namespace 资源限制，反复调用 `process_start`/`process_wait`/`process_logs` 和探测命令，未展示四项完整 SQL 结果，也未展示 pandas 二次分析或最终结论；运行最终被重启 Agent 服务中断。
- 约束违例：Agent 使用 `write` 创建了 `/tmp/get_meta.py`，违反“不得创建脚本文件”的测试要求。该文件随临时 Sandbox/Compose 清理一并移除。

复测结论：固定 IP 方案可行，原网络根因已修正；当前剩余失败点是 Agent 在资源受限时的执行策略、循环探测/超时控制，以及“不创建脚本”约束的运行时遵守。

## 资源限制专项复现

- 读取容器基线：`pids.max=max`，容器启动时 `pids.current=9`；因此不是 Docker cgroup 的固定 PID 配额直接触发。
- 按真实 Sandbox 用户运行单个 Bubblewrap：当前 `RLIMIT_NPROC=20` 在已有 zombie 时稳定报 `bwrap: Creating new namespace failed: Resource temporarily unavailable`。
- 清空容器后，当前限制下顺序执行 30 次全部成功；这说明 20 不是单次 Bubblewrap 的必然失败阈值，真正问题是残留进程逐步耗尽进程额度。
- 进程检查发现大量 `bwrap` zombie，均被无 init 的 uvicorn PID 1 接管，无法及时回收。
- 临时加入 Compose `init: true` 重建 Sandbox 后，PID 1 变为 `docker-init`；在原 `RLIMIT_NPROC=20` 下顺序执行 30 次全部成功，实验后 zombie 数为 0。

推荐修改：在 Compose 的 `sandbox` 服务增加 `init: true`；非 Compose 部署使用 Docker `--init` 或 tini/dumb-init。保留进程启动总数、超时和取消机制，并增加 zombie/PID 计数监控；不建议仅通过把 `SANDBOX_MAX_PROCESS_COUNT` 调大来掩盖回收问题。

## 启用 init/reaper 后的完整 MySQL 复测

- 实际修改：`docker-compose.yml` 的 `sandbox` 服务增加 `init: true`；重建后 PID 1 为 `docker-init`，启动时 `pids.current=9`。
- 数据库：临时 MySQL 使用固定 IP `192.168.97.10`，Agent 只收到 IP，不使用容器名；包含 `customers`、`products`、`orders`、`order_items`、`campaigns` 五张表，共 48 行合成数据。
- Skill：首次 `skill_edit` 因缺少 YAML frontmatter 失败，修正后覆盖成功；随后 `skill_reload` 成功。Skill 只包含元数据和分析方向，不含脚本；测试结束已删除。
- SQL：成功完成表结构/行数读取和 5 组只读分析：Q1 completed 总订单 11、GMV 6,754.00、AOV 614.00；复购率 57.14%；Electronics GMV 占比 86.10%；曝光组 GMV 5,124.00，未曝光组 GMV 1,630.00。
- Python：使用 PyMySQL + pandas 做独立校验；首次受 OpenBLAS 线程限制影响，设置 `OPENBLAS_NUM_THREADS=1` 后成功，SQL 与 pandas 结果全部一致。
- 资源：本次运行 13 次工具调用，未调用 `process_start`，未生成脚本文件，Agent 运行状态为 Succeeded。

## 主要缺陷与建议

1. Skill 创建工具应在目标目录不存在时自动创建目录，并在写入后校验 SKILL.md、Skill 名称和安装可见性；不要回退为普通工作区文件。
2. 外部数据库测试应在启动前校验网络拓扑：临时数据库加入 Agent/Sandbox 所在的 Compose 网络，或显式提供可达的固定地址；同时增加连接探测次数上限、总超时和用户可见的阻断原因。
3. 统一 read 的路径语义，避免工作区相对路径被误判为 Skill 路径；对相对路径提供明确错误和修复建议。
4. “停止生成”应取消 Agent 后端运行、释放探测进程并更新运行状态；不能依赖整体服务关闭来止损。
5. 增加可重复的复杂分析 E2E：先获取表元数据，再执行只读 SQL，最后使用 Python/pandas 做聚合，并断言禁止脚本生成和 DML/DDL。

## 清理确认

- 已删除测试创建的 test-echo-analysis 文件、错误生成的工作区 SKILL.md、复测 Skill `mysql-analysis-plan-r2` 和多轮测试 JSON。
- 已删除临时 MySQL 容器及其匿名卷。
- 已通过浏览器登录测试账号删除全部 4 个测试对话，重新打开服务后显示 `No conversations yet.`。
- 已通过浏览器登录测试账号删除本轮测试对话，侧边栏恢复 `No conversations yet.`。
- 已删除本轮临时 MySQL 容器、测试 Skill 目录，并关闭本次启动的前端、API、Agent、Sandbox 服务。
- `docker-compose.yml` 中的 `sandbox.init: true` 为本次修复保留项，用于避免无 init 时 bwrap zombie 累积。
- 测试账号本身未删除：本轮未执行账号删除测试，也未发现安全、明确的账号删除入口；账号凭据未写入报告。
