#!/bin/sh
# pi-exec.service 的 ExecStartPre：进程启动前的部署检查（design §9.1 / §9.2）。
#
# 只检查部署形态；取密、schema、bwrap 真跑与孤儿回收由 exec 进程自己按顺序做，失败同样拒启。
# 任何一项失败即非零退出，systemd 不会启动 ExecStart。不输出任何配置值。
set -eu

ME=pi-exec-preflight
RELEASE_DIR="${PI_EXEC_RELEASE_DIR:-$(cd "$(dirname "$0")/.." && pwd -P)}"
NODE_BIN="${PI_EXEC_NODE:-/usr/local/bin/node}"

fail() {
    echo "$ME: FAIL: $1" >&2
    exit 1
}
ok() {
    echo "$ME: ok: $1"
}

# ── 运行身份 ──
uid="$(id -u)"
[ "$uid" != 0 ] || fail "must not run as root"
ok "running as uid $uid"

# ── Node：位置必须在 bwrap 可见的 /usr 下，版本满足 engines ──
[ -x "$NODE_BIN" ] || fail "node is not executable at $NODE_BIN"
case "$NODE_BIN" in
    /usr/*) ;;
    *) fail "node must live under /usr (Bubblewrap only exposes /usr, /bin, /sbin, /lib, /lib64): $NODE_BIN" ;;
esac
node_version="$("$NODE_BIN" -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
if [ "$node_major" != 22 ] || [ "$node_minor" -lt 19 ]; then
    fail "node $node_version does not satisfy >=22.19.0 <23"
fi
ok "node $node_version"

# ── release：完整、架构匹配、对运行用户只读 ──
[ -f "$RELEASE_DIR/release-manifest.json" ] || fail "release-manifest.json missing in $RELEASE_DIR"
[ -f "$RELEASE_DIR/SHA256SUMS" ] || fail "SHA256SUMS missing in $RELEASE_DIR"
( cd "$RELEASE_DIR" && sha256sum --quiet --strict -c SHA256SUMS ) >/dev/null 2>&1 \
    || fail "release files do not match SHA256SUMS"
manifest_arch="$("$NODE_BIN" -p "require('$RELEASE_DIR/release-manifest.json').arch")"
[ "$manifest_arch" = "$("$NODE_BIN" -p 'process.arch')" ] \
    || fail "release built for $manifest_arch, host is $("$NODE_BIN" -p 'process.arch')"
if [ -n "$(find "$RELEASE_DIR" -writable -print -quit 2>/dev/null)" ]; then
    fail "release directory is writable by the service user"
fi
ok "release $(basename "$RELEASE_DIR") intact and read-only"

# ── 必需配置（只检查非空，不输出值）──
for name in DEPLOYMENT_ENV EXEC_DATABASE_URL DBPM_URL DBPM_DB_NAME DBPM_DB_USER_NAME \
    SANDBOX_INTERNAL_HMAC_KEYRING SANDBOX_INTERNAL_HMAC_ACTIVE_KID SANDBOX_API_TOKEN \
    SANDBOX_MCP_INTERNAL_TOKEN EXEC_INTERNAL_ALLOW_CIDR \
    SANDBOX_WORKSPACES_ROOT SANDBOX_TEMP_ROOT SANDBOX_ARTIFACTS_ROOT SANDBOX_CONTROL_ROOT \
    SANDBOX_SKILLS_ROOT; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || fail "$name is required"
    case "$value" in
        *'<'*'>'*) fail "$name still contains a template placeholder" ;;
    esac
done
[ "$DEPLOYMENT_ENV" = production ] || fail "DEPLOYMENT_ENV must be production on the VM"
ok "required configuration present"

# ── 本地数据根：目录、属主为运行用户、0700、不在 release 内 ──
for root in "$SANDBOX_WORKSPACES_ROOT" "$SANDBOX_TEMP_ROOT" "$SANDBOX_ARTIFACTS_ROOT" "$SANDBOX_CONTROL_ROOT"; do
    [ -d "$root" ] || fail "data root missing: $root"
    [ "$(stat -c %u "$root")" = "$uid" ] || fail "data root not owned by the service user: $root"
    [ "$(stat -c %a "$root")" = 700 ] || fail "data root mode must be 0700: $root"
    case "$(cd "$root" && pwd -P)/" in
        "$RELEASE_DIR"/*) fail "data root must not live inside the release: $root" ;;
    esac
done
ok "data roots owned by uid $uid with mode 0700"

# ── 系统 Skill 根可读 ──
[ -d "$SANDBOX_SKILLS_ROOT" ] && [ -r "$SANDBOX_SKILLS_ROOT" ] && [ -x "$SANDBOX_SKILLS_ROOT" ] \
    || fail "system skill root is not a readable directory"
ok "system skill root readable"

# ── Bubblewrap：存在、可执行、不是 setuid（unit 设了 NoNewPrivileges）──
bwrap="${SANDBOX_BWRAP_PATH:-/usr/bin/bwrap}"
[ -x "$bwrap" ] || fail "bwrap is not executable at $bwrap"
[ ! -u "$bwrap" ] || fail "bwrap must not be setuid; it has to work through unprivileged user namespaces"
ok "bwrap present (real isolation check runs inside exec at startup)"

echo "$ME: all checks passed"
