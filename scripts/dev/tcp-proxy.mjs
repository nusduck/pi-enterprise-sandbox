#!/usr/bin/env node
/**
 * 开发用极简 TCP 转发器：在本地 Docker 里模拟 UPDRDB 的两个 Proxy。
 *
 * 只做字节转发，不解析 MySQL 协议；停掉一个容器就等于「这个 Proxy 挂了」，
 * 用来在真实容器栈上演练 `UPDRDB_ENDPOINTS` 的故障切换。**仅开发**：生产不部署。
 *
 * 环境变量：
 *   TCP_PROXY_LISTEN   监听端口，默认 3306
 *   TCP_PROXY_TARGET   目标 host:port，例如 mysql:3306
 */

import { connect, createServer } from 'node:net';

if (String(process.env.DEPLOYMENT_ENV ?? '').trim().toLowerCase() === 'production') {
  process.stderr.write('tcp-proxy is a development tool and refuses to run with DEPLOYMENT_ENV=production\n');
  process.exit(1);
}

const listenPort = Number.parseInt(process.env.TCP_PROXY_LISTEN ?? '3306', 10);
const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(String(process.env.TCP_PROXY_TARGET ?? ''));
if (!Number.isInteger(listenPort) || match === null) {
  process.stderr.write('TCP_PROXY_LISTEN must be a port and TCP_PROXY_TARGET must be host:port\n');
  process.exit(1);
}
const [, targetHost, targetPortText] = match;
const targetPort = Number.parseInt(targetPortText, 10);
let active = 0;

const server = createServer((client) => {
  active += 1;
  const upstream = connect({ host: targetHost, port: targetPort });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', () => {
    active -= 1;
    upstream.destroy();
  });
  upstream.on('close', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

server.listen(listenPort, '0.0.0.0', () => {
  process.stdout.write(`tcp-proxy ${listenPort} -> ${targetHost}:${targetPort}\n`);
});

const shutdown = () => {
  process.stdout.write(`tcp-proxy stopping (${active} active connections)\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
