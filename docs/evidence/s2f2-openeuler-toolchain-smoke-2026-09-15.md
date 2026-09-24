# 验证记录：S2f-2 续——修正 unit 下的 exec 启动与 bwrap 内工具链 smoke（openEuler 24.03 容器）

日期：2026-09-15。接续 [S2f-2 工具链安装演练](s2f2-openeuler-toolchain-2026-09-15.md) 的「未做」第一项。对应
[统一 design](../design/updrdb-dbpm-deployment.md) §9.1。

> **结论：** 移除 `ProtectKernelTunables` / `ProtectKernelLogs` 后的 unit 在 openEuler 24.03（systemd 255）容器中启动就绪；经 exec
> HMAC 内部面发起、跑在 Bubblewrap 内的工具 smoke 全部通过（Chromium 以 BaoYu 实际使用的 CDP 路径验证）。仍不是目标 VM 验收。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`66b2ab0f`；工作区另有与本次无关的 `docs/reviews/2026-09-01-full-regression/` 在途改动（因此 release id 带 `-dirty`，release 内容不含 docs） |
| release | `exec-66b2ab0f0397-arm64-dirty-20260915121849`（`scripts/vm/build-exec-release.sh --arch arm64 --allow-dirty`，4979 个文件，schema 清单 `367c37ef…`） |
| 演练容器 | 本机重建：`scripts/vm/openeuler-systemd-sim.Dockerfile` → `pi-vm-openeuler-sim:dev`（systemd `255-58.oe2403`），`--privileged --cgroupns=host`，接开发栈 backend 网络 + bridge（dnf / PyPI / npm 下载用）；宿主 macOS arm64 / OrbStack |
| 工具链制品 | 本机缓存重新下载 7 个 arm64 制品，按 `toolchain-sources.json` 的 SHA256 核对全部 OK（上一轮会话的缓存不在本机） |
| 数据库 | 开发 MySQL 专用库 `pi_vm_sim`（`scripts/dev/schema-apply.sh pi_vm_sim`：27 段迁移，核对 `ok: true, drifts: []`）；取密走演练专用假 DBPM 容器（只含 `pi_vm_sim` 条目）。不碰开发栈 `sandbox` 库——exec 启动期孤儿回收会收掉开发栈的作业 |
| 服务间凭据 | 演练现生成的 HMAC keyring / token，只写入演练 `exec.env`（0600，会话临时目录）；未复用开发栈凭据 |
| 驱动 | 开发栈 agent 容器（`pi-enterprise-agent:latest`，schema 清单与 release 相同）内 `ExecRpcClient` → `http://pi-vm-sim:8081`，`sessions/ensure` 后逐步 `shell/run` |

## 安装与启动

| 步骤 | 结果 |
|---|---|
| `install-release.sh init / install / activate` | 通过；`pi-exec` uid 994 |
| `install-toolchain.sh --cache /cache --assets <release>/toolchain`（离线缓存，未给 `--allow-download`） | 全新容器一次通过；校验全部 ok（node 22.23.2、uv 0.12.14、Python 3.11.6、rg 15.2.0、fd 10.5.0、pandoc 3.11、bun 1.4.0、LibreOffice 26.8.0.3、Chrome for Testing 153.0.8010.12、bubblewrap 0.8.0、setpriv、tesseract `eng chi_sim`、Python / Node 文档库）；`toolchain verification passed` |
| `systemctl restart pi-exec` | 预检 8 项 ok → `exec listening on 8081`；`/ready`：`database / storage.* / isolation` 全 ok |
| unit 生效值 | `User=pi-exec`、`NoNewPrivileges=yes`、`ProtectSystem=strict`、`ProtectProc=invisible`、`ProtectKernelTunables=no`、`ProtectKernelLogs=no`、`KillMode=mixed`；主进程 `pi-exec /usr/local/bin/node dist/main.js` |

## bwrap 内工具 smoke（VM exec）

沙箱内 `id -u` = 10001，`PATH=/opt/pi-python/venv/bin:/usr/local/bin:/usr/bin:/bin`。每步 `set -o pipefail`，并断言产物内容（不只看退出码）。

| 步骤 | 断言 | 结果 |
|---|---|---|
| rg / fd | 命中写入的 `needle` 文件 | OK |
| Python docx / xlsx / pptx / pdf | 生成四种文件并读回文本（含中文） | OK：`hello docx 你好 hello xlsx hello pptx hello pdf OCR TEST 2026` |
| Node docx / pptxgenjs | 生成 `.docx` / `.pptx` 非空 | OK |
| `soffice --headless --convert-to pdf` | 转出 PDF 且 `pdftotext` 读回 `hello docx` | OK（0.8s） |
| pdftotext / qpdf | 读回文本、`qpdf --check` | OK |
| pandoc | md → docx → plain 读回 | OK |
| tesseract | 200dpi 渲染 PDF 后 OCR 含 `OCR TEST` | OK（`helb pdfOCR TEST 2026`）；`--list-langs` 含 `chi_sim` / `eng` |
| baoyu-format-markdown | 包装器执行、写回文件 | OK |
| baoyu-markdown-to-html | 生成 HTML 含标题 | OK |
| **Chromium（BaoYu 实际路径）**：含 mermaid 代码块的 markdown 经 `baoyu-markdown-to-html` | `baoyu-chrome-cdp` 以 `--remote-debugging-port` + `--headless=new` 启动 `baoyu-chromium` 渲染 | OK：`1 block(s), 1 rendered`，PNG 1720×5077，HTML 含图片，1.3s；结束后无残留 Chromium 进程 |

### Chromium 一次性 `--screenshot` 模式挂起（非产品路径）

首轮 smoke 用 `baoyu-chromium --headless=new --screenshot=… data:…` 测 Chromium，90s 超时、无截图。定位：

- 同一命令在 bwrap **外**以 `pi-exec` 身份直接跑，五种参数组合（仅设 HOME、`--disable-crash-reporter`、`--disable-crashpad-for-testing`、两者同时、
  `--headless=old`）全部 40s 超时；带 `--disable-crashpad-for-testing` 时日志为 `Network service crashed or was terminated, restarting service.`——
  与沙箱无关，是 Chrome for Testing 153 在此环境下一次性截图模式的问题。
- 同一环境以 CDP 方式启动（与 `baoyu-chrome-cdp` 相同参数）2s 内 `/json/version` 可用、`/json/new` 可建页面。
- 产品内唯一的 Chromium 消费者 `baoyu-chrome-cdp`（BaoYu mermaid 渲染）只走 CDP，不用 `--screenshot`；上表 CDP 路径在 bwrap 内通过。
  若将来有技能直接调用一次性截图模式，需在目标 VM 另行验证。

## Debian 镜像对照（开发栈 `sandbox`，同一 smoke 与同一 exec 内部面）

开发栈容器为 `enterprise-sandbox:latest`（2026-09-15 00:35 构建，早于 HEAD；只用作工具行为对照，不作 HEAD 验收）。

| 项 | Debian 镜像 | openEuler VM |
|---|---|---|
| `--screenshot` 一次性截图 | OK（1.6s，Debian chromium 包） | 挂起（见上） |
| mermaid 经 CDP | OK（1.5s） | OK（1.3s） |
| `soffice --convert-to pdf`（`-env:UserInstallation` 指到工作区） | **exit 134**：`SvtSysLocaleOptions` / `utl::ConfigItem` 处 abort | OK |
| `Fontconfig error: Cannot load default config file` | 出现 | 出现 |
| baoyu-format-markdown 把 `#Title` 输出为 `\#Title` | 出现 | 出现 |

## 发现（未修改，另行处理）

- **沙箱内没有 fontconfig 配置**：`exec/src/isolation/build.ts` 的 `/etc` 白名单不含 `/etc/fonts`，镜像与 VM 上 soffice / tesseract 均报
  `Fontconfig error: Cannot load default config file`。本次文本转换与读回正常，但字体选择与 CJK 字形渲染未做视觉核对。改白名单触及 exec 运行路径，
  需单独变更并重建容器验证。
- **Debian 镜像内 soffice 转换 abort（exit 134）**：只在开发栈旧镜像对照中出现，未在 HEAD 镜像复现，也未定位；不属于 VM 工具链，需另开任务复现。
- `baoyu-format-markdown` 对无空格标题 `#Title` 输出转义形式，两个环境一致，属脚本自身行为，非部署问题。

## 未做 / 边界

- 仍是共享宿主内核（OrbStack）的特权容器：麒麟 V11、KySec / SELinux、非特权 user namespace 限制、x86_64 与目标 VM 均未验证（design §12 T6）。
- smoke 只经 agent 容器内 RPC 客户端直连 VM exec；登录 → Run → 跨租户 404 的完整链路（Agent / BFF / sandbox-mcp 指向 VM exec）未做。
- 网络模式为 exec 默认（沙箱内无网络）；需联网的工具行为未测。
- Chromium 与 LibreOffice 仍是上游二进制（哈希来源见清单），目标 VM 是否允许使用未确认。
- 演练资源保留在本机：容器 `pi-vm-sim` / `pi-vm-sim-dbpm`、开发 MySQL 库 `pi_vm_sim`、`.runtime/vm-release/` 与 `.runtime/toolchain-cache/`（gitignore）。
