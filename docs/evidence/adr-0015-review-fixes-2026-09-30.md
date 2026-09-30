# ADR 0015 复审发现与修复的真实链路验证 — 2026-09-30

补充 [`adr-0015-skill-binding-real-chain-2026-09-30.md`](adr-0015-skill-binding-real-chain-2026-09-30.md)（实施方的验收记录，
本文不改写它）。

- 代码版本：工作树（`main` @ `c559d64b` + ADR 0015 未提交改动 + 本次复审修复），未提交。
- runtime：宿主 Node `v22.23.2`（`/opt/homebrew/opt/node@22`；宿主默认 `v23.11.0` 不符合版本钉，未使用），
  Python 由 `uv` 按 `runtime-versions.json` 解析。
- 验证对象：重建后的容器。`docker compose build agent agent-worker sandbox sandbox-mcp` → `docker compose up -d …`，
  逐个核对运行容器的镜像 ID 等于刚构建的 tag。`sandbox-mcp` 重建后镜像 ID 不变（facade 的 import 图不含本次改动文件）。
  `api-server` / `frontend` 本次未改，未重建。
- 驱动：只走 BFF（`/api/*`）+ 真实模型 Run。另对**开发库**里自建的测试 AgentVersion 做过一次 `config_json`
  注入（模拟更新的写入方），验证后已还原。

## 复审发现（修复前在运行栈上复现）

| # | 现象 | 复现 |
|---|---|---|
| 1 | 只绑定 `xlsx` 的 Agent 用文件工具读到未绑定的系统包 | `glob /home/sandbox/skill` 列出全部 13 个系统包；`read /home/sandbox/skill/pdf/SKILL.md` 成功。bwrap 已逐包，但 `read`/`glob`/`grep` 走 exec fs RPC，`skill` 作用域按整个系统根放行 |
| 2 | `skillPolicy` 形状非法时回落到默认策略（全部放开） | 给 `system.allowlist=[xlsx]` 的版本注入 `skillPolicy.system.pinRelease`：Run 成功，`ls /home/sandbox/skill \| wc -l` = 13 |
| 3 | exec 把 `systemSkills` 当必需字段：没有安全的部署顺序 | 静态：exec 先升级 → 旧 Worker 全部 `ENVELOPE_INVALID`；Worker 先升级 → 旧 exec 不认 `scope: org`。三处文档说法互相矛盾 |
| 4 | org 回收删掉 `active`（可绑定）版本的字节，账本仍 active | 静态 + 单测：配置面仍列出、保存成功，Run 以 mismatch 排除 |
| 5 | 批准与撤回竞态：撤回成功而 Skill 已进 org 层 | 单测复现（修复前撤回返回成功） |
| 6 | 仓储层 `SKILL_SHARE_REQUEST_DECIDED` 映射成 400，api.md 写 409 | 批准后作者撤回：`http=400` |

## 修复后验证

```text
# 1：RV-XLSX（allowlist=[xlsx], user=deny），run 01M3RQJWTXPVQ0NGSRC8T6WJAJ
glob /home/sandbox/skill            → FS_SANDBOX_DENIED（系统根不可寻址）
read /home/sandbox/skill/pdf/...    → FS_SANDBOX_DENIED: skill package not enabled: pdf
read /home/sandbox/skill/xlsx/...   → 成功

# 2：注入 skillPolicy.system.pinRelease，run 01M3RQMEQYQATKNE332YG47FEP
status FAILED — AgentVersion skillPolicy is not supported by this runtime
(skillPolicy.system.pinRelease: Unknown configuration field "pinRelease") …
（注入已还原：config_json 回到 {"skillPolicy": {"user": "deny", "system": {"mode": "allowlist", "names": ["xlsx"]}}, "schemaVersion": 1}）

# 5/6：userc 申请共享 rv-share → admin 批准（setCurrent）→ userc 撤回
approve 200 approved；withdraw → 409 SKILL_SHARE_REQUEST_DECIDED

# org 层经 fs RPC：RV-ORG（system=none, org=[rv-share@1806a776…], user=deny），userb，run 01M3RQRZ6G8GN1GEERBN60CBGV
read /home/sandbox/skill-org/rv-share/SKILL.md → 成功（RV SHARE BODY v1.）
ls /home/sandbox/skill → No such file or directory；ls /home/sandbox/skill-org → rv-share

# 通用：进程与跨用户
GET  /api/processes?session_id=…         → sleep 120 running
GET  /api/processes/{id}/logs            → 200
POST /api/processes/{id}/signal SIGTERM  → killed；列表 cancelled
userc → userb 的 run / events / processes → 404 / 404 / 404
userb → /api/admin/skills/org             → 403

# 3：兼容期告警（新 Worker 始终带名单）
docker compose logs sandbox | grep -c 'without systemSkills' → 0
```

3（兼容分支本身）与 4（回收规则）由单测覆盖，未在真机上构造旧 Worker 或推进宽限期：
`contract/test/skill-manifest.test.ts`、`exec/test/fs-skill-tiers.test.ts`、`exec/test/fs-writable-roots.test.ts`、
`exec/test/isolation-preflight.test.ts`、`agent/tests/mysql/org-gc.unit.test.js`。

## 测试与检查（Node 22.23.2）

| 命令 | 结果 |
|---|---|
| `uv run pytest -q` | 223 passed |
| `npm test --prefix contract` | 151 pass |
| （注） | exec / agent 的本机测试引用 `contract/dist`，它不随 `npm test` 重新编译。首轮跑在过期的 dist 上；`npm run build --prefix contract` 之后 exec / agent / api-server 全部重跑，结果如下。容器镜像从源码编译 contract，不受影响（已在运行容器里核对） |
| `npm test --prefix exec` | 459 pass / 3 skipped（恢复 dsh 为「必需字段」加的夹具 `systemSkillPackages: []` 之后） |
| `npm test --prefix agent` | 1742 pass |
| `npm test --prefix api-server` | 185 pass |
| `npm test --prefix frontend` | 463 pass |
| `npm run build --prefix frontend` | 通过 |
| `tsc --noEmit`（exec、contract，用各包自带 tsc；仓库根没有 `typescript`，`npx tsc` 取不到编译器） | 通过 |
| `npm --prefix api-server run typecheck`、`npm --prefix agent run typecheck` | 通过 |

## 未覆盖

- **浏览器实操**：未完成。Chrome 自动化里的 `127.0.0.1:3000` **不是本机这套 compose 栈**：同一 URL，浏览器拿到
  `nginx/1.31.6` 与前端产物 `index-BT9DNzm0.js`，本机 curl 拿到 `nginx/1.31.5` 与 `index-_G-ySjUo.js`；本机 3000 端口
  只有 compose 前端在监听，浏览器那次 401 的 trace id 不在本栈任何日志里。本栈新建的测试账号在那套部署里不存在，
  所以登录 401。前端 UI 需要在连到本栈的浏览器里做真实点击验收。
- 跨 org 404：本地只有一个 bootstrap org，仍只有单测覆盖。
- MCP 窄桥是否应收窄系统 Skill：恢复为与 ADR 0015 之前相同的整树只读，是否收窄待产品决定。
