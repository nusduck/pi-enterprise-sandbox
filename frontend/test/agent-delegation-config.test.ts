/**
 * 「协作」分类的草稿读写与行投影（docs/design/agent-delegation-config-ui.md）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELEGATION_MAX,
  delegationMaxItems,
  delegationOf,
  delegationRows,
  delegationStructureIssues,
  localDelegationCandidates,
  remoteDelegationCandidates,
  setDelegationList,
  toggleDelegation,
} from '../src/pages/settings/delegationHelpers.ts';

describe('delegation draft', () => {
  it('reads both lists and treats absent or malformed values as empty', () => {
    assert.deepEqual(delegationOf({}), { agents: [], remoteAgents: [] });
    assert.deepEqual(
      delegationOf({ delegation: { agents: ['b', 'a'], remoteAgents: ['fin'] } }),
      { agents: ['b', 'a'], remoteAgents: ['fin'] },
    );
    assert.deepEqual(delegationOf({ delegation: [] }), { agents: [], remoteAgents: [] });
  });

  it('writes a list without touching sibling keys or the source object', () => {
    const source = { schemaVersion: 1, delegation: { agents: ['a'], future: true } };
    const next = setDelegationList(source, 'remoteAgents', ['fin']);
    assert.deepEqual(next.delegation, { agents: ['a'], future: true, remoteAgents: ['fin'] });
    assert.deepEqual(source.delegation, { agents: ['a'], future: true });
    assert.equal(next.schemaVersion, 1);
  });

  it('drops an emptied list, and the whole key once nothing is left', () => {
    const one = setDelegationList({ delegation: { agents: ['a'], remoteAgents: ['fin'] } }, 'agents', []);
    assert.deepEqual(one.delegation, { remoteAgents: ['fin'] });
    const none = setDelegationList(one, 'remoteAgents', []);
    assert.equal('delegation' in none, false);
    // Unknown sub-keys keep the object alive so the server can report them.
    const kept = setDelegationList({ delegation: { agents: ['a'], future: 1 } }, 'agents', []);
    assert.deepEqual(kept.delegation, { future: 1 });
  });

  it('pauses on malformed structure instead of overwriting it', () => {
    assert.deepEqual(delegationStructureIssues({ delegation: ['a'] }), ['delegation must be an object']);
    assert.deepEqual(delegationStructureIssues({ delegation: { agents: 'a', remoteAgents: [1] } }), [
      'delegation.agents must be an array of strings',
      'delegation.remoteAgents must be an array of strings',
    ]);
    assert.deepEqual(delegationStructureIssues({ delegation: { agents: ['a'] } }), []);
    const malformed = { delegation: { agents: 'a' } };
    assert.deepEqual(setDelegationList(malformed, 'agents', ['b']), malformed);
  });

  it('appends new picks and keeps the rest of the order when unticking', () => {
    assert.deepEqual(toggleDelegation(['c', 'a'], 'b', true), ['c', 'a', 'b']);
    assert.deepEqual(toggleDelegation(['c', 'a'], 'a', true), ['c', 'a']);
    assert.deepEqual(toggleDelegation(['c', 'a', 'b'], 'a', false), ['c', 'b']);
  });

  it('reads the list limit from fieldSupport, falling back to the server default', () => {
    const support = { delegation: { fields: { agents: { maxItems: 5 }, remoteAgents: {} } } };
    assert.equal(delegationMaxItems(support, 'agents'), 5);
    assert.equal(delegationMaxItems(support, 'remoteAgents'), DEFAULT_DELEGATION_MAX);
    assert.equal(delegationMaxItems(undefined, 'agents'), DEFAULT_DELEGATION_MAX);
  });
});

describe('delegation candidates and rows', () => {
  const agents = [
    { name: 'writer', description: '写作', status: 'active' },
    { name: 'lead', description: '自己', status: 'active' },
    { name: 'analyst', description: null, status: 'active' },
    { name: 'old-bot', description: '旧', status: 'disabled' },
  ];

  it('excludes the agent itself, sorts by name, and blocks inactive targets', () => {
    const candidates = localDelegationCandidates(agents, ' lead ');
    assert.deepEqual(candidates.map((c) => c.id), ['analyst', 'old-bot', 'writer']);
    assert.equal(candidates[0]?.description, '');
    assert.equal(candidates.find((c) => c.id === 'old-bot')?.selectable, false);
    assert.equal(candidates.find((c) => c.id === 'writer')?.selectable, true);
  });

  it('projects remote candidates from platformConstraints only', () => {
    const remote = remoteDelegationCandidates({
      remoteAgents: [
        { id: 'fin', name: '财务助手', description: '报销' },
        { id: 'legal' },
        { name: 'no-id' },
      ],
    });
    assert.deepEqual(remote.map((r) => [r.id, r.label]), [['fin', '财务助手'], ['legal', 'legal']]);
    assert.deepEqual(remoteDelegationCandidates({}), []);
    assert.deepEqual(remoteDelegationCandidates(undefined), []);
  });

  it('keeps candidate order stable and appends unknown draft names as stale rows with their draft index', () => {
    const candidates = localDelegationCandidates(agents, 'lead');
    const rows = delegationRows(['writer', 'ghost', 'lead'], candidates);
    assert.deepEqual(
      rows.map((r) => [r.id, r.checked, r.stale, r.draftIndex]),
      [
        ['analyst', false, false, -1],
        ['old-bot', false, false, -1],
        ['writer', true, false, 0],
        ['ghost', true, true, 1],
        ['lead', true, true, 2],
      ],
    );
    assert.equal(rows.find((r) => r.id === 'ghost')?.selectable, false);
  });

  it('turns all draft entries into keep-only rows when the directory is unavailable', () => {
    const rows = delegationRows(['fin'], []);
    assert.deepEqual(rows.map((r) => [r.id, r.stale]), [['fin', true]]);
  });
});
