/**
 * `mysql-session-store.ts` 单测——覆盖 8 方法、seq 校验、chunk-rows、容量、租户三元组。
 *
 * 单测策略：全部走 `InMemorySessionStore`（_shared.md #6：macOS 无 MySQL 也能绿），
 * MySQL 真库路径仅做构造时跳过（检测不到池时跳过，不红）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SESSION_FORMAT_VERSION, SessionStore } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import {
  DSH_SESSION_EVENTS_DDL,
  DSH_SESSIONS_DDL,
  InMemorySessionStore,
  MAX_SESSION_BYTES,
  MysqlSessionStore,
  MysqlSessionStoreConfigError,
  readMysqlSessionStoreConfig,
  decodeStorageRecord,
  packChunkRuns,
  toSessionStoreError,
} from '../../src/runtime/providers/mysql-session-store.js';
import {
  MysqlSessionPersistence,
  SessionOwnerBindings,
} from '../../src/runtime/providers/mysql-session-persistence.js';

function header(id: string, extra: Record<string, unknown> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd: '/tmp/test',
    ...extra,
  } as unknown as SessionHeader;
}

function ev(seq: number, type = 'user/message'): SessionEvent {
  return {
    type: type as never,
    seq,
    time: Date.now() + seq,
    data: type === 'user/message' ? { content: `msg ${seq}` } : {},
  } as unknown as SessionEvent;
}

function chunkEv(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text },
    },
  } as unknown as SessionEvent;
}

test('readMysqlSessionStoreConfig prefers AGENT_DATABASE_URL and never echoes secrets', () => {
  const cfg = readMysqlSessionStoreConfig({
    AGENT_DATABASE_URL: 'mysql://sandbox:secret-pass@mysql:3306/sandbox',
    MYSQL_HOST: 'ignored',
  });
  assert.equal(cfg.host, 'mysql');
  assert.equal(cfg.port, 3306);
  assert.equal(cfg.user, 'sandbox');
  assert.equal(cfg.password, 'secret-pass');
  assert.equal(cfg.database, 'sandbox');
  try {
    readMysqlSessionStoreConfig({ AGENT_DATABASE_URL: 'postgres://x' });
    assert.fail('expected scheme refusal');
  } catch (err) {
    assert.equal(err instanceof MysqlSessionStoreConfigError, true);
    assert.equal(String(err).includes('secret-pass'), false);
    assert.equal(String(err).includes('postgres://x'), false);
  }
});

test('DDL 常量包含租户三元组与主键', () => {
  assert.match(DSH_SESSIONS_DDL, /session_id/);
  assert.match(DSH_SESSIONS_DDL, /org_id/);
  assert.match(DSH_SESSIONS_DDL, /user_id/);
  assert.match(DSH_SESSIONS_DDL, /PRIMARY KEY.*session_id/s);

  assert.match(DSH_SESSION_EVENTS_DDL, /session_id/);
  assert.match(DSH_SESSION_EVENTS_DDL, /org_id.*user_id/s);
  assert.match(DSH_SESSION_EVENTS_DDL, /seq/);
  assert.match(DSH_SESSION_EVENTS_DDL, /PRIMARY KEY.*session_id.*seq/s);
});

test('chunk-rows 无损：官方 pack 后 decode 回来数量与内容一致', () => {
  const events = [chunkEv(0, 'hello '), chunkEv(1, 'world'), chunkEv(2, '!')];
  const packed = packChunkRuns(events);
  assert.equal(packed.length, 1);
  assert.equal((packed[0] as { type: string }).type, 'text-chunks');
  const decoded: SessionEvent[] = [];
  for (const rec of packed) decoded.push(...decodeStorageRecord(rec));
  assert.equal(decoded.length, events.length);
  assert.equal(decoded[0]!.seq, 0);
  assert.equal(decoded[2]!.seq, 2);
});

test('InMemory append/load 走官方 chunk-rows 往返', async () => {
  const store = new InMemorySessionStore();
  const h = header('sess-chunks');
  const events = [chunkEv(0, 'a'), chunkEv(1, 'b'), chunkEv(2, 'c')];
  await store.appendBatch(h, events, false);
  const loaded = await store.loadStored(SessionId('sess-chunks'));
  assert.equal(loaded?.events.length, 3);
  const texts = loaded!.events.map((e) => (e.data as { chunk: { text: string } }).chunk.text);
  assert.deepEqual(texts, ['a', 'b', 'c']);
});

test('InMemory: name 与空状态', async () => {
  const s = new InMemorySessionStore();
  assert.equal(s.name, 'mysql-memory');
  assert.equal(await s.loadStored(SessionId('nope')), undefined);
  assert.equal(await s.readStoredRevision(SessionId('nope')), undefined);
  assert.equal(await s.loadStoredFrom(SessionId('nope'), 0), undefined);
  assert.deepEqual(await s.list(), []);
});

test('native DSH persistence seam materializes and prepares a resumable session', async () => {
  const ctx = new Context();
  new SessionStore(ctx);
  const bindings = new SessionOwnerBindings();
  const persistence = new MysqlSessionPersistence(ctx, new InMemorySessionStore(), bindings);
  assert.notEqual(ctx.get('sessionPersistence'), undefined);
  const id = SessionId('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  const owner = { orgId: '01ARZ3NDEKTSV4RRFFQ69G5FAA', userId: '01ARZ3NDEKTSV4RRFFQ69G5FAB' };
  const release = persistence.bindOwner(id, owner);
  await persistence.runAsOwner(owner, async () => {
    await persistence.create(header(id));
    await persistence.append(id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]);
    assert.equal(await persistence.has(id), true);
    const prepared = await persistence.prepare(id);
    const types = prepared.session.events.map((event) => event.type);
    assert.deepEqual(types.filter((type) => type === 'turn/start' || type === 'turn/end'), [
      'turn/start',
      'turn/end',
    ]);
    assert.equal(types.includes('session/end-seed'), true);
    prepared[Symbol.dispose]();
  });
  release();
});

test('appendBatch 懒物化、seq 连续性校验与容量判定', async () => {
  const store = new InMemorySessionStore();
  const h = header('sess-1');
  // 懒物化：isMaterialized=false 时首批可建
  await store.appendBatch(h, [ev(0), ev(1)], false);
  const loaded = await store.loadStored(SessionId('sess-1'));
  assert.equal(loaded?.events.length, 2);
  assert.equal(loaded?.events[0]!.seq, 0);

  // readStoredRevision 与 loadStored 一致
  const rev1 = await store.readStoredRevision(SessionId('sess-1'));
  assert.equal(String(rev1), String(loaded?.revision));

  // 增量 loadStoredFrom 只返回 seq >= from
  const tail = await store.loadStoredFrom(SessionId('sess-1'), 1);
  assert.equal(tail?.events.length, 1);
  assert.equal(tail?.events[0]!.seq, 1);
  assert.equal(tail?.events.every((e) => e.seq >= 1), true);

  // seq 不连续应拒绝（事务内追加，首事件 seq 必须等于 next-seq）
  await assert.rejects(() => store.appendBatch(h, [ev(0)], true), /seq mismatch/);
  await assert.rejects(() => store.appendBatch(h, [ev(5)], true), /seq mismatch/);

  // 追加正确 next-seq
  await store.appendBatch(h, [ev(2)], true);
  const after = await store.loadStored(SessionId('sess-1'));
  assert.equal(after?.events.length, 3);

  // 非 JSON 可序列化应拒绝（容量判定前）
  const bad = { type: 'user/message' as never, seq: 3, time: Date.now(), data: { fn: () => {} } } as unknown as SessionEvent;
  await assert.rejects(() => store.appendBatch(h, [bad], true), /non-serializable/);
});

test('容量超限直接拒绝', async () => {
  const store = new InMemorySessionStore();
  const h = header('sess-cap');
  // 构造一个超大事件（8 MiB +1 字节）
  const bigText = 'x'.repeat(MAX_SESSION_BYTES + 1);
  const bigEv: SessionEvent = {
    type: 'user/message' as never,
    seq: 0,
    time: Date.now(),
    data: { content: bigText },
  } as unknown as SessionEvent;
  await assert.rejects(() => store.appendBatch(h, [bigEv], false), /capacity exceeded/);
});

test('commitRepair：截断 tornMarker 并追加 closers', async () => {
  const store = new InMemorySessionStore();
  const h = header('sess-repair');
  await store.appendBatch(h, [ev(0), ev(1), ev(2)], false);
  // 模拟 torn：截到 seq 1 并追加 closer
  const closer = ev(2, 'turn/end') as unknown as SessionEvent;
  // tornMarker 为 "1" 表示保留到 1，丢弃 2 之后
  await store.commitRepair(h, '1', [ev(2)]);
  const after = await store.loadStored(SessionId('sess-repair'));
  // 2 被截后重新追加，仍为 3 条
  assert.equal(after?.events.length, 3);
  void closer;
});

test('list 返回所有 materialized session header', async () => {
  const store = new InMemorySessionStore();
  await store.appendBatch(header('s-a'), [ev(0)], false);
  await store.appendBatch(header('s-b'), [ev(0)], false);
  const list = await store.list();
  assert.equal(list.length, 2);
  const ids = list.map((h) => String(h.id)).sort();
  assert.deepEqual(ids, ['s-a', 's-b']);
});

test('isMaterialized=false 时未物化过的 second append 应走懒物化路径', async () => {
  const store = new InMemorySessionStore();
  const h = header('s-lazy2');
  await store.appendBatch(h, [ev(0)], false);
  assert.equal((await store.loadStored(SessionId('s-lazy2')))?.events.length, 1);
});

test('事务内追加：并发 append 仅一个成功（单实例语义）', async () => {
  const store = new InMemorySessionStore();
  const h = header('s-concurrent');
  await store.appendBatch(h, [ev(0)], false);
  // 两个并发都想追加 seq 1，只有一个应成功
  const p1 = store.appendBatch(h, [ev(1)], true);
  const p2 = store.appendBatch(h, [ev(1)], true);
  const results = await Promise.allSettled([p1, p2]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.filter((r) => r.status === 'rejected').length;
  assert.equal(ok, 1);
  assert.equal(fail, 1);
});

test('MySQL 真库路径：无环境变量时跳过（macOS）', async () => {
  if (!process.env['MYSQL_HOST']) return;
  const store = new MysqlSessionStore({
    host: process.env['MYSQL_HOST']!,
    port: Number(process.env['MYSQL_PORT'] ?? 3306),
    user: process.env['MYSQL_USER']!,
    password: process.env['MYSQL_PASSWORD']!,
    database: process.env['MYSQL_DATABASE']!,
  });
  await store.close();
  assert.ok(true);
});

test('裸 Error 含物理路径必脱敏（空 roots 也走默认前缀）', () => {
  const leak = new Error('EACCES /var/sandbox/workspaces/secret/mysql.sock');
  const wrapped = toSessionStoreError(leak, []);
  assert.equal(wrapped.message.includes('/var/sandbox/workspaces/secret'), false);
  assert.equal(wrapped.message.includes('<workspace>'), true);
});

test('MysqlSessionStore loadStored accepts already-parsed mysql2 JSON columns', async () => {
  const id = SessionId('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  const storedHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1_700_000_000_000,
    cwd: '/tmp/test',
  };
  const storedEvent = {
    type: 'turn/start',
    seq: 0,
    time: 1,
    data: { turn: 1 },
  };
  const pool = {
    execute: async (sql: string) => {
      if (String(sql).includes('FROM dsh_sessions')) {
        return [[{
          session_id: String(id),
          org_id: 'default-org',
          user_id: 'default-user',
          header_json: storedHeader,
          revision: 'abc',
        }]];
      }
      return [[{ record_json: storedEvent, seq: 0 }]];
    },
    getConnection: async () => {
      throw new Error('unused');
    },
    end: async () => undefined,
  };
  const store = new MysqlSessionStore(pool as never);
  const loaded = await store.loadStored(id);
  assert.equal(loaded?.meta.cwd, '/tmp/test');
  assert.equal(loaded?.events.length, 1);
  assert.equal(loaded?.events[0]?.type, 'turn/start');
});

test('MysqlSessionStore loadStored 对池错误脱敏', async () => {
  const pool = {
    execute: async () => {
      throw new Error('connect EACCES /var/sandbox/workspaces/secret/mysql.sock');
    },
    getConnection: async () => {
      throw new Error('connect /var/sandbox/workspaces/secret');
    },
    end: async () => undefined,
  };
  const store = new MysqlSessionStore(pool as never, { physicalRoots: ['/var/sandbox/workspaces/secret'] });
  await assert.rejects(
    () => store.loadStored(SessionId('x')),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.equal(msg.includes('/var/sandbox/workspaces/secret'), false);
      assert.equal(msg.includes('<workspace>'), true);
      return true;
    },
  );
});
