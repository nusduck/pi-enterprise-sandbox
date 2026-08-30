"""每一个 `node <路径>` 入口都必须指向 dist/。

agent 正在从 JS 迁到 TS（docs/design/agent-ts-rebuild.md 阶段 C–F）。镜像里
同时有 `src/`（COPY 进来的源码）和 `dist/`（tsc 产物），而 **plain node 读不了
`.ts`**——一个仍指向 `src/` 的入口，在文件转成 TS 的那一刻起就再也起不来。

这不是假想：阶段 C 把 Dockerfile 的 CMD 改成了 `dist/server.js`，却漏掉了
docker-compose 里用 `command:` 覆盖 CMD 的两处（agent 与 agent-migrate）。
整套测试都经 tsx 运行，tsx 会把 `.js` 解析到 `.ts`，所以 1043 个绿测试一个
都没有发现 `node server.js` 已经起不来了。

这条守卫补的就是那个盲区：它不跑 Docker，只读 compose 与 Dockerfile 的
命令行。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    ROOT / "docker-compose.yml",
    ROOT / "docker-compose.prod.yml",
    ROOT / "agent" / "Dockerfile",
]

# `node -e '...'` 是内联脚本（healthcheck 用），不指向文件，跳过。
NODE_INVOCATION = re.compile(r'"node",\s*"(?P<arg>[^"]+)"')
DOCKERFILE_CMD = re.compile(r'^(?:CMD|ENTRYPOINT)\s+(?P<json>\[.*\])\s*$', re.M)


def _entry_paths(text: str) -> list[str]:
    found = [m.group("arg") for m in NODE_INVOCATION.finditer(text)]
    for m in DOCKERFILE_CMD.finditer(text):
        try:
            argv = json.loads(m.group("json"))
        except json.JSONDecodeError:
            continue
        if argv and argv[0] == "node" and len(argv) > 1:
            found.append(argv[1])
    return [a for a in found if a != "-e" and not a.startswith("-")]


def test_every_node_entrypoint_points_into_dist() -> None:
    offenders: list[str] = []
    for path in FILES:
        if not path.exists():
            continue
        for arg in _entry_paths(path.read_text(encoding="utf-8")):
            if arg.endswith(".js") and not arg.startswith("dist/"):
                offenders.append(f"{path.relative_to(ROOT)}: node {arg}")
    assert not offenders, (
        "These entrypoints run plain node against a source path. Once that file "
        "becomes .ts they stop resolving — point them at dist/ instead:\n"
        + "\n".join(offenders)
    )
