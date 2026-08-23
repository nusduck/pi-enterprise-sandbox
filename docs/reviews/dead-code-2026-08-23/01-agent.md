# 死代码考古 · agent 模块（Node.js, ~67K 行）

> 所有结论基于对 `agent/src`、`agent/tests`、根配置文件的全局 grep 验证。

## A 类：死代码（完全未被引用）

**A-1. `A2A_MESSAGE_STREAM_KINDS` 导出无人消费**
- `src/application/a2a/stream-event-schema.js:25`，经 `a2a/index.js:41` 再导出
- 证据：全仓 grep 仅命中定义处与 barrel 再导出两处，零消费者。schema 校验实际用 `streamKindsForMethod()` → `A2A_STREAM_RESULT_KINDS`
- 风险：低｜动作：直接删（连同 index.js 再导出行）

**A-2. `config.FAKE_LLM_ENABLED` 配置键无人读取**
- `config.js:450-451`
- 证据：全仓仅命中定义处；fake-llm-policy 模块本身是活的，死的只是这个派生键
- 风险：低｜动作：直接删该键

**A-3.[待确认] `AGENT_RUN_INIT_TIMEOUT_MS` / `RUN_INITIALIZATION_TIMEOUT_MS` 疑似死环境开关**
- `config.js:420-423` 解析、`:318` 仅回显
- 证据：src/ 下无任何运行时逻辑消费该值
- 风险：中｜动作：确认是有意预留还是补上真正的 barrier 实现

## B 类：Legacy 兼容层

**B-1. `LEGACY_REQUIRED_EXTENSION_NAMES` 三件套隐式升级**（constants.js:90-97；消费点 extensions/index.js:258-265）
- AgentVersion.extensions 恰好等于旧三件套时自动补入 user-interaction
- 真实调用方 = DB 中拆分前创建的 AgentVersion 行是否存在 [待确认]
- 风险：高（删早了 ask_user 静默消失）｜动作：先一次性数据迁移回填为四件套，再删分支

**B-2. `LEGACY_EXTENSION_PACKAGE_NAMES` 拒绝逻辑 —— 安全护栏，保留**（constants.js:102-117）

**B-3. `mapLegacyRuntimeOutcome` 小写 outcome 映射表**（domain/run/legacy-status.js:15-27,42-70）
- 生产 executor 全部产大写 RUN_STATUS.*，小写映射仅测试使用
- 动作：[待确认] 执行器契约后可裁剪 lowercase 表，保留大写 identity + fail-closed 结构

**B-4. `isLegacyOrUuidIdentity` 入口守卫 ×8 —— fail-closed 护栏，保留**（ulid.js:179-196）

**B-5. `publicJsonView` 的 `_integrity` sibling 剥离**（tool-execution-repository.js:44,:305-308）
- 写入端已一律走 envelope；剥离只为迁移前旧行存在 [待确认旧行是否全部过期]

**B-6. conversation title 读时兜底**（conversation-service.js:240-252,:290-292,:60-75）
- create-run 现在创建即写标题；list() 逐会话拉 500 条消息恢复标题有 N×500 读放大
- 动作：跑一次性 backfill UPDATE 后删除 list() 恢复逻辑

## C 类：冗余兜底 / 重复辅助

**C-1. pi-run-resume.js 跨模块访问 executor 私有字段**（pi-run-resume.js:73,:130/:147/:166,:274 → pi-run-executor.js 私有 `_runtime`/`_governanceRecorder`）
- 封装破损，不能删需重构：暴露公开只读 getter 或显式传参（改动面 2 文件）

**C-2. 双形态字段 fallback**（conversation-service.js presentConversation、run-presenters.js:3,42）
- row-mappers 已统一 camelCase；别名链是防御性冗余。风险低，[待确认] 测试 fixture

**C-3. `streamKindsForMethod(_method)` 忽略参数**（stream-event-schema.js:44-46）→ 调用方直接用常量后删

**C-4. `runStateMachine.mapLegacyOutcome` 包装方法**（run-state-machine.js:110-112）唯一调用方是测试

**C-5. server.js / worker.js 入口**——均为 ~20 行薄壳，无实质重复，无需处理

## D 类：过渡残留

- D-1 `@deprecated A2A_TASK_STREAM_KINDS` 别名（stream-event-schema.js:33-34）：零消费者，直接删
- D-2 `@deprecated AgentSessionRepository.update()` 恒抛错：PR-05 安全设计，保留
- D-3 `resolveDefaultModelId` 硬编码 `'deepseek-v4-flash'` 兜底（model-registry.js:509-515）：建议改 fail-closed 抛 ModelRegistryError
- D-4 sandboxClient/factories 注入拒绝块（extensions/index.js:336-345,:398-416）：fail-closed 护栏，保留

## E 类：未使用资产

- **E-1 幽灵依赖**：`@opentelemetry/semantic-conventions` 被 telemetry.js:20 import 但 package.json 未声明（靠传递依赖侥幸解析）→ 显式加入 dependencies
- **E-2 `@earendil-works/pi-ai` 无直接 import** —— 故意版本对齐 pin（sdk-surface.test.js:49 断言存在），勿删
- E-4 `config.SESSION_WORKSPACE_CWD` 双源真相：运行时全直读 env.AGENT_SESSION_WORKSPACE_CWD，cfg 键仅日志出现 → 统一单一来源
- E-5 Dockerfile/.dockerignore 逐条核对无多余内容

## 清理收益估计
- A 类 ≈ -10 行 + 消除误导性死配置
- B 类 ≈ -100 行读路径兼容 + list() 性能改善（需两项数据迁移先行）
- C 类 ≈ -40 行 + C-1 封装修复（重构收益最大）
- D 类 ≈ -10 行 + 1 处 fail-closed 强化
- E 类 +1 条依赖声明、-1 个双源配置
