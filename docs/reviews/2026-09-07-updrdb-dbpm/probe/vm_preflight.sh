#!/usr/bin/env bash
# VM 装机前体检 —— 银河麒麟 V11 / x86_64 裸装 exec 执行面
#
# 自包含、只读、不需要 root、不装任何东西。回答部署拓扑 §4 的待确认项：
# bwrap 能不能跑、麒麟源给不给必需软件、Node 够不够新、资源够不够。
#
# 退出码：0 无 BLOCKER ／ 1 有 BLOCKER（不修好装了也跑不起来）
#
#   bash vm_preflight.sh
#   bash vm_preflight.sh > preflight-$(hostname).txt 2>&1

set -uo pipefail

BLOCKERS=0
WARNINGS=0

c_red()  { printf '\033[31m%s\033[0m' "$1"; }
c_grn()  { printf '\033[32m%s\033[0m' "$1"; }
c_yel()  { printf '\033[33m%s\033[0m' "$1"; }

section() { printf '\n\033[1m── %s %s\033[0m\n' "$1" "$(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }
ok()      { printf '  [%s] %s\n' "$(c_grn ' OK ')" "$1"; }
warn()    { printf '  [%s] %s\n' "$(c_yel 'WARN')" "$1"; WARNINGS=$((WARNINGS + 1)); }
block()   { printf '  [%s] %s\n' "$(c_red 'BLOCK')" "$1"; BLOCKERS=$((BLOCKERS + 1)); }
info()    { printf '  [ -- ] %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── 1. 主机身份 ────────────────────────────────────────────────────
section "1. 主机身份"
info "hostname : $(hostname 2>/dev/null || echo '?')"
info "user     : $(id -un) (uid=$(id -u), gid=$(id -g))"
info "kernel   : $(uname -r)  arch=$(uname -m)"
if [ -r /etc/os-release ]; then
  info "os       : $(. /etc/os-release && echo "${PRETTY_NAME:-$NAME $VERSION}")"
fi
if sudo -n true 2>/dev/null; then
  ok "当前账号有免密 sudo —— 装机步骤可自助完成"
else
  info "当前账号无免密 sudo —— 所有 root 步骤需管理员预先执行（已知前提）"
fi

# ── 2. user namespace（bwrap 的硬前提）────────────────────────────
section "2. user namespace"
MAXUSERNS=/proc/sys/user/max_user_namespaces
if [ -r "$MAXUSERNS" ]; then
  v=$(cat "$MAXUSERNS")
  if [ "$v" -gt 0 ] 2>/dev/null; then
    ok "user.max_user_namespaces = $v"
  else
    block "user.max_user_namespaces = 0 —— 非特权 user namespace 被关闭，bwrap 必然失败"
    info "     修复（root）：sysctl -w user.max_user_namespaces=15000 并写进 /etc/sysctl.d/"
  fi
else
  warn "读不到 $MAXUSERNS —— 内核可能未编译 CONFIG_USER_NS"
fi
# Debian 系特有，主线/麒麟通常没有；有就一并看
if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
  info "kernel.unprivileged_userns_clone = $(cat /proc/sys/kernel/unprivileged_userns_clone)"
fi

# ── 3. 强制访问控制（麒麟 KySec / SELinux）────────────────────────
section "3. 强制访问控制"
if have getenforce; then
  se=$(getenforce 2>/dev/null)
  case "$se" in
    Enforcing) warn "SELinux = Enforcing —— 可能拦 bwrap 的 mount/namespace，看第 4 节实测结果" ;;
    *)         ok "SELinux = $se" ;;
  esac
else
  info "无 getenforce（SELinux 未启用或未安装工具）"
fi
# 麒麟安全增强 KySec
if have kysec_get; then
  info "KySec status : $(kysec_get status 2>/dev/null || echo '读取失败')"
  warn "检测到 KySec —— 麒麟的强制访问控制，若第 4 节实测失败优先怀疑它"
elif [ -d /sys/kernel/security/kysec ]; then
  warn "检测到 /sys/kernel/security/kysec —— 麒麟强制访问控制已加载"
else
  info "未检测到 KySec"
fi
if have aa-enabled && aa-enabled >/dev/null 2>&1; then
  warn "AppArmor 已启用 —— 裸装通常无策略约束，但若第 4 节失败需排查"
fi

# ── 4. bubblewrap 实测（本脚本的核心）─────────────────────────────
section "4. bubblewrap 实测"
if ! have bwrap; then
  block "未安装 bwrap —— 请管理员 dnf install bubblewrap 后重跑本节"
else
  info "bwrap: $(command -v bwrap)  $(bwrap --version 2>/dev/null)"

  # 4.1 最小 user namespace + uid 映射
  #     直接回答 SANDBOX_BWRAP_UID=10001 在非 root 账号下成不成立
  if bwrap --unshare-user --uid 10001 --gid 10001 --ro-bind / / -- /bin/true 2>/tmp/.bwrap_e1; then
    ok "4.1 user namespace + 映射到 uid/gid 10001 成功（SANDBOX_BWRAP_UID 默认值可用）"
  else
    block "4.1 user namespace 或 uid 映射失败：$(tr -d '\n' </tmp/.bwrap_e1 | cut -c1-160)"
  fi

  # 4.2 私有 /proc（Docker 下这步要 systempaths=unconfined）
  if bwrap --unshare-user --uid 10001 --gid 10001 --unshare-pid \
           --ro-bind / / --proc /proc -- /bin/true 2>/tmp/.bwrap_e2; then
    ok "4.2 pid namespace + 私有 /proc 挂载成功"
  else
    block "4.2 私有 /proc 挂载失败：$(tr -d '\n' </tmp/.bwrap_e2 | cut -c1-160)"
  fi

  # 4.3 exec 生产路径的完整 flag 组合（见 exec/src/isolation/render.ts）
  if bwrap --die-with-parent --new-session \
           --unshare-user --uid 10001 --gid 10001 \
           --unshare-pid --unshare-ipc --unshare-uts --unshare-net \
           --ro-bind / / --proc /proc --dev /dev --cap-drop ALL \
           -- /bin/echo bwrap-ok 2>/tmp/.bwrap_e3 | grep -q bwrap-ok; then
    ok "4.3 生产 flag 全集（含 --unshare-net / --dev / --cap-drop ALL）成功"
  else
    block "4.3 生产 flag 全集失败：$(tr -d '\n' </tmp/.bwrap_e3 | cut -c1-160)"
  fi
  rm -f /tmp/.bwrap_e1 /tmp/.bwrap_e2 /tmp/.bwrap_e3
fi

# ── 5. 运行时必需二进制 ───────────────────────────────────────────
section "5. 运行时必需"
if have node; then
  nv=$(node -v 2>/dev/null); major=${nv#v}; major=${major%%.*}
  if [ "${major:-0}" -ge 22 ] 2>/dev/null; then
    ok "node ${nv}（要求 ≥22，见 runtime-versions.json）"
  else
    block "node $nv 版本过低 —— 需要 22.x；麒麟源大概率没有，需 NodeSource RPM 或官方 tarball"
  fi
else
  block "未安装 node —— 需要 22.x"
fi
for b in setpriv git curl tar; do
  if have "$b"; then ok "$b: $(command -v $b)"; else
    if [ "$b" = setpriv ]; then
      warn "缺 setpriv（util-linux）—— 裸装非 root 时用不到，装上更保险"
    else
      block "缺 $b"
    fi
  fi
done

# ── 6. 模型执行运行库（对应镜像里的 apt 层）───────────────────────
section "6. 模型执行运行库"
# 用 "命令|说明" 列表而非关联数组 —— 兼容 bash 3.x
TOOLS='python3|Python 解释器（venv 另装到 /opt/pi-python/venv）
chromium|chromium（BAOYU_CHROME_PATH 需软链到 /usr/local/bin/baoyu-chromium）
soffice|LibreOffice 转换
tesseract|OCR
pandoc|文档转换
pdftotext|poppler-utils'
while IFS='|' read -r t desc; do
  [ -z "$t" ] && continue
  if have "$t"; then ok "$t —— $desc"; else warn "缺 $t —— $desc"; fi
done <<EOF
$TOOLS
EOF
have chromium-browser && ok "chromium-browser（麒麟包名变体）"
if have tesseract; then
  if tesseract --list-langs 2>/dev/null | grep -q chi_sim; then
    ok "tesseract 中文包 chi_sim 已装"
  else
    warn "tesseract 缺 chi_sim 中文包"
  fi
fi
if have fc-list && fc-list 2>/dev/null | grep -qiE 'noto.*cjk|wqy|uming|ukai'; then
  ok "CJK 字体已装"
else
  warn "未检出 CJK 字体 —— 转换出的 PDF/图片中文会变方块"
fi

# ── 7. 包管理与内网源 ─────────────────────────────────────────────
section "7. 包管理与内网源"
if have dnf; then
  ok "dnf 可用（麒麟 V11 为 RPM 系 —— 镜像里的 apt 清单需整体换名）"
  if timeout 30 dnf repolist --quiet >/tmp/.repolist 2>&1; then
    n=$(grep -cvE '^(repo id|$)' /tmp/.repolist 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then ok "已配置 $n 个仓库"; sed -n '1,8p' /tmp/.repolist | sed 's/^/       /'
    else block "dnf repolist 为空 —— 无内网源，所有软件需离线搬运"; fi
  else
    block "dnf repolist 失败/超时 —— 无内网源，所有软件需离线搬运"
  fi
  rm -f /tmp/.repolist
elif have yum; then warn "只有 yum，无 dnf"
elif have apt-get; then warn "检出 apt-get —— 与麒麟 RPM 系的判断不符，请复核"
else block "未检出包管理器"
fi

# ── 8. 资源 ───────────────────────────────────────────────────────
section "8. 资源"
info "CPU 核数 : $(nproc 2>/dev/null || echo '?')"
if have free; then info "内存     : $(free -h | awk '/^Mem:/{print $2" 总 / "$7" 可用"}')"; fi
info "根分区   : $(df -h / | awk 'NR==2{print $2" 总 / "$4" 可用"}')"
for d in /opt /var /home; do
  [ -d "$d" ] && info "$d : $(df -h "$d" | awk 'NR==2{print $4" 可用 (挂载于 "$6")"}')"
done
avail_kb=$(df -k /var | awk 'NR==2{print $4}')
if [ "${avail_kb:-0}" -lt 20971520 ] 2>/dev/null; then
  warn "/var 可用空间 < 20GB —— 工作区字节 + 产物快照都落本地盘，建议复核容量规划"
fi

# ── 9. 进程托管与端口 ─────────────────────────────────────────────
section "9. 进程托管与端口"
if have systemctl; then
  ok "systemd 可用"
  if have loginctl; then
    lg=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)
    if [ "$lg" = "yes" ]; then
      ok "linger 已开启 —— 可用 systemctl --user 托管两个进程，不需要 root 装 system unit"
    else
      warn "linger 未开启 —— 要么请管理员 loginctl enable-linger $(id -un)，要么由管理员装 system unit"
    fi
  fi
else
  warn "无 systemd —— 需另定进程托管方式（进程退出后无人拉起）"
fi
for p in 8081 8082; do
  if have ss && ss -ltn 2>/dev/null | grep -q ":$p "; then
    warn "端口 $p 已被占用"
  else
    ok "端口 $p 空闲"
  fi
done

# ── 结论 ──────────────────────────────────────────────────────────
section "结论"
printf '  BLOCKER: %s    WARNING: %s\n\n' "$BLOCKERS" "$WARNINGS"
if [ "$BLOCKERS" -gt 0 ]; then
  printf '  %s 存在 BLOCKER —— 修好之前不要开始装机。\n\n' "$(c_red '✗')"
  exit 1
fi
printf '  %s 无 BLOCKER。WARNING 多为需要管理员补装的软件，按第 5/6 节清单提工单。\n\n' "$(c_grn '✓')"
exit 0
