#!/usr/bin/env bash
# 构建 VM exec release（design §9.1）。产物：<out>/<release-id>.tar.gz 与 .sha256。
#
#   scripts/vm/build-exec-release.sh [--arch amd64|arm64] [--out DIR] [--allow-dirty]
#
# - 在目标架构的 Linux 容器里编译与安装依赖（docker buildx --platform），原生模块不跨平台搬运。
# - 默认拒绝有未提交改动的工作区：release 必须能对应到一个提交。--allow-dirty 只用于本地验证，
#   产物 id 带 -dirty 后缀，manifest 里 git_dirty=true。
# - 不推送、不安装；安装见 deploy/vm/install-release.sh。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARCH="amd64"
OUT="$ROOT/.runtime/vm-release"
ALLOW_DIRTY=false

while [ $# -gt 0 ]; do
    case "$1" in
        --arch) ARCH="${2:-}"; shift 2 ;;
        --out) OUT="${2:-}"; shift 2 ;;
        --allow-dirty) ALLOW_DIRTY=true; shift ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
done

case "$ARCH" in
    amd64|arm64) ;;
    *) echo "--arch must be amd64 or arm64" >&2; exit 64 ;;
esac

cd "$ROOT"
GIT_SHA="$(git rev-parse HEAD)"
GIT_DIRTY=false
if [ -n "$(git status --porcelain)" ]; then
    GIT_DIRTY=true
    if [ "$ALLOW_DIRTY" != true ]; then
        echo "working tree has uncommitted changes; commit first or pass --allow-dirty for a local test build" >&2
        exit 65
    fi
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_ID="exec-${GIT_SHA:0:12}-${ARCH}"
if [ "$GIT_DIRTY" = true ]; then
    RELEASE_ID="${RELEASE_ID}-dirty-$(date -u +%Y%m%d%H%M%S)"
fi

mkdir -p "$OUT"
echo "Building ${RELEASE_ID} (linux/${ARCH})..."
docker buildx build \
    --platform "linux/${ARCH}" \
    --file scripts/vm/release-builder.Dockerfile \
    --target artifact \
    --build-arg "RELEASE_ID=${RELEASE_ID}" \
    --build-arg "GIT_SHA=${GIT_SHA}" \
    --build-arg "GIT_DIRTY=${GIT_DIRTY}" \
    --build-arg "BUILT_AT=${BUILT_AT}" \
    --output "type=local,dest=${OUT}" \
    "$ROOT"

(cd "$OUT" && shasum -a 256 -c "${RELEASE_ID}.tar.gz.sha256" >/dev/null 2>&1 || sha256sum -c "${RELEASE_ID}.tar.gz.sha256" >/dev/null)
echo "Release: ${OUT}/${RELEASE_ID}.tar.gz"
echo "Checksum: ${OUT}/${RELEASE_ID}.tar.gz.sha256"
