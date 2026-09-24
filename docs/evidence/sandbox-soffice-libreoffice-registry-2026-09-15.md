# 验证记录：执行面镜像内 soffice 在沙箱里启动即崩溃（Debian LibreOffice 注册表不可见）

日期：2026-09-15。修复 [S2f-2 工具链 smoke](s2f2-openeuler-toolchain-smoke-2026-09-15.md) Debian 对照中记录、
[/etc 白名单修复](sandbox-etc-allowlist-fonts-ca-2026-09-15.md) 前后均出现的 soffice abort。

## 复现

| 场景 | 结果 |
|---|---|
| 开发栈 `sandbox`（`0fa4f19a` 镜像）经 exec 内部面在 bwrap 内：`soffice --headless --convert-to pdf p.docx` | exit 134，无输出文件；`terminate called after throwing an instance of 'com::sun::star::uno::RuntimeException'`、`Fatal exception: Signal 6` |
| 同一容器、bwrap **外**，uid 10001，同一命令 | exit 0，生成 `p.pdf` |
| 沙箱内 `ls -la /usr/lib/libreoffice/share/registry` / `ls /etc/libreoffice` | 前者是指向 `/etc/libreoffice/registry` 的符号链接；后者不存在 |

## 根因

Debian 打包的 LibreOffice 7.4.7（`libreoffice-core 4:7.4.7-1+deb12u14`）把配置注册表（`main.xcd`、`writer.xcd` 等）装在
`/etc/libreoffice/registry`，`/usr/lib/libreoffice/share/registry` 与 `share/psprint/psprint.conf` 是指向 `/etc/libreoffice` 的符号链接。
exec 沙箱只绑定 `/usr` 与 `/etc` 白名单，这两条链接在沙箱内悬空，configmgr 读不到注册表后抛异常 abort。与 `-env:UserInstallation` 指向哪里无关。
openEuler VM 用的是 TDF 官方包，注册表在安装目录内，不受影响。

在执行面镜像中扫描 `/usr` 与 `/opt/pi-python` 下所有解析到 `/etc` 且不在白名单内的符号链接，只有五条：

| 链接 | 处理 |
|---|---|
| `/usr/lib/libreoffice/share/registry -> /etc/libreoffice/registry` | 挂载 |
| `/usr/lib/libreoffice/share/psprint/psprint.conf -> /etc/libreoffice/psprint.conf` | 挂载 |
| `/usr/lib/environment.d/99-environment.conf -> /etc/environment` | 不挂：真实主机上可能含敏感环境变量，沙箱不需要 |
| `/usr/lib/python3.11/sitecustomize.py -> /etc/python3.11/sitecustomize.py` | 不挂：模型工具走 venv，缺失时 Python 静默跳过 |
| `/usr/share/X11/rgb.txt -> /etc/X11/rgb.txt` | 不挂：headless 工具不用 |

## 修复

`exec/src/isolation/build.ts` 的 `STATIC_ETC_FILES` 追加 `/etc/libreoffice/registry`、`/etc/libreoffice/psprint.conf`，可缺省只读挂载；
不整体挂 `/etc/libreoffice`。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`0fa4f19a` + 本次未提交改动（随本证据同一 commit）；工作区另有无关的 `docs/reviews/2026-09-01-full-regression/` 在途改动 |
| Linux 测试容器 | `pi-exec-test:fontspki`（`node:22-slim` + bubblewrap，Node 22.23.2，uid 10001），安全选项同 Compose `sandbox` |
| 开发栈 | `docker compose build sandbox sandbox-mcp` 后 `up -d --no-deps --force-recreate`，均 healthy |
| VM 演练 | release `exec-0fa4f19a0bdd-arm64-dirty-20260915134006`，openEuler 24.03 容器 `pi-vm-sim` 中 install / activate / restart，就绪 |

## 回归测试

- `exec/test/isolation-build.test.ts`：两条挂载存在、`ro_bind`、源与目标相同、`required: false`、`sessionSpecific: false`；不绑定整个 `/etc/libreoffice` 与 `/etc/environment`。
- `exec/test/isolation-preflight.test.ts`：preflight 静态挂载清单加入两条。

| 运行 | 结果 |
|---|---|
| **修复前**（`git archive HEAD exec/src` + 新测试） | 52 项 2 失败，均为新断言：`missing /etc allowlist mount: /etc/libreoffice/registry`；preflight 同 |
| **修复后** exec 全量（Linux 容器，真实 bwrap） | 403 / 403，0 skip；exec `tsc --noEmit` 通过 |

未新增真实 bwrap 的 soffice 测试：测试镜像不装 LibreOffice（约 1GB），真实沙箱行为以下表为证。

## 真实沙箱验证（修复后，经 exec 内部面在 bwrap 内，默认用户配置目录）

| 检查 | Debian 执行面（开发栈 `sandbox`） | openEuler VM exec（TDF LibreOffice 26.8） |
|---|---|---|
| `/etc/libreoffice` | 沙箱内可见挂入的条目 | 不存在（挂载跳过） |
| `soffice --headless --convert-to pdf a.docx b.xlsx c.pptx` | exit 0，日志无 `RuntimeException` / `Signal 6` | 同左 |
| PDF 读回 | `docx 转换 OK 你好`、`xlsx convert OK`、`pptx convert OK` | 同左 |

## 真实链路（修复后开发栈，经 BFF）

注册 / 登录 200；`sessions/ensure` 200；带工具 Run `SUCCEEDED`（`bash` × 4 succeeded）；进程 logs `TICK-1…TICK-13`；`SIGTERM` 200 后 `cancelled`；
B 访问 A 的 run / conversation / tools / sessions.ensure / process 详情 / logs / signal 全 404，A 对照 200。驱动中「输出含 openEuler」一项在
Debian 执行面上按预期不成立（13/14）。

## 其余检查（`node:22-slim` 容器内 `npm ci`，Node 22.23.2）

| 项 | 结果 |
|---|---|
| contract 测试 | 109 / 109 |
| agent 测试 | 1325 pass / 0 fail / **3 cancelled**（既有已知组，不记为通过）；本次无 agent 改动 |
| agent / api-server 类型检查 | 通过 |
| api-server 测试 | 159 / 159 |
| frontend 测试 / build | 367 / 367；`vite build` 成功 |
| `uv run pytest -q`（宿主） | 随提交前运行，见 commit message |

## 未做 / 边界

- 只覆盖 docx / xlsx / pptx → PDF；其他过滤器（如 odt、图片导出）、宏、Java 相关功能（日志有 `failed to launch javaldx`，镜像未装 Java）未测。
- 目标麒麟 VM 若改用发行版打包的 LibreOffice，注册表位置需复核；本次挂载对 `/etc/libreoffice` 布局通用。
