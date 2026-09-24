/**
 * design §3.3 S1：启用 / 停用在一个事务里、锁 owner、账本是权威、停用不删字节、
 * 回收保留事务前与本次的摘要。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SKILL_VERSION_GC_GRACE_MS,
  mutateSkillWithLedger,
  resolveSkillVersionGcGraceMs,
} from '../src/application/skill-enablement-service.js';
import { OwnerScopedNotFoundError } from '../src/application/errors.js';

const PREVIOUS = 'a'.repeat(64);
const NEXT = 'b'.repeat(64);

function harness(opts: { locked?: boolean; previous?: string | null; upsertError?: Error } = {}) {
  const calls: string[] = [];
  const trx = { id: 'trx' };
  const transactionManager = {
    run: async <T>(work: (db: unknown) => Promise<T>): Promise<T> => {
      calls.push('begin');
      const result = await work(trx);
      calls.push('commit');
      return result;
    },
  };
  const ledgerFor = (db: unknown) => {
    assert.equal(db, trx, 'the ledger must be bound to the transaction');
    return {
      lockOwner: async () => {
        calls.push('lock');
        return opts.locked ?? true;
      },
      get: async () => {
        calls.push('get');
        return opts.previous ? { contentDigest: opts.previous } : null;
      },
      upsert: async (row: Record<string, unknown>) => {
        calls.push(`upsert:${String(row['contentDigest'])}`);
        if (opts.upsertError) throw opts.upsertError;
      },
      remove: async () => {
        calls.push('remove');
      },
    };
  };
  const manager = {
    enable: async () => {
      calls.push('publish');
      return { name: 'demo', contentDigest: NEXT, fileCount: 1, totalBytes: 1 };
    },
    disable: async () => {
      calls.push('audit-disable');
      return { name: 'demo' };
    },
    collectVersions: async (input: { keepDigests: string[]; graceMs: number }) => {
      calls.push(`collect:${input.keepDigests.join(',')}:${input.graceMs}`);
      return [];
    },
  };
  const run = (action: 'enable' | 'disable') =>
    mutateSkillWithLedger({
      action,
      name: 'demo',
      owner: { orgId: 'org1', userId: 'user1' },
      manager,
      transactionManager,
      ledgerFor,
      graceMs: 5,
    });
  return { calls, run };
}

test('enable locks the owner before publishing and collects while keeping previous and new digests', async () => {
  const h = harness({ previous: PREVIOUS });
  const record = await h.run('enable');
  assert.equal((record as { contentDigest: string }).contentDigest, NEXT);
  assert.deepEqual(h.calls, [
    'begin',
    'lock',
    'get',
    'publish',
    `upsert:${NEXT}`,
    `collect:${PREVIOUS},${NEXT}:5`,
    'commit',
  ]);
});

test('disable removes only the ledger row; bytes stay for running Runs and the old digest is kept', async () => {
  const h = harness({ previous: PREVIOUS });
  assert.deepEqual(await h.run('disable'), { name: 'demo', removed: true });
  assert.deepEqual(h.calls, ['begin', 'lock', 'get', 'audit-disable', 'remove', `collect:${PREVIOUS}:5`, 'commit']);
  assert.equal(h.calls.includes('publish'), false);
});

test('disabling a Skill that was never enabled reports removed=false', async () => {
  const h = harness({ previous: null });
  assert.deepEqual(await h.run('disable'), { name: 'demo', removed: false });
});

test('a missing membership row is a 404 and nothing is published', async () => {
  const h = harness({ locked: false });
  await assert.rejects(() => h.run('enable'), OwnerScopedNotFoundError);
  assert.deepEqual(h.calls, ['begin', 'lock']);
});

test('a failed ledger write aborts before collecting, so the referenced version survives', async () => {
  const h = harness({ previous: PREVIOUS, upsertError: new Error('mysql down') });
  await assert.rejects(() => h.run('enable'), /mysql down/);
  assert.equal(h.calls.some((call) => call.startsWith('collect:')), false);
  assert.equal(h.calls.includes('commit'), false);
});

test('SKILL_VERSION_GC_GRACE_MS parses non-negative integers and falls back otherwise', () => {
  assert.equal(resolveSkillVersionGcGraceMs({}), DEFAULT_SKILL_VERSION_GC_GRACE_MS);
  assert.equal(resolveSkillVersionGcGraceMs({ SKILL_VERSION_GC_GRACE_MS: '0' }), 0);
  assert.equal(resolveSkillVersionGcGraceMs({ SKILL_VERSION_GC_GRACE_MS: '90000' }), 90_000);
  assert.equal(resolveSkillVersionGcGraceMs({ SKILL_VERSION_GC_GRACE_MS: '-1' }), DEFAULT_SKILL_VERSION_GC_GRACE_MS);
  assert.equal(resolveSkillVersionGcGraceMs({ SKILL_VERSION_GC_GRACE_MS: 'soon' }), DEFAULT_SKILL_VERSION_GC_GRACE_MS);
});
