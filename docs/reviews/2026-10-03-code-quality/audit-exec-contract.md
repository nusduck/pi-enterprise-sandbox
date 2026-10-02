# exec/ 与 contract/ 代码质量盘点（只读）

## 范围与方法

- 范围：`exec/`（`src/`、`test/`、MCP facade 入口 `src/mcp-main.ts`、`Dockerfile`、`package.json`）和 `contract/`（`src/`、`test/`、`package.json`）。
- contract 导出的消费者判断同时搜索 `exec/` 与 `agent/`；生产消费者只算 `exec/src/`、`agent/src/`，测试消费者单列。
- 主要方法：
  - `git status --short`（干净）、`find`、`wc -l` 建立范围。
  - `grep -RIn --exclude-dir=node_modules --exclude-dir=dist` 定向搜索符号、路由、环境变量、已删路径。
  - 逐文件检查 `export` 定义，再对照 `exec/src`、`agent/src` 的 import 行。
  - 只读；未修改仓库文件。报告文件为本任务唯一写入。
- 总体结论：高置信可删约 **630 行**；把“需确认”的 contract root barrel、未接线护栏、兼容分支/别名算进去，最多约 **1000 行**。另有 **65 处**注释仍引用已删除的 Python `sandbox/` 路径，建议改写而不是直接删代码。发现共 **23 条**。

| ID | 类别 | 位置 | 现状 | 证据 | 建议 | 风险 | 预计行数变化 |
|---|---|---|---|---|---|---|---|
| F1 | 1/6 | `exec/src/attachment/service.ts:29-184` | 整个 `AttachmentService` 生产导出只被测试引用；公共上传路由自己写简化上传和 `att_${Date.now()}`，不经过这个 service。 | `grep -RIn --include='*.ts' 'attachment/service' exec/src` → 无命中；`grep -RIn -w 'AttachmentService' exec/src exec/test` → 定义 1 处 + `exec/test/artifact-dataset-attachment.test.ts` 6 处。 | 删除 service 与对应 attachment 测试；若目标是恢复真实行为，则让 `files.ts` 上传路由改用它。 | 中：当前生产路由和 service 行为已分叉，删除前要确认哪条是期望契约。 | 源码 -184，测试约 -64 |
| F2 | 1/6 | `exec/src/db/index.ts`；`exec/src/db/repositories/index.ts`；`exec/src/db/repositories/exec-jobs.ts`；`exec/src/db/repositories/workspace-quotas.ts`；`artifacts.ts:79`、`datasets.ts:57`、`workspace-policies.ts:31` | DB 收口 barrel 只被测试引用；`exec-jobs.ts` / `workspace-quotas.ts` 只有 barrel 或测试消费者；5 个 `*_DDL` 常量中 1 个完全无引用、其余只被 `db-repositories.test.ts` 引用，而迁移权威在 `agent/src/infrastructure/mysql/migrations/`。 | `grep -RIn -e 'db/index.js' -e 'repositories/index.js' exec/src exec/test` → 仅 barrel 自身/测试 import；`grep -RIn 'exec-jobs.js'` → 仅测试动态 import；`grep -RIn 'workspace-quotas.js'` → 无命中；`grep -RIn -w 'EXEC_WORKSPACE_POLICIES_DDL' exec/src exec/test` → 仅定义。 | 删除 barrel 和只做重导出的 `exec-jobs.ts` / `workspace-quotas.ts`；删除 DDL 常量，测试改读 agent 迁移 SQL 或移除重复断言。保留 `artifacts.ts` / `datasets.ts` 的实际 store。 | 中：涉及 DB 收口约定和测试覆盖，需确认没有外部按旧 barrel 路径导入。 | 源码约 -173，测试约 -30 |
| F3 | 1 | `exec/src/db/repositories/artifacts.ts:53-58` | `ARTIFACT_VISIBILITIES` 全仓无任何引用，只有定义。 | `grep -RIn -w 'ARTIFACT_VISIBILITIES' exec/src exec/test agent/src agent/tests contract/src contract/test` → 仅定义 1 处。 | 删除常量；若测试需要枚举，直接从 `ArtifactVisibility` 类型派生。 | 低。 | -6 |
| F4 | 1/5/需确认 | `exec/src/workspace/single-instance.ts:1-67`；`exec/src/workspace/manager.ts:56-57` | 单实例 fail-closed 断言已实现并重导出，但 `main.ts` 从未调用；注释明确说“调用它是 main.ts 的职责”。当前多实例保护实际上没有生效。 | `grep -RIn -w -e 'assertSingleInstance' -e 'readSingleInstanceConfig' .`（排除 node_modules/dist/.runtime）→ 仅 `manager.ts` 重导出和 `single-instance.ts` 自身。 | 需确认：要么接入 `main.ts` 恢复护栏，要么删除未接线模块和重导出；不能保持“看起来有护栏但未执行”。 | 高：若直接删且未来需要多实例保护会留下缺口；若接线则增加启动路径行为。 | 删除 -69；接线 +2 |
| F5 | 1/6 | `contract/src/envelope.ts:43-72`；`contract/src/index.ts:21-31` | `RpcRequest` / `RpcSuccess` / `RpcFailure` / `RpcResult` 无生产消费者；`RpcFailure` 仅出现在 `exec/src/http/router.ts:6` 的注释里。`okResult` / `errResult` / `assertEnvelope` 无生产消费者，只有 contract 测试引用。 | `grep -RIn -w -e 'RpcRequest' -e 'RpcSuccess' -e 'RpcFailure' -e 'RpcResult' exec/src agent/src` → 仅 `exec/src/http/router.ts:6` 注释；`grep -RIn -w -e 'okResult' -e 'errResult' -e 'assertEnvelope' exec/src agent/src` → 无命中；`contract/test/envelope.test.ts` 引用这三个。 | 删除 `RpcRequest` / `RpcSuccess` / `RpcFailure` / `RpcResult` / `okResult` / `errResult` 和 index 重导出；`assertEnvelope` 保留为 `parseEnvelope` 的内部实现，不再导出；同步改掉 router 注释。 | 中：`assertEnvelope` 的校验逻辑仍被 `parseEnvelope` 使用，不能连实现一起删。 | 源码约 -30，测试约 -30 |
| F6 | 1/5/需确认 | `contract/src/index.ts:1-260` | contract 根 barrel 没有任何消费者；`exec/`、`agent/`、contract 自身测试都不从 `@dsh/contract` 根导入。当前所有消费者都走 `@dsh/contract/xxx.js` 子路径。 | `grep -RIn -E "from ['\"]@dsh/contract['\"]" exec/src exec/test agent/src agent/tests contract/src contract/test` → 无命中；`import('@dsh/contract')` 也无命中。 | 删除 barrel，并同步去掉 `contract/package.json` 的 `exports["."]` / `types` 指向；若必须保留对外根 API，则明确标注为“无内部消费者”。 | 中：私有包外部消费者未知；删除根导出是 API 面变化。 | -260 |
| F7 | 2/6 | `exec/src/http/public/artifacts.ts:215` | `/sessions/:sessionId/artifacts/register` 与 `/submit` 共用同一 handler；`/register` 在生产客户端中无调用方，只有测试和文档引用。 | `grep -RIn 'artifacts/register' exec/src agent/src api-server frontend/src` → 只有 `exec/src/http/public/artifacts.ts` 的路由；`grep -RIn 'artifacts/submit' agent/src` → `agent/src/infrastructure/sandbox/sandbox-client.ts:427` 等生产调用。 | 删除 `/register` 路由及 `exec/test/http-public.test.ts` 对应测试；`docs/api.md` 的“旧端点”同步改写。已有 `docs/review-deferred-items.md:55` 跟踪此别名。 | 中：可能有仓库外旧客户端；建议按台账关闭条件确认后再删。 | 源码 -1，测试约 -30 |
| F8 | 2/安全/需确认 | `exec/src/security/cidr.ts:127` | `readInternalAllowCidr` 仍读取旧别名 `INTERNAL_ALLOW_CIDR`，但该别名在 exec/agent/contract 和 `.env.example`、`docs/deployment.md` 中都没有其他引用；当前文档只认 `EXEC_INTERNAL_ALLOW_CIDR`。 | `grep -RIn -w 'INTERNAL_ALLOW_CIDR' exec/src exec/test agent/src agent/tests contract/src contract/test` → 仅 `exec/src/security/cidr.ts:127`。 | 需确认后删除旧 fallback，避免配置漂移；白名单属于安全护栏，不能未经验证直接改。 | 高：删除是安全相关变更，需真实部署配置核对。 | -1 |
| F9 | 2/Redis/安全/需确认 | `exec/src/shell/safe-env.ts:63-64` | `REDIS_CONTROL_PASSWORD`、`REDIS_WORKER_PASSWORD` 只在子进程环境拒绝清单中出现，仓库内没有其他定义、读取或配置引用；疑似 Python replay/worker Redis 时代残留。 | `grep -RIn -w -e 'REDIS_CONTROL_PASSWORD' -e 'REDIS_WORKER_PASSWORD' exec/src exec/test contract/src contract/test agent/src agent/tests` → 仅 `safe-env.ts` 两行。 | 需确认名称是否已彻底退役：确认后删除；若担心误注入，保留作为防御性 denylist。 | 高：安全拒绝清单，删除前必须确认不会给未来环境变量放行。 | -2 |
| F10 | 2/Redis/需确认 | `exec/src/mcp/settings.ts:65` | facade 的 `SANDBOX_MCP_REDIS_URL` 仍回退到通用 `REDIS_URL`，注释说明是 Python AliasChoices 兼容；生产 compose 给 sandbox-mcp 显式设置 `SANDBOX_MCP_REDIS_URL`。 | `grep -RIn -w 'REDIS_URL' exec/src exec/test` → 仅 `settings.ts:65` 的 fallback；`docker-compose.prod.yml:237` 设置 `SANDBOX_MCP_REDIS_URL`。 | 需确认是否还有宿主机直连场景依赖别名；否则删除 fallback，避免 facade 连到 Agent 的通用 Redis。 | 中：可能改变本地/直连启动行为。 | -1 |
| F11 | 2/安全/需确认 | `contract/src/errors.ts:79-81` | 默认物理根脱敏前缀仍硬编码 `/sandbox/workspaces`（旧 Python 路径）；当前 exec 根是 `/var/sandbox/workspaces`。 | `grep -RIn -w '/sandbox/workspaces' contract/src exec/src` → `contract/src/errors.ts:80`；`contract/src/errors.ts:79` 是 `/var/sandbox/workspaces`。 | 需确认后移除旧前缀或保留为历史路径安全网；这是安全脱敏兜底，不能直接删。 | 高：删除可能让历史错误文本中的旧根泄漏。 | -1 |
| F12 | 2/安全/需确认 | `exec/src/shell/blocked-commands.ts:104-106` | 危险路径 denylist 仍包含 `/sandbox/workspaces`、`/sandbox/tmp`、`/sandbox/data`，这是 Python 执行面的旧物理根；当前根是 `/var/sandbox/*`。 | `grep -RIn -e "'/sandbox/workspaces'" -e "'/sandbox/tmp'" -e "'/sandbox/data'" exec/src exec/test contract/src contract/test` → 仅 blocked-commands 3 行。 | 需确认旧路径是否还会出现在任何部署中；确认后删除或保留为防绕过的历史路径。 | 高：安全 denylist。 | -3 |
| F13 | 2/需确认 | `contract/src/skill-manifest.ts:92-103`；`exec/src/http/skill-context.ts:15-56`；`exec/src/types.ts:35-40` | `systemSkills` 缺省时仍走“旧 Agent 整树挂载”兼容分支，并维护 60 秒窗口告警；design §8 要求告警归零后再收紧为 `ENVELOPE_INVALID`。 | 注释和分支见上述行；`grep -RIn -e 'systemSkills === null' -e 'parseSystemSkills' contract/src exec/src` → `parseSystemSkills` 返回 `null`，`skillPackagesForRequest` 在 `null` 时省略 `systemSkillPackages` 并记 legacy 告警。 | 需确认滚动升级窗口是否已结束；若结束，把 `systemSkills` 收紧为必填并删除 legacy 分支/告警。 | 中：可能影响仍在运行旧 Worker 的滚动升级。 | 收紧后约 -20 |
| F14 | 4 | `exec/src`、`exec/test`、`contract/src`、`contract/test` 共 53 个文件 | 注释仍引用已删除的 Python 路径，如 `sandbox/services/...`、`sandbox/routers/...`、`sandbox/security/...`、`sandbox/mcp/...`、`sandbox/paths.py` 等；仓库根已无 `sandbox/`。 | `grep -RIn -e 'sandbox/services' -e 'sandbox/routers' -e 'sandbox/security' -e 'sandbox/utils' -e 'sandbox/isolation' -e 'sandbox/mcp' -e 'sandbox/app' -e 'sandbox/artifact' -e 'sandbox/config.py' -e 'sandbox/paths.py' exec/src exec/test contract/src contract/test` → 65 处，分布在 53 个文件。 | 分批改写为当前模块引用；对“历史沿革”说明可保留但不要保留失效文件/行号。 | 低：不影响运行，但会造成导航漂移。 | 约 65 行改写，直接删除 0 行 |
| F15 | 4/6 | `exec/test/isolation-python-parity.test.ts:1-22` | 测试标题和文件头逐条引用已删除的 `tests/test_bubblewrap_isolation.py`，并有 18 个 `[py: ...]` 前缀；测试内容本身测的是当前 TS 行为，不是死测试。 | `ls tests/test_bubblewrap_isolation.py` → `No such file or directory`；`grep -c '\[py:' exec/test/isolation-python-parity.test.ts` → 18。 | 重命名为当前行为描述，删除或改写已失效的 Python 交叉引用；不要删除测试本身。 | 低。 | 约 20 行改写，直接删除 0 行 |
| F16 | 3 | `exec/src/attachment/sanitize.ts:29`；`exec/src/dataset/service.ts:62` | 两处 `extensionOf` 实现重复且已分叉：attachment 版复合后缀缺少 `.tar.zst`，dataset 版对点文件处理不同。 | `grep -RIn -E 'export function extensionOf' exec/src` → 两处定义；比较两段实现可见后缀列表和 `dot > 0` 判断不一致。 | 合并为一个共享 helper，并明确复合后缀集合；调用方按同一行为测试。 | 中：合并会改变其中一个模块的边缘行为，需要补测试。 | 约 -10 |
| F17 | 3 | `exec/src/http/public/artifacts.ts:45`；`files.ts:44`；`datasets.ts:61`；`processes.ts:36` | 四个公共路由各写一份 `actingFrom`，键集合不同（artifacts/files 带 role，datasets 带 conversation，processes 带 role），但骨架完全相同。 | `grep -RIn -E 'function actingFrom' exec/src` → 4 处定义。 | 合并为一个接受 key 列表的 helper，各路由显式传所需 key。 | 低到中：需保持各路由头字段行为一致。 | 约 -25 |
| F18 | 3 | `exec/src/http/public/artifacts.ts:62-89`；`exec/src/mcp/disposition.ts:26-77` | `displayFilename` / `asciiFallback` / `quoteAll` 与 `withPathExtension` / `asciiFilenameFallback` / `quoteAll` 是同一类文件名/头部编码逻辑的两份实现。 | `grep -RIn -e 'function quoteAll' -e 'function asciiFallback' -e 'function asciiFilenameFallback' -e 'function displayFilename' -e 'function withPathExtension' exec/src` → artifacts 3 处、disposition 3 处。 | 公共产物路由复用 `mcp/disposition.ts` 的 helper；保留一份 header 编码实现。 | 中：两版在扩展名大小写/净化细节上可能有差异，需先对齐行为。 | 约 -35 |
| F19 | 3 | `exec/src/http/public/artifacts.ts:108`；`exec/src/http/public/datasets.ts:229` | `mapError` 与 `datasetHttpError` 都是“HttpError 原样、业务 Error 脱敏、其余 500”的同一逻辑，只是业务错误类不同。 | `grep -RIn -e 'function mapError' -e 'function datasetHttpError' exec/src` → 两处定义；函数体结构一致。 | 提取一个按业务错误类映射的通用 helper。 | 低。 | 约 -15 |
| F20 | 1/5/需确认 | `contract/src/dbpm.ts`、`schema-manifest.ts`、`skill-manifest.ts`、`shell-payload.ts`、`errors.ts` 等 | contract 除 RPC 类型外还有一批导出没有 exec/agent 生产消费者，只被 contract 内部或 contract 测试使用，例如 `DBPM_*` 常量、`DbpmError`、`buildDbpmRequest`、`parseDbpmResponseLine`、`normalize*`、`ENABLED_SKILLS_MAX`、`DEFAULT_SHELL_PAYLOAD_LIMITS`、`ContractErrorCode`、`TransportErrorCode`、`redactPhysicalPaths`。 | `grep -RIn -w -e 'DBPM_REQUEST_HEADER' -e 'DbpmError' -e 'buildDbpmRequest' -e 'parseDbpmResponseLine' -e 'normalizeColumnType' -e 'ENABLED_SKILLS_MAX' -e 'DEFAULT_SHELL_PAYLOAD_LIMITS' -e 'ContractErrorCode' -e 'TransportErrorCode' -e 'redactPhysicalPaths' exec/src agent/src` → 仅 `exec/src/shell/job-types.ts:140` 的注释提到 `ToWireErrorOptions`，无生产 import。 | 需确认每个符号是否属于对外契约诊断面；确认后可去掉 `export` 或删除无人使用的 helper，减少 contract 公共面。 | 中：contract 是共享包，缩减导出可能影响未纳入本仓库的消费者。 | 约 -20（主要为 export 面，非整行删除） |
| F21 | 5/需确认 | `exec/package.json`；`exec/src/http/router.ts:26`、`fs/make-workspace-fs.ts:16`、`fs/workspace-fs.ts:26` | `exec/src` 直接 import `@deepseek-ai/cordis`，但 `exec/package.json` 没有声明该直接依赖，当前靠 `@deepseek-ai/dsh-fs` 的传递依赖可用；`@deepseek-ai/dsh-shell` 在 exec 侧全部是 `import type`，facade 阶段已显式卸载。 | `grep -RIn '@deepseek-ai/cordis' exec/src` → 3 个生产 import；`node -e` 检查 `exec/package.json` → `declared: false`；`grep -RIn '@deepseek-ai/dsh-shell' exec/src` → 均为 `import type`。 | 需确认后把 `@deepseek-ai/cordis` 补为直接依赖；评估 `@deepseek-ai/dsh-shell` 是否降为 devDependency 或由 contract 依赖覆盖。 | 中：严格依赖解析/未来传递依赖变化会直接构建失败。 | +1 |
| F22 | 5/需确认 | `exec/Dockerfile:135` | `python3-venv` 只出现在 Dockerfile；代码和测试没有引用。`uv venv /opt/dsh-python/venv` 通常自带 venv 创建能力，但未在真实镜像中验证移除影响。 | `grep -RIn -w 'python3-venv' tests exec` → 仅 `exec/Dockerfile:135`。 | 需真实构建镜像并跑 Python 工具链后再决定是否删除；不要只凭静态搜索删。 | 中：可能导致镜像内 Python venv/ensurepip 行为变化。 | -1 |
| F23 | 2/4 | `exec/src/isolation/build.ts:310` | `SANDBOX_NETWORK_MODE` 在 TS exec 中没有读取方，只剩注释说明其已删除；`SANDBOX_IPTABLES_*`、`SANDBOX_ALLOWED_CIDRS` 在 exec/contract 的 src/test 中无任何命中。 | `grep -RIn -w 'SANDBOX_NETWORK_MODE' exec/src exec/test contract/src contract/test` → 仅注释；`grep -RIn -e 'SANDBOX_IPTABLES' -e 'SANDBOX_ALLOWED_CIDRS' exec/src exec/test contract/src contract/test` → 无命中。 | 无代码残留；注释已明确说明删除，可保留。若做注释清理，可把“核实”改成指向当前 `--unshare-net` 实现。 | 低。 | 0 |


## 重点变量与已删机制核对

- `/agent-runs`：`grep -RIn -e 'agent-runs' -e 'agent_runs' -e 'AgentRun' exec/src exec/test contract/src contract/test`→ **无命中**。未发现 `/agent-runs` 删除后的代码残留。
- `SANDBOX_IPTABLES_*` / `SANDBOX_ALLOWED_CIDRS`：`grep -RIn -e 'SANDBOX_IPTABLES' -e 'SANDBOX_ALLOWED_CIDRS' exec/src exec/test contract/src contract/test` → **无命中**。
- `SANDBOX_NETWORK_MODE`：仅 `exec/src/isolation/build.ts:310` 注释，说明 TS exec 从未读取；无配置读取代码。
- Redis：MCP facade 仍用服务 Redis（`exec/src/mcp-main.ts`、`mcp/context-store.ts`），不是残留；`SANDBOX_INTERNAL_REDIS_URL` 在 exec/contract 的 src/test 中无读取代码，只在 `exec/src/startup-credentials.ts:4` 注释中出现，说明 replay Redis 已无消费方。Redis 相关需确认项见 F9/F10。

## 建议的 PR 切分

1. **PR-1：DB 收口层与测试残留**
   - 涉及：`exec/src/db/index.ts`、`exec/src/db/repositories/index.ts`、`exec-jobs.ts`、`workspace-quotas.ts`、`artifacts.ts` / `datasets.ts` / `workspace-policies.ts` 中的 `*_DDL`、`exec/test/db-repositories.test.ts`。
   - 验证：`npm test --prefix exec`；确认生产 import 已改为具体模块；迁移 SQL 仍由 agent 测试覆盖。

2. **PR-2：只被测试引用的 attachment service**
   - 涉及：`exec/src/attachment/service.ts`、`exec/test/artifact-dataset-attachment.test.ts` 的 attachment describe。
   - 验证：确认公共上传路由的期望行为；删除后跑 `npm test --prefix exec`。

3. **PR-3：未接线的单实例护栏**
   - 涉及：`exec/src/workspace/single-instance.ts`、`manager.ts`、`main.ts`。
   - 验证：若接入，增加 `main.ts` 启动路径测试（多实例拒绝/单实例通过）；若删除，跑 exec 全测试并确认没有文档仍声称该护栏生效。

4. **PR-4：contract 公共面收缩**
   - 涉及：`contract/src/envelope.ts`、`contract/src/index.ts`、`contract/package.json`、`contract/test/envelope.test.ts`，以及 F20 中的非 RPC 导出。
   - 验证：`npm test --prefix contract`、`npx tsc --noEmit -p contract/tsconfig.json`；再跑 `npm test --prefix exec` 和 `npm test --prefix agent` 证明没有消费者断链。

5. **PR-5：兼容别名与 Redis/CIDR 残留**
   - 涉及：`exec/src/security/cidr.ts`、`exec/src/mcp/settings.ts`、`exec/src/shell/safe-env.ts`、`contract/src/errors.ts`、`exec/src/shell/blocked-commands.ts`。
   - 验证：逐项做部署配置 grep + 真实链路启动；安全相关变更需按 AGENTS.md §2 提供 fail-closed 验证。

6. **PR-6：公共路由重复实现合并**
   - 涉及：`exec/src/http/public/{artifacts,files,datasets,processes}.ts`、`exec/src/mcp/disposition.ts`、`exec/src/attachment/sanitize.ts`、`exec/src/dataset/service.ts`。
   - 验证：公共面路由测试（含 header、错误脱敏、文件名边界）；`npm test --prefix exec`。

7. **PR-7：Python 兼容注释与 parity 测试命名**
   - 涉及：F14/F15 所列文件。
   - 验证：纯注释/测试命名改动，跑 `npm test --prefix exec` 和仓库卫生检查即可；不要求真实链路。
