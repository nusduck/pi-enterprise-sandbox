/**
 * `endpoint-failover.ts` 的测试：粘主/拉黑/不回切的选择规则，以及
 * acquire 循环在网络故障、致命错误、预算耗尽三种情况下的行为。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireWithFailover,
  EndpointConfigError,
  EndpointSelector,
  errorCode,
  FailoverError,
  isNetworkError,
  parseEndpointList,
  type ConnectFailureKind,
} from '../src/endpoint-failover.js';

const A = { host: 'proxy-a.internal', port: 3306 };
const B = { host: 'proxy-b.internal', port: 3307 };

function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

const classify = (err: unknown): ConnectFailureKind => (isNetworkError(err) ? 'network' : 'fatal');

describe('parseEndpointList', () => {
  it('parses hostnames, IPv4 and bracketed IPv6', () => {
    assert.deepEqual(parseEndpointList(' db-a:3306 , 10.0.0.2:3307 ', { name: 'X', count: 2 }), [
      { host: 'db-a', port: 3306 },
      { host: '10.0.0.2', port: 3307 },
    ]);
    assert.deepEqual(parseEndpointList('[::1]:7000', { name: 'X', count: 1 }), [{ host: '::1', port: 7000 }]);
  });

  it('rejects a wrong entry count, bad ports and empty input', () => {
    assert.throws(() => parseEndpointList('a:1', { name: 'UPDRDB_ENDPOINTS', count: 2 }), /exactly 2/);
    assert.throws(() => parseEndpointList('a:0,b:1', { name: 'X', count: 2 }), EndpointConfigError);
    assert.throws(() => parseEndpointList('a:65536,b:1', { name: 'X', count: 2 }), EndpointConfigError);
    assert.throws(() => parseEndpointList('a,b:1', { name: 'X', count: 2 }), EndpointConfigError);
    assert.throws(() => parseEndpointList('   ', { name: 'X', count: 2 }), /X is required/);
    assert.throws(() => parseEndpointList(undefined, { name: 'X', count: 2 }), /X is required/);
  });

  it('never echoes the raw value (it may carry credentials)', () => {
    try {
      parseEndpointList('user:hunter2@db-a:3306,db-b:3306', { name: 'UPDRDB_ENDPOINTS', count: 2 });
      assert.fail('expected rejection');
    } catch (err) {
      assert.ok(err instanceof EndpointConfigError);
      assert.match(err.message, /entry #1/);
      assert.doesNotMatch(err.message, /hunter2|user/);
    }
  });
});

describe('EndpointSelector', () => {
  it('starts on the first endpoint and keeps configured order behind it', () => {
    const s = new EndpointSelector([A, B]);
    assert.deepEqual(s.plan(), { order: [0, 1], probe: false });
  });

  it('skips a blacklisted endpoint until it expires', () => {
    let now = 1_000;
    const s = new EndpointSelector([A, B], { blacklistMs: 180_000, now: () => now });
    s.reportFailure(0);
    assert.deepEqual(s.plan(), { order: [1], probe: false });
    now += 179_999;
    assert.deepEqual(s.plan().order, [1]);
    now += 1;
    assert.deepEqual(s.plan().order, [0, 1]);
  });

  it('sticks to the endpoint that last succeeded and does not fail back on expiry', () => {
    let now = 0;
    const s = new EndpointSelector([A, B], { now: () => now });
    s.reportFailure(0);
    s.reportSuccess(1);
    assert.equal(s.primaryIndex, 1);
    now += 10 * 60_000;
    assert.deepEqual(s.plan(), { order: [1, 0], probe: false });
  });

  it('offers exactly one probe round when every endpoint is blacklisted', () => {
    const s = new EndpointSelector([A, B], { now: () => 0 });
    s.reportFailure(0);
    s.reportFailure(1);
    assert.deepEqual(s.plan(), { order: [0, 1], probe: true });
  });

  it('refuses an empty endpoint list', () => {
    assert.throws(() => new EndpointSelector([]), EndpointConfigError);
  });
});

describe('acquireWithFailover', () => {
  it('fails over on a network error and then sticks to the survivor', async () => {
    const s = new EndpointSelector([A, B], { now: () => 0 });
    const seen: string[] = [];
    const value = await acquireWithFailover(
      s,
      async ({ endpoint, label }) => {
        seen.push(label);
        if (endpoint === s.endpoint(0)) throw codeError('ECONNREFUSED');
        return `conn@${endpoint.host}`;
      },
      { role: 'agent-knex', budgetMs: 1_000, classify },
    );
    assert.equal(value, 'conn@proxy-b.internal');
    assert.deepEqual(seen, ['#1', '#2']);
    assert.equal(s.isBlacklisted(0), true);
    assert.deepEqual(s.plan().order, [1]);
  });

  it('throws a fatal error immediately without blacklisting or trying the next endpoint', async () => {
    const s = new EndpointSelector([A, B], { now: () => 0 });
    const auth = codeError('ER_ACCESS_DENIED_ERROR', 'Access denied');
    let calls = 0;
    await assert.rejects(
      acquireWithFailover(
        s,
        async () => {
          calls += 1;
          throw auth;
        },
        { role: 'agent-knex', budgetMs: 1_000, classify },
      ),
      (err) => err === auth,
    );
    assert.equal(calls, 1);
    assert.equal(s.isBlacklisted(0), false);
  });

  it('reports every attempt by label and code when all endpoints fail', async () => {
    const s = new EndpointSelector([A, B], { now: () => 0 });
    await assert.rejects(
      acquireWithFailover(
        s,
        async ({ index }) => {
          throw codeError(index === 0 ? 'ECONNREFUSED' : 'ETIMEDOUT', `connect to ${A.host} failed`);
        },
        { role: 'exec-pool', budgetMs: 1_000, classify },
      ),
      (err) => {
        assert.ok(err instanceof FailoverError);
        assert.equal(err.code, 'ALL_ENDPOINTS_FAILED');
        assert.deepEqual(err.attempts, [
          { label: '#1', code: 'ECONNREFUSED' },
          { label: '#2', code: 'ETIMEDOUT' },
        ]);
        assert.doesNotMatch(err.message, /proxy-a|failed to/);
        return true;
      },
    );
  });

  it('a second acquire while all endpoints are blacklisted runs one probe round only', async () => {
    const s = new EndpointSelector([A, B], { now: () => 0 });
    const fail = async (): Promise<never> => {
      throw codeError('ECONNREFUSED');
    };
    await assert.rejects(acquireWithFailover(s, fail, { role: 'r', budgetMs: 1_000, classify }), FailoverError);
    let calls = 0;
    await assert.rejects(
      acquireWithFailover(
        s,
        async () => {
          calls += 1;
          throw codeError('ECONNREFUSED');
        },
        { role: 'r', budgetMs: 1_000, classify },
      ),
      FailoverError,
    );
    assert.equal(calls, 2);
  });

  it('bounds a hanging handshake by the total budget, aborts it and disposes a late connection', async () => {
    const s = new EndpointSelector([A, B], { now: () => 0 });
    let aborted = false;
    let resolveLate: (v: string) => void = () => undefined;
    const disposed: string[] = [];
    const started = Date.now();
    await assert.rejects(
      acquireWithFailover(
        s,
        ({ signal }) =>
          new Promise<string>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
            resolveLate = resolve;
          }),
        { role: 'agent-dsh-pool', budgetMs: 60, classify, dispose: (v) => disposed.push(v) },
      ),
      (err) => err instanceof FailoverError && err.code === 'BUDGET_EXHAUSTED',
    );
    assert.ok(Date.now() - started < 1_000, 'budget must bound the acquire');
    assert.equal(aborted, true);
    assert.equal(s.isBlacklisted(0), true, 'a handshake that never completes counts as unreachable');
    resolveLate('late-conn');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(disposed, ['late-conn']);
  });

  it('rejects a non-positive budget', async () => {
    const s = new EndpointSelector([A]);
    await assert.rejects(
      acquireWithFailover(s, async () => 1, { role: 'r', budgetMs: 0, classify }),
      RangeError,
    );
  });
});

describe('error helpers', () => {
  it('recognises socket-level network errors, including one level of cause', () => {
    assert.equal(isNetworkError(codeError('ECONNREFUSED')), true);
    assert.equal(isNetworkError(new Error('x', { cause: codeError('EHOSTUNREACH') })), true);
    assert.equal(isNetworkError(codeError('ER_ACCESS_DENIED_ERROR')), false);
    assert.equal(isNetworkError('ECONNREFUSED'), false);
  });

  it('errorCode only passes through code-shaped strings', () => {
    assert.equal(errorCode(codeError('ETIMEDOUT')), 'ETIMEDOUT');
    assert.equal(errorCode(codeError('password=hunter2')), 'UNKNOWN');
    assert.equal(errorCode(new Error('no code')), 'UNKNOWN');
  });
});
