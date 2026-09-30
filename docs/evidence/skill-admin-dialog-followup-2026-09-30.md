# Skill 管理弹窗复审修复验证 — 2026-09-30

## 范围与版本

- 分支：`fix/skill-share-ui-and-agent-dropdown`，HEAD `92c74a17`，未提交工作区。
- 任务开始已有 agy 的 Skill 共享 UI、引用查询与默认智能体选择器改动；本次只补弹窗处理中 Esc 护栏、移除虚假影响面截断提示、浏览器回归与对应文档，不提交或回退既有改动。
- 宿主前端 / exec / contract：Node `22.19.0`；BFF 最终测试：Node `22.23.2`；Agent 测试在 `node:22-slim` 容器运行，实际 Node `22.23.2`。均满足 `runtime-versions.json` 的 Node 22 约束。
- Python：`uv run python --version` → `3.11.15`。浏览器：已安装的 Google Chrome，Playwright 来自桌面工具运行时，不修改仓库依赖或锁文件。
- STATUS IDs：无 §32 状态变化；本记录不关闭任何验收项。

## 先复现，再修复

新增 `scripts/smoke-skill-admin-ui.mjs`，直接操作构建产物中的真实 React 页面，全部 `/api/*` 请求由浏览器隔离夹具拦截。

修复前 3 条用例：1 pass / 2 fail。

1. 挂起吊销请求，确认「取消」已禁用，然后按 Esc：弹窗关闭，`isVisible()` 为 false，断言失败。
2. 完整返回 1001 个引用 ID：结果弹窗存在「已截断」，断言期望 0、实际 1。
3. 合法对照：空闲时 Esc 能关闭；Tab 不能访问背景控件，测试通过。

修复后 3/3 通过，包括失败后原因保留、弹窗内错误显示与合法重试成功；1001 条结果 / 清单可搜索最后一条，分页与复制全部入口保留。`SKILL.md` 本身的真实截断提示仍显示。

浏览器命令（模块和浏览器路径由本机运行时提供）：

```bash
PLAYWRIGHT_MODULE=<Playwright/index.mjs 的绝对路径> \
PLAYWRIGHT_EXECUTABLE_PATH=<Chrome 的绝对路径> \
node --test scripts/smoke-skill-admin-ui.mjs

SKILL_ADMIN_UI_BASE_URL=http://127.0.0.1:3000 \
PLAYWRIGHT_MODULE=<Playwright/index.mjs 的绝对路径> \
PLAYWRIGHT_EXECUTABLE_PATH=<Chrome 的绝对路径> \
node --test scripts/smoke-skill-admin-ui.mjs
```

预览和部署版各 3/3 通过。上述夹具不证明真实吊销事务、审批或鉴权；真实服务检查另见下文。

## 六套测试与类型检查

先运行 `npm run build --prefix contract`，确保其他包消费当前契约产物。

| 命令 | 最终结果 |
|---|---|
| `uv run pytest -q` | 223 passed |
| `npm test --prefix exec` | 459 pass / 3 skipped |
| `npm test --prefix contract` | 151 pass |
| `npm test --prefix agent` | 1748 pass |
| `npm test --prefix api-server` | 185 pass（Node 22.23.2） |
| `npm test --prefix frontend` | 466 pass |
| exec / contract 自带 `tsc --noEmit -p tsconfig.json` | 通过 |
| Agent `npm run typecheck`（主程序及 runtime） | 通过 |
| BFF `npm run typecheck` | 通过 |
| `npm run build --prefix frontend` | 通过；Vite 保留原有大 chunk 提示 |
| `docker compose config -q`、`git diff --check` | 通过 |

初次失败与边界：

- exec / contract / BFF 最初尝试 Linux 容器运行，但这些包现有 esbuild 是 Darwin 二进制，测试进程启动失败。改为宿主 Node 22 运行；Agent 的 esbuild 是 Linux 二进制，继续在容器运行。未重装依赖或改断言。
- BFF 在 Node 22.19.0 首轮 183 pass / 2 cancelled，单独重跑 `file-proxy-workspace-id.test.js` 仍 1 pass / 2 cancelled，报未完成 Promise 且事件循环已结束。同一文件在 22.23.2 上 3/3 通过，随后全套 185/185 通过。记录的是观察结果，未在本任务修复或断言其底层原因。
- exec 跳过的是需要真实 bwrap / 非 root Linux 或显式 `TEST_MYSQL_URL` 的测试与套件。宿主测试通过不等于这些跳过项已覆盖；下述真实 Run 在 Linux 执行面完成工具执行。

## 镜像重建与运行对象

```bash
docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend
scripts/dev/k8s/up.sh dev
```

按当前本地拓扑更新：应用层在 OrbStack K8s，exec / MySQL / Redis / dbpm-fake 在 Compose；未同时启动第二组 Worker。全部应用 Deployment 滚动完成、Ready，exec 为 healthy。

核对每个运行消费者的 image ID 与刚构建镜像相同：

| 消费者 | 镜像 digest（sha256 前缀） |
|---|---|
| agent / agent-worker | `4bdbfea75645` |
| api-server | `74c68b52c1cb` |
| frontend | `82ee17fb421c` |
| sandbox-mcp | `684794f8ffe5` |
| sandbox | `523a6c00b42f` |

部署入口 HTML 返回当前前端资产 `index-Dw7hBfj1.js`，与宿主构建一致；部署版浏览器回归使用该入口。

## 真实服务链路

新建两个专用于验收的开发账户，第二个账户只调整其新建凭据的外部组织归属以验证跨租户；正常登录，经 BFF 发起请求。使用真实模型、MySQL 账本与 Linux 执行面，没有 fake provider。

- 两个账户登录均 200；创建会话 `01M3S8H97J6M7VRTAM524TRH0E`，会话 / 工作区初始化成功。
- Run `01M3S8H99W0XZG42JQP66AG48X` → `SUCCEEDED`，真实工具账本包含预期失败的 `read`，成功的 `write`、`read`、`bash`、`submit_artifact`、`job_output`。
- 文件下载 200 并核对唯一验收标记，产物列表 200。
- 后台进程日志 200 并核对输出；合法账户 SIGTERM 200，验收后台进程已发停止信号。
- 另一组织读 Run / Conversation / 工具账本 / 进程 / 日志，及发进程信号，6 次均 404。

原始驱动和结果位于忽略的 `.runtime/skill-admin-verification/`，不作为活跃文档依赖，不输出账户密码、Cookie 或其他凭据。开发验收账户、会话和产物保留用于审计；没有改现有用户数据。
