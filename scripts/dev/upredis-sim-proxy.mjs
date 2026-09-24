#!/usr/bin/env node
/**
 * 开发用 UPRedis Proxy 模拟器：在本地 Docker 里把 `redis:5.0.14` 包成「按 key 路由的代理」。
 *
 * 只模拟 2026-09 真机探针确认过的两条路由限制（见
 * `docs/reviews/2026-09-07-updrdb-dbpm/probe/result.md`），其余命令原样转发：
 *
 * 1. `EVAL` / `EVALSHA` 必须至少带 1 个 key —— 零 key 返回
 *    `ERR wrong number of arguments for 'eval' command`；
 * 2. 一条命令里的多个 key（脚本 KEYS、DEL/MGET/BRPOPLPUSH/ZUNIONSTORE 等）必须路由到同一节点
 *    —— 否则返回 `ERR keys must route to same node`。MULTI 内的各条命令同样要求同一节点。
 *
 * 「同一节点」在这里按 Redis Cluster 的 CRC16 slot（含 `{hash tag}` 规则）判断，比真实
 * 代理更严（真实代理一个节点持有多个 slot），因此这里通过不代表真机通过；这里被拒一定
 * 说明 key 设计没有落在同一个 hash tag 上。**仅开发**：生产不部署。
 *
 * 两种用法：
 * - Compose `upredis-proxy` 服务：`node upredis-sim-proxy.mjs`，读下列环境变量；
 * - 测试：`import { startUpredisSimProxy } from '.../upredis-sim-proxy.mjs'`，端口传 0。
 *
 * 环境变量（CLI）：
 *   UPREDIS_SIM_LISTEN   监听端口，默认 6379
 *   UPREDIS_SIM_TARGET   后端 host:port，例如 redis:6379
 */

import { connect, createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

export const ERR_ROUTE = 'ERR keys must route to same node';
const MAX_FRAME_BYTES = 512 * 1024 * 1024;

/** CRC16-XMODEM，与 Redis Cluster keyHashSlot 一致。 */
export function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** key → slot；`{…}` 非空时只对 tag 内容取哈希。 */
export function keySlot(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
  const open = buf.indexOf(0x7b);
  if (open >= 0) {
    const close = buf.indexOf(0x7d, open + 1);
    if (close > open + 1) return crc16(buf.subarray(open + 1, close)) % 16384;
  }
  return crc16(buf) % 16384;
}

// 多 key 命令的 key 位置：[first, last, step]，last 为负数表示从末尾倒数（同 COMMAND 输出）。
const MULTI_KEY_SPECS = {
  del: [1, -1, 1], unlink: [1, -1, 1], exists: [1, -1, 1], touch: [1, -1, 1],
  mget: [1, -1, 1], watch: [1, -1, 1], pfcount: [1, -1, 1], pfmerge: [1, -1, 1],
  sdiff: [1, -1, 1], sinter: [1, -1, 1], sunion: [1, -1, 1],
  sdiffstore: [1, -1, 1], sinterstore: [1, -1, 1], sunionstore: [1, -1, 1],
  mset: [1, -1, 2], msetnx: [1, -1, 2],
  rename: [1, 2, 1], renamenx: [1, 2, 1], rpoplpush: [1, 2, 1], brpoplpush: [1, 2, 1], smove: [1, 2, 1],
  blpop: [1, -2, 1], brpop: [1, -2, 1], bzpopmin: [1, -2, 1], bzpopmax: [1, -2, 1],
  bitop: [2, -1, 1],
};

// 不带 key 的命令（连接/服务端级）：MULTI 内不参与同节点判断。
const KEYLESS = new Set([
  'auth', 'ping', 'echo', 'select', 'quit', 'info', 'client', 'config', 'script', 'command',
  'multi', 'exec', 'discard', 'unwatch', 'time', 'dbsize', 'role', 'readonly', 'readwrite',
  'wait', 'publish', 'subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe', 'monitor',
  'keys', 'scan', 'randomkey', 'flushdb', 'flushall', 'slowlog', 'latency', 'memory', 'debug',
  'lastsave', 'save', 'bgsave', 'bgrewriteaof', 'cluster', 'hello', 'swapdb', 'shutdown',
]);

function toInt(buf) {
  const n = Number(buf?.toString());
  return Number.isInteger(n) ? n : null;
}

/**
 * 命令里的 key。返回 `null` 表示参数形状不合法——交给后端 Redis 报原生错误。
 *
 * @param {Buffer[]} args
 */
export function commandKeys(args) {
  const name = args[0]?.toString().toLowerCase() ?? '';
  if (name === 'eval' || name === 'evalsha') {
    const numkeys = toInt(args[2]);
    if (numkeys === null || numkeys < 0 || 3 + numkeys > args.length) return null;
    return args.slice(3, 3 + numkeys);
  }
  if (name === 'zunionstore' || name === 'zinterstore') {
    const numkeys = toInt(args[2]);
    if (numkeys === null || numkeys < 1 || 3 + numkeys > args.length) return null;
    return [args[1], ...args.slice(3, 3 + numkeys)];
  }
  if (name === 'xread' || name === 'xreadgroup') {
    const at = args.findIndex((a, i) => i > 0 && a.toString().toLowerCase() === 'streams');
    const rest = at < 0 ? 0 : args.length - at - 1;
    if (at < 0 || rest === 0 || rest % 2 !== 0) return null;
    return args.slice(at + 1, at + 1 + rest / 2);
  }
  const spec = MULTI_KEY_SPECS[name];
  if (spec) {
    const [first, lastSpec, step] = spec;
    const last = lastSpec < 0 ? args.length + lastSpec : lastSpec;
    const keys = [];
    for (let i = first; i <= last && i < args.length; i += step) keys.push(args[i]);
    return keys;
  }
  if (KEYLESS.has(name) || args.length < 2) return [];
  return [args[1]];
}

/**
 * 按代理规则判一条命令；返回错误文本（不含 `-` 与 CRLF）或 `null` 放行。
 *
 * @param {Buffer[]} args
 * @param {{ slot: number | null } | null} txn MULTI 期间的同节点状态（会被更新）
 */
export function routeError(args, txn = null) {
  const name = args[0]?.toString().toLowerCase() ?? '';
  const keys = commandKeys(args);
  if ((name === 'eval' || name === 'evalsha') && keys !== null && keys.length === 0) {
    return `ERR wrong number of arguments for '${name}' command`;
  }
  if (keys === null || keys.length === 0) return null;
  const slots = new Set(keys.map(keySlot));
  if (slots.size > 1) return ERR_ROUTE;
  if (txn) {
    const [slot] = slots;
    if (txn.slot === null) txn.slot = slot;
    else if (txn.slot !== slot) return ERR_ROUTE;
  }
  return null;
}

/**
 * 从 buf[offset] 起解析一个完整 RESP 帧。不完整返回 `null`。
 * `args` 仅在顶层是 bulk-string 数组时给出（客户端命令）；内联命令给空数组。
 */
export function parseRespFrame(buf, offset = 0) {
  const lineEnd = (from) => {
    const at = buf.indexOf('\r\n', from);
    return at < 0 ? null : at;
  };
  const walk = (pos, collect) => {
    if (pos >= buf.length) return null;
    const tag = buf[pos];
    const eol = lineEnd(pos);
    if (eol === null) return null;
    if (tag === 0x2b || tag === 0x2d || tag === 0x3a) return { end: eol + 2 }; // + - :
    const len = Number(buf.subarray(pos + 1, eol).toString());
    if (!Number.isInteger(len) || len > MAX_FRAME_BYTES) throw new Error('invalid RESP length');
    if (tag === 0x24) { // $
      if (len < 0) return { end: eol + 2, value: null };
      if (eol + 2 + len + 2 > buf.length) return null;
      return { end: eol + 2 + len + 2, value: buf.subarray(eol + 2, eol + 2 + len) };
    }
    if (tag === 0x2a) { // *
      let at = eol + 2;
      const items = [];
      for (let i = 0; i < Math.max(len, 0); i += 1) {
        const child = walk(at, collect);
        if (child === null) return null;
        items.push(child.value);
        at = child.end;
      }
      return { end: at, value: collect ? items : undefined };
    }
    // 内联命令（redis-cli 健康检查等）：一整行，不做路由判断。
    return { end: eol + 2, inline: true };
  };
  const frame = walk(offset, true);
  if (frame === null) return null;
  const args = Array.isArray(frame.value) && frame.value.every(Buffer.isBuffer) ? frame.value : [];
  return { end: frame.end, args };
}

function handleConnection(client, target, log) {
  const upstream = connect(target);
  let fromClient = Buffer.alloc(0);
  let fromServer = Buffer.alloc(0);
  // 应答必须与请求同序：本地拒绝的命令也在队列里占位，等前面的后端应答回来再写。
  const pending = [];
  let txn = null;
  let passthrough = false;
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  const flushLocal = () => {
    while (pending.length > 0 && pending[0].local !== undefined) {
      client.write(pending.shift().local);
    }
  };

  client.on('data', (chunk) => {
    fromClient = Buffer.concat([fromClient, chunk]);
    try {
      for (;;) {
        const frame = parseRespFrame(fromClient);
        if (frame === null) break;
        const raw = fromClient.subarray(0, frame.end);
        fromClient = fromClient.subarray(frame.end);
        if (passthrough) {
          upstream.write(raw);
          continue;
        }
        const name = frame.args[0]?.toString().toLowerCase() ?? '';
        if (name === 'multi') txn = { slot: null, aborted: false };
        const error = frame.args.length > 0 && name !== 'multi'
          ? routeError(frame.args, txn && name !== 'exec' && name !== 'discard' ? txn : null)
          : null;
        if (error !== null) {
          if (txn) txn.aborted = true;
          log(`rejected ${name}: ${error}`);
          pending.push({ local: `-${error}\r\n` });
          flushLocal();
          continue;
        }
        if (name === 'exec' && txn?.aborted) {
          // 与 Redis 语义一致：事务里有命令被拒则 EXEC 整体放弃。
          upstream.write('*1\r\n$7\r\nDISCARD\r\n');
          pending.push({ replace: '-EXECABORT Transaction discarded because of previous errors.\r\n' });
          txn = null;
          continue;
        }
        if (name === 'exec' || name === 'discard') txn = null;
        upstream.write(raw);
        pending.push({});
        if (name === 'subscribe' || name === 'psubscribe' || name === 'monitor') passthrough = true;
      }
    } catch (err) {
      log(`protocol error: ${err instanceof Error ? err.message : String(err)}`);
      close();
    }
  });

  upstream.on('data', (chunk) => {
    fromServer = Buffer.concat([fromServer, chunk]);
    try {
      for (;;) {
        if (passthrough && pending.length === 0) {
          client.write(fromServer);
          fromServer = Buffer.alloc(0);
          break;
        }
        const frame = parseRespFrame(fromServer);
        if (frame === null) break;
        const raw = fromServer.subarray(0, frame.end);
        fromServer = fromServer.subarray(frame.end);
        const head = pending.shift();
        client.write(head?.replace ?? raw);
        flushLocal();
      }
    } catch (err) {
      log(`protocol error from backend: ${err instanceof Error ? err.message : String(err)}`);
      close();
    }
  });

  client.on('error', close);
  upstream.on('error', close);
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
}

/**
 * @param {{ port?: number, host?: string, target: { host: string, port: number }, log?: (m: string) => void }} opts
 */
export async function startUpredisSimProxy({ port = 0, host = '127.0.0.1', target, log = () => {} }) {
  const server = createServer((socket) => handleConnection(socket, target, log));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  if (String(process.env.DEPLOYMENT_ENV ?? '').trim().toLowerCase() === 'production') {
    process.stderr.write('UPRedis simulator refuses to run with DEPLOYMENT_ENV=production\n');
    process.exit(1);
  }
  const port = Number.parseInt(process.env.UPREDIS_SIM_LISTEN ?? '6379', 10);
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(String(process.env.UPREDIS_SIM_TARGET ?? ''));
  if (!Number.isInteger(port) || match === null) {
    throw new Error('UPREDIS_SIM_LISTEN must be a port and UPREDIS_SIM_TARGET must be host:port');
  }
  const proxy = await startUpredisSimProxy({
    port,
    host: '0.0.0.0',
    target: { host: match[1], port: Number.parseInt(match[2], 10) },
    log: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(`UPRedis simulator ${proxy.port} -> ${match[1]}:${match[2]} — development only\n`);
  const shutdown = () => void proxy.close().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`UPRedis simulator failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
