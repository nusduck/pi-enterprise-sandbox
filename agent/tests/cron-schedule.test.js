import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CronScheduler,
} from '../src/application/cron-job-service.js';
import {
  cronMatches,
  nextCronOccurrence,
  parseCronExpression,
} from '../src/application/cron-schedule.js';

test('five-field Cron computes the next IANA-zoned occurrence', () => {
  const next = nextCronOccurrence(
    '0 9 * * 1-5',
    'Asia/Shanghai',
    new Date('2026-07-27T01:30:00.000Z'), // 09:30 Monday in Shanghai
  );
  assert.equal(next.toISOString(), '2026-07-28T01:00:00.000Z');
});

test('cron accepts lists/ranges/steps and preserves classic DOM/DOW OR behavior', () => {
  const stepped = parseCronExpression('*/15 8-10 * * 1,3,5');
  assert.equal(
    cronMatches(stepped, new Date('2026-07-27T08:15:00.000Z'), 'UTC'),
    true,
  );
  assert.equal(
    cronMatches(stepped, new Date('2026-07-27T08:16:00.000Z'), 'UTC'),
    false,
  );

  const domOrDow = parseCronExpression('0 0 1 * 1');
  assert.equal(
    cronMatches(domOrDow, new Date('2026-08-01T00:00:00.000Z'), 'UTC'),
    true,
    'first day of month matches even when it is not Monday',
  );
  assert.equal(
    cronMatches(domOrDow, new Date('2026-08-03T00:00:00.000Z'), 'UTC'),
    true,
    'Monday matches even when it is not the first day',
  );
});

test('cron validation rejects a seconds field and invalid timezone', () => {
  assert.throws(
    () => parseCronExpression('* * * * * *'),
    /exactly five fields/,
  );
  assert.throws(
    () => nextCronOccurrence('* * * * *', 'Mars/Olympus'),
    /IANA timezone/,
  );
});

test('scheduler serializes ticks and executes durable claims', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = {
    async reconcileRuns() { calls.push('reconcile'); },
    async recoverClaims() { calls.push('recover'); },
    async claimDue() {
      calls.push('claim');
      await gate;
      return [{ id: 'claim-1' }];
    },
    async executeClaim(claim) { calls.push(`execute:${claim.id}`); },
  };
  const scheduler = new CronScheduler({
    cronJobService: service,
    intervalMs: 10_000,
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  });
  const first = scheduler.tick();
  const second = await scheduler.tick();
  assert.deepEqual(second, { skipped: true, claims: 0 });
  release();
  assert.deepEqual(await first, { skipped: false, claims: 1 });
  assert.deepEqual(calls, ['reconcile', 'recover', 'claim', 'execute:claim-1']);
});
