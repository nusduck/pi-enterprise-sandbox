"""Production edge routing contract for public A2A HTTP and SSE traffic.

边缘 nginx 有两套 server 模板（`TLS_ENABLED` 选一套），共享同一份 location 定义：
- 路由与代理语义（A2A / SSE / 上传）断言在 `templates/locations.conf` 上；
- 监听端口、TLS 与 HSTS 断言在各自的 server 模板上。
这样明文模式不会悄悄丢掉 SSE 免缓冲之类的代理语义。
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NGINX_DIR = ROOT / "nginx"
LOCATIONS = NGINX_DIR / "templates" / "locations.conf"
HTTP_TEMPLATE = NGINX_DIR / "templates" / "sandbox-http.conf"
TLS_TEMPLATE = NGINX_DIR / "templates" / "sandbox-tls.conf"
ENTRYPOINT = NGINX_DIR / "entrypoint.sh"
DOCKERFILE = NGINX_DIR / "Dockerfile"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"

INCLUDE_DIRECTIVE = "include /etc/nginx/pi-templates/locations.conf;"


def _directives(path: Path) -> str:
    """去掉注释行后的配置正文。

    断言只看真正生效的指令：模板里解释「为什么不声明 HSTS」的注释本身含有
    `Strict-Transport-Security` 字样，对整份文本做否定断言会被自己的注释误伤。
    """
    return "\n".join(
        line
        for line in path.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    )


def _location_block(config: str, marker: str) -> str:
    start = config.index(marker)
    brace = config.index("{", start)
    depth = 0
    for index in range(brace, len(config)):
        if config[index] == "{":
            depth += 1
        elif config[index] == "}":
            depth -= 1
            if depth == 0:
                return config[start : index + 1]
    raise AssertionError(f"unterminated nginx location: {marker}")


def test_public_agent_card_is_proxied_directly_to_agent() -> None:
    config = LOCATIONS.read_text(encoding="utf-8")
    block = _location_block(config, "location = /.well-known/agent-card.json")

    assert "proxy_pass http://agent:4100;" in block
    assert "proxy_set_header Authorization $http_authorization;" in block
    assert "proxy_set_header X-Forwarded-Proto $scheme;" in block
    assert "Cache-Control \"no-store" in block


def test_a2a_proxy_preserves_auth_and_disables_sse_buffering() -> None:
    config = LOCATIONS.read_text(encoding="utf-8")
    block = _location_block(config, "location ~ ^/a2a(?:/|$)")

    for directive in (
        "proxy_pass http://agent:4100;",
        "proxy_http_version 1.1;",
        "proxy_set_header Authorization $http_authorization;",
        "proxy_buffering off;",
        "proxy_cache off;",
        "proxy_request_buffering off;",
        "proxy_set_header Connection '';",
        "proxy_read_timeout 3600s;",
    ):
        assert directive in block


def test_both_modes_share_one_location_definition() -> None:
    for template in (HTTP_TEMPLATE, TLS_TEMPLATE):
        assert INCLUDE_DIRECTIVE in template.read_text(encoding="utf-8"), template.name


def test_forwarded_port_follows_the_listening_port() -> None:
    # 同一份 location 被 80 和 443 两个 server 块 include，端口不能写死。
    text = _directives(LOCATIONS)
    assert "proxy_set_header X-Forwarded-Port $server_port;" in text
    assert "X-Forwarded-Port 443" not in text


def test_plaintext_template_has_no_tls_and_no_hsts() -> None:
    text = _directives(HTTP_TEMPLATE)
    assert "listen 80 default_server;" in text
    assert "443" not in text
    assert "ssl" not in text
    # 对只有明文端口的站点声明 HSTS，会把浏览器锁在没有监听的加密端口上。
    assert "Strict-Transport-Security" not in text
    assert "return 301 https" not in text
    # 其余安全响应头仍在。
    assert "X-Content-Type-Options" in text
    assert "X-Frame-Options" in text


def test_tls_template_terminates_and_redirects() -> None:
    text = _directives(TLS_TEMPLATE)
    assert "listen 443 ssl default_server;" in text
    # 1.25.1 起 `listen ... http2` 废弃；用独立指令，别让镜像每次启动都告警。
    assert "http2 on;" in text
    assert "listen 443 ssl http2" not in text
    assert "return 301 https://$host$request_uri;" in text
    assert "Strict-Transport-Security" in text
    assert "ssl_certificate /etc/nginx/ssl/fullchain.pem;" in text
    assert "/.well-known/acme-challenge/" in text


def test_entrypoint_picks_a_template_and_fails_closed() -> None:
    text = ENTRYPOINT.read_text(encoding="utf-8")
    # 默认仍是 TLS：明文必须是显式选择，不能因为漏配就降级。
    assert 'TLS_ENABLED="${TLS_ENABLED:-true}"' in text
    assert "sandbox-http.conf" in text
    assert "sandbox-tls.conf" in text
    # 拼错的值不猜意图；渲染后校验配置，坏配置不启动。
    assert "exit 1" in text
    assert "nginx -t" in text


def test_templates_are_not_auto_loaded_from_conf_d() -> None:
    # 两套 server 模板若留在 conf.d，nginx.conf 的 include 会同时加载，80 冲突。
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY nginx/templates/ /etc/nginx/pi-templates/" in dockerfile
    assert "COPY nginx/conf.d/" not in dockerfile
    assert not (NGINX_DIR / "conf.d").exists()


def test_production_nginx_waits_for_direct_agent_upstream() -> None:
    compose = COMPOSE_PROD.read_text(encoding="utf-8")
    nginx_start = compose.index("\n  nginx:\n")
    nginx_end = compose.index("\n  sandbox:\n", nginx_start)
    nginx = compose[nginx_start:nginx_end]

    assert "agent:\n        condition: service_started" in nginx
    assert "- backend_internal" in nginx
    # 入口形态由编排显式传入，而不是只靠镜像默认值。
    assert "TLS_ENABLED:" in nginx
