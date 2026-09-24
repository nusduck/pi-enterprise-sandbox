# 验证记录：S2f VM exec release 与 systemd 部署资产

日期：2026-09-15。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §9.1 / §9.2 与 §11 S2（VM release/systemd）。
范围经用户确认：release 包、systemd unit、启动前检查、安装 / 切换 / 回滚脚本，在 Linux 容器中验证；不含 VM 工具链安装，不替代目标 VM 验收。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`3fa68656` + 本次未提交改动（随本证据同一 commit） |
| release 构建 | `scripts/vm/build-exec-release.sh --allow-dirty`（工作区有本次未提交改动，id 带 `-dirty-<时间>`），`node:22-slim` 构建容器，Node 22.23.2，glibc 2.36 |
| 演练环境 | 自建 `pi-vm-systemd-sim:dev`（`node:22-slim` + Debian bookworm 的 systemd 与 bubblewrap 包），`--privileged`，接开发 Compose 的 backend 网络；数据库为专用库 `pi_vm_sim`（`schema-apply.sh` 建表，核对零漂移），经双 UPDRDB Proxy 与 dbpm-fake 取密 |
| 宿主 | macOS arm64（OrbStack）；单测与卫生测试在宿主运行 |

## release 产物

| 架构 | id | 结果 |
|---|---|---|
| arm64 | `exec-3fa6865662ea-arm64-dirty-20260915055438` / `…055719` / `…060422` | 各 4962 个文件、约 27.7MB；原生模块 `koffi-linux-arm64`（gnu + musl）；`@pi/contract` 符号链接记录在 manifest |
| amd64（buildx 仿真） | `exec-3fa6865662ea-amd64-dirty-20260915055837` | `.sha256` 核对通过；manifest `arch: x64`；`koffi.node` 为 `ELF 64-bit LSB shared object, x86-64`；只安装了 `koffi-linux-x64`；schema 清单哈希与 arm64 相同。**未运行** |

三个 arm64 包：第一个构建时上下文早于 `exec.env.example` 的最后修改；第三个是加入最终加固项后的 unit，终验用它。

## 演练过程与结果

### 首轮演练（作废部分）

- 第一次运行在引导步骤失败：`--tmpfs /tmp` 默认 `noexec`，解到 `/tmp` 的 `install-release.sh` 报 `Permission denied`，后续步骤全部连带失败。脚本改为解到 `/root/bootstrap` 且引导失败即终止后重跑。
- 重跑后发现两处**判定写错**，结论不可用、已复核：
  - 「未监听」用 `ss` 判定，镜像没有 iproute2，永远输出 `NOT_LISTENING`；改为 `curl /health` 复核。
  - 「停止后残留 2 个进程」是 `pgrep -f "sleep 900|bwrap"` 匹配到了自身所在 `bash -c` 命令行；改为 `ps` + 方括号技巧并核对 unit cgroup 复核。

### 安装与负对照

| 步骤 | 结果 |
|---|---|
| `install-release.sh init` | 建系统用户 `pi-exec`（uid 997）；`/var/lib/pi-exec/{workspaces,tmp,artifacts,control}` 为 `pi-exec 0700`；`/etc/pi-exec` 为 `root:pi-exec 0750` |
| `install` + `activate` | 校验 `.sha256` 与 `SHA256SUMS`；release 文件 `root:root 644`；`current -> releases/<id>`；unit 安装并 daemon-reload，未重启 |
| 缺 `SANDBOX_MCP_INTERNAL_TOKEN` | ExecStartPre：`FAIL: SANDBOX_MCP_INTERNAL_TOKEN is required`；`curl /health` 复核未监听；systemd 按 `Restart=on-failure` 重试（`NRestarts=2`） |
| 篡改 `exec/dist/main.js` | `FAIL: release files do not match SHA256SUMS`，ExecStart 未执行 |
| `control` 数据根改 0755 | `FAIL: data root mode must be 0700`；恢复 0700 后 systemd 的自动重试即启动成功 |

### 启动与就绪

| 检查 | 结果 |
|---|---|
| 预检输出 | `running as uid 997` → `node 22.23.2` → `release … intact and read-only` → `required configuration present` → `data roots … 0700` → `system skill root readable` → `bwrap present` → `all checks passed` |
| 主进程 | `pi-exec  /usr/local/bin/node dist/main.js`，cwd 为 release 内 `exec/` |
| `/ready` | 200，`database / storage.* / isolation` 全 ok |

### 加固项与 Bubblewrap（逐项 drop-in 复核）

| 指令 | 结果 |
|---|---|
| `ProtectKernelTunables=yes` | 就绪、隔离 ok；mountinfo 有 `/proc/sys`、`/proc/sysrq-trigger` 只读覆盖 |
| `ProtectKernelLogs=yes` | 就绪、隔离 ok；`/proc/kmsg` tmpfs 覆盖 |
| `ProtectProc=invisible` | 就绪、隔离 ok |
| `PrivateUsers=yes` | 就绪、隔离 ok（未采用：uid 映射对共享存储的影响未评估） |
| `ProcSubset=pid` | `exec storage/isolation preflight failed, refusing to start: … bwrap: Can't read /proc/sys/kernel/overflowuid`，systemd 重试 |
| `RestrictNamespaces=yes` | `… bwrap: No permissions to create new namespace …`，exec 拒启 |

据此修正了初稿的错误判断（初稿称四个 `/proc` 相关项会使 bwrap 失败），unit 启用前三项。

### 终验（最终 unit，release `…060422`）

| 步骤 | 结果 |
|---|---|
| install + activate + restart | 成功；`list` 显示 current 为 `…060422` |
| unit 生效 | `systemctl show`：`ProtectKernelTunables=yes`、`ProtectKernelLogs=yes`、`ProtectProc=invisible`、`NoNewPrivileges=yes`、`KillMode=mixed`、`User=pi-exec`；主进程 mountinfo 含 `/proc/sys`、`/proc/sysrq-trigger`、`/proc/kmsg` 覆盖 |
| `/ready` | 200，隔离 ok |
| 后台作业（agent 容器内 `ExecRpcClient` 经 HMAC 内部面调 `pi-vm-sim:8081`） | `sleep 900` 启动，账本 `running`；进程为 2 个 `bwrap` + `sleep 900`，属主 `pi-exec` |
| `systemctl stop` | `inactive`；无 bwrap / sleep 残留；账本仍 `running` |
| `systemctl start` | `all checks passed` → `exec recovered 1 orphaned job(s) at startup` → `listening`；账本 `killed / orphaned: worker restarted`；`running/stopping` 行 0 |

### 切换与回滚（重跑演练中）

| 步骤 | 结果 |
|---|---|
| 安装并激活第二个 release 后重启 | 就绪；主进程 cwd 为新 release |
| 同 id 再次 install | `release already installed (releases are immutable)`，退出码 1 |
| `activate` 旧 id 后重启 | 就绪；`list` 与主进程 cwd 均指回旧 release |

## 单测与卫生

| 项 | 结果 |
|---|---|
| `tests/test_vm_release_assets.py` | env 模板每个变量在 exec / contract 源码中有读取方；凭据为占位符；unit 非 root、ExecStartPre、`KillMode=mixed`、启用实测兼容项、不含实测失败或未评估项；Node 在 `/usr` 下；构建器带 `contract/schema`、按目标平台构建、拒绝脏工作区；安装脚本不重启；三个脚本可执行且 `sh -n` / `bash -n` 通过 |
| 宿主 `uv run pytest -q` | 166 passed |
| 其余五套测试 | 本次无 `agent/`、`api-server/`、`exec/src`、`contract/src`、`frontend/` 改动，未重跑；最近全量见 S2c / S2e 证据 |

## 发现（未修改）

- exec 在 `EXEC_INTERNAL_ALLOW_CIDR` 为空时不限制内部面来源（`exec/src/http/router.ts` 注释与 `isIpAllowed` 行为）；开发 Compose 传入的 `SANDBOX_ALLOWED_CLIENT_CIDRS` 等大量 `SANDBOX_*` 是 Python 执行面时代的变量，TS exec 不读取。VM 上由 `exec-preflight.sh` 要求非空；应用默认值是否改为拒绝待决定。

## 未做 / 边界

- 演练容器是特权 Debian bookworm，不是麒麟 V11；KySec / SELinux、非特权主机上的 user namespace 限制、systemd 版本差异均未覆盖，加固项兼容性需在目标 VM 复测。
- amd64 release 只核对了清单、校验和与原生模块架构，未在 x86_64 上运行；构建容器 glibc 为 2.36，与目标麒麟 glibc 的兼容性未核对。
- VM 工具链（Python 3.11 venv、docx / pptxgenjs、bun 与 BaoYu 脚本依赖、麒麟 Chromium wrapper、LibreOffice / OCR / 字体）的安装与完整工具 smoke（design §9.1）未做。
- 演练中 Agent / BFF / sandbox-mcp 仍指向开发 Compose 的 sandbox，只用 agent 容器内的 RPC 客户端直连 VM exec；登录 → Run → 跨租户 404 的完整链路未经 VM exec 运行。
- LB 用 `/ready` 探测、SIGTERM 与 `TimeoutStopSec` 的真实 drain 时长、共享 Skill 挂载在 VM 上的属主与只读属性未验证。
- 演练库 `pi_vm_sim` 保留在开发 MySQL 中；release 产物在 `.runtime/vm-release/`（gitignore）与会话临时目录。
