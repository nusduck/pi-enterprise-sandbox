/**
 * Gated live integration: Outbox claim + publish against real MySQL/Redis.
 *
 * Requires:
 *   TEST_MYSQL_URL=mysql://…  (knex + mysql2 already in agent deps)
 *   TEST_REDIS_URL=redis://…  (optional redis package; falls back to mini RESP)
 *
 * Skips cleanly when URLs or deps are missing. No downloads.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const TEST_MYSQL_URL = (process.env.TEST_MYSQL_URL || '').trim();
const TEST_REDIS_URL = (process.env.TEST_REDIS_URL || '').trim();
const require = createRequire(import.meta.url);

function mysqlDepsAvailable() {
  try {
    require.resolve('knex');
    require.resolve('mysql2');
    return true;
  } catch {
    return false;
  }
}

const hasMysqlDeps = mysqlDepsAvailable();
const runLive =
  Boolean(TEST_MYSQL_URL) &&
  Boolean(TEST_REDIS_URL) &&
  hasMysqlDeps &&
  (TEST_MYSQL_URL.startsWith('mysql://') ||
    TEST_MYSQL_URL.startsWith('mysql2://'));

const describeLive = runLive ? describe : describe.skip;

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const TRACE = 'd'.repeat(32);

/**
 * Minimal Redis RESP client for XADD / XRANGE / DEL (no npm redis required).
 */
function createMiniRedis(url) {
  const u = new URL(url);
  const host = u.hostname || '127.0.0.1';
  const port = Number(u.port || 6379);
  const password = u.password ? decodeURIComponent(u.password) : null;

  /**
   * @param {string[]} parts
   */
  function encode(parts) {
    let out = `*${parts.length}\r\n`;
    for (const p of parts) {
      const b = Buffer.from(String(p), 'utf8');
      out += `$${b.length}\r\n${b.toString('utf8')}\r\n`;
    }
    return out;
  }

  /**
   * @param {Buffer} buf
   * @returns {{ value: unknown, rest: Buffer }}
   */
  function decodeOne(buf) {
    const s = buf.toString('utf8');
    const nl = s.indexOf('\r\n');
    if (nl < 0) throw new Error('incomplete redis response');
    const type = s[0];
    if (type === '+') {
      return { value: s.slice(1, nl), rest: buf.slice(nl + 2) };
    }
    if (type === '-') {
      throw new Error(s.slice(1, nl));
    }
    if (type === ':') {
      return { value: Number(s.slice(1, nl)), rest: buf.slice(nl + 2) };
    }
    if (type === '$') {
      const len = Number(s.slice(1, nl));
      if (len === -1) return { value: null, rest: buf.slice(nl + 2) };
      const start = nl + 2;
      const end = start + len;
      const val = buf.slice(start, end).toString('utf8');
      return { value: val, rest: buf.slice(end + 2) };
    }
    if (type === '*') {
      const count = Number(s.slice(1, nl));
      let rest = buf.slice(nl + 2);
      if (count === -1) return { value: null, rest };
      const arr = [];
      for (let i = 0; i < count; i += 1) {
        const dec = decodeOne(rest);
        arr.push(dec.value);
        rest = dec.rest;
      }
      return { value: arr, rest };
    }
    throw new Error(`unsupported redis type ${type}`);
  }

  /**
   * @param {string[]} cmd
   */
  async function command(cmd) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        const writeAll = async () => {
          if (password) {
            socket.write(encode(['AUTH', password]));
          }
          socket.write(encode(cmd));
        };
        writeAll().catch(reject);
      });
      /** @type {Buffer[]} */
      const chunks = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('error', reject);
      socket.on('end', () => {
        try {
          let buf = Buffer.concat(chunks);
          // AUTH reply if any
          if (password) {
            const auth = decodeOne(buf);
            buf = auth.rest;
          }
          const { value } = decodeOne(buf);
          resolve(value);
        } catch (err) {
          reject(err);
        }
      });
      // half-close after write so server ends
      socket.on('connect', () => {
        // allow data handler to attach first
        setImmediate(() => {
          // already writing on connect
        });
      });
      // Ensure we finish after response: use timeout if server keeps alive
      socket.setTimeout(3000, () => {
        socket.end();
      });
    });
  }

  // Better request/response with lingering connection for suite
  /** @type {net.Socket | null} */
  let sock = null;
  /** @type {Buffer} */
  let buf = Buffer.alloc(0);
  /** @type {Array<(v: unknown) => void>} */
  const waiters = [];

  async function ensureConnected() {
    if (sock && !sock.destroyed) return;
    await new Promise((resolve, reject) => {
      sock = net.createConnection({ host, port }, resolve);
      sock.on('error', reject);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (waiters.length > 0) {
          try {
            const dec = decodeOne(buf);
            buf = dec.rest;
            const w = waiters.shift();
            w(dec.value);
          } catch {
            break;
          }
        }
      });
    });
    if (password) {
      await send(['AUTH', password]);
    }
  }

  /**
   * @param {string[]} cmd
   */
  async function send(cmd) {
    await ensureConnected();
    return new Promise((resolve, reject) => {
      waiters.push(resolve);
      sock.write(encode(cmd), (err) => {
        if (err) reject(err);
      });
    });
  }

  return {
    async xadd(key, fields) {
      const args = ['XADD', key, '*'];
      for (const [k, v] of Object.entries(fields)) {
        args.push(k, String(v));
      }
      return send(args);
    },
    async xrange(key, start = '-', end = '+', count = 10) {
      return send(['XRANGE', key, start, end, 'COUNT', String(count)]);
    },
    async del(key) {
      return send(['DEL', key]);
    },
    async quit() {
      if (sock && !sock.destroyed) {
        try {
          await send(['QUIT']);
        } catch {
          // ignore
        }
        sock.destroy();
      }
      sock = null;
    },
  };
}

describe('outbox integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / TEST_REDIS_URL / deps missing', () => {
    if (!TEST_MYSQL_URL) {
      assert.ok(true, 'skipped: TEST_MYSQL_URL unset');
      return;
    }
    if (!TEST_REDIS_URL) {
      assert.ok(true, 'skipped: TEST_REDIS_URL unset');
      return;
    }
    if (!hasMysqlDeps) {
      assert.ok(true, 'skipped: knex/mysql2 not installed');
      return;
    }
    assert.ok(runLive, 'live gate should be open when URLs and deps present');
  });
});

describeLive('outbox integration (TEST_MYSQL_URL + TEST_REDIS_URL)', () => {
  /** @type {import('knex').Knex} */
  let knex;
  /** @type {import('../../src/infrastructure/outbox/index.js')} */
  let outboxMod;
  /** @type {ReturnType<typeof createMiniRedis>} */
  let redis;
  /** @type {string} */
  let streamKey;

  before(async () => {
    const mysql = await import('../../src/infrastructure/mysql/index.js');
    outboxMod = await import('../../src/infrastructure/outbox/index.js');
    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 5 } });
    await mysql.migrateLatest(knex);
    redis = createMiniRedis(TEST_REDIS_URL);
    streamKey = `run:stream:test-${randomBytes(4).toString('hex')}`;
  });

  after(async () => {
    if (redis) {
      try {
        await redis.del(streamKey);
        await redis.quit();
      } catch {
        // ignore cleanup errors
      }
    }
    if (knex) {
      try {
        await knex('domain_outbox').del();
      } catch {
        // ignore
      }
      await knex.destroy();
    }
  });

  it('claimBatch uses live SKIP LOCKED and publisher appends stable event to Redis', async () => {
    const { OutboxRepository, OutboxPublisher, OUTBOX_STATUS } = outboxMod;
    const outboxId = `01TEST${randomBytes(10).toString('hex')}`.slice(0, 26).toUpperCase();
    const eventId = `01EVT${randomBytes(10).toString('hex')}`.slice(0, 26).toUpperCase();
    // Ensure ULID-like length
    const pad26 = (s) => (s + 'ABCDEFGHJKMNPQRSTVWXYZ012345').slice(0, 26);

    const obId = pad26(outboxId);
    const evId = pad26(eventId);
    const runId = RUN;

    const repo = new OutboxRepository(knex, { maxAttempts: 5 });
    await knex('domain_outbox').where({ outbox_id: obId }).del().catch(() => {});
    await repo.insert({
      outboxId: obId,
      aggregateType: 'run',
      aggregateId: runId,
      eventType: 'run.started',
      payloadJson: { eventId: evId, sequence: 1, runId },
    });

    const stream = {
      async append(rid, fields) {
        assert.equal(rid, runId);
        const key = `run:stream:${rid}`;
        streamKey = key;
        return redis.xadd(key, fields);
      },
    };

    const publisher = new OutboxPublisher({ repository: repo, stream });
    const result = await publisher.publishOnce();
    assert.equal(result.claimed, 1);
    assert.equal(result.published, 1);

    const row = await repo.getById(obId);
    assert.equal(row.status, OUTBOX_STATUS.PUBLISHED);

    const entries = await redis.xrange(`run:stream:${runId}`, '-', '+', 5);
    assert.ok(Array.isArray(entries));
    assert.ok(entries.length >= 1);
    // entry: [id, [field, val, ...]]
    const last = entries[entries.length - 1];
    const fieldArr = last[1];
    /** @type {Record<string, string>} */
    const fields = {};
    for (let i = 0; i < fieldArr.length; i += 2) {
      fields[fieldArr[i]] = fieldArr[i + 1];
    }
    assert.equal(fields.eventId, evId);
    assert.equal(fields.type, 'run.started');
    assert.equal(fields.sequence, '1');

    // Cleanup stream for this run (best effort)
    await redis.del(`run:stream:${runId}`);
    void ORG;
    void USER;
    void TRACE;
  });

  it('token guard rejects wrong claim token on live MySQL', async () => {
    const { OutboxRepository, OUTBOX_STATUS } = outboxMod;
    const pad26 = (s) => (s + 'ABCDEFGHJKMNPQRSTVWXYZ012345').slice(0, 26);
    const obId = pad26(`01TG${randomBytes(8).toString('hex')}`);
    const repo = new OutboxRepository(knex);
    await repo.insert({
      outboxId: obId,
      aggregateType: 'run',
      aggregateId: RUN,
      eventType: 'run.queued',
      payloadJson: { eventId: obId, sequence: 2, runId: RUN },
    });
    const claimed = await repo.claimBatch({ limit: 10 });
    const mine = claimed.find((c) => c.outboxId === obId);
    assert.ok(mine);
    const rejected = await repo.markPublished(obId, 'WRONGTOKENWRONGTOKENWRONG');
    assert.equal(rejected, false);
    const ok = await repo.markPublished(obId, mine.claimToken);
    assert.equal(ok, true);
    const row = await repo.getById(obId);
    assert.equal(row.status, OUTBOX_STATUS.PUBLISHED);
  });
});
