#!/usr/bin/env bash
# exec release 的初始化、安装、切换与列表（design §9.1、§10）。以 root 运行。
#
#   install-release.sh init                     建运行用户、数据目录、/etc/dsh-exec（已存在不覆盖）
#   install-release.sh install <tarball>        校验 .sha256 与 SHA256SUMS，解包为只读 release
#   install-release.sh activate <release-id>    切换 current、安装 unit、daemon-reload（不重启）
#   install-release.sh list                     列出已安装 release 与 current
#
# 回滚 = activate 旧 release-id 后在维护窗口内重启。脚本**从不**自动重启服务：
# 单 VM 升级要先停准入、drain 或停止执行（design §9.2），这一步由运维决定时机。
set -euo pipefail

PREFIX="${DSH_EXEC_PREFIX:-/opt/dsh-exec}"
DATA="${DSH_EXEC_DATA:-/var/lib/dsh-exec}"
ETC_DIR="${DSH_EXEC_ETC:-/etc/dsh-exec}"
UNIT_PATH="${DSH_EXEC_UNIT_PATH:-/etc/systemd/system/dsh-exec.service}"
SERVICE_USER="dsh-exec"
ID_RE='^exec-[0-9a-f]{12}-(amd64|arm64)(-dirty-[0-9]{14})?$'

die() {
    echo "install-release: $1" >&2
    exit 1
}

require_root() {
    [ "$(id -u)" = 0 ] || die "must run as root"
}

host_arch() {
    case "$(uname -m)" in
        x86_64) echo x64 ;;
        aarch64|arm64) echo arm64 ;;
        *) uname -m ;;
    esac
}

cmd_init() {
    require_root
    if ! getent passwd "$SERVICE_USER" >/dev/null; then
        useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
        echo "created system user $SERVICE_USER"
    fi
    install -d -m 0755 -o root -g root "$PREFIX" "$PREFIX/releases"
    install -d -m 0750 -o root -g root "$DATA"
    for sub in workspaces tmp artifacts control; do
        install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA/$sub"
    done
    # 数据根的父目录要让运行用户能进入。
    chgrp "$SERVICE_USER" "$DATA"
    install -d -m 0750 -o root -g "$SERVICE_USER" "$ETC_DIR"
    echo "initialized $PREFIX, $DATA and $ETC_DIR"
    echo "next: install a release, then create $ETC_DIR/exec.env (root:$SERVICE_USER 0640) from vm/exec.env.example"
}

cmd_install() {
    require_root
    local tarball="${1:-}"
    [ -f "$tarball" ] || die "tarball not found: $tarball"
    [ -f "$tarball.sha256" ] || die "checksum file not found: $tarball.sha256"
    local name id
    name="$(basename "$tarball")"
    id="${name%.tar.gz}"
    [[ "$id" =~ $ID_RE ]] || die "unexpected release file name: $name"
    [ ! -e "$PREFIX/releases/$id" ] || die "release already installed (releases are immutable): $id"

    ( cd "$(dirname "$tarball")" && sha256sum --quiet --strict -c "$name.sha256" ) || die "tarball checksum mismatch"
    if tar -tzf "$tarball" | grep -Evq "^${id}(/|$)"; then
        die "tarball contains entries outside $id/"
    fi
    if tar -tzf "$tarball" | grep -Eq '(^|/)\.\.(/|$)'; then
        die "tarball contains parent-directory entries"
    fi

    local staging
    staging="$(mktemp -d "$PREFIX/releases/.staging-XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    tar -xzf "$tarball" -C "$staging" --no-same-owner --no-same-permissions
    local dir="$staging/$id"
    [ -f "$dir/release-manifest.json" ] || die "release-manifest.json missing"
    ( cd "$dir" && sha256sum --quiet --strict -c SHA256SUMS ) || die "release files do not match SHA256SUMS"

    local manifest_id manifest_arch
    manifest_id="$(sed -n 's/^  "release_id": "\(.*\)",$/\1/p' "$dir/release-manifest.json")"
    manifest_arch="$(sed -n 's/^  "arch": "\(.*\)",$/\1/p' "$dir/release-manifest.json")"
    [ "$manifest_id" = "$id" ] || die "manifest release_id does not match file name"
    [ "$manifest_arch" = "$(host_arch)" ] || die "release built for $manifest_arch, host is $(host_arch)"

    chown -R root:root "$dir"
    chmod -R u+rwX,go+rX,go-w "$dir"
    chmod 0755 "$dir/vm/exec-preflight.sh" "$dir/vm/install-release.sh"
    mv "$dir" "$PREFIX/releases/$id"
    rm -rf "$staging"
    trap - EXIT
    echo "installed $PREFIX/releases/$id (not active)"
}

cmd_activate() {
    require_root
    local id="${1:-}"
    [[ "$id" =~ $ID_RE ]] || die "invalid release id: $id"
    local dir="$PREFIX/releases/$id"
    [ -d "$dir" ] || die "release not installed: $id"
    ( cd "$dir" && sha256sum --quiet --strict -c SHA256SUMS ) || die "installed release is damaged: $id"

    local previous=""
    if [ -L "$PREFIX/current" ]; then
        previous="$(basename "$(readlink "$PREFIX/current")")"
    fi
    ln -sfn "releases/$id" "$PREFIX/current.new"
    mv -Tf "$PREFIX/current.new" "$PREFIX/current"
    install -m 0644 -o root -g root "$dir/vm/dsh-exec.service" "$UNIT_PATH"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload
    fi
    echo "current -> $id${previous:+ (previous: $previous)}"
    echo "the running service is unchanged; restart it inside a maintenance window: systemctl restart dsh-exec"
    [ -z "$previous" ] || echo "rollback: $0 activate $previous && systemctl restart dsh-exec"
}

cmd_list() {
    local current=""
    [ -L "$PREFIX/current" ] && current="$(basename "$(readlink "$PREFIX/current")")"
    for dir in "$PREFIX"/releases/exec-*; do
        [ -d "$dir" ] || continue
        local id
        id="$(basename "$dir")"
        if [ "$id" = "$current" ]; then echo "* $id"; else echo "  $id"; fi
    done
}

case "${1:-}" in
    init) cmd_init ;;
    install) shift; cmd_install "$@" ;;
    activate) shift; cmd_activate "$@" ;;
    list) cmd_list ;;
    *) sed -n '2,11p' "$0"; exit 64 ;;
esac
