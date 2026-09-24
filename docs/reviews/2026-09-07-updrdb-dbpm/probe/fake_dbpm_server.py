#!/usr/bin/env python3.13
"""本地假 DBPM 服务端 —— 开发期的"挡板"。

为什么用**假服务端**而不是在应用里加 stub 分支：
生产代码只保留**一条**取密路径（真的连 DBPM、真的解协议），开发期只是把
`DBPM_URL` 指到本机这个进程。这样就不存在"stub 分支不小心在生产生效"的风险 ——
AGENTS.md §2 要求密钥缺失时 fail-closed，任何"取不到就回退到环境变量明文"的
写法都是在破坏这条不变量。

协议与 docs/ref/dbpm/usage.py 一致：
    请求  b'\\x0E\\x02' + b' {db_name} {db_user_name}\\n'
    应答  'OK: {password}\\n'，未知条目返回错误串

用法：
    # 单台
    python3.13 fake_dbpm_server.py --port 7000 \\
        --entry rstlmrdsdb:rstlmap:dev_only_pwd_1

    # 主备两台（开两个进程，或用 --port 起两次），配合
    #   DBPM_URL=127.0.0.1:7000,127.0.0.1:7001
    python3.13 fake_dbpm_server.py --port 7001 \\
        --entry rstlmrdsdb:rstlmap:dev_only_pwd_1

    # 模拟故障：--fail-rate 0.5 随机失败，--down 直接拒绝连接后退出
    python3.13 fake_dbpm_server.py --port 7000 --entry a:b:c --fail-rate 0.3

**只用于开发/测试。口令是明文参数，别放真实凭据。**
"""

from __future__ import annotations

import argparse
import logging
import random
import socketserver
import sys

if sys.version_info < (3, 11):
    sys.exit("需要 Python 3.11+（目标 3.13）")

HEADER = b"\x0e\x02"


class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        data = self.request.recv(512)
        if not data.startswith(HEADER):
            logging.warning("协议头不对，拒绝: %r", data[:16])
            self.request.sendall(b"ERR: bad protocol header\n")
            return

        body = data[len(HEADER):].decode(errors="replace").strip()
        parts = body.split()
        if len(parts) != 2:
            self.request.sendall(b"ERR: expected '<db_name> <db_user_name>'\n")
            return
        db_name, db_user = parts

        srv = self.server
        if srv.fail_rate and random.random() < srv.fail_rate:      # type: ignore[attr-defined]
            logging.info("注入失败: %s/%s", db_name, db_user)
            self.request.sendall(b"ERR: injected failure\n")
            return

        pwd = srv.entries.get((db_name, db_user))                   # type: ignore[attr-defined]
        if pwd is None:
            logging.info("未知条目: %s/%s", db_name, db_user)
            self.request.sendall(f"ERR: no such entry {db_name}/{db_user}\n".encode())
            return

        logging.info("发放口令: %s/%s (len=%d)", db_name, db_user, len(pwd))
        self.request.sendall(f"OK: {pwd}\n".encode())


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description="本地假 DBPM 服务端（仅开发用）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7000)
    ap.add_argument("--entry", action="append", required=True,
                    metavar="db_name:db_user:password",
                    help="可重复。例：rstlmrdsdb:rstlmap:dev_only_pwd")
    ap.add_argument("--fail-rate", type=float, default=0.0,
                    help="0~1，按比例随机返回错误，用于验证主备切换与 fail-closed")
    args = ap.parse_args()

    entries: dict[tuple[str, str], str] = {}
    for raw in args.entry:
        try:
            name, user, pwd = raw.split(":", 2)
        except ValueError:
            sys.exit(f"--entry 格式应为 db_name:db_user:password，实际: {raw}")
        entries[(name, user)] = pwd

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    srv = Server((args.host, args.port), Handler)
    srv.entries = entries          # type: ignore[attr-defined]
    srv.fail_rate = args.fail_rate  # type: ignore[attr-defined]

    logging.info("假 DBPM 监听 %s:%d，%d 个条目，fail_rate=%.2f",
                 args.host, args.port, len(entries), args.fail_rate)
    logging.warning("仅供开发/测试。切勿放真实凭据，切勿暴露到本机以外。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        logging.info("退出")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
