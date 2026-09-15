# 验证记录：S2f-2 VM 工具链安装脚本（openEuler 24.03 LTS 容器演练）

日期：2026-09-15。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §9.1。用户决定：先用 openEuler 官方镜像演练工具链安装脚本与 release；
官方源缺失的工具使用上游官方包钉版本 + SHA256。

> **状态：未完成。** 工具链安装与校验、release 安装已通过；**bwrap 内的完整工具 smoke 尚未在修正后的 unit 下跑通**（见「未做」）。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`e27e2f7a` + 本次未提交改动（随本证据同一 commit） |
| 演练镜像 | `openeuler/openeuler:24.03-lts`（aarch64，glibc 2.38，Python 3.11.6）+ systemd 255（`scripts/vm/openeuler-systemd-sim.Dockerfile`），特权容器，接开发栈 backend 网络 + 默认 bridge（下载用） |
| release | `exec-e27e2f7a681d-arm64-dirty-20260915091932`（含修正后的安装脚本）；修正 unit 后的 `…092639` 已构建，**未在容器中安装验证** |
| 卫生测试 | 宿主 `uv run pytest -q`：199 passed |

## openEuler 24.03 LTS 仓库核对

- `repoquery --whatprovides` 对 `/usr/bin/{rg,fd,pandoc,soffice,chromium,chromium-browser}` 均为空（同批 `/usr/bin/qpdf` → `qpdf-0:11.1.0-3.oe2403` 作对照）；仓库 nodejs 为 20.18.2（低于 `>=22.19`）。
- 仓库可装：bubblewrap 0.8.0、util-linux、git、jq、zip/unzip、file、less、poppler-utils、qpdf、tesseract 5.3.2 + langpack eng / chi_sim 4.1.0、字体、systemd 255。
- Chromium / LibreOffice 运行库按 `ldd` 缺失项逐个 `repoquery` 得到包名，写入清单 `dnf_packages`（未装 GTK / Qt / GStreamer / Java 等桌面插件依赖）。

## 制品钉版（`deploy/vm/toolchain/toolchain-sources.json`）

| 制品 | 版本 | 哈希来源 | 缓存核对 |
|---|---|---|---|
| Node | 22.23.2 | 官方 `SHASUMS256.txt` | x64 / arm64 OK |
| uv | 0.12.14 | PyPI 文件摘要 | OK |
| ripgrep | 15.2.0（musl） | GitHub release digest | OK |
| fd | 10.5.0（musl） | GitHub release digest | OK |
| pandoc | 3.11 | GitHub release digest | OK |
| LibreOffice | 26.8.0 RPM tar | 两个架构 `Good signature from LibreOffice Build Team (CODE SIGNING KEY)`，主密钥指纹 `C283 9ECA D940 8FBE 9531 C3E9 F434 A1EF AFEE AEA3`（keyserver.ubuntu.com 取密钥，未做信任链核验），验签后记录 SHA256 | OK |
| Chromium | Chrome for Testing 153.0.8010.12（Playwright 1.63.0 / revision 1243） | 发布方无摘要，按下载记录；大小与 Playwright 安装器实际下载一致（arm64 195,926,016 / x64 195,836,009 字节） | OK |

全部 14 个文件（7 制品 × 2 架构）在宿主缓存 `.runtime/toolchain-cache/` 按清单 `shasum -a 256 -c` 通过。amd64 制品只核对哈希，未在 x86_64 上安装。

## 演练过程与结果

| 步骤 | 结果 |
|---|---|
| release 安装（release 自带 `install-release.sh` init / install / activate） | 通过；第二个 release 安装后 `list` 与回滚提示正确 |
| 首次 `install-toolchain.sh --cache /cache` | dnf 解析不到 `repo.openeuler.org`：演练容器只接了 compose 的 internal 网络（无外网 / DNS），**演练配置问题**；补接 bridge 后重跑 |
| 第二次安装（678s） | 各组件装完，校验 2 项 BAD：`tesseract-langs` 为空；`python-imports` 只显示 fitz 弃用警告 |
| 定位 | ① openEuler 打包不一致：tesseract 5.3.2 读 `/usr/share/tessdata/`（0 种语言），langpack 装在 `/usr/share/tesseract/tessdata/`。② 逐个 import 全部成功；校验函数 `cmd \| head -1` 在 `pipefail` 下让 Python 因 SIGPIPE 非零退出——**脚本自身缺陷** |
| 修复 | 新增 `link_tessdata`（只补缺失的语言数据链接，沙箱白名单环境不传 `TESSDATA_PREFIX`）；`check` 先完整捕获输出再截取；import 改用 `pymupdf` |
| 修复后重跑（新 release，7s，已装组件跳过） | `linked tessdata chi_sim / eng`；node 22.23.2、uv 0.12.14、Python 3.11.6、rg 15.2.0、fd 10.5.0、pandoc 3.11、bun 1.4.0、LibreOffice 26.8.0.3、Chrome for Testing 153.0.8010.12、bubblewrap 0.8.0、setpriv、tesseract `eng chi_sim`、Python 文档库导入、Node docx / pptxgenjs 全部 ok；`soffice.bin` 与 `chrome` 无缺失共享库；`toolchain verification passed` |

## exec 在 openEuler systemd 255 上启动：发现 unit 加固项不兼容

| 场景 | 结果 |
|---|---|
| 按当时 unit（含 `ProtectKernelTunables` / `ProtectKernelLogs` / `ProtectProc=invisible`）启动 | 部署预检全部通过；exec `storage/isolation preflight failed, refusing to start: bwrap: Can't mount proc on /newroot/proc: Operation not permitted`，systemd 5 次重启后 failed（fail-closed 生效） |
| 同一容器以 `pi-exec` 身份在 unit 外直接跑 `bwrap --unshare-user --unshare-pid --proc /proc` | 退出码 0 —— 环境本身支持，问题在 unit |
| 逐项放宽其中一项 | 仍失败 |
| 三项同时放宽 | `exec listening on 8081`，`/ready` 隔离 ok |
| 只开 `ProtectProc=invisible` | 就绪 |
| 只开 `ProtectKernelTunables=yes` | 拒启（同上错误） |
| 只开 `ProtectKernelLogs=yes` | 拒启（同上错误） |

对照 S2f：Debian bookworm systemd 252 上三项均兼容。据此 unit 移除 `ProtectKernelTunables`、`ProtectKernelLogs`，保留 `ProtectProc=invisible`，
卫生测试把两者列入禁止项；`deployment.md` 加固表与 design §9 同步。

## 改动要点

- `deploy/vm/toolchain/install-toolchain.sh`、`toolchain-sources.json`；`scripts/vm/release-builder.Dockerfile` 把 `requirements.txt`、三个 wrapper、两套 BaoYu 脚本与锁文件放进 release `toolchain/`。
- `scripts/vm/openeuler-systemd-sim.Dockerfile`（开发演练用）。
- `deploy/vm/pi-exec.service`：移除两项加固，注释记录两个环境的实测。
- `tests/test_vm_toolchain_assets.py`（清单两架构钉版与哈希来源、npm 版本与 `runtime-versions.json` 一致、Node 满足 engines、dnf 列表含脚本依赖、脚本先核对后使用且不 `curl | sh`、安装到 bwrap 可见路径、tessdata 链接、校验不对被检命令接管道、builder 带资产、wrapper 模板路径）；`tests/test_vm_release_assets.py` 加固项清单更新。
- 文档：`deployment.md`（工具链小节、加固表）、design §9、CHANGELOG。

## 未做 / 边界

- **bwrap 内完整工具 smoke 未通过验证**：修正后的 unit（release `…092639`）尚未安装进容器启动；此前的 smoke 运行因 exec 未启动而全部失败（`fetch failed`），结论作废。待验证：Python / Node 生成与读回 docx / xlsx / pptx / pdf、`soffice` headless 转换、`pdftotext` / `qpdf`、`pandoc`、`tesseract` 实际识别、`rg` / `fd`、`baoyu-chromium` headless、两个 BaoYu wrapper。
- 容器共享宿主内核（OrbStack），KySec / SELinux、麒麟内核与 systemd 版本下的加固兼容性仍需在目标 VM 复测；两个演练环境对同一加固项结论不同，说明必须以目标机实测为准。
- `exec/requirements.txt` 未钉版本（既有问题，镜像同样），VM 安装只记录实际版本（`python-freeze.txt`）。
- Chromium 哈希为首次下载记录，非发布方签名；LibreOffice 签名密钥未做信任链核验；目标 VM 是否允许这些上游二进制需另行确认。
- 麒麟 dnf 包名、x86_64 上的实际安装未验证。
