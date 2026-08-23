# 死代码考古 · api-server（Node BFF, ~5K 行）

> 对照 frontend/src/shared/api/* 与 scripts/smoke-cross-service.mjs 的实际调用面验证。

## A. 死代码

**A-1. `REQUEST_GRACE_MS` + `timeoutForSeconds` — 零调用**
- `src/services/sandbox-client.js:25`（常量）与 `:191-196`（函数）
- 证据：api-server 内仅定义处命中；唯一使用副本在 agent 服务自己的 sandbox-client.js:270（那边在用）。BFF 这份是旧单体重构拷贝残留
- 风险：低｜动作：直接删（约 8 行）

**A-2. `resolveUploadTraceId(req, fallback)` 的 `fallback` 参数不可达**
- `src/routes/files.js:76-83`；全部 3 处调用只传 `(req)`
- 风险：极低｜动作：删参数（或整个函数并入 req.traceId，见 C-3）

## B. Legacy 兼容层

**B-1. 审批模式布尔值 legacy 映射 + BFF 死配置面**
- `src/config.js:85-115`（parseLegacyApprovalEnabled）、`:119-121`
- `APPROVAL_MODE/APPROVAL_ENABLED` 在 BFF 源码中仅 effectiveConfig 日志读取；但 compose/.env.example 仍真实投影触发
- 动作：三处（.env.example / docker-compose.yml / config.js）同步移除；至少修正 config.js:203 过时注释。[待确认外部脚本依赖]

**B-2. `normalizeCreateRunBody` 的 message.content[]/camelCase 兼容形状**（runs.js:121-152）
- 前端只发 `{ messages[], conversation_id?, model_id? }`；旧形状仅测试覆盖，无生产调用方
- docs/api.md 为对外契约 → 保留注明或随 API 版本升级删

**B-3. SSE resume cursor 三种 query 拼写别名**（event-replay-service.js:41-49：afterSequence | after_sequence | after）
- 前端只用 after_sequence。合并到单一规范名 + 一个别名周期后删

**确认为有意保留**：SANDBOX_AUTH_ENABLED 回退、session_id/sandbox_session_id 双名契约、getDurableRun 测试 seam、X-Acting-* 剥离。

## C. 冗余兜底

**C-1. `sbFetch` 的 `timeoutMs == null` 死路径**（sandbox-client.js:143-154,182）
- 无任何调用方传 timeoutMs（含 null）；null 分支及 timer 判断不可达 → 简化为无条件 setTimeout

**C-2. `handleProcessAction` 不可达 else**（processes.js:104-106）——路由正则已限定 action 集合

**C-3. trace-id 双源冗余**（files.js:76-83、sessions.js:22-24 手工读头 vs server.js:236-241 统一 req.traceId）
- 仅上传/ensure 路径残留旧头读取路径 → 统一改 req.traceId

**C-4. agent-client requestHeaders 四层 trace 回退**（agent-client.js:100-133）
- 末层非 hex traceId 分支运行期不可达 [待确认单测依赖]

**C-5. Node 入站 header 大小写双拼检查**（trace-context.js:96-99 等）——大写拼写不可达，可清理

## E. 未使用资产

**E-1. `@opentelemetry/propagator-b3` 直接依赖冗余**（package.json:20）
- 源码零 import；是 sdk-node 传递依赖必然安装 → 从 dependencies 直接删

**E-2. compose 给 BFF 注入的 `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL`**（docker-compose.yml:225）
- api-server 全源码不读此变量，Agent 侧变量误注入 → 从 api-server environment 删

## 重点核查：端点差集（前端未调用的已挂载端点）
- GET /api/approvals/{id}、GET /api/processes/{id}、GET /api/processes/{id}/read、POST kill action、GET /api/cron-jobs/{id}、POST /api/files/upload
- 均有测试覆盖或 docs/api.md 文档化 → [待确认外部 API client]；若确认无消费者可下线约 150 行

## 清理收益估计
| 类别 | 净删行数 |
|---|---|
| A 死代码 | ~15 行 |
| B Legacy 层 | ~30 行 + 配置 3 处 |
| C 冗余兜底 | ~40 行 |
| E 未使用资产 | ~10 行 + lockfile |

合计约 95~100 行净删 + 配置面收敛。最高价值单项：C-1 与 A-1 同文件，可一次 PR 完成。
