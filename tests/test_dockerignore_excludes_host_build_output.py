"""`.dockerignore` 必须挡住**每一层**的 dist / node_modules，不只是上下文根。

Docker 的 `.dockerignore` 语义：不含 `**` 的 `dist/` 只匹配上下文根下的 `./dist`。
本仓库的构建上下文是仓库根，而每个包各有自己的 `dist`（`agent/dist`、`exec/dist`、
`api-server/dist`、`contract/dist`），Dockerfile 又都是 `COPY agent ./agent` 这种
整目录拷贝——于是宿主机的构建产物会被整个塞进镜像。

这不是理论问题。2026-09-04 在**运行中的** agent 镜像里查到：

    dist/src/infrastructure/sandbox/internal-hmac.js   # 当天刚删掉的 980 行
    dist/src/runtime/providers/memory.js               # 当天刚删掉的退役 provider

`npm run build` 里的 tsc 只覆盖它自己编译出的文件，不会清理别人留下的，所以
「源码删了」不等于「镜像里没了」。`.dockerignore` 原本就写着这个意图
（"Shipping the host's would let a stale local dist/ silently win"），只是模式
没写对。`node_modules/` 是同一个模式错误，一并改掉（改前镜像里的宿主机
node_modules 会覆盖 `npm ci` 装好的那份）。
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERIGNORE = ROOT / ".dockerignore"

# 每个有自己 dist / node_modules 的包目录。
PACKAGE_DIRS = ("agent", "exec", "api-server", "contract", "frontend")


def _patterns() -> list[str]:
    return [
        line.strip()
        for line in DOCKERIGNORE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def test_nested_build_output_is_excluded() -> None:
    patterns = _patterns()
    for name in ("dist", "node_modules"):
        nested = f"**/{name}/"
        assert nested in patterns, (
            f"`.dockerignore` needs `{nested}`: a bare `{name}/` only matches the "
            f"context root, so {'/'.join(PACKAGE_DIRS[:2])}/{name} still ships into "
            "the image and stale files from deleted sources survive there"
        )


def test_tsbuildinfo_is_excluded_at_every_level() -> None:
    patterns = _patterns()
    assert "**/*.tsbuildinfo" in patterns, (
        "a nested `*.tsbuildinfo` would let an incremental build skip work using "
        "the host's stale state"
    )
