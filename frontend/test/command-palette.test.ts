import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterPalette, type PaletteEntry } from '../src/widgets/command-palette/paletteModel.ts';
import { hasUnseenRuns } from '../src/pages/schedules/scheduleModel.ts';

const entries: PaletteEntry[] = [
  { id: 'c:1', group: '会话', label: '上海天气' },
  { id: 'c:2', group: '会话', label: '查 Rust 最新版本' },
  { id: 'c:3', group: '会话', label: '今天星期几' },
  { id: 'act:new', group: '操作', label: '新建会话', keywords: 'new chat' },
  { id: 'act:schedules', group: '操作', label: '打开定时任务', keywords: 'schedule cron' },
];

describe('filterPalette', () => {
  it('shows recent conversations then actions for an empty query', () => {
    assert.deepEqual(filterPalette(entries, '', 2).map((e) => e.id), ['c:1', 'c:2', 'act:new', 'act:schedules']);
  });

  it('matches labels and keywords, conversations before actions, prefix matches first', () => {
    assert.deepEqual(filterPalette(entries, '会话').map((e) => e.id), ['act:new']);
    assert.deepEqual(filterPalette(entries, 'CRON').map((e) => e.id), ['act:schedules']);
    const mixed: PaletteEntry[] = [...entries, { id: 'c:4', group: '会话', label: '天气预报' }];
    assert.deepEqual(filterPalette(mixed, '天气').map((e) => e.id), ['c:4', 'c:1']);
    assert.deepEqual(filterPalette(entries, 'zzz'), []);
  });
});

describe('hasUnseenRuns', () => {
  it('is true only for runs after the last visit', () => {
    const jobs = [{ last_run_at: '2026-09-25T10:00:00.000Z' }, { last_run_at: null }];
    assert.equal(hasUnseenRuns(jobs, '2026-09-25T09:00:00.000Z'), true);
    assert.equal(hasUnseenRuns(jobs, '2026-09-25T11:00:00.000Z'), false);
    assert.equal(hasUnseenRuns(jobs, null), true, 'never visited counts as unseen');
    assert.equal(hasUnseenRuns([{ last_run_at: null }], null), false);
  });
});
