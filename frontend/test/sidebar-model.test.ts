import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentTone,
  filterConversations,
  groupConversations,
  isDefaultAgentName,
} from '../src/widgets/conversation-sidebar/sidebarModel.ts';

const NOW = Date.parse('2026-09-25T10:00:00+08:00');

describe('groupConversations', () => {
  it('buckets by local day, newest first, and drops empty buckets', () => {
    const convs = [
      { id: 'old', updated_at: '2026-08-01T09:00:00+08:00' },
      { id: 'today-early', updated_at: '2026-09-25T08:00:00+08:00' },
      { id: 'yesterday', updated_at: '2026-09-24T22:00:00+08:00' },
      { id: 'today-late', updated_at: '2026-09-25T09:30:00+08:00' },
    ];
    const groups = groupConversations(convs, NOW);
    assert.deepEqual(
      groups.map((g) => [g.label, g.items.map((c) => c.id)]),
      [
        ['今天', ['today-late', 'today-early']],
        ['昨天', ['yesterday']],
        ['更早', ['old']],
      ],
    );
  });

  it('falls back to created_at when a conversation was never updated', () => {
    const groups = groupConversations([{ id: 'a', created_at: '2026-09-21T12:00:00+08:00' }], NOW);
    assert.equal(groups[0].label, '近 7 天');
  });
});

describe('filterConversations', () => {
  const convs = [
    { id: '1', title: 'Q3 区域销售周报', agent_id: 'ag_data' },
    { id: '2', title: '上海天气', agent_id: null },
    { id: '3', title: '销售合同到期', agent_id: 'ag_contract' },
  ];
  const title = (c: { title?: string | null }) => c.title || '';

  it('matches titles case-insensitively', () => {
    assert.deepEqual(filterConversations(convs, '销售', null, title).map((c) => c.id), ['1', '3']);
    assert.deepEqual(filterConversations(convs, '  ', null, title).map((c) => c.id), ['1', '2', '3']);
  });

  it('restricts to one agent when chosen', () => {
    assert.deepEqual(filterConversations(convs, '销售', 'ag_data', title).map((c) => c.id), ['1']);
  });
});

describe('agent tags', () => {
  it('gives one agent a stable colour slot', () => {
    assert.equal(agentTone('01M3AGENT0001'), agentTone('01M3AGENT0001'));
    assert.ok(agentTone('x') >= 0 && agentTone('x') < 6);
  });

  it('hides the default agent', () => {
    assert.equal(isDefaultAgentName('default'), true);
    assert.equal(isDefaultAgentName(null), true);
    assert.equal(isDefaultAgentName('数据分析助手'), false);
  });
});
