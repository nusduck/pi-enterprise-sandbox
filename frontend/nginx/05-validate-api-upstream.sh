#!/bin/sh
# 在 20-envsubst-on-templates.sh 之前校验 API_UPSTREAM（design §2.2）。
#
# 值会原样写进 `proxy_pass ...;`，所以只接受 `http://host[:port]`：
# 不带路径（会改写转发 URI）、不带 query、空白、换行、`;`、`$`（配置注入）。
# 暂不接受 https——内部 LB 按 HTTP 设计，https 上游还需要 SNI 与证书校验配置。
# 失败时非零退出，官方 entrypoint 在 set -e 下随之停止容器，nginx 不会启动。
set -eu

ME=$(basename "$0")
value="${API_UPSTREAM:-}"

fail() {
    echo "$ME: $1" >&2
    exit 1
}

[ -n "$value" ] || fail "API_UPSTREAM is required (e.g. http://api-server:4000)"

case "$value" in
    *"
"*) fail "API_UPSTREAM must be a single line" ;;
esac

printf '%s' "$value" | grep -Eq '^http://[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[0-9]{1,5})?$' \
    || fail "API_UPSTREAM must be http://host[:port] without path, query or whitespace"

port="${value##*:}"
case "$port" in
    //*) ;; # 无端口
    *)
        [ "$port" -ge 1 ] && [ "$port" -le 65535 ] \
            || fail "API_UPSTREAM port must be between 1 and 65535"
        ;;
esac

echo "$ME: API_UPSTREAM accepted"
