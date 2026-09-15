# 开发用：openEuler 24.03 LTS 官方镜像 + systemd，演练 VM 工具链安装脚本与 exec release。
#
# 不是麒麟 VM 验收：容器共享宿主内核，只能验证用户态（glibc、dnf 包名、工具链路径、systemd 行为）；
# KySec、user namespace 限制与麒麟内核上的加固项兼容性仍需在目标 VM 上做（design §12 T6）。
# 工具链不在镜像构建时安装——演练的对象正是 install-toolchain.sh 本身。
FROM openeuler/openeuler:24.03-lts
RUN dnf -y --setopt=install_weak_deps=False install \
        systemd procps-ng util-linux shadow ca-certificates curl tar xz findutils which iproute \
    && dnf clean all \
    && systemctl mask systemd-firstboot.service systemd-udevd.service getty@tty1.service
STOPSIGNAL SIGRTMIN+3
CMD ["/usr/lib/systemd/systemd"]
