import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCron,
  dailyStrip,
  describeCron,
  formFromCron,
  nextOccurrences,
  parseCron,
  runOutcome,
  zonedIso,
} from '../src/pages/schedules/scheduleModel.ts';
// The preview must agree with what the Agent will actually schedule.
import { nextCronOccurrence } from '../../agent/src/application/cron-schedule.ts';

const AFTER = new Date('2026-09-25T02:30:00Z');

function agentNext(expr: string, tz: string, count: number): string[] {
  const out: string[] = [];
  let after = AFTER;
  for (let i = 0; i < count; i += 1) {
    const next = nextCronOccurrence(expr, tz, after);
    out.push(next.toISOString());
    after = next;
  }
  return out;
}

describe('cron preview parity with the Agent', () => {
  const cases: Array<[string, string]> = [
    ['0 9 * * 1', 'Asia/Shanghai'],
    ['30 18 * * *', 'Asia/Shanghai'],
    ['0 9 1 * *', 'Asia/Shanghai'],
    ['*/15 8-10 * * 1-5', 'UTC'],
    ['0 9 13 * 5', 'Asia/Shanghai'], // both day fields: OR semantics
    ['0 2 * * 0', 'America/New_York'],
    ['0 9 * * 7', 'Asia/Singapore'], // 7 is Sunday
  ];
  for (const [expr, tz] of cases) {
    it(`${expr} @ ${tz}`, () => {
      assert.deepEqual(
        nextOccurrences(expr, tz, 4, AFTER).map((d) => d.toISOString()),
        agentNext(expr, tz, 4),
      );
    });
  }

  it('rejects what the Agent rejects', () => {
    for (const bad of ['0 9 * *', '60 9 * * *', '0 24 * * *', '0 9 32 * *', '5-1 * * * *', '*/0 * * * *', 'a b c d e']) {
      assert.equal(parseCron(bad), null, bad);
      assert.throws(() => nextCronOccurrence(bad, 'UTC', AFTER), bad);
    }
  });
});

describe('frequency builder', () => {
  const base = { time: '09:05', weekdays: [1, 3], dayOfMonth: 15, date: '2026-09-30', cron: '' };

  it('builds and reads back daily, weekly and monthly schedules', () => {
    for (const frequency of ['daily', 'weekly', 'monthly'] as const) {
      const expr = buildCron({ ...base, frequency });
      const back = formFromCron(expr);
      assert.equal(back.frequency, frequency, expr);
      assert.equal(back.time, '09:05');
    }
    assert.equal(buildCron({ ...base, frequency: 'weekly' }), '5 9 * * 1,3');
    assert.deepEqual(formFromCron('5 9 * * 1,3').weekdays, [1, 3]);
    assert.equal(formFromCron('5 9 15 * *').dayOfMonth, 15);
  });

  it('keeps anything else as a custom expression', () => {
    assert.equal(formFromCron('*/15 8-10 * * 1-5').frequency, 'custom');
    assert.equal(buildCron({ ...base, frequency: 'custom', cron: ' 0 9 * * 1 ' }), '0 9 * * 1');
  });

  it('describes schedules in Chinese', () => {
    assert.equal(describeCron('0 9 * * 1'), '每周一 09:00');
    assert.equal(describeCron('0 18 * * *'), '每天 18:00');
    assert.equal(describeCron('30 8 1 * *'), '每月 1 日 08:30');
    assert.equal(describeCron('0 9 * * 0,1'), '每周一、日 09:00');
    assert.equal(describeCron('*/15 * * * *'), 'Cron */15 * * * *');
  });
});

describe('zonedIso', () => {
  it('attaches the zone offset the Agent requires on run_at', () => {
    assert.equal(zonedIso('2026-09-30', '10:00', 'Asia/Shanghai'), '2026-09-30T10:00:00+08:00');
    assert.equal(zonedIso('2026-09-30', '10:00', 'UTC'), '2026-09-30T10:00:00+00:00');
    assert.equal(zonedIso('2026-07-01', '10:00', 'America/New_York'), '2026-07-01T10:00:00-04:00');
    assert.equal(zonedIso('2026-12-01', '10:00', 'America/New_York'), '2026-12-01T10:00:00-05:00');
  });
});

describe('run strip', () => {
  it('reads the cron row status first, then the Run status', () => {
    assert.equal(runOutcome({ status: 'FAILED', run_status: null }), 'err');
    assert.equal(runOutcome({ status: 'SKIPPED', run_status: null }), 'skip');
    assert.equal(runOutcome({ status: 'QUEUED', run_status: 'SUCCEEDED' }), 'ok');
    assert.equal(runOutcome({ status: 'QUEUED', run_status: 'CANCELLED' }), 'err');
    assert.equal(runOutcome({ status: 'RUNNING', run_status: 'RUNNING' }), 'live');
  });

  it('buckets the last 30 local days and lets a failure win the day', () => {
    const now = new Date(2026, 8, 25, 12, 0);
    const at = (d: number, h: number) => new Date(2026, 8, d, h, 0).toISOString();
    const strip = dailyStrip([
      { status: 'QUEUED', run_status: 'SUCCEEDED', scheduled_at: at(25, 9) },
      { status: 'FAILED', run_status: null, scheduled_at: at(25, 18) },
      { status: 'QUEUED', run_status: 'SUCCEEDED', scheduled_at: at(24, 9) },
      { status: 'QUEUED', run_status: 'SUCCEEDED', scheduled_at: new Date(2026, 7, 20, 9, 0).toISOString() }, // older than 30 days
    ], 30, now);
    assert.equal(strip.length, 30);
    assert.deepEqual(strip.slice(-2).map((c) => [c.outcome, c.count]), [['ok', 1], ['err', 2]]);
    assert.equal(strip.filter((c) => c.outcome !== 'none').length, 2);
  });
});
