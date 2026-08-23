# 死代码考古 · 横切资产（env / compose / docs / tests / scripts）

> 背景：2026-07-29 已做过一轮代码层清理，本轮横切资产复查总体健康，仍有以下真实残留。

## A. 死代码

| # | 位置 | 摘要 | 动作 |
|---|------|------|------|
| A1 | tests/e2e_artifact_flow.py:9-84 | 裸脚本 E2E：首个请求 POST /sessions 调用已删除的公共路由（session_workspace.py 仅剩 DELETE）；无鉴权头在 dev profile 下必 401；全仓零引用 | **直接删** |
| A2 | frontend/vite.trace-gate.config.ts | 孤儿 Vite 配置，全仓零引用 | 直接删 |
| A3 | .runtime/worktrees/ 空目录、pi_enterprise_sandbox.egg-info/ | 本地构建残渣（gitignore 已覆盖） | 本地磁盘清理 |

## B. Legacy 兼容层

| # | 位置 | 说明 | 建议 |
|---|------|------|------|
| B1 | agent/src/config.js:99-104、sandbox/config.py:839-856 | 旧布尔 APPROVAL_ENABLED → ask/deny 映射。compose 四处 fallback 仍真实触发；.env.example:139-140 布尔与 APPROVAL_MODE 双份 | 分两步：先删 .env.example 两行布尔值；代码映射保留过渡期 |
| B2 | sandbox/entrypoint.sh:26-28、config.py:869-877 | SANDBOX_HOST 为 SANDBOX_BIND_HOST 纯别名，compose 同时注入两个 | 合并：compose 删 HOST 注入 |
| B3 | container-env.js:151-152、worker-main.js:147 | REDIS_URL ↔ AGENT_REDIS_URL 双名，文档已明示有意兼容 | prod 可只写主名减少漂移面 |
| B4 | model-registry.js:518-542 | MODEL_CONTEXT_WINDOW/MODEL_MAX_TOKENS 为 MODEL_OVERRIDES_JSON 之前兼容变量，仍被解析 | 保留注明 |
| B5 | constants.js:90-114 | LEGACY_EXTENSION 包名拒绝表 = 持久数据兼容 + 生产安全护栏（guard 测试锁定） | **勿动** |
| B6 | artifact/api/public.py:149-156 | POST .../artifacts/register 旧端点别名；review-deferred-items.md 有明确关闭条件 | 保留（已有台账跟踪） |
| B7 | .env.example:43-44 | PI_PROVIDER/PI_MODEL 注释墓碑，代码零读取 | 删注释行 |

## C/D. 冗余与墓碑

| # | 位置 | 说明 | 动作 |
|---|------|------|------|
| C1 | tests/container_bwrap_smoke.py | 非死代码但像迷路测试：裸脚本不在 pytest 规范内、无 runbook/CI 说明 | 移入 scripts/release-gates/ 或 runbooks 补运行方式 |
| D1 | tests/test_python_agent_removed.py | 纯墓碑测试（断言 Python Agent 不存在），使命已完成；test_legacy_agent_routes_absent.py 因含运行期 404 守卫**应保留** | 退役或并入 legacy-routes 测试 |
| D2 | .env.example:362-367 | TTL 墓碑段落自述"已无效果可删"——该注释段本身也可删了 | 删 |
| D3 | .env.example:447 | # SANDBOX_IPTABLES_ENABLED=false 历史标志（测试已断言 compose 不含它） | 删示例行 |
| D4 | README.md「### Skill」段 | 仍描述已删除的 kit package skills / profile.skills / sharedSkills 机制（agent/src 零命中） | **改写为两层 Skill 模型**（与 skills/README.md 对齐） |
| D5 | README.md 目录结构段 | .runtime 子目录清单列 smoke/release-gates，实际是运行时生成 | 微调措辞 |

## E. 未使用资产

| # | 位置 | 说明 | 动作 |
|---|------|------|------|
| E1 | api-server/package.json:20 | @opentelemetry/propagator-b3 声明但从未 import（07-29 清理删掉了 agent 侧同名依赖，这份漏网）；反向：semantic-conventions 被 import 却未声明 | npm uninstall propagator-b3 + 显式安装 semantic-conventions |
| E2 | .env.example:360 | SANDBOX_ATTACHMENTS_ROOT sandbox 代码零读取（pydantic extra=ignore 吞掉）；仅 smoke 防御性传入 + reset runbook 护栏用 | [待确认] 删除并让 runbook 复用 SANDBOX_WORKSPACES_ROOT |
| E3 | .env.example:346 | RESET_DATABASE_NAME 全仓唯一出现处即此行 | 删 |
| E4 | .env.example:20 | 注释指向不存在的 reset 脚本（实际校验在 runbook 手工命令） | 修注释指向 docs/runbooks/development-reset.md |
| E5 | .claude/settings.local.json | 根目录存在但 .gitignore 未覆盖 .claude/ | 追加到 .gitignore |

## 逐项核对过、确认存活（避免误报）
SKILLS_ROOT/SKILLS_USER_ROOT/SKILLS_AUDIT_LOG、TOOL_RISK_POLICY_JSON/PATH、MODEL_REGISTRY_PATH/OVERRIDES_JSON、AGENT_RUN_INIT_TIMEOUT_MS、A2A_* 三件套、BFF_DEV_ACTING_*、DATASET_UPLOAD_MAX_BYTES、CORS_ALLOWED_ORIGINS、SANDBOX_UVICORN_*、TEST_MYSQL_URL/TEST_REDIS_URL、MYSQL/REDIS_*_VOLUME、NGINX_HTTP(S)_PORT/DOMAIN、全部 SANDBOX_MCP_*（mcp/settings.py 显式 alias）、SANDBOX_MAX_ATTACHMENTS_PER_TURN/MAX_TURN_ATTACHMENT_MB（pydantic env_prefix 自动映射，**不是死变量**）。

## 范围专项结论
- docker-compose.yml/prod.yml：无注释掉的段落、无孤儿卷、无失效字段；prod overlay !reset/!override 有三重校验锁定
- skills/：21 个包与 README 计数一致；内容资产按设计自动发现，裁剪属产品决策非死代码
- docs/：plan/STATUS/PROCESS_LOG/review-deferred-items 均有时效性管理；archive 外过时的仅 D4/D5 两处 README 段落。（biz-db-mcp/ 已确认为外部服务设计稿，2026-08-23 从仓库删除）
- scripts/：backup/restore/smoke/verify_compose_prod_config/release-gate 全部有测试或 CI 引用——无一完成使命

## 清理收益估计
- A 类 ≈ 100 行损坏/孤儿脚本 + 本地残渣
- B 类 ≈ .env.example 精简 5–8 行 + 审批双轨制收敛
- C/D 类 ≈ 80 行墓碑/注释/文档漂移修正（D4 必须修）
- E 类 ≈ 依赖瘦身 + lockfile 重生成

## 待监督方执行的验证命令
1. `git ls-files agent/pi-agent-home frontend/dist .runtime pi_enterprise_sandbox.egg-info .claude`（期望空输出）
2. `uv run pytest tests/test_python_agent_removed.py tests/test_legacy_agent_routes_absent.py -q`（若采纳 D1）
3. `cd api-server && npm uninstall @opentelemetry/propagator-b3 && npm install @opentelemetry/semantic-conventions`
