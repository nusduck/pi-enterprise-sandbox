/**
 * `RemoteConversationRepository`：绑定读写走 owner-scope，跨 scope 不可见
 * （docs/design/hiagent-remote-delegation.md H3）。
 *
 * 用最小 fake-knex 跑，不依赖真实 MySQL（live 迁移稽核见 schema-manifest integration）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RemoteConversationRepository } from '../../src/infrastructure/mysql/repositories/remote-conversation-repository.js';

const CONVERSATION = '01J0000000000000000000000H';

/** 只实现本仓储用到的链式表面：where/andWhere/first/insert/update/del。 */
function fakeKnex() {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const table = (name: string) => {
    let rows = tables.get(name);
    if (!rows) {
      rows = [];
      tables.set(name, rows);
    }
    const conds: Array<(row: Record<string, unknown>) => boolean> = [];
    const builder: Record<string, unknown> = {
      where(a: unknown, b?: unknown) {
        if (typeof a === 'string') {
          conds.push((row) => row[a] === b);
        } else {
          for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
            conds.push((row) => row[k] === v);
          }
        }
        return builder;
      },
      andWhere(a: unknown, b?: unknown) {
        return (builder.where as (x: unknown, y?: unknown) => unknown)(a, b);
      },
      async first() {
        return rows!.find((r) => conds.every((c) => c(r)));
      },
      async insert(obj: Record<string, unknown>) {
        rows!.push({ ...obj });
        return [1];
      },
      async update(patch: Record<string, unknown>) {
        let n = 0;
        for (const r of rows!) {
          if (conds.every((c) => c(r))) {
            Object.assign(r, patch);
            n += 1;
          }
        }
        return n;
      },
      async del() {
        const kept = rows!.filter((r) => !conds.every((c) => c(r)));
        const n = rows!.length - kept.length;
        tables.set(name, kept);
        return n;
      },
    };
    return builder;
  };
  return { db: table as unknown as import('knex').Knex, tables };
}

function repo(db: unknown) {
  let seq = 0;
  return new RemoteConversationRepository(
    db as import('knex').Knex,
    { generateId: () => `01J000000000000000000000${seq++}`.slice(0, 26) },
  );
}

const SCOPE = { orgId: 'o', userId: 'u', conversationId: CONVERSATION };

describe('RemoteConversationRepository', () => {
  it('returns null when no binding exists', async () => {
    const { db } = fakeKnex();
    assert.equal(await repo(db).getBinding(SCOPE, 'hi-helper'), null);
  });

  it('persists a binding and reads it back in scope', async () => {
    const { db } = fakeKnex();
    const r = repo(db);
    await r.setBinding(SCOPE, 'hi-helper', 'conv-1');
    assert.equal(await r.getBinding(SCOPE, 'hi-helper'), 'conv-1');
  });

  it('overwrites the binding for the same conversation and remote (upsert)', async () => {
    const { db, tables } = fakeKnex();
    const r = repo(db);
    await r.setBinding(SCOPE, 'hi-helper', 'conv-1');
    await r.setBinding(SCOPE, 'hi-helper', 'conv-2');
    assert.equal(await r.getBinding(SCOPE, 'hi-helper'), 'conv-2');
    assert.equal(tables.get('tbl_agsvc_remote_conversations')?.length, 1);
  });

  it('hides the binding from another user on the same conversation', async () => {
    const { db } = fakeKnex();
    const r = repo(db);
    await r.setBinding(SCOPE, 'hi-helper', 'conv-1');
    assert.equal(await r.getBinding({ ...SCOPE, userId: 'intruder' }, 'hi-helper'), null);
  });

  it('hides the binding from another org', async () => {
    const { db } = fakeKnex();
    const r = repo(db);
    await r.setBinding(SCOPE, 'hi-helper', 'conv-1');
    assert.equal(await r.getBinding({ ...SCOPE, orgId: 'other' }, 'hi-helper'), null);
  });

  it('clearBinding is idempotent', async () => {
    const { db } = fakeKnex();
    const r = repo(db);
    await r.setBinding(SCOPE, 'hi-helper', 'conv-1');
    await r.clearBinding(SCOPE, 'hi-helper');
    assert.equal(await r.getBinding(SCOPE, 'hi-helper'), null);
    await r.clearBinding(SCOPE, 'hi-helper');
  });

  it('requires generateId for writes and a valid scope', async () => {
    const { db } = fakeKnex();
    const noId = new RemoteConversationRepository(db as import('knex').Knex);
    await assert.rejects(() => noId.setBinding(SCOPE, 'hi-helper', 'conv-1'), /generateId/);
    await assert.rejects(
      () => repo(db).getBinding({ orgId: '', userId: 'u', conversationId: CONVERSATION }, 'hi-helper'),
      /Owner scope/,
    );
  });

  it('refuses an empty or overlong remote conversation id', async () => {
    const { db } = fakeKnex();
    await assert.rejects(() => repo(db).setBinding(SCOPE, 'hi-helper', ''), /1-191/);
    await assert.rejects(() => repo(db).setBinding(SCOPE, 'hi-helper', 'x'.repeat(192)), /1-191/);
  });
});
