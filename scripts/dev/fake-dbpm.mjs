#!/usr/bin/env node
/**
 * 开发 / 测试用的假 DBPM 服务端（真协议）——ADR 0011 D10 的「开发挡板」。
 *
 * 为什么是假服务端而不是应用里的 stub 分支：应用只保留一条取密路径（真的连 DBPM、
 * 真的解协议），开发环境只是把 `DBPM_URL` 指到这里。任何「没配 DBPM 就用环境变量
 * 口令」的写法都是 fail-open，违反 AGENTS.md §2。
 *
 * 协议：请求 `0x0E 0x02` + ` <db_name> <db_user_name>\n`；成功应答 `OK: <password>\n`，
 * 否则 `ERR: ...\n`。
 *
 * 两种用法：
 * - Compose `dbpm-fake` 服务：`node fake-dbpm.mjs`，读下列环境变量；
 * - 测试 / smoke：`import { startFakeDbpm } from '.../fake-dbpm.mjs'`，端口传 0。
 *
 * 环境变量（CLI）：
 *   FAKE_DBPM_ENTRIES     `db:user:password;db2:user2:password2`（口令可含冒号，不可含分号）
 *   FAKE_DBPM_PORTS       逗号分隔端口，默认 `7000,7001`（模拟主备两台）
 *   FAKE_DBPM_FAIL_PORTS  这些端口对所有请求返回错误，用来演练「主失败备成功」
 *   FAKE_DBPM_HOST        监听地址，默认 `0.0.0.0`
 *
 * **生产拒绝运行**：`DEPLOYMENT_ENV=production` 直接退出。只放开发占位口令。
 */

import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const HEADER_0 = 0x0e;
const HEADER_1 = 0x02;
const MAX_REQUEST_BYTES = 1024;

/** 解析 `db:user:password;…`。 */
export function parseFakeDbpmEntries(raw) {
  const entries = new Map();
  for (const item of String(raw ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const first = item.indexOf(':');
    const second = item.indexOf(':', first + 1);
    if (first <= 0 || second <= first + 1 || second === item.length - 1) {
      throw new Error('FAKE_DBPM_ENTRIES items must look like db:user:password');
    }
    entries.set(`${item.slice(0, first)} ${item.slice(first + 1, second)}`, item.slice(second + 1));
  }
  if (entries.size === 0) throw new Error('FAKE_DBPM_ENTRIES is empty');
  return entries;
}

function answer(entries, failing, request) {
  if (request.length < 3 || request[0] !== HEADER_0 || request[1] !== HEADER_1) {
    return { line: 'ERR: bad protocol header', label: 'bad-header' };
  }
  const parts = request.subarray(2).toString('utf8').replace(/\n$/, '').trim().split(' ');
  if (parts.length !== 2 || parts.some((p) => p === '')) {
    return { line: "ERR: expected '<db_name> <db_user_name>'", label: 'bad-body' };
  }
  const label = `${parts[0]}/${parts[1]}`;
  if (failing) return { line: 'ERR: injected failure', label: `${label} (injected failure)` };
  const password = entries.get(parts.join(' '));
  if (password === undefined) return { line: 'ERR: no such entry', label: `${label} (unknown)` };
  return { line: `OK: ${password}`, label: `${label} len=${password.length}` };
}

/**
 * 在给定端口上各起一台假 DBPM。返回端点列表、`DBPM_URL` 形式的地址串，
 * 以及运行期切换某台是否故障的 `setFailing(index, boolean)`。
 */
export async function startFakeDbpm({
  entries,
  ports = [0, 0],
  host = '127.0.0.1',
  failIndexes = [],
  log = () => {},
} = {}) {
  const table = entries instanceof Map ? entries : parseFakeDbpmEntries(entries);
  const failing = ports.map((_, index) => failIndexes.includes(index));
  const servers = [];
  const endpoints = [];

  for (const [index, port] of ports.entries()) {
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.setTimeout(5_000, () => socket.destroy());
      const chunks = [];
      let size = 0;
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        const buffer = Buffer.concat(chunks);
        const newline = buffer.indexOf(0x0a);
        if (newline === -1 && size <= MAX_REQUEST_BYTES) return;
        socket.removeAllListeners('data');
        const request = newline === -1 ? buffer : buffer.subarray(0, newline + 1);
        const { line, label } = answer(table, failing[index], request);
        log(`fake DBPM #${index + 1}: ${label}`);
        socket.end(`${line}\n`);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    servers.push(server);
    const address = server.address();
    endpoints.push({ host: host === '0.0.0.0' ? '127.0.0.1' : host, port: address.port });
  }

  return {
    endpoints,
    url: endpoints.map((e) => `${e.host}:${e.port}`).join(','),
    setFailing(index, value) {
      failing[index] = Boolean(value);
    },
    async close() {
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve()))));
    },
  };
}

async function main() {
  if (String(process.env.DEPLOYMENT_ENV ?? '').trim().toLowerCase() === 'production') {
    process.stderr.write('fake DBPM refuses to run with DEPLOYMENT_ENV=production\n');
    process.exit(1);
  }
  const ports = String(process.env.FAKE_DBPM_PORTS ?? '7000,7001')
    .split(',')
    .map((p) => Number.parseInt(p.trim(), 10));
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error('FAKE_DBPM_PORTS must be a comma-separated list of ports');
  }
  const failPorts = String(process.env.FAKE_DBPM_FAIL_PORTS ?? '')
    .split(',')
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter(Number.isInteger);
  const fake = await startFakeDbpm({
    entries: parseFakeDbpmEntries(process.env.FAKE_DBPM_ENTRIES),
    ports,
    host: process.env.FAKE_DBPM_HOST || '0.0.0.0',
    failIndexes: ports.flatMap((p, i) => (failPorts.includes(p) ? [i] : [])),
    log: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(
    `fake DBPM listening on ${ports.join(',')} (failing: ${failPorts.join(',') || 'none'}) — development only\n`,
  );
  const shutdown = () => void fake.close().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`fake DBPM failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
