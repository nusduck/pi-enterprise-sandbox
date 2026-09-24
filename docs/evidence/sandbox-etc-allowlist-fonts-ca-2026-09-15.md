# 验证记录：沙箱 /etc 白名单补字体配置与 RHEL 系 CA 信任库

日期：2026-09-15。修复 [VM exec 真实链路](s2f2-vm-exec-real-chain-2026-09-15.md) 与
[S2f-2 工具链 smoke](s2f2-openeuler-toolchain-smoke-2026-09-15.md) 中记录的两项发现。

## 缺陷与根因

| 现象 | 根因 |
|---|---|
| 沙箱内 soffice / tesseract 报 `Fontconfig error: Cannot load default config file`（Debian 执行面镜像与 openEuler VM 都有） | `exec/src/isolation/build.ts` 的 `STATIC_ETC_FILES` 不含 `/etc/fonts`，沙箱里没有 fontconfig 配置 |
| openEuler 上沙箱内 CA 证书全部不可读，Python `ssl.get_default_verify_paths()` 为 `None None` | openEuler `/etc/ssl/certs -> ../pki/tls/certs`，其中文件再指向 `/etc/pki/ca-trust/extracted/…`；白名单只有 `/etc/ssl` 与 `/etc/ca-certificates`，符号链接在沙箱内悬空。放开网络后沙箱内 HTTPS 校验会失败 |

## 修复

`STATIC_ETC_FILES` 追加五条可缺省只读挂载：`/etc/fonts`、`/etc/pki/tls/certs`、`/etc/pki/tls/cert.pem`、`/etc/pki/tls/openssl.cnf`、
`/etc/pki/ca-trust/extracted`。**不整体挂 `/etc/pki`**：`tls/private`（私钥）、`nssdb`、`rpm-gpg` 等不进沙箱。Debian 上 `/etc/pki` 不存在，
按 `required: false`（`--ro-bind-try`）跳过。preflight profile 由同一次 `buildIsolationProfile()` 派生，自动带上这些挂载。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`954796c2` + 本次未提交改动（随本证据同一 commit）；工作区另有无关的 `docs/reviews/2026-09-01-full-regression/` 在途改动 |
| Linux 测试容器 | 本地构建 `pi-exec-test:fontspki`（`node:22-slim` + bubblewrap / util-linux / fontconfig，Node 22.23.2，uid 10001），安全选项与 Compose `sandbox` 一致：`seccomp=exec/seccomp-bubblewrap.json`、`apparmor=unconfined`、`systempaths=unconfined` |
| 开发栈 | `docker compose build sandbox sandbox-mcp` 后 `up -d --no-deps --force-recreate`，均 healthy |
| VM 演练 | `scripts/vm/build-exec-release.sh --arch arm64 --allow-dirty` → `exec-954796c2eebf-arm64-dirty-20260915133117`，在 openEuler 24.03 容器 `pi-vm-sim` 中 install / activate / restart，`/ready` 全 ok（库为演练专用 `pi_vm_sim`） |

## 复现与回归测试

新增 / 修改的测试：

- `exec/test/isolation-build.test.ts`：五条挂载存在且为 `ro_bind`、源与目标相同、`required: false`、`sessionSpecific: false`；
  不绑定 `/etc/pki`、`/etc/pki/tls`、`/etc/pki/ca-trust`、`tls/private`、`nssdb`、`rpm-gpg` 及 `tls/private` 下任何路径。
- `exec/test/isolation-bubblewrap.test.ts`：真实 bwrap 跑生产 profile，沙箱内 `/etc/fonts/fonts.conf` 可读、存在的 CA 文件可读、
  `/etc/pki/tls/private` 不可见、`/etc/fonts` 只读（宿主无 bwrap 或无字体配置时跳过）。
- `exec/test/isolation-preflight.test.ts`：preflight 静态挂载清单加入五条。

| 运行 | 结果 |
|---|---|
| **修复前**（`git archive HEAD exec/src` + 新测试，Linux 容器） | 51 项 3 失败，均为新断言：真实 bwrap 输出 `fonts=missing`（`ca=ok /etc/ssl/certs/ca-certificates.crt`、`private=absent`）；`missing /etc allowlist mount: /etc/fonts`；preflight `missing static /etc file mount: /etc/fonts` |
| 首次复现尝试（作废） | 普通 `docker run` 只给 seccomp 时，bwrap 连最简命令也报 `Can't mount proc on /newroot/proc`，既有的真实 bwrap 测试同样失败——环境不成立；补 `apparmor=unconfined`、`systempaths=unconfined` 后重跑得到上一行 |
| **修复后** exec 全量（Linux 容器，真实 bwrap） | 402 / 402 pass，0 skip |

## 真实沙箱验证（修复后，经 exec HMAC 内部面在 bwrap 内执行）

| 检查 | Debian 执行面（开发栈 `sandbox`） | openEuler VM exec |
|---|---|---|
| `/etc/fonts/fonts.conf` | 可读 | 可读 |
| CA 文件 | `/etc/ssl/certs/ca-certificates.crt` 可读 | `/etc/ssl/certs/ca-bundle.crt`、`/etc/pki/tls/certs/ca-bundle.crt`、`/etc/pki/tls/cert.pem` 均可读（修复前全部不可读） |
| Python 默认 SSL 上下文加载 CA | 是 | 是（修复前 `None None`） |
| `/etc/pki` 可见内容 | 不存在 | 只有 `ca-trust`、`tls`；`tls/private` 与 `nssdb` 不可见 |
| `fc-match sans:lang=zh` | `Noto Sans CJK JP` | `WenQuanYi Zen Hei` |
| tesseract OCR | 识别出 `hello pdf OCR TEST 2026`，无 Fontconfig 报错 | 同左 |
| soffice docx → pdf | **仍 abort**（backtrace 于 `soffice.bin`，与修复前对照一致，另行处理） | 成功；`pdffonts` 显示嵌入 `Caladea`、`WenQuanYiZenHei`，读回 `hello docx 你好`；无 Fontconfig 报错 |

## 真实链路（修复后开发栈，经 BFF）

注册 / 登录 200；`sessions/ensure` 200；带工具 Run `SUCCEEDED`（`bash`、`bash`、`job_output` 均 succeeded）；进程 logs 有 `TICK-1…TICK-10`；
`SIGTERM` 200 后 `cancelled`；B 访问 A 的 run / conversation / tools / sessions.ensure / process 详情 / logs / signal 全 404，A 对照 200。
驱动里「输出含 openEuler」一项在 Debian 执行面上按预期不成立（13/14）。

## 其余检查

| 项 | 结果 |
|---|---|
| exec / contract 类型检查（Linux 容器） | 通过 |
| contract 测试（Linux 容器） | 109 / 109 |
| `uv run pytest -q`（宿主） | 199 passed |
| agent 测试（`node:22-slim` 容器内 `npm ci`，Node 22） | 1325 pass / 0 fail / **3 cancelled**（既有已知组，不记为通过）；本次无 agent 改动 |
| agent 类型检查（主程序 + `src/runtime` strict） | 通过 |
| api-server 测试 / 类型检查 | 159 / 159；通过 |
| frontend 测试 / build | 367 / 367；`vite build` 成功 |

## 未做 / 边界

- Debian 执行面镜像的 soffice abort 不在本次范围，修复前后均出现。
- 麒麟上的 CA / 字体目录布局未核对（按 RHEL 系推断同为 `/etc/pki`）；x86_64 与目标 VM 未验证。
- 只验证了网络关闭（默认）模式下证书文件可读与 Python 加载，未在放开网络时实际发起 HTTPS 请求。
