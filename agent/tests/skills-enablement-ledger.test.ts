import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutateSkillWithLedger } from '../src/application/skill-enablement-service.js';

test('enable writes the owner-scoped ledger and rolls back published bytes on ledger failure', async () => {
  const calls: string[] = [];
  const manager = {
    enable: async () => {
      calls.push('enable');
      return { name: 'draft-one', contentDigest: 'a'.repeat(64), fileCount: 1, totalBytes: 10 };
    },
    disable: async () => { calls.push('disable'); return { removed: true }; },
  };
  await assert.rejects(() => mutateSkillWithLedger({
    action: 'enable',
    name: 'draft-one',
    owner: { orgId: 'org1', userId: 'user1' },
    manager,
    ledger: { upsert: async () => { throw new Error('mysql down'); }, remove: async () => {} },
  }), /ledger update failed/);
  assert.deepEqual(calls, ['enable', 'disable']);
});

test('disable removes published bytes before deleting the durable row', async () => {
  const calls: string[] = [];
  await mutateSkillWithLedger({
    action: 'disable',
    name: 'draft-one',
    owner: { orgId: 'org1', userId: 'user1' },
    manager: {
      enable: async () => ({}),
      disable: async () => { calls.push('bytes'); return { removed: true }; },
    },
    ledger: {
      upsert: async () => {},
      remove: async () => { calls.push('row'); },
    },
  });
  assert.deepEqual(calls, ['bytes', 'row']);
});
