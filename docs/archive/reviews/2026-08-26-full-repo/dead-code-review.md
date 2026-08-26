# 死代码 / 冗余代码 / 无效代码及文件 专项审查（2026-08-26）

方法：工具扫描（knip 6.32.2 含 `--production` 与含测试两种模式、ruff F401/F811/F841/ERA001、vulture ≥80 置信）+ 4 个并行只读子代理逐条全仓 grep 验证。分类标签：**【完全死代码】**（生产+测试+脚本均无引用，可删）/ **【仅生产死】**（只有测试引用，删除需同步改测试）/ **【假阳性】**（动态使用）。

## 一、agent/

### 完全死代码

| 位置 | 内容 | 说明 |
|------|------|------|
| `src/infrastructure/sandbox/sandbox-client.js:427-494` | 16 个模块级 wrapper（authRegister/authLogin/authMe/readFile/writeFile/listFiles/lsFiles/findFiles/grepFiles/downloadFileStream/downloadArtifactStream/submitArtifact/listArtifacts/removeSessionWorkspace/artifactDownloadPath/ensureTraceId），~70 行 | 全仓唯一 import 只取 `createSandboxClient`；指向已退役 Sandbox 路由（CHANGELOG.md:77），调用即 404 |
| `src/skills/install.js:720` | `_testHelpers` | 连测试都不用 |

### 假阳性（不可删）

- **migrations ×16**：knip 报的 16 个「死文件」全部是假阳性——`client.js:127-128` 的 `migrationsDirectory()` + `migrate.js:13` 把目录交给 knex 运行时动态加载（21 个迁移中 5 个被静态引用，与报数精确吻合）。
- `sandbox-client.js:495 checkHealth`：被 `http-main.js:193-194` 动态 import 作 `/health` 探针。
- `pi-mcp-adapter` 依赖：经模板字符串 `require.resolve` + jiti 动态加载（pi-mcp-adapter-factory.js:94-108）。

### 仅生产死

- `@earendil-works/pi-ai` 依赖：零 import，但被 `tests/sdk-compat/sdk-surface.test.js:49` 断言为 Pi SDK 版本钉的一部分，删除需同步调整钉版本策略。
- `extensions/index.js` barrel 个别 re-export 路径冗余（符号本身在源模块存活）。

## 二、api-server/

**无可删的死代码。** knip 的 11 条 unused exports 与 8 条 OTel 依赖全部验证为假阳性：符号均模块内自用或被测试直接 import（如 `toIsoTimestamp`/`presentRunDetail` 被 tests/run-detail-fallback.test.js 引用并被 agent-run-client.test.js 源码正则断言）；OTel 由 telemetry.js 静态 import 且 server.js 调用。无孤儿源码文件。结论与 docs/archive/reviews/2026-07-29-dead-code-cleanup.md 一致。

## 三、frontend/

knip 双模式对比：70−33=37 条差异项全部为【仅生产死】（仅 test/*.test.ts 引用）；33 条交集中真正可整段删除的：

### 完全死代码

| 位置 | 内容 |
|------|------|
| `src/shared/api/client.ts:169` | `createConversation`（零调用） |
| `src/entities/store.ts:460` | `getRun`（store 版本；外部均用 api/runs.ts 的 getRun） |
| `src/shared/schemas/api.ts:138-159` | 死 re-export 桶 ~22 行（生产直接从 schemas/events 导入同名符号） |
| `src/shared/api/client.ts:27-28` | 死 re-export（本体在 sse/parser、security/url，生产在用） |
| `src/features/chat/Composer.tsx:663` | 死 re-export（canSendAttachments 等，本体在 attachments.ts） |

### 冗余（P2）

- `runReducer.ts:1232/1262` `reduceRuntimeEventBatch` 与 `reducePlatformEventBatch` 互为完全相同的别名导出。
- `schemas/api.ts` 中 `AuthUserSchema≡MeResponseSchema`、`ConversationSchema≡ConversationDetailSchema` 重复导出。

无孤儿组件（六页面全路由可达）、依赖全在用。注意：删除【仅生产死】导出会破坏 ~36 个前端测试文件的 import，需同步改测试或标注 test-only。

## 四、sandbox/（Python）及全仓杂项

### 完全死代码（可安全删除）

- 未用导入 14 处：`internal_process_contract.py:5 hashlib`、`tool_request_hash.py:18 math`、`:20 Mapping`、`artifact/api/public.py:25 FileIdentity`、`artifact/infrastructure/manager.py:15 stat`、`:49 stream_copy_hash_to_control`、`config.py:15 Field`、`safe_env.py:17 Any`、`services/audit_logger.py:11 sanitize_for_log`、`dataset_manager.py:17 stat`、`execution_manager.py:20 full_log_location`、`formal_process_runtime.py:30 get_formal_session_runtime`、`internal_plane_resources.py:27 Awaitable`、`process_manager.py:25 SandboxPathScope`
- `safe_env.py:225 sanitize_for_log` 函数本身全仓零调用（附加发现）
- `services/file_edit.py:224` 注释掉的代码行（唯一真实 ERA001）
- **`config/agent/settings.json`**：全仓零路径引用，其声明的扩展名 `enterprise-sandbox` 不在 agent 扩展注册表中——疑似与已删除 models.json 同类的遗留文件（删除前需确认 pi SDK 无 settings.json 自动发现机制）

### 仅生产死（删除需同步改测试）

- `artifact/infrastructure/manager.py:15 stat`、`:49 stream_copy_hash_to_control`：文件内零使用（消费方 mcp/runtime.py 自行导入），可删；但同文件 `:35-38` 四个 disposition 名虽生产侧各处直连导入，仍经 `services/artifact_manager.py` star-import 垫片被 tests/test_dataset_artifact_pr09.py 消费——删除需同步处理垫片与测试
- `services/formal_artifact_runtime.py:4 workspace_manager`：本文件零使用，但 tests/test_formal_artifact_runtime.py:66-80 以字符串路径 monkeypatch 它——单独删导入会炸 4 个测试用例
- **`sandbox/services/artifact_manager.py` 整个文件**：3 行 star-import 兼容垫片，生产零引用、仅 4 个测试文件使用——建议测试改直连后删除

### 假阳性

- config.py:465-501 的 9 条 ERA001 实为 `# Env: SANDBOX_*` 环境变量映射文档注释，有意保留（如需静默 linter 应加 `# noqa: ERA001` 而非删除）；network_policy.py:64 为 `# IPv4:port` 分支说明标签
- replay_store.py:52-53 nx/ex：Protocol `AsyncRedisLike.set(nx, ex)` 契约参数，RedisReplayStore.consume 以 `nx=True, ex=ttl` 实际调用

### 杂项

- 孤儿 .py 文件：无；scripts/ 与 config/ 其余文件均有 CI/Compose/runbook 引用；唯 `tests/container_bwrap_smoke.py` 非 pytest 收集命名、CI/runbook 无引用（前次评审已记录），建议移入 release-gates 或补运行说明
- **未跟踪文件**：`docs/reviews/2026-08-23-real-user-scenario/` 是真实的 UI 验收报告（记录了 P1 缺陷 RT-02），`tests/fixtures/real-user-scenario-transactions.csv` 仅被该报告引用、无自动化消费方。建议二者一并提交，后续把 CSV 移入报告目录随报告归档，消除 tests/fixtures/ 悬空数据文件

## 清理建议优先级

1. **低风险立即可删**：agent sandbox-client.js 16 个 wrapper + `_testHelpers`（~80 行）；frontend 2 个死函数 + 3 处死桶；sandbox 14 处未用导入（注意 manager.py 的 disposition 四名与 formal_artifact_runtime.py:4 需连带测试/垫片）+ file_edit.py:224 + sanitize_for_log 函数体
2. **需决策**：config/agent/settings.json（先确认 pi SDK 行为）；@earendil-works/pi-ai 版本钉策略
3. **需同步改测试**：frontend 37 条 test-only 导出；sandbox 垫片链（artifact_manager.py + manager.py:35-38 + formal_artifact_runtime.py:4）
4. **按 AGENTS.md §3/§4**：任何删除若触及运行路径，须重建容器并跑真实链路验证（尤其 /health 探针）
