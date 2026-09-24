#!/usr/bin/env bash
# exec VM 的模型工具链安装（design §9.1）。dnf 系（openEuler / 麒麟），以 root 运行。
#
#   install-toolchain.sh --cache DIR [--assets DIR] [--allow-download] [--skip-verify]
#
# --cache           预先下载的制品目录。每个制品按 toolchain-sources.json 里的文件名查找，
#                   **一律先核对 SHA256 再使用**，不匹配即失败。
# --allow-download  缓存里缺的制品按清单 URL 下载到 --cache 再核对；不给则缺失即失败（离线部署）。
# --assets DIR      release 的 toolchain/ 目录（requirements.txt、skill-runtime/、dsh-skill-runtime/）；
#                   默认为本脚本所在 release 的 ../../toolchain。
#
# 安装位置都在 Bubblewrap 可见的 /usr/local 与 /opt/dsh-python/venv 下——exec 的沙箱只暴露
# /usr /bin /sbin /lib /lib64 /usr/local 与 Python venv，装在 /opt 的工具在沙箱里不可见。
# PyPI / npm 依赖仍从配置的索引安装（可用 UV_INDEX_URL、npm_config_registry 指向内网镜像）。
# 从不执行 `curl | sh`；重复运行时已装的同版本组件跳过。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SOURCES="$SCRIPT_DIR/toolchain-sources.json"
ASSETS="$SCRIPT_DIR/../../toolchain"
CACHE=""
ALLOW_DOWNLOAD=false
SKIP_VERIFY=false
STATE_DIR=/usr/local/share/dsh-toolchain
VENV=/opt/dsh-python/venv

log() { printf '[toolchain] %s\n' "$*"; }
die() { printf '[toolchain] FAIL: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --cache) CACHE="${2:-}"; shift 2 ;;
        --assets) ASSETS="${2:-}"; shift 2 ;;
        --allow-download) ALLOW_DOWNLOAD=true; shift ;;
        --skip-verify) SKIP_VERIFY=true; shift ;;
        -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ "$(id -u)" = 0 ] || die "must run as root"
[ -n "$CACHE" ] || die "--cache DIR is required"
[ -f "$SOURCES" ] || die "toolchain-sources.json not found next to the script"
command -v dnf >/dev/null || die "dnf is required (openEuler / Kylin)"
command -v python3 >/dev/null || die "python3 is required to read the source manifest"
mkdir -p "$CACHE" "$STATE_DIR"
ASSETS="$(cd "$ASSETS" && pwd -P)" || die "assets directory not found"

case "$(uname -m)" in
    x86_64) ARCH=x86_64 ;;
    aarch64) ARCH=aarch64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
esac

# 读清单：manifest <jq-like path>，值不存在即失败。
manifest() {
    python3 - "$SOURCES" "$@" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
node = data
for key in sys.argv[2:]:
    if not isinstance(node, dict) or key not in node:
        sys.exit(f"manifest key missing: {'.'.join(sys.argv[2:])}")
    node = node[key]
print(" ".join(node) if isinstance(node, list) else node)
PY
}

# fetch <artifact>：定位缓存文件并核对 SHA256，输出文件路径。
fetch() {
    local name="$1" file url sha
    file="$(manifest artifacts "$name" "$ARCH" file)"
    url="$(manifest artifacts "$name" "$ARCH" url)"
    sha="$(manifest artifacts "$name" "$ARCH" sha256)"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "$name has no pinned sha256 for $ARCH"
    [[ "$url" == https://* ]] || die "$name url must be https"
    if [ ! -f "$CACHE/$file" ]; then
        [ "$ALLOW_DOWNLOAD" = true ] || die "$name missing from cache: $file (pass --allow-download or pre-stage it)"
        log "downloading $name ($file)"
        curl --http1.1 -fsSL --retry 5 --retry-all-errors -m 3600 -o "$CACHE/$file.part" "$url"
        mv "$CACHE/$file.part" "$CACHE/$file"
    fi
    echo "$sha  $CACHE/$file" | sha256sum --quiet --strict -c - >/dev/null 2>&1 \
        || die "$name sha256 mismatch: $CACHE/$file"
    printf '%s\n' "$CACHE/$file"
}

done_marker() { [ -f "$STATE_DIR/$1" ]; }
mark_done() { printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_DIR/$1"; }

install_packages() {
    local packages
    packages="$(manifest dnf_packages)"
    log "dnf install: $packages"
    # shellcheck disable=SC2086
    dnf -y --setopt=install_weak_deps=False install $packages
}

link_tessdata() {
    # openEuler 24.03：tesseract 5 读 /usr/share/tessdata，而 tesseract-langpack-* 把语言数据装在
    # /usr/share/tesseract/tessdata，`tesseract --list-langs` 为 0。沙箱环境是白名单，TESSDATA_PREFIX
    # 进不去，所以把缺的语言数据链接进 tesseract 实际读取的目录（在 /usr 下，Bubblewrap 可见）。
    # 只补缺失的文件；两边一致或发行版没有这个问题时什么也不做。
    local src=/usr/share/tesseract/tessdata dst=/usr/share/tessdata file name
    [ -d "$src" ] || return 0
    mkdir -p "$dst"
    for file in "$src"/*.traineddata; do
        [ -f "$file" ] || continue
        name="$(basename "$file")"
        [ -e "$dst/$name" ] || { ln -s "$file" "$dst/$name"; log "linked tessdata $name into $dst"; }
    done
}

install_node() {
    local version marker file
    version="$(manifest artifacts node version)"
    marker="node-$version"
    done_marker "$marker" && { log "node $version already installed"; return; }
    file="$(fetch node)"
    tar -xJf "$file" -C /usr/local --strip-components=1 --no-same-owner \
        --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
    [ "$(/usr/local/bin/node -p 'process.versions.node')" = "$version" ] || die "node version mismatch after install"
    mark_done "$marker"
}

install_single_binary() { # <artifact> <binary name inside the archive>
    local name="$1" binary="$2" version marker file tmp found
    version="$(manifest artifacts "$name" version)"
    marker="$name-$version"
    done_marker "$marker" && { log "$name $version already installed"; return; }
    file="$(fetch "$name")"
    tmp="$(mktemp -d)"
    tar -xzf "$file" -C "$tmp" --no-same-owner
    found="$(find "$tmp" -type f -name "$binary" -perm -u+x | head -1)"
    [ -n "$found" ] || die "$binary not found in $name archive"
    install -m 0755 "$found" "/usr/local/bin/$binary"
    rm -rf "$tmp"
    mark_done "$marker"
}

install_pandoc() {
    local version marker file tmp
    version="$(manifest artifacts pandoc version)"
    marker="pandoc-$version"
    done_marker "$marker" && { log "pandoc $version already installed"; return; }
    file="$(fetch pandoc)"
    tmp="$(mktemp -d)"
    tar -xzf "$file" -C "$tmp" --no-same-owner
    install -m 0755 "$tmp"/pandoc-*/bin/pandoc /usr/local/bin/pandoc
    rm -rf "$tmp"
    mark_done "$marker"
}

install_uv() {
    local version marker file tmp
    version="$(manifest artifacts uv version)"
    marker="uv-$version"
    done_marker "$marker" && { log "uv $version already installed"; return; }
    file="$(fetch uv)"
    tmp="$(mktemp -d)"
    python3 -m zipfile -e "$file" "$tmp"
    install -m 0755 "$tmp/uv-$version.data/scripts/uv" /usr/local/bin/uv
    rm -rf "$tmp"
    mark_done "$marker"
}

install_libreoffice() {
    local version marker file tmp root target
    version="$(manifest artifacts libreoffice version)"
    marker="libreoffice-$version"
    done_marker "$marker" && { log "libreoffice $version already installed"; return; }
    file="$(fetch libreoffice)"
    tmp="$(mktemp -d)"
    tar -xzf "$file" -C "$tmp" --no-same-owner
    mkdir -p "$tmp/root"
    # 官方 RPM 装到 /opt/libreofficeX.Y，沙箱里不可见；解包后整体搬到 /usr/local/lib。
    for rpm in "$tmp"/LibreOffice_*/RPMS/*.rpm; do
        case "$(basename "$rpm")" in
            *-gnome-integration-*|*-kde-integration-*|*-freedesktop-menus-*|*-onlineupdate-*) continue ;;
        esac
        (cd "$tmp/root" && rpm2cpio "$rpm" | cpio -idm --quiet --no-absolute-filenames)
    done
    root="$(find "$tmp/root/opt" -maxdepth 1 -type d -name 'libreoffice*' | head -1)"
    [ -n "$root" ] || die "libreoffice payload not found in RPMs"
    target="/usr/local/lib/$(basename "$root")"
    rm -rf "$target"
    mv "$root" "$target"
    chown -R root:root "$target"
    ln -sfn "../lib/$(basename "$root")/program/soffice" /usr/local/bin/soffice
    rm -rf "$tmp"
    mark_done "$marker"
}

install_chromium() {
    local version marker file tmp dir binary
    version="$(manifest artifacts chromium version)"
    marker="chromium-$version"
    done_marker "$marker" && { log "chromium $version already installed"; return; }
    file="$(fetch chromium)"
    tmp="$(mktemp -d)"
    python3 -m zipfile -e "$file" "$tmp"
    dir="$(find "$tmp" -maxdepth 1 -type d -name 'chrome-linux*' | head -1)"
    [ -n "$dir" ] && [ -f "$dir/chrome" ] || die "chrome binary not found in chromium archive"
    rm -rf /usr/local/lib/dsh-chromium
    mkdir -p /usr/local/lib/dsh-chromium
    mv "$dir" /usr/local/lib/dsh-chromium/chrome
    chown -R root:root /usr/local/lib/dsh-chromium
    # python zipfile 不保留权限位：可执行文件逐个恢复。
    chmod -R a+rX /usr/local/lib/dsh-chromium
    for binary in chrome chrome_crashpad_handler chrome_sandbox chrome-wrapper; do
        [ -f "/usr/local/lib/dsh-chromium/chrome/$binary" ] && chmod 0755 "/usr/local/lib/dsh-chromium/chrome/$binary"
    done
    find /usr/local/lib/dsh-chromium/chrome -maxdepth 1 -name '*.so*' -exec chmod 0755 {} +
    rm -rf "$tmp"
    mark_done "$marker"
}

install_python_venv() {
    local marker="python-venv-$(sha256sum "$ASSETS/requirements.txt" | cut -c1-16)"
    done_marker "$marker" && { log "python venv already matches requirements.txt"; return; }
    /usr/local/bin/uv venv --python /usr/bin/python3 --allow-existing "$VENV"
    VIRTUAL_ENV="$VENV" /usr/local/bin/uv pip install -r "$ASSETS/requirements.txt"
    # requirements.txt 未钉版本：记录实际装上的版本，供证据与复现。
    VIRTUAL_ENV="$VENV" /usr/local/bin/uv pip freeze > "$STATE_DIR/python-freeze.txt"
    mark_done "$marker"
}

install_js_globals() {
    local bun docx pptx marker
    bun="$(manifest npm_globals bun)"
    docx="$(manifest npm_globals docx)"
    pptx="$(manifest npm_globals pptxgenjs)"
    marker="npm-globals-bun$bun-docx$docx-pptx$pptx"
    done_marker "$marker" && { log "bun/docx/pptxgenjs already installed"; return; }
    /usr/local/bin/npm install --global --prefix /usr/local --no-audit --no-fund \
        "bun@$bun" "docx@$docx" "pptxgenjs@$pptx"
    mark_done "$marker"
}

install_skill_runtime() {
    local base=/usr/local/lib/dsh-skill-runtime
    mkdir -p "$base"
    rm -rf "$base/baoyu-format-markdown" "$base/baoyu-markdown-to-html"
    cp -R "$ASSETS/dsh-skill-runtime/baoyu-format-markdown" "$base/"
    cp -R "$ASSETS/dsh-skill-runtime/baoyu-markdown-to-html" "$base/"
    (cd "$base/baoyu-format-markdown" && /usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
    (cd "$base/baoyu-markdown-to-html" && /usr/local/bin/bun install --frozen-lockfile --production --no-progress)
    chown -R root:root "$base"
    install -m 0555 "$ASSETS/skill-runtime/baoyu-format-markdown" /usr/local/bin/baoyu-format-markdown
    install -m 0555 "$ASSETS/skill-runtime/baoyu-markdown-to-html" /usr/local/bin/baoyu-markdown-to-html
    # 镜像里的 wrapper 指向 Debian 的 /usr/lib/chromium/chromium；VM 上换成本脚本装的路径。
    sed 's#/usr/lib/chromium/chromium#/usr/local/lib/dsh-chromium/chrome/chrome#' \
        "$ASSETS/skill-runtime/baoyu-chromium" > /usr/local/bin/baoyu-chromium.new
    grep -q '/usr/local/lib/dsh-chromium/chrome/chrome' /usr/local/bin/baoyu-chromium.new \
        || die "baoyu-chromium template no longer references /usr/lib/chromium/chromium"
    chmod 0555 /usr/local/bin/baoyu-chromium.new
    mv -f /usr/local/bin/baoyu-chromium.new /usr/local/bin/baoyu-chromium
}

verify() {
    local failed=0 missing
    check() { # <label> <command...>
        # 先拿到完整输出与退出码再截取：`cmd | head -1` 在 pipefail 下会让命令因 SIGPIPE 失败，
        # 第一行又常是无关警告，真正的错误被藏掉。
        local label="$1" out rc
        shift
        out="$("$@" 2>&1)" && rc=0 || rc=$?
        if [ "$rc" = 0 ]; then
            log "ok  $label: $(printf '%s\n' "$out" | head -1)"
        else
            log "BAD $label (exit $rc): $(printf '%s\n' "$out" | tail -3 | tr '\n' ' ')"
            failed=1
        fi
    }
    check node /usr/local/bin/node --version
    check uv /usr/local/bin/uv --version
    check python "$VENV/bin/python3" --version
    check rg /usr/local/bin/rg --version
    check fd /usr/local/bin/fd --version
    check pandoc /usr/local/bin/pandoc --version
    check bun /usr/local/bin/bun --version
    check soffice /usr/local/bin/soffice --version
    check chromium /usr/local/lib/dsh-chromium/chrome/chrome --version
    check bwrap /usr/bin/bwrap --version
    check setpriv /usr/bin/setpriv --version
    check tesseract-langs sh -c 'tesseract --list-langs 2>&1 | grep -qx chi_sim && tesseract --list-langs 2>&1 | grep -qx eng && echo "eng chi_sim"'
    check python-imports "$VENV/bin/python3" -c 'import docx, openpyxl, pptx, reportlab, pymupdf, pypdfium2, pytesseract, pandas; print("imports ok")'
    check node-docx env NODE_PATH=/usr/local/lib/node_modules /usr/local/bin/node -e 'require("docx"); require("pptxgenjs"); console.log("docx pptxgenjs ok")'
    for binary in /usr/local/lib/dsh-chromium/chrome/chrome /usr/local/lib/libreoffice*/program/soffice.bin; do
        missing="$(ldd "$binary" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
        if [ -n "$missing" ]; then log "BAD missing shared libraries for $binary: $missing"; failed=1; fi
    done
    [ "$failed" = 0 ] || die "toolchain verification failed"
    log "toolchain verification passed"
}

install_packages
link_tessdata
install_node
install_uv
install_single_binary ripgrep rg
install_single_binary fd fd
install_pandoc
install_libreoffice
install_chromium
install_python_venv
install_js_globals
install_skill_runtime
[ "$SKIP_VERIFY" = true ] || verify
