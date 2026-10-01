# 公司 SSO（OIDC）研发环境版验证记录

日期：2026-10-01（Asia/Singapore）。设计：[sso-oidc-dev.md](../design/sso-oidc-dev.md)。
基线：P1 本地提交 `fc697b40`（未推送）；验收对象为分支 `codex/sso-oidc` 上的未提交工作区。
未推送、未查询远端 CI。**没有与公司 IdP 联调**：IdP 为开发替身 mock-oauth2-server 3.0.1。

## Runtime

权威 `runtime-versions.json`：Node 22、Python 3.11。
- Agent 全套：Agent 生产镜像内 Linux Node 22.23.2，仓库根夹具只读挂载，`env -i` 清空开发栈凭据。
- BFF 全套：`node:22`（22.23.3）容器内 `npm ci` 后运行（同时证明新 lockfile 在 Linux 可装）。
- exec / contract / frontend / 类型检查 / frontend build：宿主 Node 22.19.0（P1 下载并校验的官方归档）。
- 迭代期间曾用宿主 Node 26 跑单个文件，最终结论只取上述 Node 22 结果。

## 检查结果

| 命令/对象 | 结果 | 说明 |
|-----------|------|------|
| `uv run --python 3.11 pytest -q` | 223 passed | 含 UPspec、compose 端口与容器用户 |
| `npm test --prefix agent`（Linux 22.23.2） | 1934/1935，第 1 次 | 唯一失败 `migrate-trigger-preflight` 读 `/app/docker-compose.prod.yml` ENOENT：验收挂载漏了该文件 |
| 补挂全部 `docker-compose*.yml` 后重跑该文件 + `sso-login` + `agent-catalog-service` | 53/53 | P1 记录的 catalog「headers」误报本次未复现 |
| `npm test --prefix api-server`（node:22 22.23.3） | 304/304 | 宿主 22.19.0 上 302 pass + 2 个既有上传夹具 cancelled，与 P1 记录一致 |
| `npm test --prefix exec` | 475 pass，3 skipped | 真库/宿主 bwrap 条件门禁未启用 |
| `npm test --prefix contract` | 159/159 | |
| `npm test --prefix frontend` | 609/609 | |
| tsc exec / contract，agent / api-server typecheck | 全部通过 | |
| `npm run build --prefix frontend` | 通过 | |
| `docker compose config -q`（含 `--profile sso-dev`） | 通过 | |
| `git diff --check` | 通过 | |

新增测试：`agent/tests/http/sso-login.unit.test.ts`（18 项，起真实 HTTP discovery/JWKS，jose 签 RSA token）、
`api-server/tests/sso-routes.test.js`（7 项，生产 `dist/server.js` + 校验 PKCE 的协议替身 IdP）、
`frontend/test/sso.test.ts`（8 项）。突变检查：去掉 BFF 事务的 state 比对后，跨事务 Cookie 用例失败；恢复后通过。

## Schema

空影子库全量重放生成 manifest：38 migrations / 56 tables / 4 triggers；diff 只新增
`tbl_agsvc_sso_identities` 与迁移名。`tests/test_schema_upspec_naming.py` 通过。
用 `cli-schema sql --from 20261002000001_browser_auth_sessions.js` 导出增量包，只有
`0038_20261002000002_sso_identities.sql` 一段（建表 + 3 个索引 + 记账），应用到开发库后
`cli-schema verify` 0 drift。未清空既有业务数据。

首次只重建 agent 时 sandbox 因随镜像清单过期 fail-closed 拒绝启动（`extra_table tbl_agsvc_sso_identities`）；
按 AGENTS.md §4 重建 sandbox / sandbox-mcp 后恢复。

## 容器

`docker compose build agent api-server frontend sandbox sandbox-mcp`；SSO 配置经 shell 环境覆盖注入
（`.env` 未改，覆盖值存于 gitignored `.runtime/sso-dev.env`）。重建前比对运行容器与纯 compose 配置，
没有其他 shell 覆盖会被丢失。K8s `dsh-dev` agent-worker 副本仍为 0。

| 服务 | imageId 前缀 | uid | 状态 |
|------|-------------|-----|------|
| agent / agent-worker | 3769110a9f12 | 1000 | healthy |
| api-server | ed12f4448b2b | 1000 | healthy |
| sandbox | 98d911128642 | 10001 | healthy |
| sandbox-mcp | 4bde2f2b7f48 | 1000 | healthy |
| frontend | 1d8929f53033 | 1000 | running |
| mock-oidc | 4f3660e5f358 | 65532 | running |

`SSO_CLIENT_SECRET` / `SSO_TRANSACTION_SECRET` 只在 api-server 容器非空；agent、agent-worker、sandbox 为空。

## 真实链路（`.runtime/sso-oidc/live-sso.mjs`，32/32）

经 frontend nginx `localhost:3000` → BFF → mock-oauth2-server → Agent → MySQL，脚本扮演浏览器
（跟随跳转、提交替身登录表单、携带 Cookie）：

1. config：mode=sso、SSO 可用、注册关闭。
2. 首次登录：跳 IdP 带 S256/state/nonce；回调 303 到原站内路径并写会话 Cookie，事务 Cookie 清除；
   me 为 `login_method=sso`、`identity_provider=http://oidc.localhost:8090/default`、用户名=工号、零角色、
   `org_bootstrap`；库内 `(iss, sub, 工号)` 关联、凭据占位哈希、无 member_roles 授予。
3. 同一 sub 换工号再登录：同一账号、新 sid，工号属性刷新。
4. 员工用账号密码 → 403 `LOCAL_LOGIN_RESTRICTED`；`admin` 错误密码 → 401（名单放行到密码校验）；注册 403。
5. 工号=`admin` → `sso_error=IDENTITY_BINDING_CONFLICT`，无会话。
6. 同一 code + 保留的旧事务 Cookie 重放 → 失败且不签发会话；无事务 Cookie 的回调 → `SSO_STATE_INVALID`。
7. SSO 用户一轮 bash 工具 Run `SUCCEEDED`（Run `01M3W25SHFR1KQEEJD42CRAP8W`，真实模型 + bwrap），
   工具账本含标准输出；后台进程列表/日志/信号成功。
8. 同 org 第二个 SSO 员工读第一个人的 Run / 会话 / 工具 / 进程日志全部 404。
9. 退出 `revocation=confirmed`；旧 Cookie 重放 401；同一员工另一 sid 不受影响。

故障对照：IdP 停止且 BFF discovery 冷启动时，`/api/auth/sso/login` 立即 303
`sso_error=SSO_UPSTREAM_UNAVAILABLE`；失败不缓存，IdP 恢复后再次 302。
（探测过程中两次 502 来自 frontend nginx 缓存了重启前的 BFF 容器 IP，重启 frontend 后消失；
这是既有 nginx 上游解析行为，与 SSO 无关，未在本次修改。）

## 浏览器（`.runtime/sso-oidc/browser-sso.mjs`，12/12）

Claude in Chrome 扩展未连接，改用 Playwright 1.55 的真实 Chromium（容器接 compose 网络，
容器内把 `localhost:3000`/`:8090` 转发到 frontend 与 mock-oidc，地址与宿主浏览器一致），操作部署版
前端，无 API mock：登录面板只有 SSO 主入口与「管理员账号登录」、无注册；点 SSO 整页跳 IdP、填工号
claims、回到平台以工号登录且地址栏无 code/state；账户页显示「公司 SSO」与身份来源；退出回登录面板；
`?sso_error=SSO_ACCESS_DENIED` 显示中文提示并从地址栏移除；员工用账号密码提示改走 SSO，且旧的 SSO
错误被清掉。首轮截图发现按钮文案缺空格、两条错误叠加，已修复后重建 frontend 复验。

## 未覆盖

- 公司 IdP：真实 issuer、claims（工号字段名）、回调登记、`client_secret_basic` 需求均未验证。
- HTTPS / Secure Cookie、多副本 BFF 回调（加密 Cookie 设计上不依赖副本，未实测多副本）。
- Agent 侧登录事务消费账本未实现（设计 §1 已记录偏差与收紧方式）。
- 智能体按人可见（发布范围）未开始，另立 PR。
