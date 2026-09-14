/**
 * UPRedis Proxy 模拟器自身的测试：slot 计算与 Redis Cluster 一致、两条真机路由限制、
 * 应答保序（本地拒绝夹在后端应答之间）、MULTI 同节点、生产拒绝运行。
 *
 * 后端用一个极简 RESP 回显服务器，不需要真 Redis；真 Redis 5.0.14 上的队列放行测试见
 * `tests/redis/upredis-queue.integration.test.js`。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  commandKeys,
  ERR_ROUTE,
  keySlot,
  parseRespFrame,
  routeError,
  startUpredisSimProxy,
} from '../../../scripts/dev/upredis-sim-proxy.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/dev/upredis-sim-proxy.mjs', import.meta.url));
const b = (...xs) => xs.map((x) => Buffer.from(String(x)));
const encode = (...xs) => `*${xs.length}\r\n${xs.map((x) => `$${Buffer.byteLength(String(x))}\r\n${x}\r\n`).join('')}`;

/** 每收到一条命令回 `:<序号>`，EXEC/DISCARD 回 `+<名字>`，用来检查保序。 */
async function startEchoBackend() {
  const seen = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = parseRespFrame(buf);
        if (frame === null) break;
        buf = buf.subarray(frame.end);
        const name = frame.args[0].toString().toUpperCase();
        seen.push(name);
        socket.write(name === 'EXEC' || name === 'DISCARD' ? `+${name}\r\n` : `:${seen.length}\r\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

async function roundTrip(port, payload, replies) {
  const socket = createConnection({ port, host: '127.0.0.1' });
  let out = '';
  return new Promise((resolve, reject) => {
    socket.on('data', (chunk) => {
      out += chunk.toString();
      if (out.split('\r\n').length - 1 >= replies) {
        socket.destroy();
        resolve(out.split('\r\n').slice(0, replies));
      }
    });
    socket.on('error', reject);
    socket.write(payload);
  });
}

describe('UPRedis simulator', () => {
  it('computes Redis Cluster slots including hash tags', () => {
    // 已知值：CLUSTER KEYSLOT foo = 12182，bar = 5061。
    assert.equal(keySlot('foo'), 12182);
    assert.equal(keySlot('bar'), 5061);
    assert.equal(keySlot('{bull}:agent-runs:wait'), keySlot('{bull}:agent-runs:1'));
    assert.equal(keySlot('x{}y'), keySlot('x{}y'));
    assert.notEqual(keySlot('bull:agent-runs:wait'), keySlot('bull:agent-runs:active'));
  });

  it('extracts keys for scripts, multi-key and movable-key commands', () => {
    assert.deepEqual(commandKeys(b('EVAL', 'return 1', 2, 'k1', 'k2', 'arg')).map(String), ['k1', 'k2']);
    assert.deepEqual(commandKeys(b('BRPOPLPUSH', 'a', 'b', 0)).map(String), ['a', 'b']);
    assert.deepEqual(commandKeys(b('BZPOPMIN', 'a', 'b', 5)).map(String), ['a', 'b']);
    assert.deepEqual(commandKeys(b('MSET', 'a', 1, 'b', 2)).map(String), ['a', 'b']);
    assert.deepEqual(commandKeys(b('ZUNIONSTORE', 'd', 2, 'a', 'b', 'WEIGHTS', 1, 2)).map(String), ['d', 'a', 'b']);
    assert.deepEqual(commandKeys(b('XREAD', 'COUNT', 1, 'STREAMS', 's1', 's2', '0', '0')).map(String), ['s1', 's2']);
    assert.deepEqual(commandKeys(b('HGETALL', 'h')).map(String), ['h']);
    assert.deepEqual(commandKeys(b('PING')), []);
    assert.equal(commandKeys(b('EVAL', 'return 1', 'x')), null);
  });

  it('applies the two probed routing rules with allow controls', () => {
    assert.equal(routeError(b('EVAL', 'return 1', 0)), "ERR wrong number of arguments for 'eval' command");
    assert.equal(routeError(b('EVALSHA', 'abc', 0)), "ERR wrong number of arguments for 'evalsha' command");
    assert.equal(routeError(b('EVAL', 'return 1', 1, 'lock')), null);
    const untagged = ['bull:q:wait', 'bull:q:active', 'bull:q:meta'];
    assert.equal(routeError(b('EVAL', 's', 3, ...untagged)), ERR_ROUTE);
    assert.equal(routeError(b('EVAL', 's', 3, ...untagged.map((k) => k.replace('bull', '{bull}')))), null);
    assert.equal(routeError(b('DEL', 'foo', 'bar')), ERR_ROUTE);
    assert.equal(routeError(b('DEL', '{t}foo', '{t}bar')), null);
    const txn = { slot: null };
    assert.equal(routeError(b('SET', '{a}1', 'v'), txn), null);
    assert.equal(routeError(b('SET', '{b}1', 'v'), txn), ERR_ROUTE);
  });

  it('keeps reply order when a rejected command sits between forwarded ones', async () => {
    const backend = await startEchoBackend();
    const proxy = await startUpredisSimProxy({ target: { host: '127.0.0.1', port: backend.port } });
    try {
      const replies = await roundTrip(
        proxy.port,
        encode('GET', 'a') + encode('EVAL', 'return 1', 0) + encode('DEL', 'foo', 'bar') + encode('GET', 'b'),
        4,
      );
      assert.deepEqual(replies, [
        ':1',
        "-ERR wrong number of arguments for 'eval' command",
        `-${ERR_ROUTE}`,
        ':2',
      ]);
      assert.deepEqual(backend.seen, ['GET', 'GET'], 'rejected commands never reach the backend');
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it('aborts a MULTI whose commands span nodes, and lets a same-node MULTI through', async () => {
    const backend = await startEchoBackend();
    const proxy = await startUpredisSimProxy({ target: { host: '127.0.0.1', port: backend.port } });
    try {
      const bad = await roundTrip(
        proxy.port,
        encode('MULTI') + encode('SET', '{a}k', 1) + encode('SET', '{b}k', 1) + encode('EXEC'),
        4,
      );
      assert.deepEqual(bad, [':1', ':2', `-${ERR_ROUTE}`, '-EXECABORT Transaction discarded because of previous errors.']);
      assert.deepEqual(backend.seen, ['MULTI', 'SET', 'DISCARD']);
      const good = await roundTrip(
        proxy.port,
        encode('MULTI') + encode('SET', '{a}k', 1) + encode('SET', '{a}j', 1) + encode('EXEC'),
        4,
      );
      assert.deepEqual(good, [':4', ':5', ':6', '+EXEC']);
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it('refuses to run with DEPLOYMENT_ENV=production', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, DEPLOYMENT_ENV: 'production', UPREDIS_SIM_TARGET: '127.0.0.1:1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refuses to run/);
  });
});
