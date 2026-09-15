"""VM 工具链安装资产的静态契约（design §9.1）。

不联网、不安装。运行期安装与工具 smoke 在 openEuler 容器里演练，证据见 docs/evidence。这里守住：

- 每个制品两种架构都有 https URL 与 64 位 SHA256，并写明哈希来源；
- npm 全局包与 runtime-versions.json 的 skill_runtime 钉版一致，Node 版本满足 engines；
- 安装脚本先核对 SHA256 再用、不 `curl | sh`、装到 Bubblewrap 可见的 /usr/local；
- dnf 列表包含脚本自身依赖（openEuler 基础镜像没有 find / cpio）与隔离原语；
- release 构建器把脚本读取的资产放进 release。
"""

from __future__ import annotations

import json
import re
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TOOLCHAIN = ROOT / "deploy" / "vm" / "toolchain"
SOURCES = TOOLCHAIN / "toolchain-sources.json"
INSTALL = TOOLCHAIN / "install-toolchain.sh"
BUILDER = ROOT / "scripts" / "vm" / "release-builder.Dockerfile"
PINS = json.loads((ROOT / "runtime-versions.json").read_text(encoding="utf-8"))
MANIFEST = json.loads(SOURCES.read_text(encoding="utf-8"))

ARTIFACTS = ("node", "uv", "ripgrep", "fd", "pandoc", "libreoffice", "chromium")


def test_manifest_lists_every_artifact_the_script_installs() -> None:
    assert set(MANIFEST["artifacts"]) == set(ARTIFACTS)
    text = INSTALL.read_text(encoding="utf-8")
    for name in ARTIFACTS:
        assert re.search(rf"\b{name}\b", text), name


@pytest.mark.parametrize("name", ARTIFACTS)
@pytest.mark.parametrize("arch", ["x86_64", "aarch64"])
def test_each_artifact_is_pinned_for_both_architectures(name: str, arch: str) -> None:
    artifact = MANIFEST["artifacts"][name]
    entry = artifact[arch]
    assert re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]), (name, arch)
    assert entry["url"].startswith("https://"), (name, arch)
    assert entry["file"] and "/" not in entry["file"], (name, arch)
    assert artifact["version"] in entry["file"], (name, arch)
    assert re.match(r"^(publisher|gpg_verified_then_pinned|pinned_at_retrieval):", artifact["sha256_source"]), name


def test_hashes_are_unique_per_file() -> None:
    hashes = [entry["sha256"] for artifact in MANIFEST["artifacts"].values() for key, entry in artifact.items() if isinstance(entry, dict)]
    assert len(hashes) == len(set(hashes))


def test_npm_globals_match_runtime_version_pins() -> None:
    pins = PINS["skill_runtime"]
    assert MANIFEST["npm_globals"] == {
        "bun": pins["bun"],
        "docx": pins["docx_js"],
        "pptxgenjs": pins["pptxgenjs"],
    }


def test_node_version_satisfies_runtime_engines() -> None:
    major, minor, _ = (int(part) for part in MANIFEST["artifacts"]["node"]["version"].split("."))
    assert PINS["node"]["engines"] == ">=22.19.0 <23"
    assert major == 22 and minor >= 19


def test_dnf_packages_cover_script_and_isolation_prerequisites() -> None:
    packages = set(MANIFEST["dnf_packages"])
    for required in ("findutils", "cpio", "rpm", "python3", "bubblewrap", "util-linux", "tesseract-langpack-chi_sim"):
        assert required in packages, required
    assert len(packages) == len(MANIFEST["dnf_packages"]), "duplicate dnf package names"


def test_install_script_verifies_before_use_and_never_pipes_to_a_shell() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    # 只看可执行行：文件头注释本身写着「从不执行 curl | sh」。
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    assert "sha256sum --quiet --strict -c" in code
    assert not re.search(r"curl[^\n|]*\|\s*(ba)?sh", code)
    assert not re.search(r"wget[^\n|]*\|\s*(ba)?sh", code)
    assert "ALLOW_DOWNLOAD" in text and "--allow-download" in text
    assert 'die "$name has no pinned sha256' in text


def test_install_script_targets_paths_visible_inside_bubblewrap() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    for target in (
        "/usr/local/bin/rg",
        "/usr/local/bin/fd",
        "/usr/local/bin/pandoc",
        "/usr/local/bin/uv",
        "/usr/local/bin/soffice",
        "/usr/local/lib/pi-chromium/chrome/chrome",
        "/usr/local/lib/pi-skill-runtime",
        "/opt/pi-python/venv",
    ):
        assert target in text, target
    assert "tar -xJf \"$file\" -C /usr/local" in text
    # 官方 RPM 装到 /opt，沙箱不可见：必须解包搬进 /usr/local/lib。
    assert "rpm -i" not in text and "dnf -y install /" not in text


def test_install_script_links_tessdata_where_tesseract_reads_it() -> None:
    # openEuler 24.03 实测：langpack 装在 /usr/share/tesseract/tessdata，tesseract 5 只读 /usr/share/tessdata。
    text = INSTALL.read_text(encoding="utf-8")
    assert "/usr/share/tesseract/tessdata" in text and "dst=/usr/share/tessdata" in text
    assert re.search(r"^install_packages\nlink_tessdata$", text, re.M), "link_tessdata must run right after dnf install"


def test_verify_checks_do_not_pipe_the_checked_command() -> None:
    # `cmd | head -1` 在 pipefail 下让命令因 SIGPIPE 失败，并用第一行警告掩盖真实错误（openEuler 演练实测）。
    text = INSTALL.read_text(encoding="utf-8")
    body = text.split("check() {", 1)[1].split("\n    }", 1)[0]
    # 注释里本身写着「cmd | head -1」的教训，只看可执行行。
    body = "\n".join(line for line in body.splitlines() if not line.lstrip().startswith("#"))
    # 被检查的命令本身不能接管道；对已捕获的变量再截取是安全的。
    assert not re.search(r'"\$@"[^\n]*(?<!\|)\|(?!\|)', body)
    assert 'out="$("$@" 2>&1)"' in body


def test_install_script_is_executable_and_parses() -> None:
    assert INSTALL.stat().st_mode & stat.S_IXUSR
    result = subprocess.run(["bash", "-n", str(INSTALL)], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


def test_release_builder_ships_toolchain_assets() -> None:
    builder = BUILDER.read_text(encoding="utf-8")
    for line in (
        "COPY exec/requirements.txt ./toolchain/requirements.txt",
        "COPY exec/skill-runtime/ ./toolchain/skill-runtime/",
        "COPY skills/baoyu-format-markdown/scripts/ ./toolchain/pi-skill-runtime/baoyu-format-markdown/",
        "COPY skills/baoyu-markdown-to-html/scripts/ ./toolchain/pi-skill-runtime/baoyu-markdown-to-html/",
    ):
        assert line in builder, line


def test_chromium_wrapper_template_still_matches_the_rewrite() -> None:
    # install-toolchain.sh 用 sed 把 Debian 路径换成 VM 路径；模板改了路径，替换会静默失效。
    wrapper = (ROOT / "exec" / "skill-runtime" / "baoyu-chromium").read_text(encoding="utf-8")
    assert "/usr/lib/chromium/chromium" in wrapper
    assert "s#/usr/lib/chromium/chromium#/usr/local/lib/pi-chromium/chrome/chrome#" in INSTALL.read_text(encoding="utf-8")
