# 开发用：带 systemd 的 Linux 容器，用来演练 VM release 的安装、启动、停止与回滚。
#
# 不是 VM 验收：它是 Debian bookworm，不是麒麟；容器以 --privileged 运行，KySec / SELinux、
# 真实 user namespace 限制与办公工具链都不在范围内（design §12 T6 仍需在目标 VM 上做）。
# Node 来自 node:22-slim 的 /usr/local/bin/node，与 release 要求的位置一致。
FROM node:22-slim
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus bubblewrap util-linux procps ca-certificates curl && \
    find /etc/systemd/system /lib/systemd/system \
        \( -path '*.wants/*' -name '*getty*' -o -name 'systemd-logind.service' \) -exec rm -f {} + ; \
    systemctl mask systemd-firstboot.service systemd-udevd.service
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
