#!/bin/sh
# 在 20-envsubst-on-templates.sh 之后核对渲染结果。
#
# 官方脚本在 conf.d 不可写（例如只读根文件系统）时只打一行 ERROR 然后 `return 0`，
# nginx 照样启动——那样要么没有配置、要么沿用旧文件，/api/ 不会转发到期望的上游。
# 这里要求渲染文件存在、没有残留占位符、且确实写着本次的上游。
set -eu

ME=$(basename "$0")
conf="${NGINX_ENVSUBST_OUTPUT_DIR:-/etc/nginx/conf.d}/default.conf"

fail() {
    echo "$ME: $1" >&2
    exit 1
}

[ -f "$conf" ] || fail "$conf was not rendered from the template"
if grep -Fq '${API_UPSTREAM}' "$conf"; then
    fail "$conf still contains an unrendered API_UPSTREAM placeholder"
fi
grep -Fq "proxy_pass ${API_UPSTREAM};" "$conf" \
    || fail "$conf does not proxy to the configured API_UPSTREAM"

echo "$ME: rendered config verified"
