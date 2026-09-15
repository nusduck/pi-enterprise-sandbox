"""frontend nginx 上游模板化（design §2.2 `API_UPSTREAM`）。

- 模板里只有 `${API_UPSTREAM}` 一个 envsubst 占位符，nginx 自己的 `$host` 等变量不能被替换；
- 镜像把 envsubst 过滤器限定为 `API_UPSTREAM`，并删掉官方镜像自带的 default.conf；
- 启动前校验脚本真实执行：合法值放行，路径 / 换行 / 分号 / https / 非法端口拒绝；
- 渲染后核对脚本：未渲染、残留占位符、上游不符都拒绝。
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
TEMPLATE = FRONTEND / "nginx" / "default.conf.template"
VALIDATE = FRONTEND / "nginx" / "05-validate-api-upstream.sh"
VERIFY = FRONTEND / "nginx" / "25-verify-rendered-config.sh"
DOCKERFILE = FRONTEND / "Dockerfile"


def _run(script: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", str(script)],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), **env},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def test_legacy_hardcoded_config_is_gone() -> None:
    assert not (FRONTEND / "nginx.conf").exists()


def test_template_has_single_env_placeholder_and_keeps_nginx_variables() -> None:
    text = TEMPLATE.read_text(encoding="utf-8")
    assert set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", text)) == {"API_UPSTREAM"}
    assert "proxy_pass ${API_UPSTREAM};" in text
    assert "api-server:4000" not in text
    # nginx 运行期变量保持 `$name` 形式，交给 nginx 而不是 envsubst。
    for var in ("$host", "$remote_addr", "$proxy_add_x_forwarded_for", "$uri"):
        assert var in text, var
    # SSE / 上传要求（design §2.2）不能随模板化丢失。
    for directive in (
        "proxy_buffering off;",
        "proxy_request_buffering off;",
        "client_max_body_size 55m;",
        "proxy_read_timeout 300s;",
        "proxy_send_timeout 300s;",
    ):
        assert directive in text, directive


def test_dockerfile_wires_template_filter_and_hooks() -> None:
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert "rm -f /etc/nginx/conf.d/default.conf" in text
    assert "COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template" in text
    assert re.search(r"NGINX_ENVSUBST_FILTER=\^API_UPSTREAM\$", text)
    assert "05-validate-api-upstream.sh" in text
    assert "25-verify-rendered-config.sh" in text
    assert re.search(r"COPY --chmod=0755 .*/docker-entrypoint\.d/", text)
    assert "nginx.conf /etc/nginx/conf.d/default.conf" not in text


@pytest.mark.parametrize("script", [VALIDATE, VERIFY])
def test_hook_scripts_are_executable(script: Path) -> None:
    assert script.stat().st_mode & stat.S_IXUSR, script


@pytest.mark.parametrize(
    "value",
    [
        "http://api-server:4000",
        "http://api-server",
        "http://10.20.30.40:8080",
        "http://api.internal.example.com:1",
        "http://a:65535",
    ],
)
def test_validate_accepts_plain_http_upstreams(value: str) -> None:
    result = _run(VALIDATE, {"API_UPSTREAM": value})
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "value",
    [
        "",
        "api-server:4000",
        "https://api-server:4000",
        "http://api-server:4000/",
        "http://api-server:4000/api",
        "http://api-server:4000?x=1",
        "http://api-server:4000; return 200",
        "http://api-server:4000\nlocation / {}",
        "http://$host:4000",
        "http://api server:4000",
        "http://-bad:4000",
        "http://api-server:0",
        "http://api-server:65536",
        "http://api-server:99999",
    ],
)
def test_validate_rejects_unsafe_or_unsupported_upstreams(value: str) -> None:
    result = _run(VALIDATE, {"API_UPSTREAM": value})
    assert result.returncode != 0, value
    assert "API_UPSTREAM" in result.stderr


def test_validate_rejects_missing_variable() -> None:
    assert _run(VALIDATE, {}).returncode != 0


def _render(tmp_path: Path, upstream: str) -> Path:
    out = tmp_path / "conf.d"
    out.mkdir()
    rendered = TEMPLATE.read_text(encoding="utf-8").replace("${API_UPSTREAM}", upstream)
    (out / "default.conf").write_text(rendered, encoding="utf-8")
    return out


def test_verify_accepts_matching_rendered_config(tmp_path: Path) -> None:
    out = _render(tmp_path, "http://api-server:4000")
    result = _run(
        VERIFY,
        {"API_UPSTREAM": "http://api-server:4000", "NGINX_ENVSUBST_OUTPUT_DIR": str(out)},
    )
    assert result.returncode == 0, result.stderr


def test_verify_rejects_missing_unrendered_or_mismatched_config(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    env = {"API_UPSTREAM": "http://api-server:4000"}
    assert _run(VERIFY, {**env, "NGINX_ENVSUBST_OUTPUT_DIR": str(empty)}).returncode != 0

    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "default.conf").write_text(TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8")
    assert _run(VERIFY, {**env, "NGINX_ENVSUBST_OUTPUT_DIR": str(raw)}).returncode != 0

    stale = _render(tmp_path, "http://old-upstream:4000")
    assert _run(VERIFY, {**env, "NGINX_ENVSUBST_OUTPUT_DIR": str(stale)}).returncode != 0
